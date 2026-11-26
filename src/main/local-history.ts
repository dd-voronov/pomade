// Pomade — E-044: local history. A snapshot of every project text file each time its content
// changes on disk — Pomade's own save or any other writer — kept 7 days in the workspace's store.
//
//   Trigger     the platform watcher's tap (fs-watch.ts — one held recursive descriptor on the
//               workspace root, covering every project, never a watcher of its own). An event only
//               touches the path's quiet window (local-history-scheduler.ts); nothing is read
//               until the path has been quiet, and at most WORKERS files are processed at once.
//   Filter      cheap name rules first (shared/local-history.ts: binary extensions, node_modules,
//               .git…), then the version rule (`versionRule`): a document open in the Editor
//               (doc-watch.ts's open set) or an extension in `Always keep every change for` gets
//               every change; an extension in `Never keep versions of` is a streaming file — its
//               events are dropped before the quiet window; any other file is subject to the burst
//               rule. Then one stat (not a file, over 2 MB, empty, or the same mtime + size as last
//               time: stop); a streaming file (`StreamingFiles`) stops here unread — a new stat
//               keeps it streaming. Then the read (a NUL byte or invalid UTF-8: stop), the hash
//               against the path's newest snapshot (same content: stop, no burst counted), then
//               one burst under the burst rule (more than 12 within an hour → streaming: no
//               versions until an hour of quiet; its versions stay), and only for genuinely new
//               content `git check-ignore` (ignored by git: stop). Pomade's own
//               saves, moves and keep-now requests skip the version rule: they are always kept.
//               The two lists are app settings, applied the moment they are saved.
//   Origin      Pomade's own save calls `noteSaved` right after its write succeeded; a snapshot
//               whose content is exactly that save is 'saved'. A rename or move — Pomade's own
//               (`noteMoved`), or a file that appears holding exactly the newest snapshot of a path
//               that no longer exists (a terminal `mv`, `git mv`) — carries the old path's snapshots
//               to the new one and keeps a 'renamed' snapshot naming the old path. Every other one
//               is 'disk'.
//   Storage     local-history-store.ts in the active workspace's `Apps/Pomade/local-history/`
//               (`Apps/Pomade/dev/local-history/` for a dev build); the store follows a workspace
//               switch.
//   Limits      the store's size cap is the setting `localHistoryCapMb` (a lower one prunes at
//               once); Settings' Delete purges one group — the Local versions here, or the
//               Discarded drafts in recovery-store — kept before a moment, previewed first.
//
// A file that did not change while Pomade ran has no snapshot: nothing walks the workspace.

