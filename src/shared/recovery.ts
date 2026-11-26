// Pomade — E-035 (rule 8 "the file on disk is the truth" + unsaved-doc recovery): the shared
// types and the pure decisions behind them. Main (recovery-store) and the renderer (the editor's
// doc lifecycle) both import this module, so keying, staleness and pruning are decided in one
// place and pinned by vitest (recovery.unit.test.ts).

/** A doc's last moment of agreement with the disk: the file's mtime and a hash of its exact
 *  bytes-as-read. Pomade's own load, save and reload set it; anything else that changes the file
 *  (an agent, git, an app, another editor, Finder) moves the disk away from it. */
export interface SyncPoint {
  mtimeMs: number
  hash: string
}

/** One dirty buffer's recovery copy, in `<userData>/recovery/buffers/`. */
export interface RecoveryRecord {
  /** Absolute workspace root the doc belongs to. */
  workspace: string
  /** The doc's path (ws-relative, or absolute for an outside-workspace doc); '' for Untitled. */
  path: string
  /** The tab that holds the buffer — the Untitled doc's identity, informational for path docs. */
  tabId: string
  title: string
  content: string
  /** When the copy was taken (epoch ms) — the time the recovery banner shows. */
  savedAt: number
  /** The disk state the buffer was last in sync with; null for Untitled (no file). */
  base: SyncPoint | null
  /** The editing stretch this copy belongs to (see DiscardedDraft.id). */
  stretchId: string
}

export type DraftReason =
  | 'close'
  | 'quit'
  | 'recovery-discard'
  | 'load-disk'
  /** E-039 — the file's content when its changes were discarded from the Git panel. */
  | 'git-discard'
  /** E-039 — the staged version of such a file, when it differed from the file. */
  | 'git-discard-staged'
  /** T-226 — the document's text when a version tab replaced it and local history does not keep
   *  the file. */
  | 'replaced'

/** E-039 — a draft kept by a git discard (Document history lists it as a discarded change). */
export function isGitDiscard(reason: string): boolean {
  return reason === 'git-discard' || reason === 'git-discard-staged'
}

/** A discarded unsaved state, in `<userData>/recovery/drafts/`, kept DRAFT_TTL_MS. One per
 *  editing stretch: the id is the stretch id, so discarding the same stretch twice overwrites. */
export interface DiscardedDraft {
  id: string
  workspace: string
  path: string
  tabId: string
  title: string
  content: string
  discardedAt: number
  reason: DraftReason
  /** T-310 (git discards) — when the file was last restored from Document history after this
   *  discard; with a save since, the file counts as back. */
  restoredAt?: number
}

/** T-310 — a row of the Git panel's Discarded section: a file with kept git-discard copies whose
 *  content is not back. */
export interface DiscardedFile {
  path: string
  /** The newest discard. */
  at: number
  /** Kept copies. */
  count: number
}

/** T-310 — what decides whether a discarded file's row shows. */
export interface DiscardedFileState {
  /** The newest git discard of the file and its kept content. */
  latestAt: number
  kept: string
  /** The newest restore from Document history (any version), if any. */
  restoredAt?: number
  /** The file on disk now; null when it is gone. `content` is null when not read (too big). */
  file: { mtimeMs: number; content: string | null } | null
}

/** T-310 — a discarded file's row shows unless the file is back: it holds the kept copy, or it was
 *  restored from Document history after the newest discard and saved since. A file that is gone
 *  always shows. */
export function discardedRowShown(s: DiscardedFileState): boolean {
  if (!s.file) return true
  if (s.file.content !== null && s.file.content === s.kept) return false
  return !(s.restoredAt !== undefined && s.restoredAt >= s.latestAt && s.file.mtimeMs >= s.restoredAt)
}

/** What the renderer sends to store a recovery copy; main adds `workspace`. */
export type RecoveryPut = Omit<RecoveryRecord, 'workspace'>

/** What the renderer sends to keep a discarded draft; main adds `workspace` + `discardedAt`. */
export interface DraftPut {
  id: string
  path: string
  tabId: string
  title: string
  content: string
  reason: DraftReason
  /** The recovery copy to drop with it, when it is not the one under `path` (T-226: a version
   *  tab keeps its copy under `''` + its tab id, and its drafts under the document's path). */
  recoveryPath?: string
}

