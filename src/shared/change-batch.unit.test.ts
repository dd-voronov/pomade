import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createChangeBatch } from './change-batch'

describe('createChangeBatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes once after the quiet window, latest value per path', async () => {
    const flushed: (Map<string, number> | null)[] = []
    const b = createChangeBatch<number>((c) => flushed.push(c), 100, 1000)
    b.add('a', 1)
    await vi.advanceTimersByTimeAsync(50)
    b.add('a', 2)
    b.add('b', 3)
    await vi.advanceTimersByTimeAsync(99)
    expect(flushed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(flushed).toEqual([
      new Map([
        ['a', 2],
        ['b', 3]
      ])
    ])
  })

  it('a steady stream never holds a batch past the maximum wait', async () => {
    const flushed: (Map<string, true> | null)[] = []
    const b = createChangeBatch<true>((c) => flushed.push(c), 180, 1000)
    for (let t = 0; t < 2500; t += 50) {
      b.add('log', true)
      await vi.advanceTimersByTimeAsync(50)
    }
    // Windows close at 1000 and 2000 ms (each restarts on the next path), never at the quiet gap.
    expect(flushed).toHaveLength(2)
    b.cancel()
  })

  it('the window that opens after a flush gets a fresh maximum wait', async () => {
    const flushed: (Map<string, true> | null)[] = []
    const b = createChangeBatch<true>((c) => flushed.push(c), 100, 300)
    b.add('a', true)
    await vi.advanceTimersByTimeAsync(100)
    expect(flushed).toHaveLength(1)
    b.add('b', true)
    await vi.advanceTimersByTimeAsync(99)
    expect(flushed).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(flushed).toEqual([new Map([['a', true]]), new Map([['b', true]])])
  })

  it('a change with no path, or too many paths, flushes null', async () => {
    const flushed: (Map<string, true> | null)[] = []
    const b = createChangeBatch<true>((c) => flushed.push(c), 100, 1000, 2)
    b.add('a', true)
    b.add(null, true)
    b.add('b', true)
    await vi.advanceTimersByTimeAsync(100)
    b.add('a', true)
    b.add('b', true)
    b.add('c', true)
    await vi.advanceTimersByTimeAsync(100)
    expect(flushed).toEqual([null, null])
  })

  it('cancel drops what is pending and keeps working', async () => {
    const flushed: (Map<string, true> | null)[] = []
    const b = createChangeBatch<true>((c) => flushed.push(c), 100, 1000)
    b.add('a', true)
    b.cancel()
    await vi.advanceTimersByTimeAsync(500)
    expect(flushed).toEqual([])
    b.add('b', true)
    await vi.advanceTimersByTimeAsync(100)
    expect(flushed).toEqual([new Map([['b', true]])])
  })
})