import { app, type IpcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { CH, EV } from '@shared/ipc-api'
import {
  SNAPSHOT_MAX_FILE_BYTES,
  STREAMING_BURSTS,
  STREAMING_WINDOW_MS,
  blobHash,
  capBytesOf,
  isTrackablePath,
  localHistoryStoreDir,
  looksBinary,
  pathBeforeMove,
  versionRule,
  type PurgeGroup,
  type PurgePreview,
  type RemovalSize,
  type VersionLists,
  type VersionRule
} from '@shared/local-history'
import { DEFAULT_LOCAL_HISTORY_ALWAYS, DEFAULT_LOCAL_HISTORY_NEVER, type AppSettings } from '@shared/types'

import { buildFlavor } from './app-settings-files'
import { configStore, onAppSettingsChanged, onWorkspaceReady, onWorkspaceTeardown } from './config-store'
import { isDocOpen } from './doc-watch'
import { holdAppWatch, releaseAppWatch, tapWorkspaceChanges, type RawWorkspaceChange } from './fs-watch'
import { GIT_READ_ENV } from './git-state'
import { defineHandler } from './ipc'
import { LocalHistoryStore } from './local-history-store'
import { PathScheduler, StreamingFiles } from './local-history-scheduler'
import { measureDrafts, purgeDrafts } from './recovery-store'
import { tunedMs } from './test-tuning'
import { abs, requireRoot } from './ws-path'
import { safeBroadcast } from './windows'

const execFileP = promisify(execFile)

/** A path is snapshotted once its events have been quiet this long. */
const DEBOUNCE_MS = tunedMs('POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS', 1500)
/** …or this long after its first event when they never go quiet. */
const MAX_WAIT_MS = tunedMs('POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS', 20_000)
/** Files read and hashed at once. */
const WORKERS = 2
/** Distinct paths waiting at once; further ones in a burst are dropped. */
const PENDING_LIMIT = 2000
/** The first prune runs this long after launch, then hourly. */
const PRUNE_DELAY_MS = tunedMs('POMADE_TEST_LOCAL_HISTORY_PRUNE_DELAY_MS', 30_000)
const PRUNE_EVERY_MS = 60 * 60 * 1000
const STAT_CACHE_LIMIT = 5000
const OWN_WRITES_LIMIT = 1000

/** The active workspace's store. */
let store: LocalHistoryStore | null = null
let scheduler: PathScheduler | null = null
let untap: (() => void) | null = null
let heldKey: string | null = null
let workspace: string | null = null
let pruneTimer: NodeJS.Timeout | null = null

/** path → `mtimeMs:size` of the last file state that was looked at (kept or deliberately skipped). */
const seen = new Map<string, string>()
/** path → when its "ignored by git" verdict stops being trusted: an ignored file that is written
 *  all the time costs one `git check-ignore` a minute, not one per write. */
const ignoredUntil = new Map<string, number>()
const IGNORED_TRUST_MS = 60_000
/** path → hash of the content Pomade's own last save wrote there. */
const ownWrites = new Map<string, string>()
/** Pomade's own recent renames and moves, newest last: a file found at (or under) `to` before
 *  `until` arrived from `from` — its next snapshot is the 'renamed' one. */
const moves: { from: string; to: string; until: number; arrived: Set<string> }[] = []
const MOVE_TRUST_MS = 60_000
const MOVES_LIMIT = 200
/** Paths whose next job is Pomade's own save or move: kept whatever the version rule says. */
const forced = new Set<string>()
/** The settings `Always keep every change for` / `Never keep versions of`. */
let lists: VersionLists = { always: DEFAULT_LOCAL_HISTORY_ALWAYS, never: DEFAULT_LOCAL_HISTORY_NEVER }
/** The setting `localHistoryCapMb`, in bytes. */
let capSetting = capBytesOf(undefined)
const streaming = new StreamingFiles({ bursts: STREAMING_BURSTS, windowMs: STREAMING_WINDOW_MS, limit: STAT_CACHE_LIMIT })

function strings(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : fallback
}

/** `changed`: the user just saved a setting (not the workspace's settings being loaded) — a lower
 *  cap then prunes at once; at load the cap waits for the scheduled prune, off the startup path. */
function applySettings(settings: AppSettings, changed: boolean): void {
  lists = {
    always: strings(settings.localHistoryAlways, DEFAULT_LOCAL_HISTORY_ALWAYS),
    never: strings(settings.localHistoryNever, DEFAULT_LOCAL_HISTORY_NEVER)
  }
  const before = capBytes()
  capSetting = capBytesOf(settings.localHistoryCapMb)
  const cap = capBytes()
  if (cap === before || !store) return
  store.setCap(cap)
  // A lower cap applies at once: the oldest versions over it go now, not at the next hourly prune.
  if (changed && cap < before) void pruneNow().catch(() => undefined)
}

function ruleFor(rel: string): VersionRule {
  return versionRule(rel, lists, isDocOpen(rel))
}

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/** The store's size cap: the setting, or the test hook `POMADE_TEST_LOCAL_HISTORY_CAP_BYTES` over it. */
function capBytes(): number {
  const raw = Number(process.env['POMADE_TEST_LOCAL_HISTORY_CAP_BYTES'])
  return Number.isFinite(raw) && raw > 0 ? raw : capSetting
}

/** Open `root`'s store. */
function openStore(root: string): void {
  store = new LocalHistoryStore({ dir: join(root, localHistoryStoreDir(buildFlavor(process.env, app.isPackaged))), capBytes: capBytes() })
}

/** Is the file ignored by the git repository holding it? A directory outside any repo, or any git
 *  failure, is "not ignored": a version is kept rather than lost. */
async function isGitIgnored(absPath: string): Promise<boolean> {
  try {
    await execFileP('git', ['check-ignore', '-q', '--', basename(absPath)], {
      cwd: dirname(absPath),
      env: GIT_READ_ENV,
      timeout: 5000
    })
    return true
  } catch {
    return false
  }
}

/** One path's job: decide whether the file holds a new, trackable version, and keep it. `force`:
 *  Pomade's own save, move or keep-now — the version rule does not apply. */
async function snapshot(root: string, rel: string, force = false): Promise<void> {
  const s = store
  if (!s || workspace !== root) return
  if ((ignoredUntil.get(rel) ?? 0) > Date.now()) return
  const rule = force ? 'every' : ruleFor(rel)
  if (rule === 'none') return
  const target = abs(rel)
  let st
  try {
    st = await fsp.stat(target)
  } catch {
    return
  }
  const stamp = `${st.mtimeMs}:${st.size}`
  if (!st.isFile() || st.size === 0 || st.size > SNAPSHOT_MAX_FILE_BYTES) {
    remember(seen, rel, stamp, STAT_CACHE_LIMIT)
    return
  }
  if (seen.get(rel) === stamp) return
  // A streaming file is not read at all: its changes (any new stat) keep it streaming.
  if (rule === 'bursts' && streaming.isStreaming(rel, Date.now())) {
    streaming.burst(rel, Date.now())
    remember(seen, rel, stamp, STAT_CACHE_LIMIT)
    return
  }
  const bytes = await fsp.readFile(target)
  if (workspace !== root) return
  remember(seen, rel, stamp, STAT_CACHE_LIMIT)
  // A burst is a change of content: a touch or rewrite of the same text counts nothing. Content
  // with no baseline to compare (binary, invalid UTF-8) counts at every new stat.
  const burst = (): boolean => rule === 'bursts' && streaming.burst(rel, Date.now())
  if (looksBinary(bytes)) {
    burst()
    return
  }
  const content = bytes.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(bytes)) {
    burst()
    return
  }
  const hash = blobHash(content)
  const newest = await s.newestHash(rel)
  // A rename keeps the content: new content at a moved path is an edit, not the arrival.
  // Marked arrived at once (same tick): a second job for the path keeps no second rename.
  const moved = newest === null || newest === hash ? movedFrom(rel) : null
  if (moved !== null) markArrived(rel)
  if (newest === hash && moved === null) return
  if (burst()) return
  if (await isGitIgnored(target)) {
    remember(ignoredUntil, rel, Date.now() + IGNORED_TRUST_MS, STAT_CACHE_LIMIT)
    return
  }
  if (workspace !== root) return
  const from = moved ?? (newest === null ? await vanishedSource(s, hash) : null)
  if (from !== null) await s.move(from, rel)
  const origin = from !== null ? 'renamed' : ownWrites.get(rel) === hash ? 'saved' : 'disk'
  const ref = await s.record(rel, content, origin, from ?? undefined)
  if (ref) safeBroadcast(EV.localHistoryChanged, rel)
}

