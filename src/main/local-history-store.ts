// Pomade — E-044: the local-history snapshot store of one workspace. It lives in the workspace
// (`Apps/Pomade/local-history/`, shared/local-history.ts `localHistoryStoreDir`), so it travels with
// a copy of the workspace; it keeps itself out of git with its own `.gitignore`. Content-addressed,
// pruned by age and by size.
//
//   <dir>/blobs/<hash>.txt      one file per distinct content — equal content is stored once
//   <dir>/paths/<key>.json      one PathRecord per workspace-relative path: its snapshots, oldest
//                               first; the key hashes the path alone, so the store still reads
//                               when the workspace sits at another path on another Mac
//
// A rename or move carries a path's snapshots to the new path (`move`), so a file's local history
// follows it; `record` with origin 'renamed' then marks the arrival. Which paths exist and their
// newest content are indexed in memory on first need (`known`) — a folder move finds the records
// under it, and a file that appears under a new name finds the vanished path it came from.
//
// Every write is atomic (tmp + rename) and every mutation runs on ONE FIFO queue, so a prune can
// never delete a blob a record in flight is about to reference. Reads need no queue: they only
// ever see whole files. The clock, the retention and the size cap are injected (tests pin them);
// the cap is the user's setting and changes while the store is open (`setCap`). A purge removes
// every snapshot observed before a moment, whatever the cap (Settings' Delete).

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { recoveryFileName } from '@shared/recovery'
import {
  SNAPSHOT_CAP_BYTES,
  SNAPSHOT_TTL_MS,
  blobHash,
  planPrune,
  planPurge,
  removalSize,
  snapshotId,
  snapshotRef,
  type PruneCandidate,
  type RemovalSize,
  type SnapshotEntry,
  type SnapshotOrigin,
  type SnapshotRef
} from '@shared/local-history'

import { writeFileAtomic, writeJsonAtomic } from './atomic-write'

interface PathRecord {
  path: string
  entries: SnapshotEntry[]
}

export interface LocalHistoryStoreOptions {
  /** The store's root directory. */
  dir: string
  now?: () => number
  ttlMs?: number
  capBytes?: number
}

/** A store's folders and its `.gitignore` (`*`: nothing in the store is ever committed); what is
 *  already there is left as it is. The workspace bootstrap calls it when a workspace becomes
 *  active, before any watcher runs, so a first snapshot never creates folders mid-session. */
export async function createStoreDirs(dir: string): Promise<void> {
  await fsp.mkdir(join(dir, 'blobs'), { recursive: true })
  await fsp.mkdir(join(dir, 'paths'), { recursive: true })
  const ignore = join(dir, '.gitignore')
  if (!(await fsp.stat(ignore).then(() => true, () => false))) await writeFileAtomic(ignore, '*\n')
}

export class LocalHistoryStore {
  private readonly dir: string
  private readonly now: () => number
  private readonly ttlMs: number
  private capBytes: number
  private queue: Promise<unknown> = Promise.resolve()
  /** The newest snapshot's hash per path file — read once, then kept current by `record`. */
  private readonly lastHash = new Map<string, string | null>()
  /** Every path record: path file → its path and newest hash. Built on first need by one read of
   *  the store, then kept current by every mutation. */
  private index: Map<string, { path: string; hash: string }> | null = null
  private dirsMade = false

  constructor(opts: LocalHistoryStoreOptions) {
    this.dir = opts.dir
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? SNAPSHOT_TTL_MS
    this.capBytes = opts.capBytes ?? SNAPSHOT_CAP_BYTES
  }

  private blobFile(hash: string): string {
    return join(this.dir, 'blobs', `${hash}.txt`)
  }

  private pathFile(path: string): string {
    return join(this.dir, 'paths', recoveryFileName(path))
  }

