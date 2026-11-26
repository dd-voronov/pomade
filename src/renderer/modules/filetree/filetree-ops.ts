// Pomade — file-tree pure helpers + the mutating-op orchestration (T-159). Everything here is
// either a pure path/dispatch helper or a store-driven action; no JSX. The dispatch helpers route
// each fs op to the T-131/T-133 outside door for an ABSOLUTE path (a leading '/' is the exact
// "outside the workspace" signal — a ws-relative path never begins with one) and to the
// escape-guarded in-workspace op otherwise. `useTreeOps` owns the clipboard/rename/prompt/collision/
// open-many/delete-confirm state and the move/paste/trash/bulk flows built on these helpers.

import { useCallback, useState } from 'react'

import type { FileNode } from '@shared/types'
import type { Scope } from '@shared/paths'
import { useTabsStore } from '../../stores/tabs-store'
import { cleanIpcError } from '../../lib/ipc-errors'
import { basename, parentOf as parentOfPath, splitPath } from '../../lib/path-display'

type Toast = (message: string, kind?: 'info' | 'error') => void

// ── types ────────────────────────────────────────────────────────────────────

// E-018 — one selected entry. `kind` drives where header creates land and which bulk actions
// apply; `symlink` rides along so a bulk "Open in editor" flags the tab exactly as a single
// tree click does.
export interface SelItem {
  path: string
  kind: 'file' | 'dir'
  symlink?: boolean
}

// E-026 — a rendered tree root: the pinned project root first, then each within-workspace mount
// in display order. `path` is workspace-relative (Slice 1); `id` is the collapse/persist key.
export interface RootDesc {
  id: string
  path: string
  kind: 'project' | 'mount'
  // T-144 — a mount's optional custom display name (project root never has one).
  name?: string
  // E-047 — the mount is in the project's scope.
  inScope?: boolean
}

export interface MenuState {
  x: number
  y: number
  target: FileNode | null // null → tree root (project-root header or empty body)
  // E-018 — non-null when the menu was opened INSIDE a multi-selection: its items in visible-row
  // order. Drives the bulk menu variant (every action applies to all of them).
  bulk: SelItem[] | null
  // E-026 / T-144 — non-null when a ROOT header's own commands menu is open (right-click on a
  // mount, or the ⋯ kebab on any root). `kind` gates the mount-only items (Rename + Unmount):
  // the pinned project root ('project') shows only Copy path / Copy full path / Reveal. `name`
  // is the mount's current custom name (seeds the inline rename).
  mount?: { id: string; path: string; kind: 'project' | 'mount'; name?: string; inScope?: boolean } | null
  // T-144 — non-null when the file-tree SECTION ⋯ kebab is open (ignored items…, show/hide
  // ignored items, mount a new folder).
  section?: boolean
}

export interface PromptState {
  kind: 'file' | 'dir'
  dir: string
}

export interface ClipState {
  paths: string[]
  op: 'cut' | 'copy'
}

export interface CollisionState {
  src: string
  dest: string
  destDir: string
  name: string
  canOverwrite: boolean
}

// ── constants ──────────────────────────────────────────────────────────────────
// T-122 — fixed width of the go-to-path suggestion popover (viewport-clamped like other popovers).
export const GOTO_HINT_WIDTH = 280
// E-018 — above this many files, "Open in editor" asks first (locked decision 4).
export const OPEN_MANY_CONFIRM_AT = 10
// E-026 — stable empty references so the mounts-store selectors don't return a fresh array each
// render (which would loop React). Never mutated.
export const EMPTY_MOUNTS: never[] = []
export const EMPTY_COLLAPSED: never[] = []

// ── pure path helpers ────────────────────────────────────────────────────────────

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function parentOf(path: string): string {
  return parentOfPath(path)
}

export function nameOf(path: string): string {
  return basename(path)
}

export function toSel(node: FileNode): SelItem {
  return { path: node.path, kind: node.kind, ...(node.symlink ? { symlink: true } : {}) }
}

