// Pomade — E-038: Document history's model. One list per document, newest first, built from
// pluggable row sources; each row is a version of the doc that can be compared with it and
// restored. Pure: no I/O, no React.
//
//   buildHistoryRows(sources)    the sources → the ordered rows
//   groupRows(rows)              the rows → their groups, in list order, empty groups left out
//   currentRow(rows)             the row that is what the editor holds now
//   rowSource(row, ctx)          the comparison source a row stands for (its version)
//   rowVsCurrent(row, ctx)       what a click on the row compares with the current doc
//   earlierPath(row, ctx)        the other path a row's version was kept under, or null
//   orderPair(rows, a, b)        two picked rows → [older, newer], by time
//   versionTime(ms, now)         `Nov 8 14:32`
//
// Row kinds, in list order, and their group (`ROW_GROUP`):
//   unsaved   the buffer, only while dirty — saved ↔ unsaved                         Current
//   saved     the file on disk, whenever it exists; absorbs the newest local        Current
//             version when that holds the same text, and says where git stands
//   draft     a discarded draft (E-035), newest first                               Discarded
//   discarded what the file held when its changes were discarded from the Git panel   Discarded
//   snapshot  a local-history version (E-044), newest first                         Local versions
//   commit    a commit that touched the file, renames followed, git's order         Commits
// A new source adds a kind here and a group.

import type { CompareSource } from './compare'
import type { FileCommit } from './git-history'
import { formatBytes, type SnapshotOrigin, type SnapshotRef } from './local-history'
import { isGitDiscard } from './recovery'

export type HistoryRow =
  | { kind: 'unsaved'; id: 'unsaved' }
  | { kind: 'draft'; id: string; draftId: string; at: number; reason: string }
  /** E-039 — a discard from the Git panel kept this content (`staged`: the staged version). */
  | { kind: 'discarded'; id: string; draftId: string; at: number; staged: boolean }
  /** The file on disk. `at` = the absorbed local version's time, else the file's modified time;
   *  `snapshot` = that absorbed version (its row left Local versions). */
  | {
      kind: 'saved'
      id: 'saved'
      at: number
      size: number
      git: SavedGit
      snapshot?: { snapshotId: string; origin: SnapshotOrigin }
    }
  | { kind: 'commit'; id: string; commit: FileCommit }
  /** E-044 — a version kept when the file's content changed on disk. A rename's (origin
   *  'renamed') carries the old path, and `sameText` when it holds what the version below it held.
   *  `pathThen` = the path the file had when the version was kept, set from the nearest rename at
   *  or above it (a rename's row stands for the file as it was under its old name). */
  | {
      kind: 'snapshot'
      id: string
      snapshotId: string
      at: number
      origin: SnapshotOrigin
      size: number
      from?: string
      sameText?: boolean
      pathThen?: string
    }

export type HistoryRowKind = HistoryRow['kind']

/** Where the saved file stands against git: not what the last commit holds (`from` = the path it
 *  was renamed from), the same as the newest commit that touched it, or no git to say (outside a
 *  repo, or a file no listed commit holds). */
export type SavedGit =
  | { state: 'changed'; isNew: boolean; from?: string }
  | { state: 'committed'; hash: string }
  | { state: 'none' }

/** The panel's groups, in list order. Each has a sub-header and folds on its own. */
export const HISTORY_GROUPS = ['current', 'discarded', 'local', 'commits'] as const
export type HistoryGroup = (typeof HISTORY_GROUPS)[number]

export const ROW_GROUP: Record<HistoryRowKind, HistoryGroup> = {
  unsaved: 'current',
  saved: 'current',
  draft: 'discarded',
  discarded: 'discarded',
  snapshot: 'local',
  commit: 'commits'
}

/** A group's sub-header. */
export const GROUP_TITLE: Record<HistoryGroup, string> = {
  current: 'Current',
  discarded: 'Discarded',
  local: 'Local versions',
  commits: 'Commits'
}

export function isHistoryGroup(v: unknown): v is HistoryGroup {
  return typeof v === 'string' && (HISTORY_GROUPS as readonly string[]).includes(v)
}

/** The group ids a saved `docHistoryFolded` names, each read as today's: `changes` is `current`. */
const FOLDED_ALIAS: Record<string, HistoryGroup> = { changes: 'current' }

export function foldedGroups(saved: readonly string[]): HistoryGroup[] {
  const out = saved.map((g) => FOLDED_ALIAS[g] ?? g).filter(isHistoryGroup)
  return [...new Set(out)]
}

/** The saved fold list with `group` folded or unfolded; an alias of the group goes with it. */
export function withGroupFolded(saved: readonly string[], group: string, folded: boolean): string[] {
  const rest = saved.filter((g) => g !== group && FOLDED_ALIAS[g] !== group)
  return folded ? [...rest, group] : rest
}

/** The rows by group, in list order; a group with no row is left out. */
export function groupRows(rows: readonly HistoryRow[]): { group: HistoryGroup; rows: HistoryRow[] }[] {
  return HISTORY_GROUPS.map((group) => ({ group, rows: rows.filter((r) => ROW_GROUP[r.kind] === group) })).filter(
    (g) => g.rows.length > 0
  )
}