/** Recovery copies are taken this long after typing stops. */
export const RECOVERY_DEBOUNCE_MS = 2000

/** Discarded drafts are kept this long, then pruned on launch. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The doc half of a recovery key: the path, or `untitled:<tabId>` for an Untitled doc. */
export function docKeyOf(path: string, tabId: string): string {
  return path ? `path:${path}` : `untitled:${tabId}`
}

/** The full recovery key: workspace + doc. Two workspaces never share a copy. */
export function recoveryKey(workspace: string, path: string, tabId: string): string {
  return `${workspace}\n${docKeyOf(path, tabId)}`
}

/** cyrb53 — a fast, well-mixed 53-bit string hash. Not cryptographic: it tells "same bytes" from
 *  "changed bytes" for change detection and builds collision-resistant file names. Hex output. */
export function contentHash(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** The on-disk file name of a recovery key: two independently seeded hashes (106 bits) so
 *  distinct keys never share a file, and no path characters reach the file system. */
export function recoveryFileName(key: string): string {
  return `${contentHash(key, 1)}${contentHash(key, 2)}.json`
}

/** Disk state as observed now; null when the file does not exist. `hash` is only computed when
 *  the mtime alone can't settle the question (see syncVerdict). */
export interface DiskObservation {
  mtimeMs: number
  hash?: string
}

/** Has the disk moved away from the sync point?
 *  - 'in-sync'    — same mtime, or a different mtime over the same bytes (a touch, Pomade's own
 *                   write observed before its post-write stat landed, a checkout to identical
 *                   content). Bytes decide, never the clock alone.
 *  - 'needs-hash' — the mtime differs and no hash was supplied: read the file and ask again.
 *  - 'changed'    — another writer changed the bytes.
 *  - 'missing'    — the file is gone. */
export function syncVerdict(
  sync: SyncPoint,
  disk: DiskObservation | null
): 'in-sync' | 'needs-hash' | 'changed' | 'missing' {
  if (!disk) return 'missing'
  if (disk.mtimeMs === sync.mtimeMs) return 'in-sync'
  if (disk.hash === undefined) return 'needs-hash'
  return disk.hash === sync.hash ? 'in-sync' : 'changed'
}

/** On relaunch: does the recovered copy still sit on the disk state it was taken against?
 *  'recovered' shows the plain recovery banner; 'changed' shows the amber one. An Untitled copy
 *  (no base) and a vanished file (the missing notice covers it) are plain recoveries. */
export function recoveryVerdict(
  base: SyncPoint | null,
  diskHash: string | null
): 'recovered' | 'changed' {
  if (!base || diskHash === null) return 'recovered'
  return diskHash === base.hash ? 'recovered' : 'changed'
}

/** The drafts a launch-time prune deletes: discarded more than `ttlMs` before `now`. A draft
 *  with an unreadable timestamp is pruned too — nothing can tell its age. */
export function draftsToPrune<T extends Pick<DiscardedDraft, 'discardedAt'>>(
  drafts: T[],
  now: number,
  ttlMs = DRAFT_TTL_MS
): T[] {
  return drafts.filter((d) => !Number.isFinite(d.discardedAt) || now - d.discardedAt > ttlMs)
}

/** The drafts a purge from Settings deletes: discarded before `before` (epoch ms), and those with
 *  an unreadable timestamp. */
export function draftsBefore<T extends Pick<DiscardedDraft, 'discardedAt'>>(drafts: T[], before: number): T[] {
  return drafts.filter((d) => !Number.isFinite(d.discardedAt) || d.discardedAt < before)
}

/** "14:32" — the recovery banner's time, in the viewer's local clock. A copy from another day
 *  adds the date ("Nov 8, 14:32") so an old recovery never reads as today's. */
export function formatRecoveredAt(savedAt: number, now: number): string {
  const at = new Date(savedAt)
  const today = new Date(now)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  if (sameDay) return hhmm
  const month = at.toLocaleString('en-US', { month: 'short' })
  return `${month} ${at.getDate()}, ${hhmm}`
}
