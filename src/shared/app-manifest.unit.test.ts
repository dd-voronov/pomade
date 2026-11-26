import { describe, expect, it } from 'vitest'

import { formatChord, parseChord, type AppShortcut } from 'pomade-kit/protocol'

import {
  POMADE_SHORTCUTS,
  pomadeShortcutConflicts,
  resolveAppShortcuts,
  manifestSummary,
  callCycles,
  parseAppLinks,
  parseDevTarget,
  parseManifest,
  serializeAppLinks,
  validateManifest
} from './app-manifest'

const VALID = {
  id: 'pomade-planner',
  name: 'Planner',
  version: '0.1.0',
  hostApi: 0,
  capabilities: ['project.read', 'files.read']
}

function errorsOf(raw: unknown): string[] {
  const r = validateManifest(raw)
  return 'errors' in r ? r.errors : []
}

describe('validateManifest', () => {
  it('accepts a minimal manifest and defaults the entry', () => {
    const r = validateManifest(VALID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.entry).toBe('index.html')
    expect(r.manifest.icon).toBeUndefined()
    expect(r.manifest.strip).toEqual([])
    expect(r.unsupportedKeys).toEqual([])
  })

  it('keeps entry and icon, and dedupes capabilities', () => {
    const r = validateManifest({ ...VALID, entry: 'app/main.html', icon: 'icon.svg', capabilities: ['files.read', 'files.read'] })
    expect(r.ok && r.manifest).toMatchObject({ entry: 'app/main.html', icon: 'icon.svg', capabilities: ['files.read'] })
  })

  it('accepts unknown top-level keys and reports them', () => {
    const r = validateManifest({ ...VALID, sidePanel: { icon: 'x.svg' }, dashboard: [] })
    expect(r.ok && r.unsupportedKeys).toEqual(['sidePanel', 'dashboard'])
  })

  it.each([
    ['id missing', { ...VALID, id: undefined }, '"id"'],
    ['id with uppercase', { ...VALID, id: 'Planner' }, '"id"'],
    ['id one char', { ...VALID, id: 'p' }, '"id"'],
    ['id leading digit', { ...VALID, id: '1app' }, '"id"'],
    ['id too long', { ...VALID, id: 'a' + 'b'.repeat(64) }, '"id"'],
    ['name empty', { ...VALID, name: '  ' }, '"name"'],
    ['name not a string', { ...VALID, name: 3 }, '"name"'],
    ['version not semver', { ...VALID, version: '1.0' }, '"version"'],
    ['version leading zero', { ...VALID, version: '01.0.0' }, '"version"'],
    ['hostApi missing', { ...VALID, hostApi: undefined }, '"hostApi"'],
    ['hostApi fractional', { ...VALID, hostApi: 0.5 }, '"hostApi"'],
    ['hostApi negative', { ...VALID, hostApi: -1 }, '"hostApi"'],
    ['entry absolute', { ...VALID, entry: '/index.html' }, '"entry"'],
    ['entry escapes', { ...VALID, entry: '../index.html' }, '"entry"'],
    ['icon escapes', { ...VALID, icon: 'a/../../x.svg' }, '"icon"'],
    ['capabilities missing', { ...VALID, capabilities: undefined }, '"capabilities"'],
    ['capabilities not an array', { ...VALID, capabilities: 'files.read' }, '"capabilities"'],
    ['unknown capability', { ...VALID, capabilities: ['files.delete'] }, '"capabilities"']
  ])('rejects %s, naming the field', (_label, raw, field) => {
    const errors = errorsOf(raw)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(field)
  })

  it('names the received value in the error', () => {
    expect(errorsOf({ ...VALID, hostApi: 'zero' })).toEqual(['"hostApi" must be a non-negative integer (got "zero")'])
    expect(errorsOf({ ...VALID, id: undefined })[0]).toMatch(/\(missing\)$/)
  })

  it('trims the name', () => {
    const r = validateManifest({ ...VALID, name: '  Planner ' })
    expect(r.ok && r.manifest.name).toBe('Planner')
  })

  it('reads strip icons in order, defaulting the route and ignoring unknown icon keys', () => {
    const r = validateManifest({
      ...VALID,
      strip: [
        { id: 'planner', title: ' Planner ', icon: 'planner.svg', action: 'panel', badgeColor: 'x' },
        { id: 'board', title: 'Board', action: 'both', route: 'board', panelRoute: 'needs-you' },
        { id: 'log', title: 'Log', action: 'tab', route: '' }
      ]
    })
    expect(r.ok && r.manifest.strip).toEqual([
      { id: 'planner', title: 'Planner', icon: 'planner.svg', action: 'panel', route: '' },
      { id: 'board', title: 'Board', action: 'both', route: 'board', panelRoute: 'needs-you' },
      { id: 'log', title: 'Log', action: 'tab', route: '' }
    ])
    expect(r.ok && r.unsupportedKeys).toEqual([])
  })

  const icon = { id: 'p', title: 'P', action: 'panel' }
  it('rejects an invalid strip icon with the kit rules, naming the icon field and the value', () => {
    expect(errorsOf({ ...VALID, strip: [icon, { ...icon, id: 'b', action: 'popup' }] })).toEqual([
      '"strip[1].action" must be one of panel, tab, both (got "popup")'
    ])
  })

  it('lists strip icons in the install summary', () => {
    const r = validateManifest({ ...VALID, strip: [icon, { id: 'b', title: 'Board', action: 'both' }] })
    if (!r.ok) throw new Error('invalid')
    expect(manifestSummary(r.manifest, [])).toContain('  Strip icons:   P (panel), Board (both)')
    expect(manifestSummary({ ...r.manifest, strip: [] }, [])).toContain('  Strip icons:   (none)')
  })

  it('E-030: keeps the symlink folders and lists them in the install summary', () => {
    const r = validateManifest({ ...VALID, symlinks: ['Agents/*/skills'] })
    if (!r.ok) throw new Error('invalid')
    expect(r.manifest.symlinks).toEqual(['Agents/*/skills'])
    expect(r.unsupportedKeys).toEqual([])
    expect(manifestSummary(r.manifest, [])).toContain('  Symlinks in:   Agents/*/skills')
    const none = validateManifest(VALID)
    expect(none.ok && none.manifest.symlinks).toEqual([])
    expect(errorsOf({ ...VALID, symlinks: ['../x'] })).toEqual([
      '"symlinks[0]" must be a workspace-relative folder pattern ("*" = one folder name) (got "../x")'
    ])
  })

  it('outsideWorkspace: keeps the paths as written and lists them in the install summary', () => {
    const r = validateManifest({ ...VALID, outsideWorkspace: ['~/.claude/', '~/.zshrc'] })
    if (!r.ok) throw new Error('invalid')
    expect(r.manifest.outsideWorkspace).toEqual(['~/.claude/', '~/.zshrc'])
    expect(r.unsupportedKeys).toEqual([])
    expect(manifestSummary(r.manifest, [])).toContain('  Outside the workspace: ~/.claude/, ~/.zshrc')
    const none = validateManifest(VALID)
    expect(none.ok && none.manifest.outsideWorkspace).toEqual([])
    expect(none.ok && manifestSummary(none.manifest, [])).toContain('  Outside the workspace: (none)')
    expect(errorsOf({ ...VALID, outsideWorkspace: ['.claude'] })).toEqual([
      '"outsideWorkspace[0]" must be an absolute path or one starting with "~/", without "." or ".." segments (got ".claude")'
    ])
  })

  it('startOnLaunch: the launch panel is the first panel/both icon; the summary says so', () => {
    const strip = [
      { id: 'log', title: 'Log', action: 'tab' },
      { id: 'board', title: 'Board', action: 'both' },
      { id: 'p', title: 'P', action: 'panel' }
    ]
    const on = validateManifest({ ...VALID, strip, startOnLaunch: true })
    if (!on.ok) throw new Error('invalid')
    expect(on.manifest.launchPanel).toBe('board')
    expect(on.unsupportedKeys).toEqual([])
    expect(manifestSummary(on.manifest, [])).toContain('  Start on launch: the "Board" panel loads hidden when Pomade starts')
    const off = validateManifest({ ...VALID, strip })
    expect(off.ok && off.manifest.launchPanel).toBeNull()
    expect(off.ok && manifestSummary(off.manifest, []).join('\n')).not.toContain('Start on launch')
    expect(errorsOf({ ...VALID, strip: [strip[0]], startOnLaunch: true })).toEqual([
      '"startOnLaunch" needs a strip icon with action "panel" or "both"'
    ])
  })

  it('reports every invalid field at once', () => {
    expect(errorsOf({ id: 'X', version: 'x', hostApi: 'zero' })).toHaveLength(5)
  })

  it.each([null, [], 'manifest', 3])('rejects a non-object (%j)', (raw) => {
    expect(errorsOf(raw)).toEqual(['manifest must be a JSON object'])
  })

  it('accepts pre-release and build semver', () => {
    expect(validateManifest({ ...VALID, version: '1.2.3-beta.1+sha.5' }).ok).toBe(true)
  })
})

