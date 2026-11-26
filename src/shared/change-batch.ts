// Pomade — the watcher CHANGE BATCH: collects changed paths over a debounce window and hands them
// over as one batch. The window closes after `quietMs` without a new path, and never later than
// `maxWaitMs` after its first path — a path changed more often than `quietMs` (a log being
// appended to) cannot hold the batch off. Past `maxPaths` distinct paths, or on a change with no
// path, the batch only says "something changed" (`null`): the consumer re-reads everything.
//
// Used by the tree watchers (main, `fs-watch.ts`) and the file tree (renderer, `use-tree-data.ts`).

/** Upper bound on how long a stream of changes defers a batch. */
export const BATCH_MAX_WAIT_MS = 1000
/** Distinct paths a batch carries before it gives up naming them. */
export const BATCH_MAX_PATHS = 1000

export interface ChangeBatch<T> {
  /** A changed path with its value (the latest value per path wins); `null` = a change that
   *  names no path. */
  add(path: string | null, value: T): void
  /** Drop what is pending; the batch keeps working for later changes. */
  cancel(): void
}

/** `onFlush` receives each closed window's paths, or `null` when they are unknown. */
export function createChangeBatch<T>(
  onFlush: (changes: Map<string, T> | null) => void,
  quietMs: number,
  maxWaitMs: number = BATCH_MAX_WAIT_MS,
  maxPaths: number = BATCH_MAX_PATHS
): ChangeBatch<T> {
  let pending = new Map<string, T>()
  let unknown = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadline = 0

  const flush = (): void => {
    timer = null
    const changes = unknown ? null : pending
    pending = new Map()
    unknown = false
    onFlush(changes)
  }

  return {
    add(path, value): void {
      const now = Date.now()
      if (timer === null) deadline = now + maxWaitMs
      else clearTimeout(timer)
      if (path === null) unknown = true
      else if (!unknown) {
        pending.set(path, value)
        if (pending.size > maxPaths) {
          unknown = true
          pending = new Map()
        }
      }
      timer = setTimeout(flush, Math.max(0, Math.min(quietMs, deadline - now)))
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
      pending = new Map()
      unknown = false
    }
  }
}
