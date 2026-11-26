// Pomade — shared path helpers. Project/workspace paths are ALWAYS stored workspace-relative
// (never absolute); the main process joins them onto the workspace root.

/**
 * Normalize a hand-typed workspace-relative path (T-064).
 *
 * A user typing `/sub/dir` means the same thing as `sub/dir` — a folder *inside* the
 * workspace — but a stored leading slash makes `path.resolve(root, "/sub/dir")` discard the
 * root (→ the file tree throws "escapes workspace" and renders empty), while
 * `path.join(root, "/sub/dir")` collapses it (→ Reveal-in-Finder still works). That divergence
 * is the bug. Normalizing the *input* removes it so both routes agree.
 *
 * - trims surrounding whitespace
 * - tolerates backslashes (treats them as separators)
 * - collapses repeated slashes
 * - drops leading slash(es): a typed absolute-looking path is interpreted relative to the root
 * - strips trailing slash(es)
 *
 * Returns '' for input that is empty or only slashes/whitespace (i.e. the workspace root).
 */
export function normalizeWorkspaceRelPath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, '/') // tolerate backslashes as separators
    .replace(/\/+/g, '/') // collapse repeated slashes (handles "//", "a//b")
    .replace(/^\/+/, '') // drop leading slash(es) → interpret as workspace-relative
    .replace(/\/+$/, '') // drop trailing slash(es)
    .trim()
}

/**
 * Where a doc lives relative to the project scope it is viewed in — the single source of the
 * scope-mark tier (orange/red triangle) and the editor header's path format.
 *
 * Project scope = the project's root folder plus its in-scope folders (`scopeFolders`: in-scope
 * mounts, and later app scope folders). Paths are stored workspace-relative; an ABSOLUTE path
 * (leading '/') means outside the workspace. A scope folder may be either form. The Workspace
 * project has rootPath '' — every workspace-relative path is in-project for it (its root IS the
 * workspace root).
 *
 * - 'in-project'        → path is under the project root or an in-scope folder (no triangle)
 * - 'outside-project'   → workspace-relative, outside the project scope (ORANGE triangle)
 * - 'outside-workspace' → an absolute path no in-scope folder covers (RED triangle)
 */
export type Scope = 'in-project' | 'outside-project' | 'outside-workspace'

/** True when `path` is `folder` itself or lies under it. A workspace-relative `folder` of ''
 *  (the workspace root) contains every workspace-relative path and no absolute one. */
export function isUnderFolder(path: string, folder: string): boolean {
  if (folder === '') return !path.startsWith('/')
  if (folder === '/') return path.startsWith('/')
  return path === folder || path.startsWith(`${folder}/`)
}

/** The deepest of `scopeFolders` that contains `path`, or null when none does. */
export function scopeFolderOf(path: string, scopeFolders: readonly string[]): string | null {
  let best: string | null = null
  for (const folder of scopeFolders) {
    if (isUnderFolder(path, folder) && (best === null || folder.length > best.length)) best = folder
  }
  return best
}

export function classifyScope(path: string, projectRoot: string, scopeFolders: readonly string[] = []): Scope {
  if (isUnderFolder(path, projectRoot)) return 'in-project'
  if (scopeFolderOf(path, scopeFolders) !== null) return 'in-project'
  return path.startsWith('/') ? 'outside-workspace' : 'outside-project'
}

/**
 * The editor header's short path for a doc in project scope, or null when the doc is outside it.
 * Under the project root: the path from the root (workspace-relative for the Workspace project).
 * Under an in-scope folder: `<folder name>/…`, from the deepest such folder; the folder name of the
 * workspace root ('') is the workspace folder's own name (`wsRoot`'s last segment).
 */
export function scopeRelativePath(
  path: string,
  projectRoot: string,
  scopeFolders: readonly string[],
  wsRoot: string | null
): string | null {
  if (isUnderFolder(path, projectRoot)) {
    return projectRoot && path.startsWith(`${projectRoot}/`) ? path.slice(projectRoot.length + 1) : path
  }
  const folder = scopeFolderOf(path, scopeFolders)
  if (folder === null) return null
  const name = (folder === '' ? (wsRoot ?? '') : folder).split('/').filter(Boolean).pop() ?? ''
  const rest = folder === '' ? path : path.slice(folder.length + 1)
  if (!name) return rest
  return rest ? `${name}/${rest}` : name
}

/**
 * A file-tree path for the canonical absolute `abs` under a tree root, or null when `abs` is not
 * under it. `root.path` is the root's tree path (workspace-relative, or absolute for a root outside
 * the workspace) and `root.canonAbs` its canonical absolute path (realpath, as `fs.probePath`
 * returns it), so a root typed as `/var/…` or through a symlink still matches the canonical target.
 */
export function treePathUnderRoot(abs: string, root: { path: string; canonAbs: string }): string | null {
  if (abs === root.canonAbs) return root.path
  const base = root.canonAbs === '/' ? '' : root.canonAbs
  if (!abs.startsWith(`${base}/`)) return null
  return joinTreePath(root.path, abs.slice(base.length + 1))
}

function joinTreePath(parent: string, name: string): string {
  if (parent === '') return name
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

/** The folders between a tree root and `path` (excluding both), outermost first — what a reveal
 *  loads and expands. `path` must lie under `rootPath` (see `isUnderFolder`). */
export function ancestorsWithin(path: string, rootPath: string): string[] {
  if (path === rootPath) return []
  const rel = rootPath === '' || rootPath.endsWith('/') ? path.slice(rootPath.length) : path.slice(rootPath.length + 1)
  const segs = rel.split('/')
  const out: string[] = []
  let cur = rootPath
  for (let i = 0; i < segs.length - 1; i++) {
    cur = joinTreePath(cur, segs[i])
    out.push(cur)
  }
  return out
}
