import { describe, expect, it } from 'vitest'

import { gateMethod } from './host-api-core'
import { DATA_METHODS, parseDataParams } from './host-api-data-core'

describe('E-030 git state params and capability', () => {
  it('git.* need git.read and nothing else grants them', () => {
    const git = ['git.getState', 'git.watch', 'git.unwatch'] as const
    expect(DATA_METHODS).toEqual(expect.arrayContaining([...git]))
    for (const m of git) {
      expect(gateMethod(m, ['git.read']).ok).toBe(true)
      const denied = gateMethod(m, ['project.read', 'files.read', 'files.write', 'tabs.open', 'project.write', 'files.symlink'])
      expect(denied).toMatchObject({ ok: false, error: { code: 'capability-denied' } })
    }
  })

  it('getState / watch take an optional projectId; unwatch a watchId; unknown keys are dropped', () => {
    expect(parseDataParams('git.getState', undefined)).toEqual({ ok: true, params: {} })
    expect(parseDataParams('git.getState', { projectId: 'p1', extra: 1 })).toEqual({ ok: true, params: { projectId: 'p1' } })
    expect(parseDataParams('git.watch', {})).toEqual({ ok: true, params: {} })
    expect(parseDataParams('git.watch', { projectId: '__workspace__' })).toEqual({
      ok: true,
      params: { projectId: '__workspace__' }
    })
    expect(parseDataParams('git.unwatch', { watchId: 'g1' })).toEqual({ ok: true, params: { watchId: 'g1' } })
  })

  it.each<[Parameters<typeof parseDataParams>[0], unknown]>([
    ['git.getState', { projectId: 7 }],
    ['git.watch', { projectId: null }],
    ['git.unwatch', {}],
    ['git.unwatch', { watchId: 1 }],
    ['git.getState', 'p1']
  ])('%s %j is invalid-params', (method, params) => {
    expect(parseDataParams(method, params)).toMatchObject({ ok: false, error: { code: 'invalid-params' } })
  })
})
