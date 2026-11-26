import { describe, expect, it } from 'vitest'

import type { Project } from '@shared/types'

import {
  admitToast,
  appendNotice,
  moreTarget,
  NOTICES_MAX,
  noticeProject,
  projectLabel,
  selectOnClick,
  unreadCounts,
  withoutNotices,
  withPostingProject,
  type Notice
} from './notice-model'

const n = (id: string, source = 'runner', read = false, projectId = 'alpha'): Notice => ({ id, source, title: id, projectId, postedAt: 0, read })

describe('notice list', () => {
  it('appends, keeping the newest NOTICES_MAX', () => {
    let list: Notice[] = []
    for (let i = 0; i < NOTICES_MAX + 3; i++) list = appendNotice(list, n(`n${i}`))
    expect(list).toHaveLength(NOTICES_MAX)
    expect(list[0]!.id).toBe('n3')
    expect(list[list.length - 1]!.id).toBe(`n${NOTICES_MAX + 2}`)
  })
  it('counts the unread, from unmuted and from muted sources', () => {
    expect(unreadCounts([n('a'), n('b', 'x', true), n('c')])).toEqual({ unmuted: 2, muted: 0 })
    expect(unreadCounts([n('a'), n('b', 'git'), n('c'), n('d', 'git', true)], ['git'])).toEqual({ unmuted: 2, muted: 1 })
  })
})

describe('toasts', () => {
  it('a notice gets its own toast', () => {
    expect(admitToast([], n('a'), 't1')).toEqual([{ id: 't1', source: 'runner', noticeId: 'a', more: 0, projects: ['alpha'], seq: 0 }])
  })
  it('a burst from one source is one toast showing the newest, counting the rest', () => {
    let toasts = admitToast([], n('a'), 't1')
    toasts = admitToast(toasts, n('x', 'git'), 't2')
    for (const id of ['b', 'c', 'd', 'e', 'f']) toasts = admitToast(toasts, n(id), `t-${id}`)
    expect(toasts).toEqual([
      { id: 't1', source: 'runner', noticeId: 'f', more: 5, projects: ['alpha'], seq: 5 },
      { id: 't2', source: 'git', noticeId: 'x', more: 0, projects: ['alpha'], seq: 0 }
    ])
  })
  it('a muted source gets no toast', () => {
    expect(admitToast([], n('a', 'git'), 't1', ['git'])).toEqual([])
  })
})

describe('the posting project', () => {
  it('an action without a project belongs to the one it was posted from', () => {
    expect(withPostingProject({ kind: 'openApp', route: 'roadmap' }, 'gamma')).toEqual({ kind: 'openApp', route: 'roadmap', projectId: 'gamma' })
    expect(withPostingProject({ kind: 'openFile', path: 'a.md' }, 'gamma')).toEqual({ kind: 'openFile', path: 'a.md', projectId: 'gamma' })
  })
  it('a named project stays; no action stays none', () => {
    expect(withPostingProject({ kind: 'openTerminal', cwd: 'x', projectId: 'beta' }, 'gamma')).toEqual({ kind: 'openTerminal', cwd: 'x', projectId: 'beta' })
    expect(withPostingProject(undefined, 'gamma')).toBeUndefined()
  })
})

describe('a notice\'s project', () => {
  it('is the project its action names, else the one it was posted from', () => {
    expect(noticeProject({ kind: 'openApp', projectId: 'beta' }, 'gamma')).toBe('beta')
    expect(noticeProject({ kind: 'openApp' }, 'gamma')).toBe('gamma')
    expect(noticeProject(undefined, 'gamma')).toBe('gamma')
  })
  it('shows as the project\'s name; the Workspace project as "Workspace"; an unknown or missing project as nothing', () => {
    const projects = [{ id: 'p1', name: 'Gamma' }] as Project[]
    expect(projectLabel('p1', projects)).toBe('Gamma')
    expect(projectLabel('__workspace__', projects)).toBe('Workspace')
    expect(projectLabel('gone', projects)).toBeNull()
    expect(projectLabel(undefined, projects)).toBeNull()
  })
  it('a burst keeps the distinct projects of every notice it holds', () => {
    let toasts = admitToast([], n('a', 'runner', false, 'gamma'), 't1')
    toasts = admitToast(toasts, n('b', 'runner', false, 'gamma'), 't2')
    expect(toasts[0]!.projects).toEqual(['gamma'])
    expect(moreTarget(toasts[0]!)).toBe('gamma')
    toasts = admitToast(toasts, n('c', 'runner', false, 'alpha'), 't3')
    toasts = admitToast(toasts, n('d', 'runner', false, 'gamma'), 't4')
    expect(toasts[0]!.projects).toEqual(['gamma', 'alpha'])
    expect(moreTarget(toasts[0]!)).toBeNull()
  })
})

describe('deleting notices', () => {
  it('removes the notices and a toast showing one of them', () => {
    const toasts = [
      { id: 't1', source: 'runner', noticeId: 'b', more: 1, projects: ['alpha'], seq: 1 },
      { id: 't2', source: 'git', noticeId: 'c', more: 0, projects: ['alpha'], seq: 0 }
    ]
    expect(withoutNotices([n('a'), n('b'), n('c', 'git')], toasts, ['a', 'b'])).toEqual({ notices: [n('c', 'git')], toasts: [toasts[1]] })
  })
})

describe('panel selection', () => {
  const order = ['e', 'd', 'c', 'b', 'a']
  const none = { ids: [], anchor: null }
  it('a plain click is no selection click', () => {
    expect(selectOnClick({ ids: ['d'], anchor: 'd' }, 'c', order, { cmd: false, shift: false })).toBeNull()
  })
  it('Cmd toggles a row and moves the anchor', () => {
    const one = selectOnClick(none, 'd', order, { cmd: true, shift: false })!
    expect(one).toEqual({ ids: ['d'], anchor: 'd' })
    const two = selectOnClick(one, 'b', order, { cmd: true, shift: false })!
    expect(two).toEqual({ ids: ['d', 'b'], anchor: 'b' })
    expect(selectOnClick(two, 'd', order, { cmd: true, shift: false })).toEqual({ ids: ['b'], anchor: 'd' })
  })
  it('Shift selects the range from the anchor, either way; Cmd+Shift adds it', () => {
    expect(selectOnClick({ ids: ['d'], anchor: 'd' }, 'b', order, { cmd: false, shift: true })).toEqual({ ids: ['d', 'c', 'b'], anchor: 'd' })
    expect(selectOnClick({ ids: ['b'], anchor: 'b' }, 'e', order, { cmd: false, shift: true })).toEqual({ ids: ['e', 'd', 'c', 'b'], anchor: 'b' })
    expect(selectOnClick({ ids: ['a'], anchor: 'c' }, 'd', order, { cmd: true, shift: true })).toEqual({ ids: ['a', 'd', 'c'], anchor: 'c' })
    expect(selectOnClick(none, 'c', order, { cmd: false, shift: true })).toEqual({ ids: ['c'], anchor: 'c' })
  })
})
