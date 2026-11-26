// Pomade — filesystem mutation cores: collision-safe copy / move / duplicate (files and
// directories), the outside-workspace WRITE doors, and symlink-target resolution. Every op
// shares one set of collision / self-descendant / recoverable-trash internals so the in-workspace
// and outside-workspace paths cannot drift.

import { promises as fs } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path'
import { shell } from 'electron'

import type { LinkTarget } from '@shared/types'

import { abs, requireAbs, splitName, toRel } from './fs-shared'

export async function copyRecursive(srcAbs: string, destAbs: string): Promise<void> {
  const stat = await fs.stat(srcAbs)
  if (stat.isDirectory()) {
    await fs.mkdir(destAbs, { recursive: true })
    const entries = await fs.readdir(srcAbs, { withFileTypes: true })
    for (const entry of entries) {
      await copyRecursive(join(srcAbs, entry.name), join(destAbs, entry.name))
    }
  } else {
    await fs.mkdir(destAbs.slice(0, destAbs.lastIndexOf(sep)), { recursive: true })
    await fs.copyFile(srcAbs, destAbs)
  }
}

/** First non-existing "<stem> copy<ext>", "<stem> copy 2<ext>", … in `destDirAbs`. When
 *  `keepOriginalFirst`, try the plain "<stem><ext>" before adding the " copy" suffix
 *  (copy-to another folder keeps the name unless it collides; duplicate always suffixes). */