describe('parseManifest', () => {
  it('reports invalid JSON readably', () => {
    const r = parseManifest('{ "id": ')
    expect(r.ok).toBe(false)
    expect('errors' in r && r.errors[0]).toMatch(/^manifest\.json is not valid JSON/)
  })
})

describe('parseDevTarget', () => {
  it.each([
    ['http://localhost:5173', { kind: 'url', url: 'http://localhost:5173' }],
    ['http://localhost:5173/', { kind: 'url', url: 'http://localhost:5173' }],
    ['http://127.0.0.1:8080', { kind: 'url', url: 'http://127.0.0.1:8080' }],
    ['/abs/build/', { kind: 'folder', path: '/abs/build' }]
  ])('accepts %s', (input, expected) => {
    expect(parseDevTarget(input)).toEqual(expected)
  })

  it.each(['https://localhost:5173', 'http://example.com:80', 'http://localhost', 'relative/path'])(
    'refuses %s',
    (input) => {
      expect(parseDevTarget(input)).toHaveProperty('error')
    }
  )
})

describe('app-links.json', () => {
  it('round-trips and skips malformed entries', () => {
    const text = serializeAppLinks([{ id: 'hello', target: '/x' }])
    expect(parseAppLinks(text)).toEqual([{ id: 'hello', target: '/x' }])
    expect(parseAppLinks('{"links":[{"id":"Bad","target":"/x"},{"id":"ok-app"},{"id":"ok-app","target":"/y"}]}')).toEqual([
      { id: 'ok-app', target: '/y' }
    ])
    expect(parseAppLinks('not json')).toEqual([])
  })
})

