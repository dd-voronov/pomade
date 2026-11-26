// Pomade — main-process filesystem service: the IPC-registration shim over the fs subsystem.
// Every `fs.*` / outside-workspace channel is wired here to its owning module:
//   fs-tree     — depth-bounded tree walk (in + outside workspace)
//   fs-ops      — collision-safe copy / move / duplicate, outside write doors, symlink resolve
//   fs-watch    — live recursive watchers (in + outside workspace)
//   fm-index    — E-014 frontmatter index (properties-panel autocomplete)
//   name-index  — E-020 terminal file-link path probe + basename/stem/dir index
// The path guards and shared walk primitives live in fs-shared. This file holds no fs logic of
// its own beyond the small IPC-only glue (the native pickers, data-URL / stat handlers).

import { ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join, relative, isAbsolute, sep, extname, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

import { CH } from '@shared/ipc-api'

import { configStore } from './config-store'
import { defineHandler } from './ipc'
import { noteMoved, noteSaved } from './local-history'
import { abs, requireAbs, requireRoot, toRel } from './fs-shared'
import { showDialog } from './windows'
import { buildTree, treeOutside } from './fs-tree'
import {
  copyEntry,
  copyFileSafe,
  copyOutside,
  copyRecursive,
  createDirOutside,
  createFileOutside,
  duplicateOutside,
  moveEntry,
  moveOutside,
  renameOutside,
  resolveLinkTarget,
  trashOutside
} from './fs-ops'
import { fmIndex } from './fm-index'
import { nameIndexService } from './name-index'
import { pathProbe } from './path-probe'
import {
  startWatch,
  startWatchOutside,
  stopAllWatchers,
  stopWatch,
  stopWatchOutside
} from './fs-watch'
import { setWatchedDocs } from './doc-watch'

const DEFAULT_DEPTH = 4

function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp'
}

// Re-exported so `main/index.ts` keeps one import edge: the workspace-teardown / -ready hooks
// call these regardless of which module owns the state now.
export { stopAllWatchers }

/** T-091 — build the current workspace's terminal name index up front (boot + workspace switch). */
export function warmNameIndex(): void {
  nameIndexService.warm()
}

/** T-091 — drop the terminal name index and its watcher (workspace switch). */
export function resetNameIndex(): void {
  nameIndexService.reset()
}

// Test hook (docs/contracts/test-hooks.md): under NODE_ENV=test every folder the tree reads
// (`fs.tree`, `fs.treeOutside`) is appended to `globalThis.__pomadeTreeReads`, so e2e can count
// the reads a burst of file events causes.
function recordTreeRead(path: string): void {
  if (process.env.NODE_ENV !== 'test') return
  const g = globalThis as { __pomadeTreeReads?: string[] }
  ;(g.__pomadeTreeReads ??= []).push(path)
}

