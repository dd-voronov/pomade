// Pomade — the watcher SETTLE (T-243): re-check after a change until a re-check finds nothing new.
//
// A native recursive watcher (FSEvents on macOS) is not a complete record: a descriptor that has
// just opened is not live yet, and a second change to a path changed moments before can be
// coalesced away or dropped. Every watcher that must not miss a change therefore re-reads what it
// watches on its own, at bounded delays after each trigger (its registration and each burst of
// events): a re-check that finds something new restarts the sequence, one that finds nothing moves
// to the next delay, and after the last delay the settler goes idle. Cost stays bounded — nothing
// runs while the disk is quiet, and a busy disk drives the re-checks with its own events.
//
// Used by `files.watch` (main, `host-api.ts`) and the file tree (renderer, `use-tree-data.ts`).

/** Delays (ms) of the re-checks after a trigger; any finding restarts from the first. */
export const SETTLE_DELAYS_MS: readonly number[] = [300, 1200]

export interface Settler {
  /** A trigger (registration, a burst of events): (re)start the re-check sequence. */
  kick(): void
  /** Stop for good; a re-check in flight finishes but schedules nothing. */
  dispose(): void
}

/** `check` re-reads the watched scope and resolves true when it found something new (the caller
 *  reports it). Re-checks never overlap: a kick during one restarts the sequence after it. `onIdle`
 *  runs when a sequence ends — the last re-check found nothing and no kick came meanwhile. */
export function createSettler(
  check: () => Promise<boolean>,
  delays: readonly number[] = SETTLE_DELAYS_MS,
  onIdle?: () => void
): Settler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let step = 0
  let running = false
  let kickedWhileRunning = false
  let disposed = false

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (disposed || step >= delays.length) return
    timer = setTimeout(() => void run(), delays[step])
  }

  const run = async (): Promise<void> => {
    timer = null
    running = true
    let found = false
    try {
      found = await check()
    } catch {
      found = false // an unreadable scope is not news; the next trigger re-checks
    }
    running = false
    if (disposed) return
    step = found || kickedWhileRunning ? 0 : step + 1
    kickedWhileRunning = false
    if (step >= delays.length) onIdle?.()
    schedule()
  }

  return {
    kick(): void {
      if (disposed) return
      step = 0
      if (running) {
        kickedWhileRunning = true
        return
      }
      schedule()
    },
    dispose(): void {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