const sc = (id: string, key: string, title = id): AppShortcut => ({ id, title, key, action: 'tab', route: '' })

describe('shortcuts', () => {
  it('Cmd+G is free for apps; Cmd+Shift+G is the quick peek', () => {
    expect(POMADE_SHORTCUTS['Cmd+G']).toBeUndefined()
    expect(POMADE_SHORTCUTS['Cmd+Shift+G']).toBe('Quick peek')
    expect(resolveAppShortcuts([{ id: 'a', shortcuts: [sc('next', 'Cmd+G')] }]).get('a')).toEqual({
      active: [sc('next', 'Cmd+G')],
      conflicts: []
    })
  })

  it("Pomade's own chords are spelled canonically", () => {
    for (const key of Object.keys(POMADE_SHORTCUTS)) {
      const chord = parseChord(key)
      expect(chord && formatChord(chord), key).toBe(key)
    }
  })

  it('validateManifest keeps the declared shortcuts, keys canonical; [] when none', () => {
    const r = validateManifest({
      ...VALID,
      shortcuts: [{ id: 'today', title: 'Today', key: 'shift+cmd+y', action: 'tab', route: 'today' }]
    })
    expect(r.ok && r.manifest.shortcuts).toEqual([{ id: 'today', title: 'Today', key: 'Cmd+Shift+Y', action: 'tab', route: 'today' }])
    const none = validateManifest(VALID)
    expect(none.ok && none.manifest.shortcuts).toEqual([])
  })

  it("conflicts with Pomade's chords name both sides", () => {
    expect(pomadeShortcutConflicts([sc('close', 'Cmd+W', 'Close it'), sc('ok', 'Cmd+Shift+Y')])).toEqual([
      'Cmd+W ("Close it") is Pomade\'s Close Tab'
    ])
  })

  it('E-031: keeps the declared events and lists them in the install summary', () => {
    const r = validateManifest({
      ...VALID,
      events: { publish: ['run.started', 'run.finished'], subscribe: ['project.renamed', 'pomade-agents:session.closed'] }
    })
    if (!r.ok) throw new Error('invalid')
    expect(r.manifest.events).toEqual({
      publish: ['run.started', 'run.finished'],
      subscribe: ['project.renamed', 'pomade-agents:session.closed']
    })
    expect(manifestSummary(r.manifest, [])).toContain(
      '  Events:        publishes run.started, run.finished · subscribes to project.renamed, pomade-agents:session.closed'
    )
    const listen = validateManifest({ ...VALID, events: { subscribe: ['pomade.ready'] } })
    if (!listen.ok) throw new Error('invalid')
    expect(manifestSummary(listen.manifest, [])).toContain('  Events:        publishes (none) · subscribes to pomade.ready')
    const plain = validateManifest(VALID)
    if (!plain.ok) throw new Error('invalid')
    expect(plain.manifest.events).toEqual({ publish: [], subscribe: [] })
    expect(manifestSummary(plain.manifest, [])).toContain('  Events:        (none)')
    const bad = validateManifest({ ...VALID, events: { subscribe: ['project.deleted'] } })
    expect(bad.ok).toBe(false)
  })

  it('the summary lists shortcuts and the conflicts Pomade wins', () => {
    const r = validateManifest({
      ...VALID,
      shortcuts: [
        { id: 'today', title: 'Today', key: 'Cmd+Shift+Y', action: 'tab', route: 'today' },
        { id: 'save', title: 'Save all', key: 'Cmd+S', action: 'tab' }
      ]
    })
    if (!r.ok) throw new Error('invalid')
    const lines = manifestSummary(r.manifest, [])
    expect(lines).toContain('  Shortcuts:     Today Cmd+Shift+Y (tab "today"), Save all Cmd+S (tab)')
    expect(lines).toContain('  Shortcut conflicts — Pomade wins, these do nothing: Cmd+S ("Save all") is Pomade\'s Save')
    const plain = validateManifest(VALID)
    if (!plain.ok) throw new Error('invalid')
    expect(manifestSummary(plain.manifest, [])).toContain('  Shortcuts:     (none)')
    expect(manifestSummary(plain.manifest, []).join('\n')).not.toContain('conflicts')
  })

  it("resolveAppShortcuts: Pomade wins, then the app first by id; per app, in manifest order", () => {
    const r = resolveAppShortcuts([
      { id: 'zeta', shortcuts: [sc('a', 'Cmd+Shift+Y'), sc('b', 'Cmd+Alt+P')] },
      { id: 'alpha', shortcuts: [sc('c', 'Cmd+Shift+Y'), sc('d', 'Cmd+W'), sc('e', 'Cmd+Ctrl+J')] }
    ])
    expect(r.get('alpha')).toEqual({
      active: [sc('c', 'Cmd+Shift+Y'), sc('e', 'Cmd+Ctrl+J')],
      conflicts: ['Cmd+W ("d") is Pomade\'s Close Tab']
    })
    expect(r.get('zeta')).toEqual({
      active: [sc('b', 'Cmd+Alt+P')],
      conflicts: ['Cmd+Shift+Y ("a") is taken by the app "alpha"']
    })
    expect(resolveAppShortcuts([]).size).toBe(0)
  })
})