// Split a root's path into a dimmed parent prefix and an emphasized leaf, for the header label.
// Handles both a workspace-relative form (`Projects/alpha`) and a `~`-relative outside form
// (`~/Documents/foo`, T-101 convention) — the split is a plain last-separator split either way.
export function splitRootLabel(path: string): { parent: string; leaf: string } {
  if (path === '') return { parent: '', leaf: '<workspace root>' }
  return splitPath(path)
}

// E-026 (T-135) — the SCOPE line of a root's tooltip (line 1). Line 2 (existence) is appended only
// for a missing root. Matches the diamond's colour tier: accent (in-project) / orange
// (outside-project) / red (outside-workspace).
/** E-047 — what putting a mount in the project's scope means (the mount dialog's (i) and the
 *  mount menu's Add to project scope say it). */
export const SCOPE_ADD_TIP = "Files in this folder count as part of this project: no 'Outside this project' mark."
export const SCOPE_REMOVE_TIP = 'Files in this folder stop counting as part of this project and get the scope mark again.'

export function scopeLine(scope: Scope): string {
  switch (scope) {
    case 'outside-workspace':
      return 'Outside your workspace'
    case 'outside-project':
      return 'Outside this project'
    default:
      return 'Inside your workspace'
  }
}

// E-026 (T-132) — render an absolute outside-workspace path home-relative (`~/…`), matching the
// editor header's expanded path format (EditorPane.headerPath). Falls back to the raw absolute
// path when it isn't under the home dir (or home is unknown).
export function tildeDisplay(abs: string, home: string | undefined): string {
  return home && (abs === home || abs.startsWith(`${home}/`)) ? `~${abs.slice(home.length)}` : abs
}

// E-018 — the deepest folder that contains EVERY given path (Copy path / Copy full path on a
// multi-selection resolve to it). Same folder for all ⇒ that folder; spanning folders ⇒ their
// first common ancestor; nothing in common ⇒ '' (the workspace root).
export function commonParent(paths: string[]): string {
  if (paths.length === 0) return ''
  let common: string[] | null = null
  for (const p of paths) {
    const segs = parentOf(p).split('/').filter(Boolean)
    if (common === null) {
      common = segs
      continue
    }
    let i = 0
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++
    common = common.slice(0, i)
  }
  return (common ?? []).join('/')
}

// Guard: a drop into its own current folder is a no-op; into itself or a descendant is
// forbidden (would orphan/duplicate a folder into its own subtree).
export function canDrop(src: string, destDir: string): boolean {
  if (src === destDir) return false
  if (destDir === parentOf(src)) return false
  if (destDir === src || destDir.startsWith(src + '/')) return false
  return true
}

// ── fs dispatch helpers (inside vs outside the workspace) ──────────────────────────

// E-026 (T-132) — the loader dispatch: an ABSOLUTE path (an outside-workspace mount, or a dir under
// one) reads through the T-131 outside door; a workspace-relative path keeps the escape-guarded
// fs.tree. Absolute keys never collide with ws-relative ones (a ws-relative path never starts with
// '/'), so childrenByPath can hold both. treeOutside has no ignored items (its own INDEX_IGNORE).
export function fetchTree(path: string, depth: number, includeIgnored: boolean): Promise<FileNode> {
  return path.startsWith('/')
    ? window.pomade.fs.treeOutside(path, depth)
    : window.pomade.fs.tree(path, depth, { includeIgnored })
}

// E-026 (T-133) — a node's path is ABSOLUTE for an outside-workspace mount (a ws-relative path
// never begins with '/'), so a leading slash is the exact, reliable "outside" signal — the same
// convention EditorPane/TabStrip use. A single Cut/Copy is one path and a multi-selection that
// mixes inside+outside is blocked upstream, so a clip is always uniformly inside OR outside — the
// boundary is never crossed in one op.
export const isOutside = (p: string): boolean => p.startsWith('/')

