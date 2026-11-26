// Pomade — the open workspace's skipped paths, live: the local-history stores and the unwatched
// folders (`WorkspaceConfig.fileTree.unwatched`). config-store sets the list when a workspace
// activates and on every save of its config; the watcher, the name index and the index walks read
// it on each event, so an edit in Settings applies at once. No imports beyond `@shared`: every
// fs module can read it without an import cycle.

import { isInFolders, isSkippedPath } from '@shared/skipped-paths'

let unwatched: readonly string[] = []

/** Told the folders that entered (`added`) and left (`removed`) the list. */
type UnwatchedListener = (added: readonly string[], removed: readonly string[]) => void
const listeners = new Set<UnwatchedListener>()

/** Replace the unwatched folders; listeners hear the difference (nothing when there is none). */
export function setUnwatchedFolders(next: readonly string[]): void {
  const added = next.filter((f) => !unwatched.includes(f))
  const removed = unwatched.filter((f) => !next.includes(f))
  unwatched = [...next]
  if (added.length === 0 && removed.length === 0) return
  for (const fn of [...listeners]) {
    try {
      fn(added, removed)
    } catch (err) {
      console.error('[skipped-paths] listener failed', err)
    }
  }
}

/** Hear every change to the unwatched folders. Returns the unsubscribe. */
export function onUnwatchedChanged(fn: UnwatchedListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The unwatched folders, as listed (workspace-relative). */
export function unwatchedFolders(): readonly string[] {
  return unwatched
}

/** Is the workspace-relative `rel` an unwatched folder, or inside one? */
export function isUnwatchedRel(rel: string): boolean {
  return isInFolders(rel, unwatched)
}

/** Is the workspace-relative `rel` skipped by path — a local-history store or an unwatched folder,
 *  or inside one? */
export function isSkippedRel(rel: string): boolean {
  return isSkippedPath(rel, unwatched)
}
