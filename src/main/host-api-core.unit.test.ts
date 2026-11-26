import { describe, expect, it } from 'vitest'

import { classifyChanges, gateMethod, negotiate, parseOpenAppParams, parseParams, watchCovers, workspacePath } from './host-api-core'

describe('negotiate', () => {
  it('welcomes an exact match and rejects both directions', () => {
    expect(negotiate(0)).toBe('welcome')
    expect(negotiate(1)).toBe('needs-newer-pomade')
    expect(negotiate(-1)).toBe('app-too-old')
  })
  it.each(['0', 0.5, undefined, null, NaN])('ignores a non-integer hostApi (%j)', (v) => {
    expect(negotiate(v)).toBe('ignore')
  })
})

describe('gateMethod', () => {
  it('lets host.info through without capabilities', () => {
    expect(gateMethod('host.info', [])).toEqual({ ok: true, method: 'host.info' })
  })
  it('denies a method whose capability is not declared', () => {
    const r = gateMethod('files.readFolder', ['project.read'])
    expect(!r.ok && r.error.code).toBe('capability-denied')
  })
  it('lets strip.setBadge through without capabilities', () => {
    expect(gateMethod('strip.setBadge', [])).toEqual({ ok: true, method: 'strip.setBadge' })
  })
  it('allows a declared capability', () => {
    expect(gateMethod('files.watch', ['files.read']).ok).toBe(true)
  })
  it.each(['files.erase', 'toString', '__proto__', 7])('refuses unknown method %j', (m) => {
    const r = gateMethod(m, ['files.read', 'project.read'])
    expect(!r.ok && r.error.code).toBe('unknown-method')
  })
})

