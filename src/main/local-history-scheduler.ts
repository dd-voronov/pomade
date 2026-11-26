// Pomade — E-044: coalesces the platform watcher's raw events into one snapshot job per path.
// A path is touched on every event; its job runs once the events have been quiet for `debounceMs`,
// or `maxWaitMs` after the first one when they never go quiet (a file written continuously).
// Jobs run on a bounded worker pool, so a burst — a checkout rewriting thousands of files —
// never reads more than `concurrency` files at once, and the pending set is capped: past `limit`
// paths a new path is dropped, so a burst cannot grow memory without bound.
// `StreamingFiles` (T-274) counts a path's bursts — its quiet windows that found new content — and
// tells a streaming file: more than 12 bursts within an hour, until an hour of quiet.

interface Pending {
  firstAt: number
  timer: ReturnType<typeof setTimeout>
}

export interface PathSchedulerOptions {
  debounceMs: number
  maxWaitMs: number
  concurrency: number
  /** Most distinct paths waiting at once (timer-pending or queued). */
  limit: number
  run: (path: string) => Promise<void>
}

export class PathScheduler {
  private readonly pending = new Map<string, Pending>()
  private readonly queued: string[] = []
  private readonly queuedSet = new Set<string>()
  private active = 0
  private stopped = false
  /** Paths dropped because the pending set was full. */
  dropped = 0

  constructor(private readonly opts: PathSchedulerOptions) {}

  /** Paths waiting for their job (quiet window or worker). */
  get size(): number {
    return this.pending.size + this.queuedSet.size
  }

  /** An event touched `path`: (re)start its quiet window. */
  touch(path: string): void {
    if (this.stopped) return
    const cur = this.pending.get(path)
    if (cur) {
      clearTimeout(cur.timer)
      const wait = Math.max(0, Math.min(this.opts.debounceMs, cur.firstAt + this.opts.maxWaitMs - Date.now()))
      cur.timer = setTimeout(() => this.release(path), wait)
      return
    }
    if (this.queuedSet.has(path)) return
    if (this.size >= this.opts.limit) {
      this.dropped += 1
      return
    }
    this.pending.set(path, {
      firstAt: Date.now(),
      timer: setTimeout(() => this.release(path), this.opts.debounceMs)
    })
  }

  /** Run `path`'s job as soon as a worker is free, skipping its quiet window. */
  now(path: string): void {
    if (this.stopped) return
    const cur = this.pending.get(path)
    if (cur) clearTimeout(cur.timer)
    this.pending.delete(path)
    this.enqueue(path)
  }

  private release(path: string): void {
    this.pending.delete(path)
    this.enqueue(path)
  }

  private enqueue(path: string): void {
    if (!this.queuedSet.has(path)) {
      this.queuedSet.add(path)
      this.queued.push(path)
    }
    this.pump()
  }

  private pump(): void {
    while (!this.stopped && this.active < this.opts.concurrency && this.queued.length > 0) {
      const path = this.queued.shift() as string
      this.queuedSet.delete(path)
      this.active += 1
      void this.opts
        .run(path)
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }

  /** Drop everything waiting; jobs already running finish. */
  stop(): void {
    this.stopped = true
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    this.queued.length = 0
    this.queuedSet.clear()
  }
}

export interface StreamingFilesOptions {
  /** More bursts than this within `windowMs` make a path a streaming file. */
  bursts: number
  windowMs: number
  /** Most paths tracked at once; the least recently changed is forgotten first. */
  limit: number
}

/** T-274 — the burst rule. Each burst (one quiet window that found new content) of a path whose
 *  version rule is 'bursts' is reported here; a path with more than `bursts` of them within the last
 *  `windowMs` is a streaming file and gets no versions until it has been quiet for `windowMs`. */
interface Bursts {
  /** Burst times within the window, oldest first. */
  at: number[]
  streaming: boolean
}

export class StreamingFiles {
  private readonly paths = new Map<string, Bursts>()

  constructor(private readonly opts: StreamingFilesOptions) {}

  /** Is `path` a streaming file at `now` (streaming, and not yet quiet for a window)? Counts nothing. */
  isStreaming(path: string, now: number): boolean {
    const cur = this.paths.get(path)
    const last = cur?.at[cur.at.length - 1]
    return cur !== undefined && cur.streaming && last !== undefined && now - last < this.opts.windowMs
  }

  /** `path` changed in a new burst at `now`: true when it is (now) a streaming file — keep no version. */
  burst(path: string, now: number): boolean {
    const cur = this.paths.get(path)
    const last = cur?.at[cur.at.length - 1]
    const quiet = last === undefined || now - last >= this.opts.windowMs
    const entry: Bursts = cur && !quiet ? cur : { at: [], streaming: false }
    entry.at = entry.at.filter((t) => now - t < this.opts.windowMs)
    entry.at.push(now)
    if (entry.at.length > this.opts.bursts) {
      entry.streaming = true
      entry.at = entry.at.slice(-this.opts.bursts - 1)
    }
    // Re-inserted: the map's order is least recently changed first.
    this.paths.delete(path)
    this.paths.set(path, entry)
    if (this.paths.size > this.opts.limit) {
      const oldest = this.paths.keys().next().value
      if (oldest !== undefined) this.paths.delete(oldest)
    }
    return entry.streaming
  }

  clear(): void {
    this.paths.clear()
  }
}
