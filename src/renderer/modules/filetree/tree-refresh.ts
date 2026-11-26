// Pomade — which loaded folders a watcher batch makes the tree re-read (T-273), and which loaded
// folders no watcher event can ever name (T-296). A folder's listing
// changes only when an entry appears in it, disappears from it, or is renamed (one of each), so a
// changed path matters only where its existence disagrees with the listing its parent shows. A
// write to a file the tree already lists changes nothing the tree shows and re-reads nothing.
// Existence, not the native event kind, decides: macOS reports a plain write as a rename. A path
// the tree hides (an ignored name) is never in a listing, so its writes re-read nothing either.

import { WATCH_IGNORE_NAMES } from '@shared/ignore-names'
import type { FileNode, FsChange } from '@shared/types'

const WATCH_SKIPPED = new Set(WATCH_IGNORE_NAMES)

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const within = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`)

/** The folders to re-read for `changes`, given the listings the tree holds (`loaded`, keyed by
 *  folder path) and its root paths. A root is re-read when the changed path is the root or one of
 *  its ancestors (the root may have appeared or vanished); a loaded folder at or under a path that
 *  no longer exists is re-read so the tree drops it. `hidden` says whether the tree hides a path
 *  from its folder's listing; such a path agrees with the listing whether it exists or not. */
export function foldersToReread(
  changes: readonly FsChange[],
  loaded: Readonly<Record<string, readonly FileNode[]>>,
  rootPaths: readonly string[],
  hidden: (path: string) => boolean = () => false
): Set<string> {
  const out = new Set<string>()
  for (const { path, exists } of changes) {
    for (const r of rootPaths) if (path && within(r, path)) out.add(r)
    const listing = loaded[parentOf(path)]
    if (listing && !hidden(path)) {
      const name = nameOf(path)
      const listed = listing.some((c) => c.name === name)
      if (listed !== exists) out.add(parentOf(path))
    }
    if (!exists) for (const folder of Object.keys(loaded)) if (within(folder, path)) out.add(folder)
  }
  return out
}

/** The `folders` that sit inside a folder on the watcher's skip-list (`node_modules`, `dist`, …)
 *  below their root: the watcher drops every change in them, so no batch ever names a path in
 *  their listings and the tree must re-read them on its own. Measured from the nearest root, since
 *  each root's watcher matches the skip-list on paths relative to that root; a root itself is never
 *  one. */
export function skipListFolders(folders: Iterable<string>, rootPaths: readonly string[]): string[] {
  const out: string[] = []
  for (const folder of folders) {
    let root: string | null = null
    for (const r of rootPaths) {
      const holds = r === '' ? !folder.startsWith('/') : within(folder, r)
      if (holds && (root === null || r.length > root.length)) root = r
    }
    if (root === null || folder === root) continue
    const rel = root === '' ? folder : folder.slice(root.length + 1)
    if (rel.split('/').some((seg) => WATCH_SKIPPED.has(seg))) out.push(folder)
  }
  return out
}
