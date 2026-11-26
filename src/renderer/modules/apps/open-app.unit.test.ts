import { describe, expect, it } from 'vitest'

import type { HostedApp, Tab } from '@shared/types'
import { appTabRetitles, appTabTitle, iconForRoute, keyedAppTab, recordedRoute } from './open-app'

const app = {
  id: 'planner',
  tabKinds: {},
  strip: [
    { id: 'panel', title: 'Planner', action: 'panel', route: 'today', iconUrl: null },
    { id: 'board', title: 'Board', action: 'both', route: 'board', panelRoute: 'needs-you', iconUrl: null },
    { id: 'log', title: 'Log', action: 'tab', route: 'log', iconUrl: null },
    { id: 'log2', title: 'Log 2', action: 'tab', route: 'log', iconUrl: null }
  ]
} as unknown as HostedApp

describe('iconForRoute', () => {
  it('is the first tab-opening icon whose route matches', () => {
    expect(iconForRoute(app, 'board')).toBe('board')
    expect(iconForRoute(app, 'log')).toBe('log')
  })
  it('never a panel-only icon, never a panelRoute', () => {
    expect(iconForRoute(app, 'today')).toBeUndefined()
    expect(iconForRoute(app, 'needs-you')).toBeUndefined()
  })
  it('none for other routes, "" included when no icon declares it', () => {
    expect(iconForRoute(app, 'planner/today')).toBeUndefined()
    expect(iconForRoute(app, '')).toBeUndefined()
  })
})

describe('recordedRoute', () => {
  it("T-269 — the tab's recorded route, else its icon's, else the default view", () => {
    expect(recordedRoute(app, { icon: 'board', route: 'board/card/3' })).toBe('board/card/3')
    expect(recordedRoute(app, { icon: 'board', route: '' })).toBe('')
    expect(recordedRoute(app, { icon: 'board' })).toBe('board')
    expect(recordedRoute(app, { route: 'card/1' })).toBe('card/1')
    expect(recordedRoute(app, {})).toBe('')
    expect(recordedRoute(app, { icon: 'gone' })).toBe('')
  })
})

describe('appTabTitle', () => {
  it("is the icon's title, the app's name without an icon, null for an icon the manifest dropped", () => {
    const named = { ...app, name: 'Planner app' } as HostedApp
    expect(appTabTitle(named, { icon: 'board' })).toBe('Board')
    expect(appTabTitle(named, {})).toBe('Planner app')
    expect(appTabTitle(named, { icon: 'gone' })).toBeNull()
  })
  it("T-268 — a keyed tab's is its kind's title, else the app's name (no kind, a dropped kind)", () => {
    const named = { ...app, name: 'Runner', tabKinds: { output: { title: 'Output', iconUrl: null, iconTint: false } } } as HostedApp
    expect(appTabTitle(named, { key: 'output:r1', tabKind: 'output' })).toBe('Output')
    expect(appTabTitle(named, { key: 'output:r1' })).toBe('Runner')
    expect(appTabTitle(named, { key: 'output:r1', tabKind: 'gone' })).toBe('Runner')
    expect(appTabTitle(named, { key: 'output:r1', tabKind: 'toString' })).toBe('Runner')
  })
})

describe('appTabRetitles', () => {
  const live = { ...app, name: 'Planner', unavailable: null } as HostedApp
  const tab = (id: string, extra: Record<string, unknown>): Tab =>
    ({ id, projectId: 'p', kind: 'app', appId: 'planner', title: 'Old', ...extra }) as unknown as Tab

  it('retitles tabs whose icon (or app) title changed, in every project', () => {
    const out = appTabRetitles(
      {
        p1: [tab('a', { icon: 'board' }), tab('b', { icon: 'log', title: 'Log' })],
        p2: [tab('c', {})]
      },
      [live]
    )
    expect(out).toEqual([
      { projectId: 'p1', tabId: 'a', title: 'Board' },
      { projectId: 'p2', tabId: 'c', title: 'Planner' }
    ])
  })

  it("T-268 — a keyed tab follows its kind's title, an app-titled one keeps the app's", () => {
    const kinds = { ...live, tabKinds: { output: { title: 'Output', iconUrl: null, iconTint: false } } } as HostedApp
    const out = appTabRetitles(
      {
        p: [
          tab('a', { key: 'a', tabKind: 'output' }),
          tab('b', { key: 'b', tabKind: 'output', title: 'Scraper · output', appTitled: true }),
          tab('c', { key: 'c', tabKind: 'gone', title: 'Output' }),
          tab('d', { key: 'd', tabKind: 'output', title: 'Mine', renamed: true })
        ]
      },
      [kinds]
    )
    expect(out).toEqual([
      { projectId: 'p', tabId: 'a', title: 'Output' },
      { projectId: 'p', tabId: 'c', title: 'Planner' }
    ])
  })

  it('leaves renamed tabs, dropped icons, unavailable or unknown apps, and other kinds alone', () => {
    const down = { ...live, unavailable: 'gone' } as HostedApp
    const tabs = {
      p: [
        tab('a', { icon: 'board', renamed: true }),
        tab('b', { icon: 'gone' }),
        tab('c', { appId: 'other' }),
        { id: 'd', projectId: 'p', kind: 'doc', title: 'x', path: 'x', mode: 'raw' } as Tab
      ]
    }
    expect(appTabRetitles(tabs, [live])).toEqual([])
    expect(appTabRetitles({ p: [tab('e', { icon: 'board' })] }, [down])).toEqual([])
  })
})

describe('keyedAppTab', () => {
  const t = (id: string, extra: Record<string, unknown>): Tab =>
    ({ id, projectId: 'p', kind: 'app', appId: 'runner', title: 'x', ...extra }) as unknown as Tab

  it("T-268 — matches the app's tab with that key only: not another app's, not the icon-less or an icon's tab", () => {
    const tabs = [
      t('icon-less', { route: 'a' }),
      t('icon', { icon: 'a' }),
      t('other-app', { appId: 'planner', key: 'a' }),
      t('b', { key: 'b' }),
      t('a', { key: 'a' }),
      { id: 'doc', projectId: 'p', kind: 'doc', title: 'a', path: 'a', mode: 'raw' } as Tab
    ]
    expect(keyedAppTab(tabs, 'runner', 'a')?.id).toBe('a')
    expect(keyedAppTab(tabs, 'runner', 'b')?.id).toBe('b')
    expect(keyedAppTab(tabs, 'planner', 'a')?.id).toBe('other-app')
    expect(keyedAppTab(tabs, 'runner', 'c')).toBeUndefined()
    // Per project: another project's tabs are another list.
    expect(keyedAppTab([], 'runner', 'a')).toBeUndefined()
  })
})