/** A discarded draft as the list needs it (the content stays in the store until restored). */
export interface DraftRef {
  id: string
  discardedAt: number
  reason: string
}

/** The file on disk as the list needs it. `hash` = its text's local-history content hash
 *  (`blobHash`), null when it was not read (too big, binary). */
export interface DiskFile {
  mtime: number
  size: number
  hash: string | null
}

export interface HistorySources {
  /** The buffer differs from the saved file. */
  dirty: boolean
  /** The file on disk; null when there is none (an Untitled document). */
  disk: DiskFile | null
  /** The document is in a repo. */
  inRepo: boolean
  /** The saved file differs from HEAD, in a repo; null otherwise. */
  saved: { isNew: boolean; from?: string } | null
  drafts: readonly DraftRef[]
  commits: readonly FileCommit[]
  /** E-044 — the file's local-history snapshots. */
  snapshots: readonly SnapshotRef[]
}

/** The rows, in list order, group by group: unsaved and the saved file; drafts (newest first),
 *  then discarded changes (newest first); the snapshots, newest first; the commits, in the order
 *  git gave them. A draft kept by a git discard (`isGitDiscard` reason) is a discarded-change row.
 *  The saved row takes the newest snapshot's place when that holds the disk's text — one row, not
 *  two, for one text; a rename's snapshot stays (it stands for the file under its old name). */
export function buildHistoryRows(src: HistorySources): HistoryRow[] {
  const rows: HistoryRow[] = []
  if (src.dirty) rows.push({ kind: 'unsaved', id: 'unsaved' })
  const snaps = [...src.snapshots].sort((a, b) => b.at - a.at)
  const absorbed =
    src.disk && src.disk.hash !== null && snaps[0]?.hash === src.disk.hash && snaps[0].origin !== 'renamed'
      ? snaps[0]
      : null
  if (src.disk) rows.push(savedRow(src, src.disk, absorbed))
  const newest = [...src.drafts].sort((a, b) => b.discardedAt - a.discardedAt)
  for (const d of newest) {
    if (isGitDiscard(d.reason)) continue
    rows.push({ kind: 'draft', id: `draft:${d.id}`, draftId: d.id, at: d.discardedAt, reason: d.reason })
  }
  for (const d of newest) {
    if (!isGitDiscard(d.reason)) continue
    rows.push({ kind: 'discarded', id: `discarded:${d.id}`, draftId: d.id, at: d.discardedAt, staged: d.reason === 'git-discard-staged' })
  }
  let pathThen: string | undefined
  snaps.forEach((s, i) => {
    if (s.origin === 'renamed' && s.from) pathThen = s.from
    if (s === absorbed) return
    const row = snapshotRow(s, snaps[i + 1])
    rows.push(pathThen && row.kind === 'snapshot' ? { ...row, pathThen } : row)
  })
  for (const c of src.commits) rows.push({ kind: 'commit', id: `commit:${c.hash}`, commit: c })
  return rows
}

function savedRow(src: HistorySources, disk: DiskFile, absorbed: SnapshotRef | null): HistoryRow {
  const git: SavedGit = src.saved
    ? { state: 'changed', isNew: src.saved.isNew, ...(src.saved.from ? { from: src.saved.from } : {}) }
    : src.inRepo && src.commits.length > 0
      ? { state: 'committed', hash: src.commits[0].hash }
      : { state: 'none' }
  return {
    kind: 'saved',
    id: 'saved',
    at: absorbed ? absorbed.at : disk.mtime,
    size: disk.size,
    git,
    ...(absorbed ? { snapshot: { snapshotId: absorbed.id, origin: absorbed.origin } } : {})
  }
}

/** The row that is what the editor holds now: the unsaved edits while dirty, else the saved file. */
export function currentRow(rows: readonly HistoryRow[]): HistoryRow | null {
  return rows.find((r) => r.kind === 'unsaved') ?? rows.find((r) => r.kind === 'saved') ?? null
}

function snapshotRow(s: SnapshotRef, older: SnapshotRef | undefined): HistoryRow {
  const row: HistoryRow = { kind: 'snapshot', id: `snapshot:${s.id}`, snapshotId: s.id, at: s.at, origin: s.origin, size: s.size }
  if (s.origin !== 'renamed') return row
  return { ...row, ...(s.from ? { from: s.from } : {}), sameText: older?.hash === s.hash }
}

/** When a row's version was made, for ordering a picked pair: the buffer is the newest, the saved
 *  file next, every other row at its own time (a commit at its author date). */
export function rowTime(row: HistoryRow): number {
  switch (row.kind) {
    case 'unsaved':
      return Number.POSITIVE_INFINITY
    case 'saved':
      return Number.MAX_VALUE
    case 'draft':
    case 'discarded':
    case 'snapshot':
      return row.at
    case 'commit':
      return row.commit.date
  }
}

/** Where a doc's versions are read from. */
export interface HistoryContext {
  /** The doc's ws-relative (or absolute) path. */
  path: string
  /** The owning repo's ws-relative root; null outside any repo. */
  repo: string | null
}