/** The path `rel` had before one of Pomade's own recent renames or moves; null when none covers it. */
function movedFrom(rel: string): string | null {
  const now = Date.now()
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i]
    if (m.until < now || m.arrived.has(rel)) continue
    const before = pathBeforeMove(rel, m.from, m.to)
    if (before !== null) return before
  }
  return null
}

/** A file's arrival under its new name is recorded once. */
function markArrived(rel: string): void {
  for (const m of moves) if (pathBeforeMove(rel, m.from, m.to) !== null) m.arrived.add(rel)
}

/** A rename made outside Pomade (a terminal `mv`, `git mv`, Finder): a path with no snapshots
 *  whose content is exactly the newest snapshot of a path that no longer exists came from there. */
async function vanishedSource(s: LocalHistoryStore, hash: string): Promise<string | null> {
  for (const path of await s.known({ newest: hash })) {
    const gone = await fsp.stat(abs(path)).then(() => false, () => true)
    if (gone) return path
  }
  return null
}

function onChange(change: RawWorkspaceChange): void {
  if (isTrackablePath(change.path) && ruleFor(change.path) !== 'none') scheduler?.touch(change.path)
}

/** Pomade just saved `content` to the workspace-relative `rel`: snapshot it now, marked as saved
 *  in Pomade (no quiet window — a save is the user's own act). */
export function noteSaved(rel: string, content: string): void {
  if (!scheduler || !isTrackablePath(rel)) return
  remember(ownWrites, rel, blobHash(content), OWN_WRITES_LIMIT)
  forced.add(rel)
  seen.delete(rel)
  ignoredUntil.delete(rel)
  scheduler.now(rel)
}

/** T-226 — keep `rel`'s current content as a snapshot right away (a version tab is about to
 *  replace it). True when that content is the path's newest snapshot afterwards — kept now, or
 *  already the newest; false when local history does not keep this file. */
export async function keepNow(rel: string): Promise<boolean> {
  const root = workspace
  if (!root || rel.startsWith('/') || !isTrackablePath(rel)) return false
  let bytes: Buffer
  try {
    await snapshot(root, rel, true)
    bytes = await fsp.readFile(abs(rel))
  } catch {
    return false
  }
  if (bytes.length === 0 || looksBinary(bytes)) return false
  const content = bytes.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(bytes)) return false
  const s = store
  return s !== null && workspace === root && (await s.newestHash(rel)) === blobHash(content)
}

/** Pomade just renamed or moved `from` (a file or a folder) to `to`, both workspace-relative:
 *  the snapshots of every path it covers follow it, and each file's next snapshot (kept right
 *  away for the paths that had snapshots) is the 'renamed' one naming its old path. */
export async function noteMoved(from: string, to: string): Promise<void> {
  const root = workspace
  if (!scheduler || !root || from === to) return
  moves.push({ from, to, until: Date.now() + MOVE_TRUST_MS, arrived: new Set() })
  if (moves.length > MOVES_LIMIT) moves.shift()
  const s = store
  if (!s || workspace !== root) return
  for (const path of await s.known({ under: from })) {
    const dest = to + path.slice(from.length)
    await s.move(path, dest)
    seen.delete(dest)
    forced.add(dest)
    scheduler?.now(dest)
  }
  if (isTrackablePath(to)) {
    seen.delete(to)
    forced.add(to)
    scheduler?.now(to)
  }
}

