import { describe, expect, it } from 'vitest'

import type { AppBackendStatus } from '@shared/types'
import { backendLines, backendNeedsAttention } from './backend-status'

const s = (patch: Partial<AppBackendStatus>): AppBackendStatus => ({
  mode: 'with-pomade',
  state: 'running',
  detail: 'pid 7',
  pid: 7,
  connected: true,
  ...patch
})

describe('backend status on the strip', () => {
  it('reads a plain state and mode, the detail muted under it', () => {
    expect(backendLines(null)).toEqual([])
    expect(backendLines(s({}))).toEqual(['Background: running (with Pomade)', { text: 'pid 7', muted: true }])
    expect(backendLines(s({ mode: 'always-on', detail: 'connected to Pomade' }))).toEqual([
      'Background: running (always on)',
      { text: 'connected to Pomade', muted: true }
    ])
  })

  it('names every state', () => {
    expect(backendLines(s({ state: 'starting', detail: null }))).toEqual(['Background: starting (with Pomade)'])
    expect(backendLines(s({ state: 'stopped', detail: 'exited with code 1' }))[0]).toBe('Background: stopped (with Pomade)')
    expect(backendLines(s({ state: 'restarting', detail: 'exited with code 1 · crash 2' }))).toEqual([
      'Background: crashed — restarting (with Pomade)',
      { text: 'exited with code 1 · crash 2', muted: true }
    ])
  })

  it('warns only when it is down', () => {
    expect(backendNeedsAttention(null)).toBe(false)
    expect(backendNeedsAttention(s({}))).toBe(false)
    expect(backendNeedsAttention(s({ state: 'starting' }))).toBe(false)
    expect(backendNeedsAttention(s({ state: 'restarting' }))).toBe(true)
    expect(backendNeedsAttention(s({ state: 'stopped' }))).toBe(true)
  })
})
