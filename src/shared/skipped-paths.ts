// Pomade — the workspace paths Pomade's watcher and index walks skip by path, never by name: the
// local-history stores (Pomade's own data) and the workspace's unwatched folders (Settings ▸ File
// tree). Pure: the caller passes the unwatched folders it holds.

import { isLocalHistoryStorePath } from './local-history'

const within = (rel: string, folder: string): boolean => rel === folder || rel.startsWith(`${folder}/`)

/** Is the workspace-relative `rel` one of `folders`, or inside one? */
export function isInFolders(rel: string, folders: readonly string[]): boolean {
  return folders.some((f) => within(rel, f))
}

/** Is the workspace-relative `rel` skipped — a local-history store or an unwatched folder, or
 *  inside one? */
export function isSkippedPath(rel: string, unwatched: readonly string[]): boolean {
  return isLocalHistoryStorePath(rel) || isInFolders(rel, unwatched)
}

/** A typed or picked folder as an unwatched-folders entry: workspace-relative, `/`-separated, no
 *  leading `./` or trailing `/`. Null for what cannot be one — empty, absolute, the workspace root
 *  itself, or a path that climbs out with `..`. */
export function normalizeUnwatchedFolder(raw: string): string | null {
  const parts = raw
    .trim()
    .split(/[/\\]+/)
    .filter((p) => p !== '' && p !== '.')
  if (raw.trim().startsWith('/') || /^[A-Za-z]:/.test(raw.trim())) return null
  if (parts.length === 0 || parts.includes('..')) return null
  return parts.join('/')
}
