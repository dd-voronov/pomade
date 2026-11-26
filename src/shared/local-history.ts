// Pomade — E-044: local history's shared types and pure decisions. Main (the snapshot store and the
// watcher-driven service) and the renderer (Document history's rows, the comparison side) both
// import this module, so which paths are tracked, what a snapshot is called, and which snapshots a
// prune removes are decided in one place and pinned by vitest (local-history.unit.test.ts).

import { contentHash } from './recovery'

/** Who wrote the content a snapshot holds: another writer ('disk': an agent, git, an app,
 *  another editor, Finder), Pomade's own save ('saved'), or a rename / move that brought the
 *  file to this path ('renamed' — the content as it arrived, `from` = the path it left). */
export type SnapshotOrigin = 'disk' | 'saved' | 'renamed'

/** One kept version of a file, as the per-path index stores it. */
export interface SnapshotEntry {
  /** When the content was observed (epoch ms). */
  at: number
  /** Content hash — names the blob; equal content shares one blob. */
  hash: string
  /** The content's size in bytes. */
  size: number
  origin: SnapshotOrigin
  /** 'renamed' only: the workspace-relative path the file had before. */
  from?: string
}

/** A snapshot as the renderer lists it (the content stays in the store until read). */
export interface SnapshotRef extends SnapshotEntry {
  /** Unique per entry (the same content can be snapshotted twice, A → B → A). */
  id: string
}

/** Snapshots are kept this long. */
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Files over this size are never snapshotted (the editor's own cap). */
export const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024

const MB = 1024 * 1024

/** The store's size caps the user can pick (Settings ▸ General ▸ Local history), in MB. */
export const LOCAL_HISTORY_CAP_CHOICES_MB: readonly number[] = [64, 128, 256, 512, 1024, 2048]

/** The store's size cap until the user picks another, in MB. */
export const DEFAULT_LOCAL_HISTORY_CAP_MB = 256

/** The store's size cap: the bytes of distinct content kept, pruned oldest first. */
export const SNAPSHOT_CAP_BYTES = DEFAULT_LOCAL_HISTORY_CAP_MB * MB

/** The cap in bytes for the setting `localHistoryCapMb`; anything but a positive number reads as
 *  the default. */
export function capBytesOf(capMb: unknown): number {
  return typeof capMb === 'number' && Number.isFinite(capMb) && capMb > 0 ? Math.round(capMb * MB) : SNAPSHOT_CAP_BYTES
}

/** `256 MB`, `1 GB` — a cap as the setting shows it. */
export function capLabel(capMb: number): string {
  return capMb >= 1024 && capMb % 1024 === 0 ? `${capMb / 1024} GB` : `${capMb} MB`
}

/** A snapshot's content hash: two independently seeded hashes (106 bits) — distinct content never
 *  shares a blob. The renderer hashes the disk text the same way to tell a snapshot of it. */
export function blobHash(content: string): string {
  return `${contentHash(content, 11)}${contentHash(content, 12)}`
}

export function snapshotId(e: Pick<SnapshotEntry, 'at' | 'hash'>): string {
  return `${e.at}-${e.hash}`
}

export function snapshotRef(e: SnapshotEntry): SnapshotRef {
  return { ...e, id: snapshotId(e) }
}

/** Extensions whose files are binary (or generated noise) — never read, never snapshotted. */
const SKIPPED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'heic',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'mp4', 'mov', 'mkv', 'avi', 'webm',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'dmg', 'iso', 'pkg',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar', 'wasm', 'node',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3', 'lock', 'tmp', 'swp', 'swo', 'map', 'pyc'
])

/** Where a workspace keeps its local history, relative to the workspace root: the stable Pomade in
 *  `Apps/Pomade/local-history`, a dev build in `Apps/Pomade/dev/local-history`, so the two never
 *  write one store at once. */
