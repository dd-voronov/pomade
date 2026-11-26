// Pomade (T-179) — the ONE basename/parent-split implementation for the renderer. Every prior
// reimplementation (TabStrip, tabs-store, SymlinkPopover, doc-kind, filetree's splitRootLabel) was
// the same `lastIndexOf('/')` arithmetic done five different ways; this module is now what they
// all delegate to.

/** The filename component of a path (workspace-relative or absolute). Returns the whole string
 *  when there is no `/` — including the empty string. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

/** The directory component of a path, with NO trailing slash (`''` when `path` has no `/`). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Split a path into a dimmed parent prefix (trailing slash kept, for direct display before the
 *  leaf) and the leaf name — e.g. for `<span>{parent}</span><span>{leaf}</span>` labels. */
export function splitPath(path: string): { parent: string; leaf: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { parent: '', leaf: path } : { parent: path.slice(0, i + 1), leaf: path.slice(i + 1) }
}
