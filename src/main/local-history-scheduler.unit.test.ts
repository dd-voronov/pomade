import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STREAMING_BURSTS, STREAMING_WINDOW_MS, versionRule, type VersionLists } from '@shared/local-history'

import { PathScheduler, StreamingFiles } from './local-history-scheduler'

let ran: string[]

beforeEach(() => {
  vi.useFakeTimers()
  ran = []
})
afterEach(() => vi.useRealTimers())

function make(over: Partial<ConstructorParameters<typeof PathScheduler>[0]> = {}): PathScheduler {
  return new PathScheduler({
    debounceMs: 100,
    maxWaitMs: 1000,
    concurrency: 2,
    limit: 5,
    run: (p) => {
      ran.push(p)
      return Promise.resolve()
    },
    ...over
  })
}

describe('PathScheduler', () => {
  it('runs a path once after its events go quiet', async () => {
    const s = make()
    for (let i = 0; i < 10; i++) {
      s.touch('a.md')
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(ran).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(ran).toEqual(['a.md'])
  })

  it('runs a path that never goes quiet once the max wait has passed', async () => {
    const s = make()
    for (let i = 0; i < 40; i++) {
      s.touch('log.md')
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(ran.length).toBeGreaterThanOrEqual(1)
    expect(ran.every((p) => p === 'log.md')).toBe(true)
    expect(ran.length).toBeLessThanOrEqual(3)
  })

  it('keeps separate quiet windows per path', async () => {
    const s = make()
    s.touch('a.md')
    await vi.advanceTimersByTimeAsync(60)
    s.touch('b.md')
    await vi.advanceTimersByTimeAsync(50)
    expect(ran).toEqual(['a.md'])
    await vi.advanceTimersByTimeAsync(60)
    expect(ran).toEqual(['a.md', 'b.md'])
  })

  it('never runs more jobs at once than its workers', async () => {
    let active = 0
    let peak = 0
    const s = make({
      limit: 100,
      run: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 30))
        active -= 1
      }
    })
    for (let i = 0; i < 20; i++) s.touch(`f${i}.md`)
    await vi.advanceTimersByTimeAsync(2000)
    expect(peak).toBe(2)
    expect(s.size).toBe(0)
  })

  it('drops new paths past the limit, keeps those already waiting', async () => {
    const s = make({ limit: 3 })
    for (let i = 0; i < 6; i++) s.touch(`f${i}.md`)
    expect(s.size).toBe(3)
    expect(s.dropped).toBe(3)
    s.touch('f0.md')
    expect(s.dropped).toBe(3)
    await vi.advanceTimersByTimeAsync(500)
    expect(ran.sort()).toEqual(['f0.md', 'f1.md', 'f2.md'])
  })

  it('now() skips the quiet window', async () => {
    const s = make()
    s.touch('a.md')
    s.now('a.md')
    await vi.advanceTimersByTimeAsync(0)
    expect(ran).toEqual(['a.md'])
    await vi.advanceTimersByTimeAsync(500)
    expect(ran).toEqual(['a.md'])
  })

  it('a failing job does not stop the others', async () => {
    const s = make({
      run: (p) => {
        ran.push(p)
        return p === 'bad.md' ? Promise.reject(new Error('x')) : Promise.resolve()
      }
    })
    s.touch('bad.md')
    s.touch('good.md')
    await vi.advanceTimersByTimeAsync(200)
    expect(ran.sort()).toEqual(['bad.md', 'good.md'])
  })

  it('stop() drops what is waiting', async () => {
    const s = make()
    s.touch('a.md')
    s.stop()
    s.touch('b.md')
    await vi.advanceTimersByTimeAsync(500)
    expect(ran).toEqual([])
  })
})

describe('StreamingFiles — the burst rule (T-274)', () => {
  const MIN = 60_000
  const HOUR = STREAMING_WINDOW_MS
  const lists: VersionLists = { always: ['.md', '.txt'], never: ['.log', '.jsonl', '.ndjson'] }
  const make = (): StreamingFiles => new StreamingFiles({ bursts: STREAMING_BURSTS, windowMs: HOUR, limit: 100 })
  /** The decision local-history.ts makes for one burst of another writer's change. */
  const keeps = (s: StreamingFiles, path: string, now: number, open = false): boolean => {
    const rule = versionRule(path, lists, open)
    return rule === 'every' || (rule === 'bursts' && !s.burst(path, now))
  }

  it('keeps all 30 bursts of a .md changed 30 times within an hour', () => {
    const s = make()
    const kept = Array.from({ length: 30 }, (_, i) => keeps(s, 'notes.md', i * 2 * MIN)).filter(Boolean)
    expect(kept).toHaveLength(30)
  })

  it('keeps the first 12 of 13 bursts of a .ts within an hour, none after, again after an hour of quiet', () => {
    const s = make()
    const verdicts = Array.from({ length: 13 }, (_, i) => keeps(s, 'src/gen.ts', i * 4 * MIN))
    expect(verdicts.slice(0, 12).every(Boolean)).toBe(true)
    expect(verdicts[12]).toBe(false)
    // Still changing, but slowly: still streaming until a full hour passes with no burst at all.
    let t = 12 * 4 * MIN
    for (let i = 0; i < 4; i++) {
      t += 50 * MIN
      expect(keeps(s, 'src/gen.ts', t)).toBe(false)
    }
    t += HOUR
    expect(keeps(s, 'src/gen.ts', t)).toBe(true)
    expect(keeps(s, 'src/gen.ts', t + MIN)).toBe(true)
  })

  it('counts bursts within the last hour only: 12 an hour forever stays a normal file', () => {
    const s = make()
    for (let i = 0; i < 60; i++) expect(keeps(s, 'src/a.ts', i * 5 * MIN + 1), String(i)).toBe(true)
  })

  it('keeps no version of a .log', () => {
    const s = make()
    expect(keeps(s, 'logs/server.log', 0)).toBe(false)
    expect(keeps(s, 'out/events.ndjson', 0)).toBe(false)
  })

  it('keeps every change of a .ts open in the Editor', () => {
    const s = make()
    const kept = Array.from({ length: 40 }, (_, i) => keeps(s, 'src/gen.ts', i * MIN, true)).filter(Boolean)
    expect(kept).toHaveLength(40)
  })

  it('tracks each path on its own and forgets the least recently changed past its limit', () => {
    const s = new StreamingFiles({ bursts: 2, windowMs: HOUR, limit: 2 })
    expect([s.burst('a', 0), s.burst('a', 1), s.burst('a', 2)]).toEqual([false, false, true])
    expect(s.burst('b', 3)).toBe(false)
    expect(s.burst('c', 4)).toBe(false) // 'a' forgotten
    expect(s.burst('a', 5)).toBe(false)
  })
})