export function createFileD(path: string): Promise<void> {
  return isOutside(path) ? window.pomade.fs.createFileOutside(path) : window.pomade.fs.createFile(path)
}
export function createDirD(path: string): Promise<void> {
  return isOutside(path) ? window.pomade.fs.createDirOutside(path) : window.pomade.fs.createDir(path)
}
export function moveD(
  src: string,
  dest: string,
  opts?: { onCollision?: 'rename' | 'overwrite' }
): Promise<string> {
  return isOutside(src)
    ? window.pomade.fs.moveOutside(src, dest, opts)
    : window.pomade.fs.move(src, dest, opts)
}
export function copyD(src: string, dest: string): Promise<string> {
  return isOutside(src) ? window.pomade.fs.copyOutside(src, dest) : window.pomade.fs.copy(src, dest)
}
export function trashD(path: string): Promise<void> {
  return isOutside(path) ? window.pomade.fs.trashOutside(path) : window.pomade.fs.trash(path)
}
/** Existence check that works for both spaces: outside has no `exists` door, so a `statOutside`
 *  that resolves means "exists" and one that throws means "gone". */
export function existsD(path: string): Promise<boolean> {
  return isOutside(path)
    ? window.pomade.fs.statOutside(path).then(() => true, () => false)
    : window.pomade.fs.exists(path)
}
export function statD(path: string): ReturnType<typeof window.pomade.fs.stat> {
  return isOutside(path) ? window.pomade.fs.statOutside(path) : window.pomade.fs.stat(path)
}

// ── the mutating-op hook ───────────────────────────────────────────────────────

export interface TreeOpsDeps {
  activeProjectId: string
  wsRoot: string | null
  rootPath: string
  previewTabMode: boolean
  loadDir: (path: string) => Promise<void>
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
  clearSelIfAffected: (path: string) => void
  toast: Toast
  retargetPaths: (oldPrefix: string, newPrefix: string) => void
}

export interface TreeOps {
  clip: ClipState | null
  setClip: React.Dispatch<React.SetStateAction<ClipState | null>>
  prompt: PromptState | null
  setPrompt: React.Dispatch<React.SetStateAction<PromptState | null>>
  rename: { path: string; name: string } | null
  setRename: React.Dispatch<React.SetStateAction<{ path: string; name: string } | null>>
  collision: CollisionState | null
  setCollision: React.Dispatch<React.SetStateAction<CollisionState | null>>
  openMany: SelItem[] | null
  setOpenMany: React.Dispatch<React.SetStateAction<SelItem[] | null>>
  deleteConfirm: SelItem[] | null
  setDeleteConfirm: React.Dispatch<React.SetStateAction<SelItem[] | null>>
  openDoc: (node: { name: string; path: string; symlink?: boolean }, opts?: { real?: boolean }) => void
  targetDirFor: (node: { kind: 'file' | 'dir'; path: string } | null) => string
  copyToClipboard: (text: string, label: string) => void
  dropFromClip: (path: string) => void
  submitName: (name: string) => Promise<void>
  submitRename: (newName: string) => Promise<void>
  requestDelete: (items: SelItem[]) => void
  performMove: (src: string, dest: string, onCollision?: 'rename' | 'overwrite') => Promise<void>
  pasteInto: (dir: string) => Promise<void>
  moveTo: (src: string, destDir: string) => Promise<void>
  filesOf: (items: SelItem[]) => SelItem[]
  openInEditor: (items: SelItem[]) => void
  requestOpenInEditor: (items: SelItem[]) => void
  bulkTrash: (items: SelItem[]) => Promise<void>
  bulkReveal: (items: SelItem[]) => void
  copySelectionPath: (items: SelItem[], absolute: boolean) => void
  pasteBlocked: (target: FileNode | null) => boolean
  isMixedSelection: (items: SelItem[] | null) => boolean
}

