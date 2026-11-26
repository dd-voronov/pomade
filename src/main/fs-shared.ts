// Pomade — shared filesystem primitives for the main-process fs subsystem: the bounded-concurrency
// workspace walk both indexes share (its ignore lists live in `shared/ignore-names.ts`). Everything here is pure or
// config-derived — no mutable module state. The workspace-escape guard itself (requireRoot/abs/
// requireAbs/toRel) lives in `ws-path.ts` — re-exported here so the fs subsystem's existing
// imports don't all need to move.

import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'

import { INDEX_WALK_CONCURRENCY } from '@shared/ignore-names'
import { isSkippedRel } from './skipped-paths'
import { toRel } from './ws-path'

export { requireRoot, abs, requireAbs, toRel } from './ws-path'

/** Is the absolute `absPath` skipped by path in the workspace `root` — a local-history store or an
 *  unwatched folder, or inside one (`./skipped-paths`)? Matched by workspace-relative path, never
 *  by name, by every walk and watcher of the workspace, so a user's own folder called
 *  `local-history` (or one named like an unwatched folder elsewhere) is still walked. */
export function isSkippedAbs(root: string, absPath: string): boolean {
  return isSkippedRel(toRel(root, absPath))
}

// ─── E-001 (T-010): collision-safe file copies ────────────────────────────────
/** Split "notes.md" → { stem: 'notes', ext: '.md' }; a leading-dot file (".zshrc") is
 *  treated as all-stem (no ext) so a dotfile copy stays ".zshrc copy". */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

// ─── T-091: one ignore list + one bounded-concurrency walk for BOTH indexes ────
// Pomade performs two whole-workspace walks: the frontmatter index (E-014) and the terminal
// name index (E-020). Both used to descend into build outputs, virtualenvs and vendored trees:
// on real git-base that is 110k files of which ~90k are junk (`.repo` 40.6k, `target/` 19.4k,
// venvs, `dist/out/build`…), and a fully serialized walk of it cost ~2 s per build.

export { INDEX_IGNORE_NAMES, INDEX_WALK_CONCURRENCY, WATCH_IGNORE_NAMES } from '@shared/ignore-names'

async function readDirSafe(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null // unreadable directory — skip it; both indexes are best-effort
  }
}

/** Level-by-level, bounded-concurrency directory walk from `root`. `visit` is called once per
 *  readable, non-ignored directory with that directory's raw entries. A symlinked directory is
 *  reported as an entry but never descended into (`Dirent.isDirectory()` is lstat-based), which
 *  is what keeps the walk cycle-safe — same rule as `buildTree`. */
export async function walkWorkspace(
  root: string,
  ignore: Set<string>,
  visit: (dirAbs: string, entries: Dirent[]) => void,
  /** The workspace root, when `root` lies in one: its skipped paths (`isSkippedAbs`) are never
   *  visited, never listed among their parent's entries. */
  workspaceRoot?: string
): Promise<void> {
  let level = [root]
  while (level.length > 0) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += INDEX_WALK_CONCURRENCY) {
      const batch = level.slice(i, i + INDEX_WALK_CONCURRENCY)
      const reads = await Promise.all(batch.map(readDirSafe))
      for (let k = 0; k < batch.length; k++) {
        const read = reads[k]
        if (!read) continue
        const ws = workspaceRoot
        const entries = ws === undefined ? read : read.filter((e) => !isSkippedAbs(ws, join(batch[k], e.name)))
        visit(batch[k], entries)
        for (const entry of entries) {
          if (ignore.has(entry.name)) continue
          if (entry.isDirectory()) next.push(join(batch[k], entry.name))
        }
      }
    }
    level = next
  }
}

/** True when any segment of a workspace-relative path is an ignored name. Used to drop watcher
 *  events for trees the index never walked in the first place. */
export function hasIgnoredSegment(relPath: string, ignore: Set<string>): boolean {
  for (const seg of relPath.split(/[/\\]/)) {
    if (ignore.has(seg)) return true
  }
  return false
}