describe('E-028 backend, api, calls', () => {
  it('summarizes the backend, the API it offers and the apps it calls', () => {
    const r = validateManifest({
      ...VALID,
      backend: { entry: 'b/main.js', mode: 'always-on', restartOnUpdate: true },
      api: ['today'],
      calls: ['pomade-agents']
    })
    if (!r.ok) throw new Error('errors' in r ? r.errors.join() : '')
    expect(r.manifest).toMatchObject({ api: ['today'], calls: ['pomade-agents'] })
    const lines = manifestSummary(r.manifest, [])
    expect(lines).toContain('  Backend:       b/main.js — always on: a login item that keeps running when Pomade quits; an update restarts it')
    expect(lines).toContain('  API offered:   today')
    expect(lines).toContain('  Calls apps:    pomade-agents')
    const plain = validateManifest(VALID)
    if (!plain.ok) throw new Error()
    expect(manifestSummary(plain.manifest, [])).toEqual(
      expect.arrayContaining(['  Backend:       (none)', '  API offered:   (none)', '  Calls apps:    (none)'])
    )
  })

  it('callCycles finds each cycle once, from its smallest id', () => {
    expect(callCycles([{ id: 'a', calls: ['b'] }, { id: 'b', calls: ['c'] }, { id: 'c', calls: [] }])).toEqual([])
    expect(callCycles([{ id: 'b', calls: ['a'] }, { id: 'a', calls: ['b'] }])).toEqual([['a', 'b', 'a']])
    expect(
      callCycles([
        { id: 'c', calls: ['a'] },
        { id: 'a', calls: ['b', 'x'] },
        { id: 'b', calls: ['c'] }
      ])
    ).toEqual([['a', 'b', 'c', 'a']])
  })
})
