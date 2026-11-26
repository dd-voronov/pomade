// Pomade — git-core: one operation per repository at a time, across processes. The Git panel's
// operations (Pomade's main process) and every `pomade-git` run take the same lock: a file in the
// repository's git directory, created exclusively, naming its holder. A holder that is gone (its
// process ended, or the lock is older than any operation can run) does not block anyone.
//
// A background operation (the Git panel's quiet fetch) holds the lock too, but it gives way: an
// operation the user asked for that finds one holding the lock asks it to yield (a request file
// next to the lock, so it works across processes), and waits — at most REPO_YIELD_WAIT_MS — for
// the lock to come free. The background holder sees the request within YIELD_POLL_MS and stops
// its git (SIGTERM, then SIGKILL). A background operation never waits: a busy repo skips it.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleepMs } from 'node:timers/promises'

import { GIT_LOCAL_TIMEOUT_MS, GIT_NET_TIMEOUT_MS } from '@shared/git-ops'

import { gitDirOf } from './repo-state'

/** The lock file's name inside the git directory. */
export const REPO_LOCK_FILE = 'pomade-operation.lock'

/** A lock older than this is a leftover: the longest operation (fetch, rebase, push, each bounded)
 *  ends well before it. */
export const REPO_LOCK_STALE_MS = 4 * (GIT_NET_TIMEOUT_MS + GIT_LOCAL_TIMEOUT_MS)

/** The request a waiting operation leaves for a background holder: "give way". */
export const REPO_YIELD_FILE = 'pomade-operation.yield'

/** How long an operation waits for a background holder to give way before it is refused as busy.
 *  A yielding git is gone within the 2 s between SIGTERM and SIGKILL. */
export const REPO_YIELD_WAIT_MS = 5_000

/** How often a background holder looks for a yield request, and a waiter for the free lock. */
export const YIELD_POLL_MS = 100

interface LockRecord {
  pid: number
  /** What holds it, in words: "Commit & push", "Commit & push (pomade-git)". */
  title: string
  at: number
  /** A background operation: it gives way to any other. */
  background?: true
}

export interface LockOptions {
  /** Take the lock as a background operation, which gives way to any other. */
  background?: boolean
  now?: () => number
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still a holder.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readHolder(path: string): Promise<LockRecord | null> {
  try {
    const r = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<LockRecord>
    if (typeof r.pid !== 'number' || typeof r.title !== 'string' || typeof r.at !== 'number') return null
    return { pid: r.pid, title: r.title, at: r.at, ...(r.background === true ? { background: true as const } : {}) }
  } catch {
    return null
  }
}

/** A taken lock: `release` frees it; `yielded` aborts when a background holder is asked to give
 *  way (never, for any other). A refused one names its holder and whether it is a background one. */
export type LockAttempt =
  | { ok: true; release: () => Promise<void>; yielded: AbortSignal }
  | { ok: false; holder: string; background: boolean }

const NEVER = new AbortController().signal

/** Take the lock of the repository at `cwd` for `title`, or say who holds it. A repository without a
 *  git directory has nothing to lock (git itself fails the operation). */
export async function tryLockRepo(cwd: string, title: string, opts: LockOptions = {}): Promise<LockAttempt> {
  const now = opts.now ?? Date.now
  const gitDir = await gitDirOf(cwd)
  if (!gitDir) return { ok: true, release: async () => {}, yielded: NEVER }
  const path = join(gitDir, REPO_LOCK_FILE)
  const yieldPath = join(gitDir, REPO_YIELD_FILE)
  const record: LockRecord = { pid: process.pid, title, at: now(), ...(opts.background ? { background: true as const } : {}) }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fs.open(path, 'wx', 0o644)
      try {
        await fh.writeFile(JSON.stringify(record))
      } finally {
        await fh.close()
      }
      // A request left before this lock was taken was meant for an earlier holder; a waiter that
      // still waits renews it.
      await fs.rm(yieldPath, { force: true })
      const yielding = opts.background ? watchYield(yieldPath) : null
      return {
        ok: true,
        yielded: yielding?.signal ?? NEVER,
        release: async () => {
          yielding?.stop()
          const holder = await readHolder(path)
          if (holder && holder.pid === record.pid && holder.at === record.at) await fs.rm(path, { force: true })
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = await readHolder(path)
    // A half-written record (its writer is between open and write) is a live holder.
    if (holder === null) {
      const st = await fs.stat(path).catch(() => null)
      if (st && now() - st.mtimeMs < 5_000) return { ok: false, holder: 'another git operation', background: false }
    } else if (alive(holder.pid) && now() - holder.at < REPO_LOCK_STALE_MS) {
      return { ok: false, holder: holder.title, background: holder.background === true }
    }
    await fs.rm(path, { force: true })
  }
  return { ok: false, holder: 'another git operation', background: false }
}

/** A background holder's watch for a yield request: `signal` aborts once one appears. */
function watchYield(yieldPath: string): { signal: AbortSignal; stop: () => void } {
  const ctl = new AbortController()
  const timer = setInterval(() => {
    fs.access(yieldPath).then(
      () => {
        clearInterval(timer)
        ctl.abort()
      },
      () => {}
    )
  }, YIELD_POLL_MS)
  timer.unref()
  return { signal: ctl.signal, stop: () => clearInterval(timer) }
}

/** Take the lock; a background holder is asked to give way and waited for (at most
 *  REPO_YIELD_WAIT_MS) — a background operation itself never waits. */
export async function lockRepo(cwd: string, title: string, opts: LockOptions = {}): Promise<LockAttempt> {
  let lock = await tryLockRepo(cwd, title, opts)
  if (lock.ok || !lock.background || opts.background) return lock
  const gitDir = await gitDirOf(cwd)
  if (!gitDir) return lock
  const yieldPath = join(gitDir, REPO_YIELD_FILE)
  try {
    for (let waited = 0; !lock.ok && lock.background && waited < REPO_YIELD_WAIT_MS; waited += YIELD_POLL_MS) {
      await fs.writeFile(yieldPath, title)
      await sleepMs(YIELD_POLL_MS)
      lock = await tryLockRepo(cwd, title, opts)
    }
  } finally {
    await fs.rm(yieldPath, { force: true })
  }
  return lock
}

/** Run `fn` holding the repository's lock (`lockRepo`: a background holder gives way); `busy(holder)`
 *  answers instead when someone else holds it. `fn` gets the lock's `yielded` signal. The lock is
 *  released however `fn` ends. */
export async function withRepoLockAt<T>(
  cwd: string,
  title: string,
  fn: (yielded: AbortSignal) => Promise<T>,
  busy: (holder: string) => T,
  opts: LockOptions = {}
): Promise<T> {
  const lock = await lockRepo(cwd, title, opts)
  if (!lock.ok) return busy(lock.holder)
  try {
    return await fn(lock.yielded)
  } finally {
    await lock.release()
  }
}