describe('parseParams', () => {
  it('accepts omitted params for parameterless methods', () => {
    expect(parseParams('project.getActive', undefined).ok).toBe(true)
  })
  it('normalizes the path and drops unknown keys', () => {
    expect(parseParams('files.readFolder', { path: 'a/./b/', recursive: true, extra: 1 })).toEqual({
      ok: true,
      params: { path: 'a/b', recursive: true }
    })
  })
  it('rejects an escaping path as outside-workspace', () => {
    const r = parseParams('files.readFolder', { path: '../x' })
    expect(!r.ok && r.error.code).toBe('outside-workspace')
  })
  it('reads a badge, dropping unknown keys and a false urgent', () => {
    expect(parseParams('strip.setBadge', { icon: 'p', count: 3, urgent: true, color: 'x' })).toEqual({
      ok: true,
      params: { icon: 'p', count: 3, urgent: true }
    })
    expect(parseParams('strip.setBadge', { icon: 'p', count: 0, urgent: false })).toEqual({
      ok: true,
      params: { icon: 'p', count: 0 }
    })
  })
  it('reads tabs.openApp: route defaults to "", projectId only when given, unknown keys dropped', () => {
    expect(parseOpenAppParams(undefined, {})).toEqual({ ok: true, params: { route: '' } })
    expect(parseOpenAppParams({ route: 'planner/today', projectId: 'p1', x: 1 }, {})).toEqual({
      ok: true,
      params: { route: 'planner/today', projectId: 'p1' }
    })
  })
  it('T-268 — reads a keyed tabs.openApp: key, trimmed title, a kind the manifest declares', () => {
    const kinds = { output: { title: 'Output', icon: 'output.svg' } }
    expect(
      parseOpenAppParams({ key: 'output:r1', kind: 'output', title: ' Scraper · output ', route: 'output/r1', projectId: 'p1' }, kinds)
    ).toEqual({
      ok: true,
      params: { route: 'output/r1', projectId: 'p1', key: 'output:r1', title: 'Scraper · output', kind: 'output' }
    })
  })
  it.each<[string, unknown]>([
    ['route not a string', { route: 1 }],
    ['projectId not a string', { projectId: 7 }],
    ['params not an object', 'board'],
    ['a key with a slash', { key: 'a/b' }],
    ['a key over 128 characters', { key: 'k'.repeat(129) }],
    ['kind without key', { kind: 'output' }],
    ['title without key', { title: 'A' }],
    ['an unknown kind', { key: 'a', kind: 'log' }],
    ['a blank title', { key: 'a', title: '  ' }]
  ])('T-268 — tabs.openApp with %s is invalid-params', (_label, params) => {
    const r = parseOpenAppParams(params, { output: { title: 'Output' } })
    expect(r.ok ? null : r.error.code).toBe('invalid-params')
  })
  it('T-269 — reads tabs.setRoute: any string route, "" included; anything else is invalid-params', () => {
    expect(parseParams('tabs.setRoute', { route: '', x: 1 })).toEqual({ ok: true, params: { route: '' } })
    expect(parseParams('tabs.setRoute', { route: 'card/1' })).toEqual({ ok: true, params: { route: 'card/1' } })
    for (const bad of [{}, { route: 1 }, { route: null }]) {
      const r = parseParams('tabs.setRoute', bad)
      expect(!r.ok && r.error.code).toBe('invalid-params')
    }
  })

  it('T-268 — reads tabs.setTitle (title trimmed, not blank) and tabs.close', () => {
    expect(parseParams('tabs.setTitle', { title: ' Deploy · output ', x: 1 })).toEqual({ ok: true, params: { title: 'Deploy · output' } })
    expect(parseParams('tabs.close', undefined)).toEqual({ ok: true, params: {} })
    for (const bad of [{}, { title: '' }, { title: ' ' }, { title: 3 }]) {
      const r = parseParams('tabs.setTitle', bad)
      expect(r.ok ? null : r.error.code).toBe('invalid-params')
    }
  })
  it('reads overlay.open: route defaults to "", height rounded to whole pixels, anchor as given, unknown keys dropped', () => {
    expect(parseParams('overlay.open', undefined)).toEqual({ ok: true, params: { route: '' } })
    expect(parseParams('overlay.open', { route: 'quick-add', x: 1 })).toEqual({ ok: true, params: { route: 'quick-add' } })
    expect(parseParams('overlay.open', { height: 260.6, anchor: 'panel' })).toEqual({
      ok: true,
      params: { route: '', height: 261, anchor: 'panel' }
    })
    expect(parseParams('overlay.open', { height: 0.2, anchor: 'center' })).toEqual({
      ok: true,
      params: { route: '', height: 1, anchor: 'center' }
    })
  })
  it('T-325 — reads panel.show: icon and route optional strings, "" a route, unknown keys dropped', () => {
    expect(parseParams('panel.show', undefined)).toEqual({ ok: true, params: {} })
    expect(parseParams('panel.show', { route: 'note/7', x: 1 })).toEqual({ ok: true, params: { route: 'note/7' } })
    expect(parseParams('panel.show', { icon: 'both', route: '' })).toEqual({ ok: true, params: { icon: 'both', route: '' } })
  })
  it('reads overlay.resize: a height in whole pixels, at least 1', () => {
    expect(parseParams('overlay.resize', { height: 300.4, x: 1 })).toEqual({ ok: true, params: { height: 300 } })
    expect(parseParams('overlay.resize', { height: 0.1 })).toEqual({ ok: true, params: { height: 1 } })
  })
  it('reads state keys and JSON values, dropping unknown keys; null is a value (removal)', () => {
    expect(parseParams('state.get', { key: 'view.p1', extra: 1 })).toEqual({ ok: true, params: { key: 'view.p1' } })
    expect(parseParams('state.set', { key: 'pins', value: ['a', { b: null }], extra: 1 })).toEqual({
      ok: true,
      params: { key: 'pins', value: ['a', { b: null }] }
    })
    expect(parseParams('state.set', { key: 'pins', value: null })).toEqual({ ok: true, params: { key: 'pins', value: null } })
  })
  it.each([
    ['files.readFolder', {}],
    ['files.readFolder', { path: 'a', recursive: 'yes' }],
    ['files.watch', 'a'],
    ['files.unwatch', { watchId: 3 }],
    ['strip.setBadge', {}],
    ['strip.setBadge', { icon: 1, count: 1 }],
    ['strip.setBadge', { icon: 'p' }],
    ['strip.setBadge', { icon: 'p', count: -1 }],
    ['strip.setBadge', { icon: 'p', count: 1.5 }],
    ['strip.setBadge', { icon: 'p', count: '3' }],
    ['strip.setBadge', { icon: 'p', count: 3, urgent: 'yes' }],
    ['state.get', {}],
    ['state.get', { key: '' }],
    ['state.get', { key: 7 }],
    ['state.set', { key: 'k' }],
    ['state.set', { value: 1 }],
    ['state.set', { key: 'k', value: NaN }],
    ['state.set', { key: 'k', value: { at: new Date(0) } }],
    ['state.set', { key: 'k'.repeat(201), value: 1 }],
    ['overlay.open', { route: 7 }],
    ['overlay.open', 'quick-add'],
    ['overlay.open', { height: 0 }],
    ['overlay.open', { height: -3 }],
    ['overlay.open', { height: '300' }],
    ['overlay.open', { height: Number.POSITIVE_INFINITY }],
    ['overlay.open', { anchor: 'left' }],
    ['overlay.open', { anchor: 1 }],
    ['overlay.resize', {}],
    ['overlay.resize', { height: 0 }],
    ['overlay.resize', { height: 'tall' }],
    ['overlay.resize', 'tall'],
    ['panel.show', { icon: 1 }],
    ['panel.show', { route: 7 }],
    ['panel.show', { route: null }],
    ['panel.show', 'note/7']
  ] as const)('rejects malformed %s params', (method, params) => {
    const r = parseParams(method, params)
    expect(!r.ok && r.error.code).toBe('invalid-params')
  })
})

