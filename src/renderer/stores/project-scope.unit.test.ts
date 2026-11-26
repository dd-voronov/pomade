import { describe, expect, it } from 'vitest'

import type { HostedApp } from '@shared/types'

import { appliedAppScopePaths, inScopeMountPaths } from './project-scope'

const app = (id: string, unavailable: string | null = null): HostedApp => ({ id, unavailable }) as HostedApp

describe('project scope', () => {
  it('in-scope mounts only', () => {
    expect(inScopeMountPaths([{ id: 'a', path: 'A', inScope: true }, { id: 'b', path: 'B' }])).toEqual(['A'])
  })

  it('an app scope folder applies only while its app is hosted and available', () => {
    const folders = [
      { appId: 'planner', path: 'Pomade-Notes/alpha' },
      { appId: 'broken', path: '/x' },
      { appId: 'gone', path: '/y' },
      { appId: 'planner', path: '/notes' }
    ]
    expect(appliedAppScopePaths(folders, [app('planner'), app('broken', 'Invalid manifest')])).toEqual([
      'Pomade-Notes/alpha',
      '/notes'
    ])
    expect(appliedAppScopePaths(folders, [])).toEqual([])
  })
})