export function useTreeOps(deps: TreeOpsDeps): TreeOps {
  const {
    activeProjectId,
    wsRoot,
    rootPath,
    previewTabMode,
    loadDir,
    setExpanded,
    clearSelIfAffected,
    toast,
    retargetPaths
  } = deps

  // E-018 — the clipboard holds a LIST of paths (a single Cut/Copy is a one-element list), so
  // paste applies the E-012 rules item-wise.
  const [clip, setClip] = useState<ClipState | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [rename, setRename] = useState<{ path: string; name: string } | null>(null)
  // E-016 — move/paste collision: raised when a move (drag-and-drop or Cut→Paste) lands on an
  // existing name. `canOverwrite` is true only when BOTH sides are files (a folder can only be
  // renamed or cancelled). Resolving it re-runs the move with the chosen strategy.
  const [collision, setCollision] = useState<CollisionState | null>(null)
  // E-018 — "Open in editor" on a large multi-selection asks first (locked at >10 files).
  const [openMany, setOpenMany] = useState<SelItem[] | null>(null)
  // T-133 — deleting an OUTSIDE node (single or bulk) always confirms first (it lives outside the
  // workspace → Trash). In-workspace deletes are unchanged (straight to Trash, no confirm).
  const [deleteConfirm, setDeleteConfirm] = useState<SelItem[] | null>(null)

  // `opts.real` (E-018) opens a REAL tab even while preview-tab mode is on — bulk "Open in
  // Editor" must leave every file open, not chain them through the one preview slot.
  // T-170 — thin wrapper over the shared `openDocByPath` action: this is the ONE call site that
  // ever turns on T-063 preview-tab semantics (`usePreviewMode`), and the only one that already
  // knows the symlink flag synchronously (from the tree node, so the action skips its own stat).
  const openDoc = useCallback(
    (node: { name: string; path: string; symlink?: boolean }, opts?: { real?: boolean }): void => {
      useTabsStore.getState().openDocByPath(activeProjectId, node.path, {
        title: node.name,
        symlink: node.symlink === true,
        usePreviewMode: previewTabMode && !opts?.real
      })
    },
    [activeProjectId, previewTabMode]
  )

  // Structural param so it accepts both a full FileNode (context menu) and the lightweight
  // `selected` record (header buttons): dir → itself, file → its parent, nothing → project root.
  const targetDirFor = useCallback(
    (node: { kind: 'file' | 'dir'; path: string } | null): string => {
      if (!node) return rootPath
      return node.kind === 'dir' ? node.path : parentOf(node.path)
    },
    [rootPath]
  )

  const copyToClipboard = useCallback(
    (text: string, label: string): void => {
      void window.pomade.app.clipboardWrite(text)
      toast(label)
    },
    [toast]
  )

  // E-018 — drop a path from the tree clipboard (it was trashed or moved away).
  const dropFromClip = useCallback((path: string): void => {
    setClip((c) => {
      if (!c) return c
      const paths = c.paths.filter((p) => p !== path)
      if (paths.length === c.paths.length) return c
      return paths.length ? { ...c, paths } : null
    })
  }, [])

  const reloadDirs = useCallback(
    async (dirs: string[]): Promise<void> => {
      await Promise.all([...new Set(dirs)].map((d) => loadDir(d)))
    },
    [loadDir]
  )

  // E-018 — ONE summary toast for a bulk run (locked decision 6): all-good states read naturally,
  // any failure surfaces as an error toast carrying both counts. Never one toast per item.
  const summaryToast = useCallback(
    (verb: string, done: number, failed: number): void => {
      if (failed === 0) toast(`${done} ${done === 1 ? 'item' : 'items'} ${verb}`)
      else toast(`${done} ${verb}, ${failed} failed`, 'error')
    },
    [toast]
  )

  // E-018 — apply `op` to every item, CONTINUING past failures, and report the tally.
  const runBulk = useCallback(
    async (
      items: SelItem[],
      op: (item: SelItem) => Promise<void>
    ): Promise<{ done: number; failed: number }> => {
      let done = 0
      let failed = 0
      for (const item of items) {
        try {
          await op(item)
          done++
        } catch {
          failed++
        }
      }
      return { done, failed }
    },
    []
  )

  const submitName = useCallback(
    async (name: string): Promise<void> => {
      if (!prompt) return
      const trimmed = name.trim()
      if (!trimmed) return
      const target = joinRel(prompt.dir, trimmed)
      try {
        if (prompt.kind === 'file') await createFileD(target)
        else await createDirD(target)
        setExpanded((prev) => new Set(prev).add(prompt.dir))
        await loadDir(prompt.dir)
      } catch (err) {
        toast(cleanIpcError(err), 'error')
      } finally {
        setPrompt(null)
      }
    },
    [prompt, setExpanded, loadDir, toast]
  )

  const submitRename = useCallback(
    async (newName: string): Promise<void> => {
      if (!rename) return
      const trimmed = newName.trim()
      const dir = parentOf(rename.path)
      const dest = joinRel(dir, trimmed)
      if (!trimmed || dest === rename.path) {
        setRename(null)
        return
      }
      try {
        // Outside nodes rename via the T-133 door (a sibling `newName`, collision-refusing); in-
        // workspace nodes keep the E-004 move-based rename. `dest` equals the door's returned path
        // either way (parent dir + new name), so the tab retarget below is uniform.
        if (isOutside(rename.path)) await window.pomade.fs.renameOutside(rename.path, trimmed)
        else await window.pomade.fs.move(rename.path, dest)
        setClip((c) =>
          c?.paths.includes(rename.path)
            ? { paths: c.paths.map((p) => (p === rename.path ? dest : p)), op: c.op }
            : c
        )
        clearSelIfAffected(rename.path)
        // E-016 — open doc tabs pointing at the renamed file (or, for a folder, its descendants)
        // follow to the new path.
        retargetPaths(rename.path, dest)
        await loadDir(dir)
      } catch (err) {
        toast(cleanIpcError(err), 'error')
      } finally {
        setRename(null)
      }
    },
    [rename, clearSelIfAffected, retargetPaths, loadDir, toast]
  )

  const doDelete = useCallback(
    async (node: FileNode): Promise<void> => {
      try {
        await trashD(node.path)
        dropFromClip(node.path)
        clearSelIfAffected(node.path)
        await loadDir(parentOf(node.path))
      } catch (err) {
        toast(cleanIpcError(err), 'error')
      }
    },
    [dropFromClip, clearSelIfAffected, loadDir, toast]
  )

  const bulkTrash = useCallback(
    async (items: SelItem[]): Promise<void> => {
      const dirs = new Set(items.map((i) => parentOf(i.path)))
      const { done, failed } = await runBulk(items, async (item) => {
        await trashD(item.path)
        dropFromClip(item.path)
        clearSelIfAffected(item.path)
      })
      await reloadDirs([...dirs])
      summaryToast('moved to Trash', done, failed)
    },
    [runBulk, dropFromClip, clearSelIfAffected, reloadDirs, summaryToast]
  )

  // T-133 — a delete request from a single row or a bulk selection. An OUTSIDE target always
  // routes through a confirm dialog first (it lives outside the workspace); an in-workspace target
  // goes straight to Trash (unchanged). `items` is already the trash payload.
  const requestDelete = useCallback(
    (items: SelItem[]): void => {
      if (items.length === 0) return
      if (items.some((i) => isOutside(i.path))) setDeleteConfirm(items)
      else if (items.length === 1)
        void doDelete({ name: nameOf(items[0].path), path: items[0].path, kind: items[0].kind })
      else void bulkTrash(items)
    },
    [doDelete, bulkTrash]
  )

  // E-016 — perform a move (drag-and-drop or Cut→Paste), retarget any open doc tabs to the final
  // path, and refresh the source + destination directories. `onCollision` is forwarded to fs.move
  // for the collision-dialog resolutions ('rename' / 'overwrite'); undefined only reaches here
  // once the caller has already confirmed there is no collision.
  const performMove = useCallback(
    async (src: string, dest: string, onCollision?: 'rename' | 'overwrite'): Promise<void> => {
      try {
        const finalRel = await moveD(src, dest, onCollision ? { onCollision } : undefined)
        dropFromClip(src)
        clearSelIfAffected(src)
        retargetPaths(src, finalRel)
        setExpanded((prev) => new Set(prev).add(parentOf(finalRel)))
        await reloadDirs([parentOf(src), parentOf(finalRel)])
      } catch (err) {
        toast(cleanIpcError(err), 'error')
      }
    },
    [dropFromClip, clearSelIfAffected, retargetPaths, setExpanded, reloadDirs, toast]
  )

  // E-016 — a move landed on an existing name: open the collision dialog. Stat both sides to
  // decide whether Overwrite is offered (files only).
  const openCollision = useCallback(async (src: string, destDir: string): Promise<void> => {
    const dest = joinRel(destDir, nameOf(src))
    let canOverwrite = false
    try {
      const [s, d] = await Promise.all([statD(src), statD(dest)])
      canOverwrite = s.isFile && d.isFile
    } catch {
      /* stat failure → no overwrite offered; rename/cancel still work */
    }
    setCollision({ src, dest, destDir, name: nameOf(src), canOverwrite })
  }, [])

  const pasteInto = useCallback(
    async (dir: string): Promise<void> => {
      if (!clip) return
      const paths = clip.paths
      // ONE item — unchanged E-012/E-016 behavior, move-collision dialog included.
      if (paths.length === 1) {
        const src = paths[0]
        const dest = joinRel(dir, nameOf(src))
        if (clip.op === 'cut') {
          if (await existsD(dest)) {
            void openCollision(src, dir)
            return
          }
          await performMove(src, dest)
          return
        }
        // Copy → duplicate on paste (copy is already collision-safe, no dialog needed).
        try {
          await copyD(src, dest)
          setExpanded((prev) => new Set(prev).add(dir))
          await loadDir(dir)
        } catch (err) {
          toast(cleanIpcError(err), 'error')
        }
        return
      }
      // E-018 MULTI — E-012 collision rules applied ITEM-WISE: copy renames itself around a
      // collision, move REFUSES one (counted as a failure; no per-item dialog, which would turn a
      // bulk paste into an interrogation). Failures never stop the run; one summary toast at the end.
      const op = clip.op
      const dirs = new Set<string>([dir])
      const { done, failed } = await runBulk(
        paths.map((p) => ({ path: p, kind: 'file' as const })),
        async (item) => {
          const dest = joinRel(dir, nameOf(item.path))
          if (op === 'copy') {
            await copyD(item.path, dest)
            return
          }
          const finalRel = await moveD(item.path, dest)
          retargetPaths(item.path, finalRel)
          clearSelIfAffected(item.path)
          dirs.add(parentOf(item.path))
        }
      )
      if (op === 'cut') setClip(null)
      setExpanded((prev) => new Set(prev).add(dir))
      await reloadDirs([...dirs])
      summaryToast(op === 'cut' ? 'moved' : 'copied', done, failed)
    },
    [
      clip,
      openCollision,
      performMove,
      setExpanded,
      loadDir,
      toast,
      runBulk,
      retargetPaths,
      clearSelIfAffected,
      reloadDirs,
      summaryToast
    ]
  )

  const moveTo = useCallback(
    async (src: string, destDir: string): Promise<void> => {
      if (!canDrop(src, destDir)) return
      const dest = joinRel(destDir, nameOf(src))
      if (await window.pomade.fs.exists(dest)) {
        void openCollision(src, destDir)
        return
      }
      await performMove(src, dest)
    },
    [openCollision, performMove]
  )

  // ── E-018: bulk actions (applied per item, continuing past failures) ─────────
  const filesOf = useCallback((items: SelItem[]): SelItem[] => items.filter((i) => i.kind === 'file'), [])

  // Every selected FILE becomes a REAL tab — bulk open bypasses the T-063 preview slot, which
  // would otherwise collapse the whole batch into one reused tab. Folders are skipped.
  const openInEditor = useCallback(
    (items: SelItem[]): void => {
      for (const item of filesOf(items)) {
        openDoc(
          { name: nameOf(item.path), path: item.path, ...(item.symlink ? { symlink: true } : {}) },
          { real: true }
        )
      }
    },
    [filesOf, openDoc]
  )

  const requestOpenInEditor = useCallback(
    (items: SelItem[]): void => {
      const files = filesOf(items)
      if (files.length === 0) return
      if (files.length > OPEN_MANY_CONFIRM_AT) {
        setOpenMany(files)
        return
      }
      openInEditor(files)
    },
    [filesOf, openInEditor]
  )

  // One reveal per DISTINCT parent folder (a selected folder reveals itself — the single-item
  // rule, applied item-wise), so N files in one folder open ONE Finder window.
  const bulkReveal = useCallback((items: SelItem[]): void => {
    const dirs = [...new Set(items.map((i) => (i.kind === 'dir' ? i.path : parentOf(i.path))))]
    for (const d of dirs) void window.pomade.app.openPath(d)
  }, [])

  // Copy path / Copy full path on a multi-selection resolve to the COMMON PARENT folder (locked
  // decision 3). '' means the workspace root itself — copied as '.' relative, as the absolute
  // workspace root full-path.
  const copySelectionPath = useCallback(
    (items: SelItem[], absolute: boolean): void => {
      const rel = commonParent(items.map((i) => i.path))
      if (absolute) copyToClipboard(rel ? `${wsRoot ?? ''}/${rel}` : wsRoot ?? '', 'Copied full path')
      else copyToClipboard(rel || '.', 'Copied path')
    },
    [copyToClipboard, wsRoot]
  )

  // T-133 — a paste must NEVER cross the inside/outside boundary (an outside clipboard pastes only
  // into an outside folder, and vice-versa). The clip is always uniformly inside OR outside (a
  // mixed multi-selection can't Cut/Copy), so compare the clip's space to the drop folder's. True
  // ⇒ the Paste item is disabled (never offered).
  const pasteBlocked = useCallback(
    (target: FileNode | null): boolean => {
      if (!clip || clip.paths.length === 0) return true
      return isOutside(targetDirFor(target)) !== isOutside(clip.paths[0])
    },
    [clip, targetDirFor]
  )

  // T-133 — a multi-selection that spans BOTH inside and outside the workspace: the mutating bulk
  // items (Cut/Copy/Paste/Move to Trash) are disabled for it — a single op can't straddle the two
  // fs doors. Non-mutating items (Open, Copy path, Reveal) stay enabled.
  const isMixedSelection = useCallback((items: SelItem[] | null): boolean => {
    if (!items || items.length === 0) return false
    const anyOut = items.some((i) => isOutside(i.path))
    const anyIn = items.some((i) => !isOutside(i.path))
    return anyOut && anyIn
  }, [])

  return {
    clip,
    setClip,
    prompt,
    setPrompt,
    rename,
    setRename,
    collision,
    setCollision,
    openMany,
    setOpenMany,
    deleteConfirm,
    setDeleteConfirm,
    openDoc,
    targetDirFor,
    copyToClipboard,
    dropFromClip,
    submitName,
    submitRename,
    requestDelete,
    performMove,
    pasteInto,
    moveTo,
    filesOf,
    openInEditor,
    requestOpenInEditor,
    bulkTrash,
    bulkReveal,
    copySelectionPath,
    pasteBlocked,
    isMixedSelection
  }
}