export function registerFsService(ipc: typeof ipcMain): void {
  defineHandler(ipc, CH.fs.tree, async (_e, rootRel, depth, treeOpts) => {
    recordTreeRead(rootRel || '')
    const root = requireRoot()
    const ignoreList = await configStore.getTreeIgnore()
    return buildTree(
      root,
      abs(rootRel || ''),
      depth ?? DEFAULT_DEPTH,
      {
        ignoreSet: new Set(ignoreList),
        includeIgnored: treeOpts?.includeIgnored ?? false
      },
      true
    )
  })

  defineHandler(ipc, CH.fs.read, (_e, rel) => fs.readFile(abs(rel), 'utf8'))

  defineHandler(ipc, CH.fs.write, async (_e, rel, content, opts) => {
    const target = abs(rel)
    await fs.mkdir(target.slice(0, target.lastIndexOf(sep)), { recursive: true })
    try {
      // Exclusive write ('wx') rejects with EEXIST if the file exists — Save-As uses this to
      // detect a collision rather than silently overwriting. Plain write truncates as before.
      await fs.writeFile(target, content, { encoding: 'utf8', flag: opts?.exclusive ? 'wx' : 'w' })
      noteSaved(rel, content)
      return { ok: true } as const
    } catch (err) {
      if (opts?.exclusive && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, code: 'EEXIST' } as const
      }
      throw err
    }
  })

  defineHandler(ipc, CH.fs.createFile, async (_e, rel) => {
    const target = abs(rel)
    await fs.mkdir(target.slice(0, target.lastIndexOf(sep)), { recursive: true })
    const handle = await fs.open(target, 'wx')
    await handle.close()
  })

  defineHandler(ipc, CH.fs.createDir, (_e, rel) =>
    fs.mkdir(abs(rel), { recursive: true }).then(() => undefined)
  )

  defineHandler(ipc, CH.fs.exists, async (_e, rel) => {
    try {
      await fs.access(abs(rel))
      return true
    } catch {
      return false
    }
  })

  defineHandler(ipc, CH.fs.copyDir, (_e, srcRel, destRel) =>
    copyRecursive(abs(srcRel), abs(destRel))
  )

  // ── E-001 (T-010): collision-safe file copies ───────────────────────────────
  defineHandler(ipc, CH.fs.duplicate, (_e, srcRel) =>
    copyFileSafe(requireRoot(), srcRel, parentRel(srcRel), false)
  )
  defineHandler(ipc, CH.fs.copyTo, (_e, srcRel, destDirRel) =>
    copyFileSafe(requireRoot(), srcRel, destDirRel || '', true)
  )

  // ── E-004 (T-020): collision-refusing rename/move ────────────────────────────
  defineHandler(ipc, CH.fs.rename, async (_e, srcRel, destRel) => {
    const root = requireRoot()
    const srcAbs = abs(srcRel)
    const destAbs = abs(destRel) // both refuse workspace escapes
    // A no-op rename to the same path is allowed through so it can't wedge on the identity
    // case; otherwise refuse if the destination already exists — never clobber a sibling.
    if (destAbs !== srcAbs) {
      const collides = await fs
        .access(destAbs)
        .then(() => true)
        .catch(() => false)
      if (collides) {
        throw new Error(
          `A file named "${destRel.slice(destRel.lastIndexOf('/') + 1)}" already exists`
        )
      }
      await fs.mkdir(destAbs.slice(0, destAbs.lastIndexOf(sep)), { recursive: true })
      await fs.rename(srcAbs, destAbs)
      await noteMoved(srcRel, toRel(root, destAbs)).catch(() => undefined)
    }
    return toRel(root, destAbs)
  })

  // ── E-012: move / copy / trash (files + directories) ─────────────────────────
  defineHandler(ipc, CH.fs.move, async (_e, srcRel, destRel, opts) => {
    const moved = await moveEntry(requireRoot(), srcRel, destRel, opts?.onCollision)
    if (moved !== srcRel) await noteMoved(srcRel, moved).catch(() => undefined)
    return moved
  })
  defineHandler(ipc, CH.fs.copy, (_e, srcRel, destRel) =>
    copyEntry(requireRoot(), srcRel, destRel)
  )
  defineHandler(ipc, CH.fs.trash, async (_e, rel) => {
    // shell.trashItem moves to the OS trash (recoverable). Never rm — this is the user's vault.
    await shell.trashItem(abs(rel))
  })

  // ── E-012 (final): resolve a symlink target for the popover ──────────────────
  defineHandler(ipc, CH.fs.linkTarget, (_e, rel) => resolveLinkTarget(requireRoot(), rel))

  // ── E-014: workspace frontmatter index (cached per app run, keyed by root) ────
  defineHandler(ipc, CH.fs.frontmatterIndex, () => fmIndex.get(requireRoot()))

  // ── E-020 (T-086): terminal file links ──────────────────────────────────────
  defineHandler(ipc, CH.fs.probePath, (_e, input, baseAbs) =>
    pathProbe.probePath(requireRoot(), input, baseAbs)
  )
  defineHandler(ipc, CH.fs.findByName, (_e, name, projectRootAbs) =>
    nameIndexService.findByName(requireRoot(), name, projectRootAbs)
  )
  defineHandler(ipc, CH.fs.findByStem, (_e, word, projectRootAbs) =>
    nameIndexService.findByStem(requireRoot(), word, projectRootAbs)
  )
  defineHandler(ipc, CH.fs.findDirsBySuffix, (_e, token, projectRootAbs) =>
    nameIndexService.findDirsBySuffix(requireRoot(), token, projectRootAbs)
  )
  defineHandler(ipc, CH.fs.findFilesBySuffix, (_e, token, projectRootAbs) =>
    nameIndexService.findFilesBySuffix(requireRoot(), token, projectRootAbs)
  )

  // ── Wave 2a: watch / unwatch ────────────────────────────────────────────────
  defineHandler(ipc, CH.fs.watch, (_e, rootRel) => {
    startWatch(rootRel || '')
  })
  defineHandler(ipc, CH.fs.unwatch, (_e, rootRel) => stopWatch(rootRel || ''))
  // E-035 — the open-doc watcher (rule 8), kept in its own module beside the tree watchers.
  defineHandler(ipc, CH.fs.watchDocs, (_e, paths) => {
    setWatchedDocs(paths)
  })

  // ── Wave 2a: native picker constrained to the workspace ─────────────────────
  defineHandler(ipc, CH.fs.pickPath, async (_e, opts) => {
    const root = requireRoot()
    const defaultPath = opts?.defaultRel ? abs(opts.defaultRel) : root
    const properties: Array<'openDirectory' | 'openFile' | 'createDirectory'> = opts?.directory
      ? ['openDirectory', 'createDirectory']
      : ['openFile']
    const filters = opts?.image
      ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }]
      : undefined
    const result = await showDialog({ defaultPath, properties, filters })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    const rel = relative(root, picked)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Selection must be inside the workspace')
    }
    return rel.split(sep).join('/')
  })

  // ── E-008 (T-033): pick an image WITHOUT the workspace constraint ────────────
  // Unlike pickPath (which refuses selections outside the workspace), this accepts an image
  // from anywhere. Inside-workspace picks are returned as-is (existing behavior, no copy).
  // Outside picks are COPIED into `.pomade/assets/<id>.<ext>` — a workspace-relative,
  // laptop-portable location that survives moving the workspace — and the copy's relative
  // path is returned. `.pomade/assets` is the single convention for imported binary assets.
  // Testing hook: POMADE_PICK_PATH (read fresh) stubs the dialog's returned absolute path.
  defineHandler(ipc, CH.fs.pickImage, async () => {
    const root = requireRoot()
    const stub = process.env.POMADE_PICK_PATH
    let picked: string
    if (stub) {
      picked = stub
    } else {
      const filters = [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }
      ]
      const result = await showDialog({ properties: ['openFile'], filters })
      if (result.canceled || result.filePaths.length === 0) return null
      picked = result.filePaths[0]
    }
    const insideRel = relative(root, picked)
    if (!insideRel.startsWith('..') && !isAbsolute(insideRel)) {
      const rel = insideRel.split(sep).join('/')
      // Re-picking an already-copied asset — no duplicate copy.
      if (rel.startsWith('.pomade/assets/')) return rel
    }
    // Copy into .pomade/assets/<id>.<ext> — for in-workspace picks too: the original
    // may be moved or deleted later, which would silently break the image.
    const ext = extname(picked).toLowerCase()
    const destRel = `.pomade/assets/${randomBytes(8).toString('hex')}${ext}`
    const destAbs = join(root, destRel)
    await fs.mkdir(dirname(destAbs), { recursive: true })
    await fs.copyFile(picked, destAbs)
    return destRel
  })

  // ── Wave 2a: read a file as a data: URL (image preview) ──────────────────────
  defineHandler(ipc, CH.fs.readDataUrl, async (_e, rel) => {
    const buf = await fs.readFile(abs(rel))
    const mime = IMAGE_MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  // ── Wave 3: byte-accurate stat (editor size guard + external-change detection) ─
  // E-012 (round-3): also report whether the path itself is a symlink. `stat` follows the link
  // (so size/mtime/isFile describe the TARGET, unchanged), while `lstat` reveals the link itself.
  defineHandler(ipc, CH.fs.stat, async (_e, rel) => {
    const target = abs(rel)
    const [st, lst] = await Promise.all([fs.stat(target), fs.lstat(target)])
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      isFile: st.isFile(),
      isSymbolicLink: lst.isSymbolicLink()
    }
  })

  // ── T-102 (E-021): outside-workspace read / write / stat for ONE absolute path ─
  // The sanctioned door for the outside-workspace doc object class (see requireAbs in fs-shared).
  defineHandler(ipc, CH.fs.readOutside, (_e, absPath) => fs.readFile(requireAbs(absPath), 'utf8'))
  defineHandler(ipc, CH.fs.writeOutside, async (_e, absPath, content) => {
    const target = requireAbs(absPath)
    await fs.mkdir(target.slice(0, target.lastIndexOf(sep)), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
  })
  defineHandler(ipc, CH.fs.statOutside, async (_e, absPath) => {
    const target = requireAbs(absPath)
    const [st, lst] = await Promise.all([fs.stat(target), fs.lstat(target)])
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      isFile: st.isFile(),
      isSymbolicLink: lst.isSymbolicLink()
    }
  })

  // ── T-131 (E-026): outside-workspace tree read + bounded recursive watcher ────
  // The mount door. `treeOutside` reads ONE absolute mount root (tree-display only); `watchOutside`
  // / `unwatchOutside` manage its single recursive descriptor. Change events reach the renderer on
  // the SAME EV.fsChanged channel (keyed by the absolute root path — see startWatchOutside).
  defineHandler(ipc, CH.fs.treeOutside, (_e, absPath, depth) => {
    recordTreeRead(absPath)
    return treeOutside(absPath, depth)
  })
  defineHandler(ipc, CH.fs.watchOutside, (_e, absPath) => {
    startWatchOutside(absPath)
  })
  defineHandler(ipc, CH.fs.unwatchOutside, (_e, absPath) => stopWatchOutside(absPath))

  // ── T-133 (E-026): outside-workspace WRITE doors (create/rename/delete/duplicate/move/copy) ──
  // Each requires an absolute path (requireAbs); the renderer routes an absolute-path node here.
  defineHandler(ipc, CH.fs.createFileOutside, (_e, absPath) => createFileOutside(absPath))
  defineHandler(ipc, CH.fs.createDirOutside, (_e, absPath) => createDirOutside(absPath))
  defineHandler(ipc, CH.fs.renameOutside, (_e, absPath, newName) =>
    renameOutside(absPath, newName)
  )
  defineHandler(ipc, CH.fs.duplicateOutside, (_e, absPath) => duplicateOutside(absPath))
  defineHandler(ipc, CH.fs.moveOutside, (_e, srcAbs, destAbs, opts) =>
    moveOutside(srcAbs, destAbs, opts?.onCollision)
  )
  defineHandler(ipc, CH.fs.copyOutside, (_e, srcAbs, destAbs) => copyOutside(srcAbs, destAbs))
  defineHandler(ipc, CH.fs.trashOutside, async (_e, absPath) => {
    await trashOutside(absPath)
  })
}
