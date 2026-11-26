import { describe, expect, it } from 'vitest'

import type { Group, Project } from '@shared/types'
import { buildProjectList } from './project-list'

const g = (id: string, name: string, order: number, parentId?: string): Group => ({
  id,
  name,
  order,
  ...(parentId ? { parentId } : {})
})
const p = (id: string, name: string, order: number, groupId?: string): Project => ({
  id,
  name,
  rootPath: `Projects/${name}`,
  visibleAgents: ['*'],
  order,
  ...(groupId ? { groupId } : {})
})

describe('buildProjectList', () => {
  const groups = [g('life', 'Life', 1), g('build', 'Building tools', 0), g('tools', 'Tools', 0, 'build'), g('deep', 'Deep', 1, 'build')]
  const projects = [
    p('home', 'Home', 0, 'life'),
    p('pomade', 'Pomade', 1, 'tools'),
    p('kit', 'pomade-kit', 0, 'tools'),
    p('cli', 'cli', 0, 'build'),
    p('loose', 'Loose', 0),
    p('deep1', 'Deep one', 0, 'deep')
  ]

  it('walks the Projects panel order: a group, its projects, then its sub-groups; Ungrouped last by default', () => {
    const r = buildProjectList(groups, projects, undefined)
    expect(r.workspace).toEqual({ id: '__workspace__', kind: 'workspace', name: 'Workspace', root: '' })
    expect(r.groups).toEqual([
      { id: 'build', name: 'Building tools', parentId: null, path: ['Building tools'] },
      { id: 'tools', name: 'Tools', parentId: 'build', path: ['Building tools', 'Tools'] },
      { id: 'deep', name: 'Deep', parentId: 'build', path: ['Building tools', 'Deep'] },
      { id: 'life', name: 'Life', parentId: null, path: ['Life'] }
    ])
    expect(r.projects.map((x) => [x.id, x.groupId, x.groupPath.join(' › ')])).toEqual([
      ['cli', 'build', 'Building tools'],
      ['kit', 'tools', 'Building tools › Tools'],
      ['pomade', 'tools', 'Building tools › Tools'],
      ['deep1', 'deep', 'Building tools › Deep'],
      ['home', 'life', 'Life'],
      ['loose', null, '']
    ])
    expect(r.projects[1]).toEqual({
      id: 'kit',
      kind: 'project',
      name: 'pomade-kit',
      root: 'Projects/pomade-kit',
      groupId: 'tools',
      groupPath: ['Building tools', 'Tools']
    })
  })

  it('places Ungrouped at its stored top-level position', () => {
    const r = buildProjectList(groups, projects, 0.5)
    expect(r.projects.map((x) => x.id)).toEqual(['cli', 'kit', 'pomade', 'deep1', 'loose', 'home'])
  })

  it('an empty workspace lists nothing but the Workspace project', () => {
    expect(buildProjectList([], [], undefined)).toEqual({
      workspace: { id: '__workspace__', kind: 'workspace', name: 'Workspace', root: '' },
      groups: [],
      projects: []
    })
  })
})
