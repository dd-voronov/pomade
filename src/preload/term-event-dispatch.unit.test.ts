// T-168 — preload per-terminal event routing: ONE ipcRenderer.on per pty channel, dispatched
// over a Map<termId, Set<cb>>. This proves the two structural acceptance properties directly on
// the REAL preload module (electron mocked): exactly one shared listener per channel, and no
// listener growth as terminals are added (so >10 terminals never trip MaxListenersExceededWarning).
// It also pins the observable semantics the call sites depend on: per-termId delivery, the
// `project` payload→args mapping, and unsubscribe-removes-exactly-its-own-callback (re-entrancy
// safe). The preload API shape is derived from PomadeApi; here we only exercise the pty.on* wiring.

import { describe, expect, it, vi } from 'vitest'

import { EV, type PomadeApi } from '@shared/ipc-api'

// Hoisted so the vi.mock factory (itself hoisted above imports) can close over them without a TDZ.
const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(() => Promise.resolve()),
  send: vi.fn(),
  exposeInMainWorld: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: {
    on: mocks.on,
    removeListener: mocks.removeListener,
    invoke: mocks.invoke,
    send: mocks.send
  }
}))

// Importing the preload runs it: it builds the bridge (registering the shared listeners) and
// exposes it. Done once; the module is cached, so on-calls reflect only api construction.
import '../preload/index'

/** The bridge object the preload handed to contextBridge.exposeInMainWorld. */
function api(): PomadeApi {
  const call = mocks.exposeInMainWorld.mock.calls.find((c) => c[0] === 'pomade')
  if (!call) throw new Error('preload never exposed the `pomade` bridge')
  return call[1] as PomadeApi
}

/** How many ipcRenderer.on listeners are registered for `channel`. */
function listenerCount(channel: string): number {
  return mocks.on.mock.calls.filter((c) => c[0] === channel).length
}

/** The single shared dispatch handler the preload registered for `channel`. */
function dispatchHandler(channel: string): (e: unknown, payload: unknown) => void {
  const call = mocks.on.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`no ipcRenderer.on registered for ${channel}`)
  return call[1] as (e: unknown, payload: unknown) => void
}

const PTY_CHANNELS = [
  EV.ptyData,
  EV.ptyExit,
  EV.ptyBusy,
  EV.ptyCwd,
  EV.ptyExec,
  EV.ptyAgentExit,
  EV.ptyAgentStart,
  EV.ptyAttention,
  EV.ptySessionId,
  EV.ptySessionUnbound
]

describe('T-168 preload per-terminal event dispatch', () => {
  it('registers exactly ONE ipcRenderer.on listener per pty channel', () => {
    for (const channel of PTY_CHANNELS) {
      expect(listenerCount(channel), `one listener for ${channel}`).toBe(1)
    }
  })

  it('adds NO new ipcRenderer.on listeners as terminals are subscribed (15 terms, no growth)', () => {
    const before = PTY_CHANNELS.map(listenerCount)
    const offs: (() => void)[] = []
    // Subscribe 15 distinct termIds on EVERY per-term channel — the pre-T-168 model would have
    // added 15 listeners per channel (>10 ⇒ MaxListenersExceededWarning). Here it must add none.
    for (let i = 0; i < 15; i++) {
      const termId = `term-${i}`
      offs.push(api().pty.onData(termId, () => {}))
      offs.push(api().pty.onExit(termId, () => {}))
      offs.push(api().pty.onBusy(termId, () => {}))
      offs.push(api().pty.onCwd(termId, () => {}))
      offs.push(api().pty.onExec(termId, () => {}))
      offs.push(api().pty.onAgentExit(termId, () => {}))
      offs.push(api().pty.onAgentStart(termId, () => {}))
      offs.push(api().pty.onAttention(termId, () => {}))
      offs.push(api().pty.onSessionId(termId, () => {}))
      offs.push(api().pty.onSessionUnbound(termId, () => {}))
    }
    expect(PTY_CHANNELS.map(listenerCount)).toEqual(before)
    for (const off of offs) off()
    // Unsubscribing goes through the shared listener's own bookkeeping, never removeListener.
    expect(mocks.removeListener).not.toHaveBeenCalled()
    expect(PTY_CHANNELS.map(listenerCount)).toEqual(before)
  })

  it('dispatches an emit only to callbacks subscribed for the matching termId', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = api().pty.onData('A', a)
    const offB = api().pty.onData('B', b)

    dispatchHandler(EV.ptyData)(null, { termId: 'A', data: 'hello' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('hello') // `project` maps {termId,data} → [data]
    expect(b).not.toHaveBeenCalled()

    // A termId nobody subscribed is a silent no-op (no throw).
    expect(() => dispatchHandler(EV.ptyData)(null, { termId: 'Z', data: 'x' })).not.toThrow()

    offA()
    offB()
  })

  it('applies the `project` payload→args mapping (exec + agent-start object shapes)', () => {
    const exec = vi.fn()
    const start = vi.fn()
    const offExec = api().pty.onExec('T', exec)
    const offStart = api().pty.onAgentStart('T', start)

    dispatchHandler(EV.ptyExec)(null, { termId: 'T', command: 'ls -a', agentLaunch: false })
    expect(exec).toHaveBeenCalledWith({ command: 'ls -a', agentLaunch: false })

    dispatchHandler(EV.ptyAgentStart)(null, {
      termId: 'T',
      agentId: 'claude',
      agentName: 'Claude',
      command: 'claude',
      cwd: '/w'
    })
    expect(start).toHaveBeenCalledWith({
      agentId: 'claude',
      agentName: 'Claude',
      command: 'claude',
      cwd: '/w'
    })

    offExec()
    offStart()
  })

  it('two callbacks on ONE termId both fire; unsubscribe removes exactly its own', () => {
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = api().pty.onCwd('T', first)
    const offSecond = api().pty.onCwd('T', second)

    dispatchHandler(EV.ptyCwd)(null, { termId: 'T', cwd: '/one' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    offFirst()
    dispatchHandler(EV.ptyCwd)(null, { termId: 'T', cwd: '/two' })
    expect(first).toHaveBeenCalledTimes(1) // gone
    expect(second).toHaveBeenCalledTimes(2) // still delivered
    expect(second).toHaveBeenLastCalledWith('/two')

    offSecond()
  })

  it('a callback that unsubscribes mid-dispatch does not perturb this emit (snapshot iteration)', () => {
    const calls: string[] = []
    let offSelf = (): void => {}
    const selfRemoving = vi.fn(() => {
      calls.push('self')
      offSelf() // unsubscribe from inside the dispatch
    })
    const sibling = vi.fn(() => calls.push('sibling'))
    offSelf = api().pty.onAttention('T', selfRemoving)
    const offSibling = api().pty.onAttention('T', sibling)

    // Both must fire on THIS emit even though the first removes itself while iterating.
    dispatchHandler(EV.ptyAttention)(null, { termId: 'T' })
    expect(calls).toEqual(['self', 'sibling'])

    // The self-removing one is gone next time; the sibling remains.
    dispatchHandler(EV.ptyAttention)(null, { termId: 'T' })
    expect(selfRemoving).toHaveBeenCalledTimes(1)
    expect(sibling).toHaveBeenCalledTimes(2)

    offSibling()
  })
})
