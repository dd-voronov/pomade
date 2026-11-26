import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSettler } from './settle'

describe('createSettler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-checks at each delay after a kick, then goes idle when nothing is new', async () => {
    const check = vi.fn(async () => false)
    const s = createSettler(check, [100, 400])
    s.kick()
    await vi.advanceTimersByTimeAsync(99)
    expect(check).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('restarts the sequence after a re-check that found something new', async () => {
    const results = [true, false, false]
    const check = vi.fn(async () => results.shift() ?? false)
    const s = createSettler(check, [100, 400])
    s.kick()
    await vi.advanceTimersByTimeAsync(100) // found → restart at the first delay
    await vi.advanceTimersByTimeAsync(100)
    expect(check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(400)
    expect(check).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('a kick restarts the delays; a kick during a re-check restarts after it, never overlapping', async () => {
    let release: (v: boolean) => void = () => {}
    let inFlight = 0
    let maxInFlight = 0
    const check = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          release = (v) => {
            inFlight -= 1
            r(v)
          }
        })
    )
    const s = createSettler(check, [100, 400])
    s.kick()
    await vi.advanceTimersByTimeAsync(60)
    s.kick() // restart: the first re-check now lands at 160
    await vi.advanceTimersByTimeAsync(60)
    expect(check).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(40)
    expect(check).toHaveBeenCalledTimes(1)
    s.kick() // during the re-check
    release(false)
    await vi.advanceTimersByTimeAsync(100) // restarted from the first delay, not the second
    expect(check).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(1)
    release(false)
    s.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('a failing re-check counts as nothing new', async () => {
    const check = vi.fn(async () => {
      throw new Error('gone')
    })
    const s = createSettler(check, [100])
    s.kick()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('reports idle once a sequence ends, not while a kick keeps it going', async () => {
    const check = vi.fn(async () => false)
    const idle = vi.fn()
    const s = createSettler(check, [100, 400], idle)
    s.kick()
    await vi.advanceTimersByTimeAsync(100)
    expect(idle).not.toHaveBeenCalled()
    s.kick() // restarts: the sequence runs both delays again before it ends
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(399)
    expect(idle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(3)
    expect(idle).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(idle).toHaveBeenCalledTimes(1)
  })
})
