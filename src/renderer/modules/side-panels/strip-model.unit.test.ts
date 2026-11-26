import { describe, expect, it } from 'vitest'

import type { HostedApp, HostedStripIcon } from '@shared/types'
import { appsWithStaleBadges } from '../../stores/apps-store'
import { appStripKey, buildStrip, clickOutcome, FILES_PANEL, launchPanelKeys, resolvePanel, type StripEntry } from './strip-model'

function app(
  id: string,
  strip: Omit<HostedStripIcon, 'iconUrl' | 'iconTint' | 'route'>[],
  extra: Partial<HostedApp> = {}
): HostedApp {
  return {
    id,
    name: id,
    version: '0.1.0',
    source: 'dev-link',
    location: '/x',
    entryUrl: `pomade-app://${id}/index.html`,
    iconUrl: null,
    iconTint: false,
    revision: 0,
    unavailable: null,
    strip: strip.map((s) => ({ ...s, route: '', iconUrl: null, iconTint: false })),
    tabKinds: {},
    launchPanel: null,
    shortcuts: [],
    shortcutConflicts: [],
    backend: null,
    ...extra
  }
}

const BUILTINS = [{ key: FILES_PANEL, title: 'Files' }]
const planner = app('planner', [
  { id: 'planner', title: 'Planner', action: 'panel' },
  { id: 'board', title: 'Board', action: 'both' }
])
const runner = app('runner', [{ id: 'log', title: 'Log', action: 'tab' }])

describe('buildStrip', () => {
  it('puts built-ins first, then each app icon in manifest order', () => {
    expect(buildStrip(BUILTINS, [planner, runner]).map((e) => [e.key, e.action])).toEqual([
      ['files', 'panel'],
      ['app:planner/planner', 'panel'],
      ['app:planner/board', 'both'],
      ['app:runner/log', 'tab']
    ])
  })
  it('leaves out unavailable apps', () => {
    expect(buildStrip(BUILTINS, [{ ...planner, unavailable: 'gone' }]).map((e) => e.key)).toEqual(['files'])
  })
})

describe('resolvePanel', () => {
  const strip = buildStrip(BUILTINS, [planner, runner])
  it.each([
    [undefined, 'files'],
    ['files', 'files'],
    ['app:planner/planner', 'app:planner/planner'],
    ['app:planner/board', 'app:planner/board'],
    ['app:runner/log', 'files'],
    ['app:gone/x', 'files']
  ])('%j resolves to %j', (stored, expected) => {
    expect(resolvePanel(stored, strip)).toBe(expected)
  })
})

describe('clickOutcome', () => {
  const entry = (action: StripEntry['action']): StripEntry => ({
    kind: 'app',
    key: 'k',
    title: 't',
    action,
    appId: 'a',
    icon: 'i'
  })
  it.each([
    ['panel', false, { select: true, openTab: false, expand: false }],
    ['panel', true, { select: true, openTab: false, expand: true }],
    ['tab', false, { select: false, openTab: true, expand: false }],
    ['tab', true, { select: false, openTab: true, expand: false }],
    ['both', false, { select: true, openTab: true, expand: false }],
    ['both', true, { select: true, openTab: true, expand: true }]
  ] as const)('%s (collapsed %s)', (action, collapsed, expected) => {
    expect(clickOutcome(entry(action), collapsed)).toEqual(expected)
  })
})

describe('badges', () => {
  it("an app's badges go when it reloads, becomes unavailable or is removed", () => {
    expect(appsWithStaleBadges([planner], [planner])).toEqual([])
    expect(appsWithStaleBadges([planner], [{ ...planner, revision: 1 }])).toEqual(['planner'])
    expect(appsWithStaleBadges([planner], [{ ...planner, unavailable: 'x' }])).toEqual(['planner'])
    expect(appsWithStaleBadges([planner], [])).toEqual(['planner'])
    expect(appsWithStaleBadges([], [planner])).toEqual([])
  })
})

describe('launchPanelKeys', () => {
  it("is each available app's launch panel, by strip key", () => {
    const a = app('a', [{ id: 'p', title: 'P', action: 'panel' }], { launchPanel: 'p' })
    const b = app('b', [{ id: 'q', title: 'Q', action: 'panel' }])
    const gone = app('c', [{ id: 'r', title: 'R', action: 'panel' }], { launchPanel: 'r', unavailable: 'removed' })
    expect(launchPanelKeys([a, b, gone])).toEqual([appStripKey('a', 'p')])
    expect(launchPanelKeys([])).toEqual([])
  })
})
