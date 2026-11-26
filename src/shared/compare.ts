// Pomade — E-037: the comparison tab's model, shared by the tab type (persisted) and the pane.
// Pure. A comparison holds two sources; which kinds sit on which side decides the mode:
//
//   rev  ↔ file   version ↔ current   left read-only, right the live doc (editable)
//   rev  ↔ rev    version ↔ version   both read-only
//   disk ↔ file   file ↔ file, or the disk ↔ my edits of a rule-8 conflict (same path)
//   none ↔ rev    a file's first version (a root commit): left empty
//
// Sources are pluggable: Document history (E-038) added `draft`, local history (E-044) `snapshot`.

import type { SnapshotOrigin } from './local-history'

/** One side of a comparison. Paths are workspace-relative. */
export type CompareSource =
  /** A file at a commit (`rev` = a full hash, or `HEAD`). `path` is where the file is at that rev. */
  | { kind: 'rev'; repo: string; rev: string; path: string }
  /** The live document (the doc tab's buffer): editable on the right. */
  | { kind: 'file'; path: string }
  /** The file as it is on disk, read-only. */
  | { kind: 'disk'; path: string }
  /** A discarded draft of the doc (E-035's store), read-only; `at` = when it was discarded (ms). */
  | { kind: 'draft'; path: string; id: string; at: number }
  /** A local-history snapshot of the doc (E-044's store), read-only; `at` = when it was kept (ms),
   *  `from` = a rename's old path, `pathThen` = the path the doc had when this version was kept,
   *  set only when it is not `path` (a version from before a rename: the rename's own row and
   *  every older one). The snapshot itself is stored under `path`. */
  | {
      kind: 'snapshot'
      path: string
      id: string
      at: number
      origin: SnapshotOrigin
      from?: string
      pathThen?: string
    }
  /** No version (the file did not exist before). */
  | { kind: 'none' }

export type CompareMode = 'version-current' | 'version-version' | 'file-file' | 'disk-mine'

/** The size cap for either side (the editor's own cap). */
export const COMPARE_MAX_BYTES = 2 * 1024 * 1024

/** What a commit looks like on a side's label and in the title. */
export interface RevisionInfo {
  hash: string
  date: number
  subject: string
}

/** A file at a revision, as main reads it. `no-revision`: the revision does not resolve. */
export type RevisionFile =
  | { kind: 'text'; content: string; commit: RevisionInfo }
  | { kind: 'absent'; commit: RevisionInfo }
  | { kind: 'binary'; size: number; commit: RevisionInfo }
  | { kind: 'too-big'; size: number; commit: RevisionInfo }
  | { kind: 'no-revision' }

export function compareMode(left: CompareSource, right: CompareSource): CompareMode {
  if (right.kind === 'file') {
    if (left.kind === 'disk') return left.path === right.path ? 'disk-mine' : 'file-file'
    return 'version-current'
  }
  return 'version-version'
}

/** True when the right side is the live document (editable, shares the doc tab's buffer). */
export function rightIsLive(right: CompareSource): right is { kind: 'file'; path: string } {
  return right.kind === 'file'
}

/** The path a side shows ('' for `none`). */
export function sourcePath(s: CompareSource): string {
  return s.kind === 'none' ? '' : s.path
}

/** One identity per comparison: opening the same two sources again focuses the open tab. */
export function compareKey(left: CompareSource, right: CompareSource): string {
  return JSON.stringify([left, right])
}

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayLabel(ms: number, now: number): string {
  const d = new Date(ms)
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`
}

function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The tab title: `BACKLOG.md · Oct 12 ↔ now`, `links.md · Oct 11 ↔ Oct 12` (short hashes when the
 *  two dates read the same), `BACKLOG.md · disk ↔ my edits`, `a.md ↔ b.md`. `info` carries the
 *  commits of rev sides (left, right). */
export function compareTitle(
  left: CompareSource,
  right: CompareSource,
  info: { left?: RevisionInfo; right?: RevisionInfo },
  now: number
): string {
  const name = base(sourcePath(right) || sourcePath(left))
  const mode = compareMode(left, right)
  if (mode === 'disk-mine') return `${name} · disk ↔ my edits`
  if (mode === 'file-file') return `${base(sourcePath(left))} ↔ ${name}`
  const sideLabel = (r: RevisionInfo | undefined, s: CompareSource): string => {
    if (s.kind === 'draft') return `draft ${dayLabel(s.at, now)} ${clock(s.at)}`
    if (s.kind === 'snapshot') return `${dayLabel(s.at, now)} ${clock(s.at)}`
    if (s.kind === 'disk') return 'saved'
    if (s.kind === 'file') return 'now'
    return r ? dayLabel(r.date, now) : s.kind === 'rev' ? (s.rev === 'HEAD' ? 'HEAD' : s.rev.slice(0, 7)) : ''
  }
  if (mode === 'version-current') return `${name} · ${sideLabel(info.left, left)} ↔ now`
  if (left.kind === 'none') return `${name} · ${sideLabel(info.right, right)}`
  let l = sideLabel(info.left, left)
  let r = sideLabel(info.right, right)
  if (l === r && info.left && info.right) {
    l = info.left.hash.slice(0, 7)
    r = info.right.hash.slice(0, 7)
  }
  return `${name} · ${l} ↔ ${r}`
}