describe('watchCovers', () => {
  it('matches the path, direct children, and descendants only when recursive', () => {
    expect(watchCovers('a', false, 'a')).toBe(true)
    expect(watchCovers('a', false, 'a/x.md')).toBe(true)
    expect(watchCovers('a', false, 'a/done/x.md')).toBe(false)
    expect(watchCovers('a', true, 'a/done/x.md')).toBe(true)
    expect(watchCovers('a', true, 'ab/x.md')).toBe(false)
    expect(watchCovers('', false, 'x.md')).toBe(true)
    expect(watchCovers('', false, 'a/x.md')).toBe(false)
  })
})

describe('classifyChanges', () => {
  const o = (path: string, structural: boolean, present: boolean, isDir = false) => ({ path, structural, present, isDir })
  it('maps presence and event kind', () => {
    expect(classifyChanges([o('a.md', true, true), o('b.md', false, true), o('c.md', true, false)])).toEqual([
      { kind: 'create', path: 'a.md' },
      { kind: 'change', path: 'b.md' },
      { kind: 'delete', path: 'c.md' }
    ])
  })
  it('reports a folder rename as one rename', () => {
    expect(classifyChanges([o('old', true, false), o('new', true, true, true)])).toEqual([
      { kind: 'rename', path: 'new', oldPath: 'old' }
    ])
  })
  it('keeps a file delete + create as the pair', () => {
    expect(classifyChanges([o('old.md', true, false), o('new.md', true, true)])).toEqual([
      { kind: 'delete', path: 'old.md' },
      { kind: 'create', path: 'new.md' }
    ])
  })
})

describe('workspacePath', () => {
  it('normalizes with the kit rule', () => {
    expect(workspacePath('./Projects//alpha/../beta/')).toEqual({ ok: true, path: 'Projects/beta' })
    expect(workspacePath('')).toEqual({ ok: true, path: '' })
  })
  it.each(['..', 'a/../../x', '/etc/passwd'])('refuses %j as outside-workspace', (input) => {
    expect(workspacePath(input)).toMatchObject({ ok: false, error: { code: 'outside-workspace' } })
  })
  it.each([undefined, 3, null, 'a\0b'])('refuses %j as invalid-params', (input) => {
    expect(workspacePath(input)).toMatchObject({ ok: false, error: { code: 'invalid-params' } })
  })
})