/** The version a row stands for, as a comparison source. The unsaved row is the live document. */
export function rowSource(row: HistoryRow, ctx: HistoryContext): CompareSource {
  switch (row.kind) {
    case 'unsaved':
      return { kind: 'file', path: ctx.path }
    case 'draft':
    case 'discarded':
      return { kind: 'draft', path: ctx.path, id: row.draftId, at: row.at }
    case 'saved':
      return { kind: 'disk', path: ctx.path }
    case 'snapshot': {
      const pathThen = earlierPath(row, ctx)
      return {
        kind: 'snapshot',
        path: ctx.path,
        id: row.snapshotId,
        at: row.at,
        origin: row.origin,
        ...(row.from ? { from: row.from } : {}),
        ...(pathThen ? { pathThen } : {})
      }
    }
    case 'commit':
      return { kind: 'rev', repo: ctx.repo ?? '', rev: row.commit.hash, path: row.commit.path }
  }
}

/** The path a row's version was kept under when it is not the document's path now (a local version
 *  from before a rename); null otherwise. Restore of such a version renames the document back. */
export function earlierPath(row: HistoryRow, ctx: HistoryContext): string | null {
  if (row.kind !== 'snapshot' || !row.pathThen || row.pathThen === ctx.path) return null
  return row.pathThen
}

/** The Saved row's second line, short enough to show whole at the panel's default width. */
export function savedMeta(row: Extract<HistoryRow, { kind: 'saved' }>): string {
  const git = row.git
  switch (git.state) {
    case 'changed':
      if (git.isNew) return 'new file · not committed'
      if (git.from) return `renamed from ${baseOf(git.from)} · not committed`
      return 'not committed'
    case 'committed':
      return `same as ${git.hash.slice(0, 7)}`
    case 'none':
      return `local version · ${formatBytes(row.size)}`
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** How an earlier path reads next to the document's: its name in the same folder, the full
 *  workspace path in another. */
export function earlierName(earlier: string, path: string): string {
  return dirOf(earlier) === dirOf(path) ? baseOf(earlier) : earlier
}

/** Restore's confirm for a version kept under another path. */
export function restoreUnderQuestion(path: string, earlier: string): string {
  return `Restore ${baseOf(path)} as it was, under its earlier name ${earlierName(earlier, path)}?`
}

/** Restore's confirm, second line: what happens to the text. */
export const RESTORE_UNDER_DETAIL =
  'The document is renamed back and this version’s text goes into the editor as an unsaved edit.'

/** Restore refused: another file holds the earlier path. */
export function restoreUnderTaken(path: string, earlier: string): string {
  return `Can’t restore under ${earlierName(earlier, path)} — a file with that name is already there. Rename or move that file first.`
}

/** What a click on a row opens: [left, right]. The right side is always the current document. The
 *  unsaved row compares the saved file with the buffer; the saved row, while not committed,
 *  compares the last commit with the doc (a renamed file from its old name); every other row —
 *  the saved row too, once committed or outside a repo — compares its version with the doc. */
export function rowVsCurrent(row: HistoryRow, ctx: HistoryContext): [CompareSource, CompareSource] {
  const current: CompareSource = { kind: 'file', path: ctx.path }
  if (row.kind === 'saved' && row.git.state === 'changed') {
    return [{ kind: 'rev', repo: ctx.repo ?? '', rev: 'HEAD', path: row.git.from ?? ctx.path }, current]
  }
  return [rowSource(row, ctx), current]
}

/** Two picked rows, older first — by `rowTime`, so a pair across groups is ordered by when each
 *  version was made; at a tie the lower row in the list is the older. */
export function orderPair(rows: readonly HistoryRow[], a: string, b: string): [HistoryRow, HistoryRow] | null {
  const ia = rows.findIndex((r) => r.id === a)
  const ib = rows.findIndex((r) => r.id === b)
  if (ia < 0 || ib < 0 || ia === ib) return null
  const ta = rowTime(rows[ia])
  const tb = rowTime(rows[ib])
  const aOlder = ta === tb ? ia > ib : ta < tb
  return aOlder ? [rows[ia], rows[ib]] : [rows[ib], rows[ia]]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Nov 8 14:32`, with the year when it is not `now`'s (`Nov 8, 2025 14:32`). */
export function versionTime(ms: number, now: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `, ${d.getFullYear()}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${hh}:${mm}`
}

/** Why a draft was discarded, for its row's second line. */
export function draftReasonLabel(reason: string): string {
  switch (reason) {
    case 'close':
      return 'closed without saving'
    case 'quit':
      return 'quit without saving'
    case 'recovery-discard':
      return 'recovered edits discarded'
    case 'load-disk':
      return 'replaced by the disk version'
    case 'replaced':
      return 'replaced by an earlier version'
    default:
      return 'discarded'
  }
}

/** Under a doc outside any repo's list: what is missing and when it appears. */
export const NO_REPO_LINE = 'Git history appears when this file is in a repository.'

/** A list with no row at all (a doc in a repo with no saved or committed version yet). */
export const EMPTY_LINE = 'No earlier versions of this file yet.'