export function localHistoryStoreDir(flavor: 'stable' | 'dev'): string {
  return flavor === 'stable' ? 'Apps/Pomade/local-history' : 'Apps/Pomade/dev/local-history'
}

/** Is `rel` inside either flavor's store? Never tracked: a snapshot of the store would write the
 *  store again. */
export function isLocalHistoryStorePath(rel: string): boolean {
  return (['stable', 'dev'] as const).some((f) => {
    const dir = localHistoryStoreDir(f)
    return rel === dir || rel.startsWith(`${dir}/`)
  })
}

/** Path segments that are never tracked, beyond the platform watcher's own ignore list. */
const SKIPPED_SEGMENTS = new Set(['.git', 'node_modules', '.pomade'])

/** Could a file at this workspace-relative path hold a trackable text file? A name-level
 *  filter that costs nothing: no I/O, so a burst of events never reads a binary. */
export function isTrackablePath(rel: string): boolean {
  if (!rel) return false
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  if (!name || name === '.DS_Store') return false
  if (parts.some((p) => SKIPPED_SEGMENTS.has(p))) return false
  if (isLocalHistoryStorePath(rel)) return false
  if (name.endsWith('~')) return false
  const dot = name.lastIndexOf('.')
  if (dot > 0 && SKIPPED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return false
  return true
}

/** The settings `Always keep every change for` and `Never keep versions of`: extensions such as
 *  `.md`, matched at the end of the file name, case-insensitive (`.tar.gz` works too). */
export interface VersionLists {
  always: readonly string[]
  never: readonly string[]
}

/** A typed extension as the lists hold it — `md`, `.MD` and ` .md ` all become `.md`; null for
 *  input that names no extension (empty, a lone dot, or a path). */
export function normalizeExtension(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  const ext = t.startsWith('.') ? t : `.${t}`
  if (ext.length < 2 || ext.includes('/') || /\s/.test(ext) || ext.endsWith('.')) return null
  return ext
}

/** Does the file name at `rel` end in one of `exts`? */
export function hasListedExtension(rel: string, exts: readonly string[]): boolean {
  const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
  return exts.some((e) => name.length > e.length && name.endsWith(e))
}

/** How local history treats another writer's change to a trackable file:
 *  'every'  — a version for every change: a document open in the Editor, or an always-listed extension;
 *  'none'   — no versions: a never-listed extension (a streaming file by name);
 *  'bursts' — versions unless it changes in too many bursts (`StreamingFiles` in main decides).
 *  Pomade's own saves are kept before this is asked. The order is the rule: open and always first. */
export type VersionRule = 'every' | 'none' | 'bursts'

export function versionRule(rel: string, lists: VersionLists, openInEditor: boolean): VersionRule {
  if (openInEditor || hasListedExtension(rel, lists.always)) return 'every'
  if (hasListedExtension(rel, lists.never)) return 'none'
  return 'bursts'
}

/** More than this many bursts (quiet windows) within `STREAMING_WINDOW_MS` makes a file a
 *  streaming file; it stays one until it has been quiet for `STREAMING_WINDOW_MS`. */
export const STREAMING_BURSTS = 12
export const STREAMING_WINDOW_MS = 60 * 60 * 1000

/** A NUL byte in the first 8 KB — git's own test for a binary file. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/** One snapshot as a prune sees it. `ref` identifies it across the store. */
export interface PruneCandidate {
  ref: string
  at: number
  hash: string
  size: number
}

/** The snapshots a prune removes: those older than `ttlMs`, then — oldest first — as many as it
 *  takes for the distinct content left to fit `capBytes` (a blob shared by several snapshots
 *  counts once and is freed only with the last of them). A snapshot with an unreadable time is
 *  removed too: nothing can tell its age. */
export function planPrune(
  all: readonly PruneCandidate[],
  now: number,
  ttlMs: number,
  capBytes: number
): Set<string> {
  const removed = new Set<string>()
  const kept: PruneCandidate[] = []
  for (const c of all) {
    if (!Number.isFinite(c.at) || now - c.at > ttlMs) removed.add(c.ref)
    else kept.push(c)
  }
  const refs = new Map<string, number>()
  const sizes = new Map<string, number>()
  for (const c of kept) {
    refs.set(c.hash, (refs.get(c.hash) ?? 0) + 1)
    sizes.set(c.hash, c.size)
  }
  let total = 0
  for (const s of sizes.values()) total += s
  if (total <= capBytes) return removed
  const oldestFirst = [...kept].sort((a, b) => a.at - b.at)
  for (const c of oldestFirst) {
    if (total <= capBytes) break
    removed.add(c.ref)
    const left = (refs.get(c.hash) ?? 1) - 1
    refs.set(c.hash, left)
    if (left === 0) total -= sizes.get(c.hash) ?? 0
  }
  return removed
}

/** The snapshots a purge removes: those observed before `before` (epoch ms), and those with an
 *  unreadable time. */
export function planPurge(all: readonly PruneCandidate[], before: number): Set<string> {
  const removed = new Set<string>()
  for (const c of all) if (!Number.isFinite(c.at) || c.at < before) removed.add(c.ref)
  return removed
}

/** What removing some stored versions frees: how many go, and the bytes they take. */
export interface RemovalSize {
  versions: number
  bytes: number
}

/** The size of removing `removed` from `all`: the content no snapshot left references — content
 *  shared with a snapshot that stays frees nothing. */
export function removalSize(all: readonly PruneCandidate[], removed: ReadonlySet<string>): RemovalSize {
  const kept = new Set<string>()
  const sizes = new Map<string, number>()
  let versions = 0
  for (const c of all) {
    if (removed.has(c.ref)) {
      versions++
      sizes.set(c.hash, c.size)
    } else kept.add(c.hash)
  }
  let bytes = 0
  for (const [hash, size] of sizes) if (!kept.has(hash)) bytes += size
  return { versions, bytes }
}

/** The two kinds of stored version Settings can delete before their 7 days: the Local versions
 *  group (this store) and the Discarded group (discarded drafts and changes, recovery-store). The
 *  ids are Document history's group ids. */
export type PurgeGroup = 'local' | 'discarded'

/** What a purge would delete: the versions of `group` kept before `before` (epoch ms). The purge
 *  takes the same `before`, so it deletes exactly what the preview counted. */
export interface PurgePreview extends RemovalSize {
  group: PurgeGroup
  before: number
}

/** `3 versions, 1.2 MB` — a removal as the preview and the confirm say it. */
export function removalLabel(r: RemovalSize): string {
  return `${r.versions} ${r.versions === 1 ? 'version' : 'versions'}, ${formatBytes(r.bytes)}`
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** The label for how a version came to be: `saved in Pomade`, `changed on disk`, `renamed from
 *  T-2.md` (same folder), `moved from docs/old/` (another folder, same name) or `moved from
 *  docs/old/T-2.md` (both changed). `path` = where the file is now. */
export function originLabel(origin: SnapshotOrigin, from?: string, path?: string): string {
  if (origin === 'saved') return 'saved in Pomade'
  if (origin === 'disk') return 'changed on disk'
  if (!from) return 'renamed'
  if (path === undefined || dirName(from) === dirName(path)) return `renamed from ${baseName(from)}`
  if (baseName(from) === baseName(path)) return `moved from ${dirName(from) || '.'}/`
  return `moved from ${from}`
}

/** The path a file at `path` had before `fromPrefix` → `toPrefix` was moved (the file itself, or
 *  one of its parent folders); null when the move does not cover it. */
export function pathBeforeMove(path: string, fromPrefix: string, toPrefix: string): string | null {
  if (path === toPrefix) return fromPrefix
  if (path.startsWith(`${toPrefix}/`)) return fromPrefix + path.slice(toPrefix.length)
  return null
}

/** `1.2 KB`, `640 B`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
