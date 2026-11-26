import { describe, expect, it } from 'vitest'

import type { Group, Project } from '@shared/types'
import { termTabs } from '../../stores/pty-tab-refs'
import { projectEvents, projectFacts, projectRefs, projectUpdates, sameRef, tabsRestored } from './platform-events'

const p = (id: string, name: string, rootPath: string): Project => ({ id, name, rootPath, visibleAgents: ['*'], order: 0 })

describe('projectEvents', () => {
  const before = projectRefs([p('a', 'Alpha', 'Projects/alpha'), p('b', 'Beta', 'Projects/beta')])

  it('an id gone is project.removed with the project as it was; a new id is project.created', () => {
    const after = projectRefs([p('a', 'Alpha', 'Projects/alpha'), p('c', 'Gamma', 'Apps/gamma')])
    expect(projectEvents(before, after)).toEqual([
      { name: 'project.removed', payload: { id: 'b', kind: 'project', name: 'Beta', root: 'Projects/beta' } },
      { name: 'project.created', payload: { id: 'c', kind: 'project', name: 'Gamma', root: 'Apps/gamma' } }
    ])
  })

  it('a changed name or folder is project.renamed with the previous ref', () => {
    const after = projectRefs([p('a', 'Alpha 2', 'Projects/alpha'), p('b', 'Beta', 'Projects/beta-2')])
    expect(projectEvents(before, after)).toEqual([
      {
        name: 'project.renamed',
        payload: {
          project: { id: 'a', kind: 'project', name: 'Alpha 2', root: 'Projects/alpha' },
          previous: { id: 'a', kind: 'project', name: 'Alpha', root: 'Projects/alpha' }
        }
      },
      {
        name: 'project.renamed',
        payload: {
          project: { id: 'b', kind: 'project', name: 'Beta', root: 'Projects/beta-2' },
          previous: { id: 'b', kind: 'project', name: 'Beta', root: 'Projects/beta' }
        }
      }
    ])
  })

  it('nothing changed, nothing to say', () => {
    expect(projectEvents(before, projectRefs([p('b', 'Beta', 'Projects/beta'), p('a', 'Alpha', 'Projects/alpha')]))).toEqual([])
  })
})

describe('projectUpdates', () => {
  const groups: Group[] = [
    { id: 'g1', name: 'Tools', order: 0 },
    { id: 'g2', name: 'Life', order: 1 }
  ]
  const alpha: Project = { ...p('a', 'Alpha', 'Projects/alpha'), groupId: 'g1', visibleAgents: ['claude'] }
  const beta: Project = { ...p('b', 'Beta', 'Projects/beta'), appSettings: { hello: { folder: 'docs', n: 1 } } }
  const before = projectFacts(groups, [alpha, beta], undefined)
  const info = (project: Project, groupId: string | null, groupPath: string[]) => ({
    id: project.id,
    kind: 'project',
    name: project.name,
    root: project.rootPath,
    groupId,
    groupPath
  })

  it('a regroup and an agent-list change are one event to everyone, with the project as it is now', () => {
    const moved = { ...alpha, groupId: 'g2', visibleAgents: ['claude', 'codex'] }
    expect(projectUpdates(before, projectFacts(groups, [moved, beta], undefined))).toEqual([
      { payload: { project: info(moved, 'g2', ['Life']), changes: ['group', 'agents'] }, to: null }
    ])
    const ungrouped = { ...alpha, groupId: undefined }
    expect(projectUpdates(before, projectFacts(groups, [ungrouped, beta], undefined))).toEqual([
      { payload: { project: info(ungrouped, null, []), changes: ['group'] }, to: null }
    ])
  })

  it("a renamed group changes its projects' group path", () => {
    const renamed = [{ ...groups[0], name: 'Tooling' }, groups[1]]
    expect(projectUpdates(before, projectFacts(renamed, [alpha, beta], undefined))).toEqual([
      { payload: { project: info(alpha, 'g1', ['Tooling']), changes: ['group'] }, to: null }
    ])
  })

  it("a settings change goes only to the app whose settings changed; key order is not a change", () => {
    const written = { ...beta, appSettings: { hello: { folder: 'done', n: 1 }, planner: { view: 'board' } } }
    expect(projectUpdates(before, projectFacts(groups, [alpha, written], undefined))).toEqual([
      { payload: { project: info(beta, null, []), changes: ['settings'] }, to: 'hello' },
      { payload: { project: info(beta, null, []), changes: ['settings'] }, to: 'planner' }
    ])
    const cleared = { ...beta, appSettings: undefined }
    expect(projectUpdates(before, projectFacts(groups, [alpha, cleared], undefined))).toEqual([
      { payload: { project: info(beta, null, []), changes: ['settings'] }, to: 'hello' }
    ])
    const reordered = { ...beta, appSettings: { hello: { n: 1, folder: 'docs' } } }
    expect(projectUpdates(before, projectFacts(groups, [alpha, reordered], undefined))).toEqual([])
  })

  it('a rename, a reorder, a new or a removed project is no update', () => {
    const renamed = { ...alpha, name: 'Alpha 2', order: 5 }
    const gamma = p('c', 'Gamma', 'Projects/gamma')
    expect(projectUpdates(before, projectFacts(groups, [renamed, gamma], undefined))).toEqual([])
  })
})

describe('tabsRestored', () => {
  const projects = [p('a', 'Alpha', ''), p('b', 'Beta', '')]
  it('needs the Workspace project and every project hydrated', () => {
    expect(tabsRestored(projects, { __workspace__: true, a: true, b: true })).toBe(true)
    expect(tabsRestored(projects, { __workspace__: true, a: true })).toBe(false)
    expect(tabsRestored(projects, { a: true, b: true })).toBe(false)
    expect(tabsRestored([], { __workspace__: true })).toBe(true)
  })
})

describe('sameRef', () => {
  it('compares every field; null is never the same', () => {
    const r = { id: 'a', kind: 'project' as const, name: 'A', root: 'x' }
    expect(sameRef(r, { ...r })).toBe(true)
    expect(sameRef(r, { ...r, name: 'B' })).toBe(false)
    expect(sameRef(null, r)).toBe(false)
  })
})

describe('termTabs', () => {
  it('maps each terminal and agent tab’s term to its tab and project', () => {
    expect(
      termTabs({
        p1: [
          { id: 't1', kind: 'agent', termId: 'term-1' },
          { id: 'd1', kind: 'doc' },
          { id: 't2', kind: 'terminal', termId: 'term-2' }
        ],
        __workspace__: [{ id: 't3', kind: 'agent', termId: 'term-3' }]
      })
    ).toEqual(
      new Map([
        ['term-1', { tabId: 't1', projectId: 'p1' }],
        ['term-2', { tabId: 't2', projectId: 'p1' }],
        ['term-3', { tabId: 't3', projectId: '__workspace__' }]
      ])
    )
  })
})