  /** The store's folders and its `.gitignore` (`*`: nothing in the store is ever committed). */
  async ensureDirs(): Promise<void> {
    if (this.dirsMade) return
    await createStoreDirs(this.dir)
    this.dirsMade = true
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async readRecord(file: string): Promise<PathRecord | null> {
    try {
      const rec = JSON.parse(await fsp.readFile(file, 'utf8')) as PathRecord
      return typeof rec.path === 'string' && Array.isArray(rec.entries) ? rec : null
    } catch {
      return null
    }
  }

  /** The record of `path`; null when it has none (a key collision reads as none). */
  private async recordOf(path: string): Promise<PathRecord | null> {
    const rec = await this.readRecord(this.pathFile(path))
    return rec && rec.path === path ? rec : null
  }

  /** The hash of the path's newest snapshot; null when it has none. */
  async newestHash(path: string): Promise<string | null> {
    const file = this.pathFile(path)
    const cached = this.lastHash.get(file)
    if (cached !== undefined) return cached
    const rec = await this.recordOf(path)
    const hash = rec && rec.entries.length > 0 ? rec.entries[rec.entries.length - 1].hash : null
    // A record that arrived meanwhile wins over this (older) read.
    if (!this.lastHash.has(file)) this.lastHash.set(file, hash)
    return this.lastHash.get(file) ?? null
  }

  /** Keep `content` as a new snapshot of the path unless its newest snapshot already holds exactly
   *  it — a rename (origin 'renamed', `from` = the old path) is kept even then: it marks when the
   *  file arrived under this name (unless the newest snapshot is that very rename). Resolves the
   *  snapshot when one was added. */
  async record(path: string, content: string, origin: SnapshotOrigin, from?: string): Promise<SnapshotRef | null> {
    const hash = blobHash(content)
    const renamed = origin === 'renamed'
    if (!renamed && (await this.newestHash(path)) === hash) return null
    const file = this.pathFile(path)
    return this.enqueue(async () => {
      const rec = (await this.recordOf(path)) ?? { path, entries: [] }
      const newest = rec.entries[rec.entries.length - 1]
      // The same rename twice (two jobs racing for one arrival) is kept once.
      if (newest?.hash === hash && (!renamed || (newest.origin === 'renamed' && newest.from === from))) {
        this.lastHash.set(file, hash)
        return null
      }
      await this.ensureDirs()
      const blob = this.blobFile(hash)
      const size = Buffer.byteLength(content, 'utf8')
      const have = await fsp.stat(blob).then((s) => s.size === size, () => false)
      if (!have) await writeFileAtomic(blob, content)
      const at = Math.max(this.now(), (newest?.at ?? 0) + 1)
      const entry: SnapshotEntry = renamed && from ? { at, hash, size, origin, from } : { at, hash, size, origin }
      rec.entries.push(entry)
      await writeJsonAtomic(file, rec)
      this.lastHash.set(file, hash)
      this.index?.set(file, { path, hash })
      return snapshotRef(entry)
    })
  }

  private async loadIndex(): Promise<Map<string, { path: string; hash: string }>> {
    if (this.index) return this.index
    const pathsDir = join(this.dir, 'paths')
    let names: string[]
    try {
      names = (await fsp.readdir(pathsDir)).filter((n) => n.endsWith('.json'))
    } catch {
      names = []
    }
    const index = new Map<string, { path: string; hash: string }>()
    for (const n of names) {
      const file = join(pathsDir, n)
      const rec = await this.readRecord(file)
      const newest = rec?.entries[rec.entries.length - 1]
      if (rec && newest) index.set(file, { path: rec.path, hash: newest.hash })
    }
    this.index ??= index
    return this.index
  }

  /** The paths with snapshots that are `under` itself or inside the folder `under`, or whose
   *  newest snapshot holds the content `newest`. */
  known(filter: { under: string } | { newest: string }): Promise<string[]> {
    return this.enqueue(async () => {
      const out: string[] = []
      for (const e of (await this.loadIndex()).values()) {
        if ('under' in filter ? e.path === filter.under || e.path.startsWith(`${filter.under}/`) : e.hash === filter.newest) {
          out.push(e.path)
        }
      }
      return out
    })
  }

  /** Carry `from`'s snapshots to `to` (a rename or move): merged by time with any `to` already
   *  has, `from`'s record removed. Resolves true when there was anything to carry. */
  move(from: string, to: string): Promise<boolean> {
    if (from === to) return Promise.resolve(false)
    const src = this.pathFile(from)
    const dest = this.pathFile(to)
    return this.enqueue(async () => {
      const index = await this.loadIndex()
      const moving = await this.recordOf(from)
      if (!moving || moving.entries.length === 0) return false
      const kept = (await this.recordOf(to))?.entries ?? []
      const entries = [...kept, ...moving.entries].sort((a, b) => a.at - b.at)
      await this.ensureDirs()
      await writeJsonAtomic(dest, { path: to, entries } satisfies PathRecord)
      await fsp.rm(src, { force: true })
      const newest = entries[entries.length - 1].hash
      this.lastHash.set(dest, newest)
      this.lastHash.set(src, null)
      index.delete(src)
      index.set(dest, { path: to, hash: newest })
      return true
    })
  }

  /** The path's snapshots, newest first. */
  async list(path: string): Promise<SnapshotRef[]> {
    const rec = await this.recordOf(path)
    if (!rec) return []
    return rec.entries.map(snapshotRef).sort((a, b) => b.at - a.at)
  }

  /** One snapshot's content; null when it is gone (pruned) or unreadable. */
  async read(path: string, id: string): Promise<string | null> {
    const entry = (await this.list(path)).find((e) => e.id === id)
    if (!entry) return null
    try {
      return await fsp.readFile(this.blobFile(entry.hash), 'utf8')
    } catch {
      return null
    }
  }

  /** Every readable path record, by path file; `dropUnreadable` removes the unreadable ones. */
  private async readRecords(dropUnreadable: boolean): Promise<Map<string, PathRecord>> {
    const pathsDir = join(this.dir, 'paths')
    let names: string[]
    try {
      names = (await fsp.readdir(pathsDir)).filter((n) => n.endsWith('.json'))
    } catch {
      names = []
    }
    const records = new Map<string, PathRecord>()
    for (const n of names) {
      const file = join(pathsDir, n)
      const rec = await this.readRecord(file)
      if (rec) records.set(file, rec)
      else if (dropUnreadable) await fsp.rm(file, { force: true })
    }
    return records
  }

  private static candidates(records: Map<string, PathRecord>): PruneCandidate[] {
    const all: PruneCandidate[] = []
    for (const [file, rec] of records) {
      for (const e of rec.entries) all.push({ ref: `${file}\n${snapshotId(e)}`, at: e.at, hash: e.hash, size: e.size })
    }
    return all
  }

  /** Remove the snapshots `plan` picks from the whole store, then every blob no snapshot
   *  references. Unreadable path files are removed too. Resolves what went and the paths whose
   *  snapshots changed. */
  private remove(plan: (all: readonly PruneCandidate[]) => Set<string>): Promise<{ removed: RemovalSize; paths: string[] }> {
    return this.enqueue(async () => {
      const records = await this.readRecords(true)
      const all = LocalHistoryStore.candidates(records)
      const gone = plan(all)
      const removed = removalSize(all, gone)
      const paths: string[] = []
      const live = new Set<string>()
      for (const [file, rec] of records) {
        const entries = rec.entries.filter((e) => !gone.has(`${file}\n${snapshotId(e)}`))
        if (entries.length === rec.entries.length) {
          for (const e of entries) live.add(e.hash)
          continue
        }
        paths.push(rec.path)
        this.lastHash.delete(file)
        if (entries.length === 0) {
          await fsp.rm(file, { force: true })
          this.index?.delete(file)
        } else {
          await writeJsonAtomic(file, { ...rec, entries })
          this.index?.set(file, { path: rec.path, hash: entries[entries.length - 1].hash })
        }
        for (const e of entries) live.add(e.hash)
      }
      let blobs: string[]
      try {
        blobs = await fsp.readdir(join(this.dir, 'blobs'))
      } catch {
        blobs = []
      }
      for (const b of blobs) {
        if (!b.endsWith('.txt')) {
          if (b.endsWith('.tmp')) await fsp.rm(join(this.dir, 'blobs', b), { force: true })
          continue
        }
        if (!live.has(b.slice(0, -4))) await fsp.rm(join(this.dir, 'blobs', b), { force: true })
      }
      return { removed, paths }
    })
  }

  /** What `plan` would remove, without removing it. Queued behind the writes in flight. */
  private measure(plan: (all: readonly PruneCandidate[]) => Set<string>): Promise<RemovalSize> {
    return this.enqueue(async () => {
      const all = LocalHistoryStore.candidates(await this.readRecords(false))
      return removalSize(all, plan(all))
    })
  }

  /** The size cap from now on; the next prune applies it. */
  setCap(capBytes: number): void {
    this.capBytes = capBytes
  }

  /** Remove snapshots past their retention, then the oldest until the distinct content fits the
   *  cap, then every blob no snapshot references. Unreadable path files are removed too. Resolves
   *  the paths whose snapshots changed. */
  async prune(): Promise<string[]> {
    return (await this.remove((all) => planPrune(all, this.now(), this.ttlMs, this.capBytes))).paths
  }

  /** What a prune under `capBytes` would remove now. */
  measurePrune(capBytes: number): Promise<RemovalSize> {
    return this.measure((all) => planPrune(all, this.now(), this.ttlMs, capBytes))
  }

  /** What `purge(before)` would remove. */
  measurePurge(before: number): Promise<RemovalSize> {
    return this.measure((all) => planPurge(all, before))
  }

  /** Remove every snapshot observed before `before` (epoch ms), whatever its age and the cap. */
  purge(before: number): Promise<{ removed: RemovalSize; paths: string[] }> {
    return this.remove((all) => planPurge(all, before))
  }
}