/** Tell open History panels which paths lost versions. */
function broadcastChanged(paths: readonly string[]): void {
  for (const p of paths) safeBroadcast(EV.localHistoryChanged, p)
}

async function pruneNow(): Promise<void> {
  const s = store
  if (s) broadcastChanged(await s.prune())
}

function schedulePrune(delay: number): void {
  if (pruneTimer) clearTimeout(pruneTimer)
  pruneTimer = setTimeout(() => {
    void pruneNow()
      .catch(() => undefined)
      .finally(() => schedulePrune(PRUNE_EVERY_MS))
  }, delay)
  pruneTimer.unref()
}

const DAY_MS = 24 * 60 * 60 * 1000
const NOTHING: RemovalSize = { versions: 0, bytes: 0 }

function purgeGroup(group: unknown): PurgeGroup {
  if (group === 'local' || group === 'discarded') return group
  throw new Error(`Unknown group: ${String(group)}`)
}

/** T-234 — Settings' Delete, previewed: the versions of `group` kept more than `olderThanDays`
 *  days ago, as of now. */
async function previewPurge(group: unknown, olderThanDays: unknown): Promise<PurgePreview> {
  requireRoot()
  const g = purgeGroup(group)
  const days = typeof olderThanDays === 'number' && Number.isFinite(olderThanDays) && olderThanDays > 0 ? olderThanDays : 0
  const before = Date.now() - days * DAY_MS
  const size = g === 'discarded' ? await measureDrafts(before) : ((await store?.measurePurge(before)) ?? NOTHING)
  return { group: g, before, ...size }
}

/** T-234 — Settings' Delete: the versions of `group` kept before `before`. */
async function purge(group: unknown, before: unknown): Promise<RemovalSize> {
  requireRoot()
  const g = purgeGroup(group)
  if (typeof before !== 'number' || !Number.isFinite(before)) throw new Error('No time to delete before')
  if (g === 'discarded') return purgeDrafts(before)
  const s = store
  if (!s) return NOTHING
  const { removed, paths } = await s.purge(before)
  broadcastChanged(paths)
  return removed
}

/** Start watching the open workspace. */
export function startLocalHistory(): void {
  stopLocalHistory()
  const root = configStore.getRoot()
  if (!root) return
  workspace = root
  openStore(root)
  scheduler = new PathScheduler({
    debounceMs: DEBOUNCE_MS,
    maxWaitMs: MAX_WAIT_MS,
    concurrency: WORKERS,
    limit: PENDING_LIMIT,
    run: (rel) => snapshot(root, rel, forced.delete(rel))
  })
  void configStore.getAppSettings().then((settings) => applySettings(settings, false), () => undefined)
  heldKey = holdAppWatch('')
  untap = tapWorkspaceChanges(onChange)
  schedulePrune(PRUNE_DELAY_MS)
}

/** Stop and drop everything per-workspace (workspace switch, quit). */
export function stopLocalHistory(): void {
  untap?.()
  untap = null
  if (heldKey !== null) releaseAppWatch(heldKey)
  heldKey = null
  scheduler?.stop()
  scheduler = null
  if (pruneTimer) clearTimeout(pruneTimer)
  pruneTimer = null
  workspace = null
  store = null
  seen.clear()
  ignoredUntil.clear()
  ownWrites.clear()
  forced.clear()
  streaming.clear()
  moves.length = 0
  capSetting = capBytesOf(undefined)
}

export function registerLocalHistory(ipc: IpcMain): void {
  defineHandler(ipc, CH.localHistory.list, async (_e, path) => {
    requireRoot()
    return (await store?.list(path)) ?? []
  })
  defineHandler(ipc, CH.localHistory.read, async (_e, path, id) => {
    requireRoot()
    return (await store?.read(path, id)) ?? null
  })
  defineHandler(ipc, CH.localHistory.keep, (_e, path) => keepNow(path))
  defineHandler(ipc, CH.localHistory.previewPurge, (_e, group, days) => previewPurge(group, days))
  defineHandler(ipc, CH.localHistory.purge, (_e, group, before) => purge(group, before))
  defineHandler(ipc, CH.localHistory.previewCap, async (_e, capMb) => {
    requireRoot()
    return (await store?.measurePrune(capBytesOf(capMb))) ?? NOTHING
  })
  onWorkspaceTeardown(() => stopLocalHistory())
  onWorkspaceReady(() => startLocalHistory())
  onAppSettingsChanged((settings) => applySettings(settings, true))
}
