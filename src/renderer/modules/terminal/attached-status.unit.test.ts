import { describe, expect, it } from 'vitest'
import type { SessionInfo } from 'pomade-kit/protocol'

import { attachedStatus, exitLabel } from './attached-status'

const info = (patch: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 's',
  title: 'Coda web',
  command: 'npm run dev',
  cwd: '/w',
  pid: 42,
  startedAt: 1,
  cols: 80,
  rows: 24,
  state: 'running',
  exit: null,
  clients: 1,
  actions: [],
  ...patch
})

describe('attachedStatus', () => {
  it('says where the connection stands before the session', () => {
    expect(attachedStatus({ kind: 'connecting' }, null, 'Runner', false).label).toBe('Attaching…')
    expect(attachedStatus({ kind: 'connecting' }, info(), 'Runner', true).label).toBe('Reconnecting…')
    expect(attachedStatus({ kind: 'unreachable', reason: 'ENOENT' }, null, 'Runner', false)).toMatchObject({ label: 'Keeper not running', tone: 'warning' })
    expect(attachedStatus({ kind: 'gone' }, null, 'Runner', false)).toMatchObject({ label: 'Session not found', tone: 'warning' })
    expect(attachedStatus({ kind: 'rejected', message: 'no' }, null, 'Runner', false)).toMatchObject({ label: 'Refused', tone: 'danger' })
  })

  it('a running session, and the latest info over the attach-time one', () => {
    expect(attachedStatus({ kind: 'attached', info: info() }, null, 'Runner', true)).toMatchObject({ label: 'Running', tone: 'live' })
    const ended = info({ state: 'exited', pid: null, exit: { code: 130, signal: 'SIGINT', reason: 'stopped-by-you', at: 1 } })
    expect(attachedStatus({ kind: 'attached', info: info() }, ended, 'Runner', true)).toMatchObject({ label: 'Stopped by you', tone: 'muted' })
  })

  it.each([
    [{ code: 0, signal: null, reason: 'exited' as const }, 'Exited'],
    [{ code: 3, signal: null, reason: 'crashed' as const }, 'Crashed · code 3'],
    [{ code: null, signal: 'SIGKILL', reason: 'crashed' as const }, 'Crashed · SIGKILL'],
    [{ code: 143, signal: 'SIGTERM', reason: 'stopped' as const }, 'Stopped'],
    [{ code: 143, signal: 'SIGTERM', reason: 'time-limit' as const }, 'Stopped · time limit'],
    [{ code: null, signal: null, reason: 'lost-in-keeper-crash' as const }, 'Lost · keeper crashed']
  ])('exit %j → %s', (exit, label) => {
    expect(exitLabel({ ...exit, at: 1 }).label).toBe(label)
  })
})