async function freeName(
  destDirAbs: string,
  stem: string,
  ext: string,
  keepOriginalFirst: boolean
): Promise<string> {
  const exists = async (candidate: string): Promise<boolean> => {
    try {
      await fs.access(join(destDirAbs, candidate))
      return true
    } catch {
      return false
    }
  }
  if (keepOriginalFirst) {
    const plain = `${stem}${ext}`
    if (!(await exists(plain))) return plain
  }
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`
    if (!(await exists(candidate))) return candidate
  }
}

/** Collision-safe file copy on ABSOLUTE paths. Copies the file at `srcAbs` into `destDirAbs`,
 *  refusing a non-file source, and returns the new file's ABSOLUTE path. `keepOriginalFirst` is
 *  false for duplicate (always " copy") and true for copy-to (keep the name unless it collides).
 *  Shared by the in-workspace `copyFileSafe` and the T-133 outside `duplicateOutside` door. */
async function copyFileSafeCore(
  srcAbs: string,
  destDirAbs: string,
  keepOriginalFirst: boolean
): Promise<string> {
  const st = await fs.stat(srcAbs)
  if (!st.isFile()) throw new Error('Only files can be copied here')
  await fs.mkdir(destDirAbs, { recursive: true })
  const { stem, ext } = splitName(basename(srcAbs))
  const finalName = await freeName(destDirAbs, stem, ext, keepOriginalFirst)
  const destAbs = join(destDirAbs, finalName)
  await fs.copyFile(srcAbs, destAbs)
  return destAbs
}

/** Copy `srcRel` into `destDirRel` (default: its own folder), collision-safe. Returns the
 *  new file's workspace-relative path. `keepOriginalFirst` is false for duplicate (always
 *  " copy") and true for copy-to (keep the name unless it collides). */
export async function copyFileSafe(
  root: string,
  srcRel: string,
  destDirRel: string,
  keepOriginalFirst: boolean
): Promise<string> {
  return toRel(root, await copyFileSafeCore(abs(srcRel), abs(destDirRel), keepOriginalFirst))
}

// ─── E-012: file-manager move / copy (files + directories) ─────────────────────
/** True when `destAbs` is `srcAbs` itself or lives inside it — moving/copying a directory
 *  into its own subtree, which would be nonsensical (and, for move, destructive). */
function isSelfOrDescendant(srcAbs: string, destAbs: string): boolean {
  return destAbs === srcAbs || destAbs.startsWith(srcAbs + sep)
}

/** Move a file OR directory between ABSOLUTE paths (the collision/self-guard logic; see
 *  `moveEntry` for the semantics). Returns the final ABSOLUTE destination path. Shared by the
 *  in-workspace `moveEntry` and the T-133 `moveOutside` door.
 *  E-016 — `onCollision` decides an existing destination: undefined ⇒ refuse (unchanged);
 *  'rename' ⇒ pick a collision-safe " copy" name (reuses freeName) and move there; 'overwrite'
 *  ⇒ replace a destination FILE with a source FILE (old file → OS trash for recoverability),
 *  refusing when either side is a directory. */
async function moveEntryCore(
  srcAbs: string,
  destAbsIn: string,
  onCollision?: 'rename' | 'overwrite'
): Promise<string> {
  let destAbs = destAbsIn
  if (destAbs === srcAbs) return destAbs // no-op
  if (isSelfOrDescendant(srcAbs, destAbs)) {
    throw new Error('Cannot move a folder into itself')
  }
  const collides = await fs
    .access(destAbs)
    .then(() => true)
    .catch(() => false)
  if (collides) {
    if (onCollision === 'rename') {
      const destDirAbs = dirname(destAbs)
      const name = basename(destAbs)
      const srcStat = await fs.stat(srcAbs)
      const { stem, ext } = srcStat.isDirectory() ? { stem: name, ext: '' } : splitName(name)
      // keepOriginalFirst: false — always suffix " copy" (the plain name is what collided).
      const finalName = await freeName(destDirAbs, stem, ext, false)
      destAbs = join(destDirAbs, finalName)
    } else if (onCollision === 'overwrite') {
      const [srcStat, destStat] = await Promise.all([fs.stat(srcAbs), fs.stat(destAbs)])
      if (srcStat.isDirectory() || destStat.isDirectory()) {
        throw new Error('Cannot overwrite a folder')
      }
      // Recoverable replace: the displaced file goes to the OS trash, never rm (the user's vault).
      await shell.trashItem(destAbs)
    } else {
      throw new Error(`A file named "${basename(destAbs)}" already exists`)
    }
  }
  await fs.mkdir(destAbs.slice(0, destAbs.lastIndexOf(sep)), { recursive: true })
  await fs.rename(srcAbs, destAbs)
  return destAbs
}

/** Move a file OR directory to `destRel`. Collision-refusing (never clobbers a sibling) and
 *  guarded against moving a directory into itself/descendant. A no-op move to the same path
 *  is allowed. Returns the new workspace-relative path. */
export async function moveEntry(
  root: string,
  srcRel: string,
  destRel: string,
  onCollision?: 'rename' | 'overwrite'
): Promise<string> {
  return toRel(root, await moveEntryCore(abs(srcRel), abs(destRel), onCollision))
}

/** Copy a file OR directory (recursive) between ABSOLUTE paths, collision-safe (see `copyEntry`
 *  for the semantics). Returns the new copy's ABSOLUTE path. Shared by the in-workspace
 *  `copyEntry` and the T-133 `copyOutside` door. */
async function copyEntryCore(srcAbs: string, destAbs: string): Promise<string> {
  const st = await fs.stat(srcAbs)
  const destDirAbs = dirname(destAbs)
  if (st.isDirectory() && isSelfOrDescendant(srcAbs, destDirAbs)) {
    throw new Error('Cannot copy a folder into itself')
  }
  await fs.mkdir(destDirAbs, { recursive: true })
  const name = basename(destAbs)
  const { stem, ext } = st.isDirectory() ? { stem: name, ext: '' } : splitName(name)
  const finalName = await freeName(destDirAbs, stem, ext, true)
  const finalAbs = join(destDirAbs, finalName)
  await copyRecursive(srcAbs, finalAbs)
  return finalAbs
}

/** Copy a file OR directory (recursive) toward `destRel`, collision-safe: if the destination
 *  exists the copy is renamed "<stem> copy<ext>" / "<stem> copy N<ext>" (a directory's whole
 *  name is the stem). Guarded against copying a directory into its own subtree. Returns the
 *  new workspace-relative path. */
export async function copyEntry(root: string, srcRel: string, destRel: string): Promise<string> {
  return toRel(root, await copyEntryCore(abs(srcRel), abs(destRel)))
}

// ─── T-133 (E-026): the outside-workspace WRITE doors ─────────────────────────
// The mutating analogue of the T-102 read/write door and the T-131 tree/watch door: full
// create/rename/delete/duplicate/move/copy INSIDE an explicitly-mounted outside subtree. Each
// takes ABSOLUTE path(s) via requireAbs — a relative token can never be laundered through them to
// sidestep the escape-refusing `abs()` guard, which stays in force for every in-workspace call.
// They reuse the exact same *Core internals as the in-workspace ops (identical collision /
// self-descendant / recoverable-trash semantics), so the two paths cannot drift. The renderer is
// what routes an absolute-path node here (matching T-102 — no main-side mount allowlist).
export async function createFileOutside(absPath: string): Promise<void> {
  const target = requireAbs(absPath)
  await fs.mkdir(dirname(target), { recursive: true })
  const handle = await fs.open(target, 'wx') // 'wx' — refuse to clobber an existing file
  await handle.close()
}

export async function createDirOutside(absPath: string): Promise<void> {
  await fs.mkdir(requireAbs(absPath), { recursive: true })
}

/** Rename the entry at `absPath` to a sibling `newName` (collision-refusing, like `rename`).
 *  Returns the new ABSOLUTE path. */
export async function renameOutside(absPath: string, newName: string): Promise<string> {
  const srcAbs = requireAbs(absPath)
  const destAbs = join(dirname(srcAbs), newName)
  if (destAbs !== srcAbs) {
    const collides = await fs
      .access(destAbs)
      .then(() => true)
      .catch(() => false)
    if (collides) throw new Error(`A file named "${newName}" already exists`)
    await fs.mkdir(dirname(destAbs), { recursive: true })
    await fs.rename(srcAbs, destAbs)
  }
  return destAbs
}

/** Duplicate the FILE at `absPath` next to itself as "<name> copy<ext>" (collision-safe). Returns
 *  the new ABSOLUTE path. Files only, mirroring the in-workspace `duplicate`. */
export async function duplicateOutside(absPath: string): Promise<string> {
  const srcAbs = requireAbs(absPath)
  return copyFileSafeCore(srcAbs, dirname(srcAbs), false)
}

/** Move a file OR directory between two ABSOLUTE paths (collision-refusing + self/descendant
 *  guarded). `onCollision` supports the collision dialog's 'rename'/'overwrite' resolutions,
 *  exactly as the in-workspace `move`. Returns the final ABSOLUTE path. */
export async function moveOutside(
  srcAbs: string,
  destAbs: string,
  onCollision?: 'rename' | 'overwrite'
): Promise<string> {
  return moveEntryCore(requireAbs(srcAbs), requireAbs(destAbs), onCollision)
}

/** Copy a file OR directory (recursive) between two ABSOLUTE paths, collision-safe. Returns the
 *  new copy's ABSOLUTE path. */
export async function copyOutside(srcAbs: string, destAbs: string): Promise<string> {
  return copyEntryCore(requireAbs(srcAbs), requireAbs(destAbs))
}

/** Send the entry at `absPath` to the OS trash (recoverable — never rm, matching `trash`). */
export async function trashOutside(absPath: string): Promise<void> {
  await shell.trashItem(requireAbs(absPath))
}

// ─── E-012 (final): resolve a symlink's target ────────────────────────────────
/** Resolve the symbolic link at `srcRel` to its FINAL target (chained links resolved once,
 *  via realpath). A broken link (realpath throws) falls back to the raw readlink text resolved
 *  against the link's own directory. `targetRel` is workspace-relative when the target lives
 *  inside the workspace, else null. */
export async function resolveLinkTarget(root: string, srcRel: string): Promise<LinkTarget> {
  // Canonicalize the root so the inside/outside test survives OS-level path aliasing — on macOS
  // realpath resolves /var → /private/var, so a raw `relative(root, realpath(...))` would wrongly
  // read every in-workspace target as "outside". Comparing two canonical paths avoids that.
  const canonRoot = await fs.realpath(root)
  const linkAbs = abs(srcRel)
  let targetAbs: string
  let exists: boolean
  try {
    // realpath follows the whole chain to the final on-disk target; fails on a broken link.
    targetAbs = await fs.realpath(linkAbs)
    exists = true
  } catch {
    // Broken link: realpath can't resolve it, so resolve the raw link text ourselves. A
    // relative link is resolved against the LINK's own (canonicalized) directory — POSIX symlink
    // semantics — keeping it comparable to canonRoot even though the target itself is missing.
    const linkText = await fs.readlink(linkAbs)
    const canonDir = await fs.realpath(dirname(linkAbs))
    targetAbs = isAbsolute(linkText) ? linkText : resolve(canonDir, linkText)
    exists = false
  }
  const rp = relative(canonRoot, targetAbs)
  const inside = !rp.startsWith('..') && !isAbsolute(rp)
  return { targetAbs, targetRel: inside ? rp.split(sep).join('/') : null, exists }
}
