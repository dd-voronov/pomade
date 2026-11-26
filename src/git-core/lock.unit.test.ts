import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { REPO_LOCK_FILE, REPO_LOCK_STALE_MS, REPO_YIELD_FILE, lockRepo, tryLockRepo, withRepoLockAt } from './lock'

let repo: string

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pomade-lock-'))
  execFileSync('git', ['init', '-q', repo])
})

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('the repo lock', () => {
  it('one holder at a time, named to the second caller; released after', async () => {
    const first = await tryLockRepo(repo, 'Pull')
    expect(first.ok).toBe(true)
    expect(await tryLockRepo(repo, 'Push')).toEqual({ ok: false, holder: 'Pull', background: false })
    if (first.ok) await first.release()
    const again = await tryLockRepo(repo, 'Push')
    expect(again.ok).toBe(true)
    if (again.ok) await again.release()
    await expect(fs.access(join(repo, '.git', REPO_LOCK_FILE))).rejects.toThrow()
  })

  it('a holder that is gone, or a lock too old, does not block', async () => {
    const path = join(repo, '.git', REPO_LOCK_FILE)
    await fs.writeFile(path, JSON.stringify({ pid: 2 ** 22 + 12345, title: 'Ghost', at: Date.now() }))
    const taken = await tryLockRepo(repo, 'Fetch')
    expect(taken.ok).toBe(true)
    if (taken.ok) await taken.release()
    await fs.writeFile(path, JSON.stringify({ pid: process.pid, title: 'Old', at: Date.now() - REPO_LOCK_STALE_MS - 1 }))
    const old = await tryLockRepo(repo, 'Fetch')
    expect(old.ok).toBe(true)
    if (old.ok) await old.release()
  })

  it('withRepoLockAt answers busy, and releases however the work ends', async () => {
    const held = await tryLockRepo(repo, 'Commit & push')
    expect(await withRepoLockAt(repo, 'Pull', async () => 'ran', (h) => `busy: ${h}`)).toBe('busy: Commit & push')
    if (held.ok) await held.release()
    await expect(withRepoLockAt(repo, 'Pull', () => Promise.reject(new Error('boom')), () => 'busy')).rejects.toThrow('boom')
    expect(await withRepoLockAt(repo, 'Pull', async () => 'ran', () => 'busy')).toBe('ran')
  })

  it('a background holder gives way: the other operation asks, it stops, the other one runs', async () => {
    const bg = await tryLockRepo(repo, 'Fetch', { background: true })
    expect(bg.ok).toBe(true)
    if (!bg.ok) return
    // The background "operation": runs until it is asked to give way, then lets go.
    bg.yielded.addEventListener('abort', () => void bg.release(), { once: true })
    expect(await tryLockRepo(repo, 'Commit & push')).toEqual({ ok: false, holder: 'Fetch', background: true })
    const started = Date.now()
    expect(await withRepoLockAt(repo, 'Commit & push', async (y) => (y.aborted ? 'aborted' : 'ran'), (h) => `busy: ${h}`)).toBe('ran')
    expect(bg.yielded.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    await expect(fs.access(join(repo, '.git', REPO_YIELD_FILE))).rejects.toThrow()
  })

  it('a background operation never waits and never makes another give way; user operations are refused, not queued', async () => {
    const bg = await tryLockRepo(repo, 'Fetch', { background: true })
    expect(await lockRepo(repo, 'Fetch', { background: true })).toEqual({ ok: false, holder: 'Fetch', background: true })
    if (bg.ok) {
      expect(bg.yielded.aborted).toBe(false)
      await bg.release()
    }
    const user = await tryLockRepo(repo, 'Pull')
    const started = Date.now()
    expect(await lockRepo(repo, 'Push')).toEqual({ ok: false, holder: 'Pull', background: false })
    expect(await lockRepo(repo, 'Fetch', { background: true })).toEqual({ ok: false, holder: 'Pull', background: false })
    expect(Date.now() - started).toBeLessThan(1_000)
    if (user.ok) {
      expect(user.yielded.aborted).toBe(false)
      await user.release()
    }
  })

  it('a background holder that does not let go is waited for only so long, then the operation is refused', async () => {
    const bg = await tryLockRepo(repo, 'Fetch', { background: true })
    const started = Date.now()
    expect(await lockRepo(repo, 'Pull')).toEqual({ ok: false, holder: 'Fetch', background: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500)
    if (bg.ok) {
      expect(bg.yielded.aborted).toBe(true)
      await bg.release()
    }
  }, 15_000)

  it('a leftover yield request does not stop the next background holder', async () => {
    await fs.writeFile(join(repo, '.git', REPO_YIELD_FILE), 'Pull')
    const bg = await tryLockRepo(repo, 'Fetch', { background: true })
    await new Promise((r) => setTimeout(r, 300))
    if (bg.ok) {
      expect(bg.yielded.aborted).toBe(false)
      await bg.release()
    }
  })
})
