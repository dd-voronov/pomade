import { describe, expect, it } from 'vitest'

import type { Tab } from '@shared/types'
import { combinedMark, projectRowCounts, projectRowTarget, stripTarget, tabAttentionCounts, withMark, withoutSource, type Marks } from './marks-store'

describe('marks', () => {
  const icon = stripTarget('app:planner/board')

  it('sets, updates and clears one source on a target; unchanged is the same object', () => {
    const a = withMark({}, icon, 'app:planner', { count: 3, urgent: false })
    expect(a).toEqual({ [icon]: { 'app:planner': { count: 3, urgent: false } } })
    expect(withMark(a, icon, 'app:planner', { count: 3, urgent: false })).toBe(a)
    const b = withMark(a, icon, 'app:planner', { count: 4, urgent: true })
    expect(combinedMark(b, icon)).toEqual({ count: 4, urgent: true })
    expect(withMark(b, icon, 'app:planner', { count: 0, urgent: true })).toEqual({})
    expect(withMark(b, icon, 'app:planner', null)).toEqual({})
    const empty: Marks = {}
    expect(withMark(empty, icon, 'x', null)).toBe(empty)
  })

  it('combines sources: counts summed, urgent if any is', () => {
    let m: Marks = {}
    m = withMark(m, stripTarget('git'), 'git', { count: 1, urgent: true })
    m = withMark(m, stripTarget('git'), 'app:runner', { count: 2, urgent: false })
    expect(combinedMark(m, stripTarget('git'))).toEqual({ count: 3, urgent: true })
    expect(combinedMark(m, stripTarget('files'))).toBeUndefined()
  })

  it('quiet only when every source is: a quiet mark alone is grey, one loud source makes it loud', () => {
    const t = stripTarget('notices')
    let m: Marks = withMark({}, t, 'notices-muted', { count: 2, urgent: false, quiet: true })
    expect(combinedMark(m, t)).toEqual({ count: 2, urgent: false, quiet: true })
    expect(withMark(m, t, 'notices-muted', { count: 2, urgent: false, quiet: true })).toBe(m)
    expect(withMark(m, t, 'notices-muted', { count: 2, urgent: false })).not.toBe(m)
    m = withMark(m, t, 'notices', { count: 1, urgent: false })
    expect(combinedMark(m, t)).toEqual({ count: 3, urgent: false })
    m = withMark(m, t, 'notices', { count: 0, urgent: false })
    expect(combinedMark(m, t)).toEqual({ count: 2, urgent: false, quiet: true })
  })

  it('clearing a source removes its marks everywhere, keeping the others', () => {
    let m: Marks = {}
    m = withMark(m, icon, 'app:planner', { count: 1, urgent: false })
    m = withMark(m, stripTarget('app:planner/today'), 'app:planner', { count: 2, urgent: false })
    m = withMark(m, icon, 'notices', { count: 5, urgent: false })
    expect(withoutSource(m, 'app:planner')).toEqual({ [icon]: { notices: { count: 5, urgent: false } } })
    expect(withoutSource(m, 'nobody')).toBe(m)
  })
})

describe('project rows', () => {
  const tab = (id: string, attention?: boolean): Tab =>
    ({ id, projectId: 'p', kind: 'doc', title: id, path: id, mode: 'raw', dirty: false, ...(attention ? { attention } : {}) }) as Tab

  it('terminal attention is the derived source: dotted tabs per project', () => {
    expect(tabAttentionCounts({ a: [tab('1', true), tab('2'), tab('3', true)], b: [tab('4')] })).toEqual({ a: 2 })
  })

  it('without row marks the counts are the tab counts themselves; with them, added', () => {
    const fromTabs = { a: 2 }
    expect(projectRowCounts(fromTabs, {})).toBe(fromTabs)
    expect(projectRowCounts(fromTabs, withMark({}, stripTarget('git'), 'git', { count: 1, urgent: true }))).toBe(fromTabs)
    const marks = withMark(withMark({}, projectRowTarget('a'), 'git', { count: 1, urgent: true }), projectRowTarget('b'), 'git', { count: 3, urgent: false })
    expect(projectRowCounts(fromTabs, marks)).toEqual({ a: 3, b: 3 })
  })
})
