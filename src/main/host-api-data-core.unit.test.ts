import { describe, expect, it } from 'vitest'

import { gateMethod } from './host-api-core'
import { FILES_DELETE_MAX_PATHS } from 'pomade-kit/protocol'

import { DATA_METHODS, deletePath, fieldWriteError, hasExtension, isSelfOrInside, parseDataParams, pickStart, revealRepoRoot } from './host-api-data-core'

describe('E-030 capabilities', () => {
  it('readFile needs files.read; every write needs files.write', () => {
    expect(gateMethod('files.readFile', ['files.read']).ok).toBe(true)
    const writes = ['files.create', 'files.write', 'files.setBody', 'files.setField', 'files.removeField', 'files.setKeyLines', 'files.move', 'files.delete'] as const
    expect(DATA_METHODS).toEqual(expect.arrayContaining([...writes]))
    for (const m of writes) {
      expect(gateMethod(m, ['files.read', 'project.read']).ok).toBe(false)
      expect(gateMethod(m, ['files.write']).ok).toBe(true)
    }
  })
})

describe('parseDataParams', () => {
  it('normalizes paths, defaults create content, drops unknown keys', () => {
    expect(parseDataParams('files.create', { path: './a//b/../c.md', extra: 1 })).toEqual({
      ok: true,
      params: { path: 'a/c.md', content: '' }
    })
    expect(parseDataParams('files.move', { from: 'a/x.md', to: 'a/done/x.md' })).toEqual({
      ok: true,
      params: { from: 'a/x.md', to: 'a/done/x.md' }
    })
    expect(parseDataParams('files.setField', { path: 'a.md', key: 'tags', value: ['x', 'y'] })).toEqual({
      ok: true,
      params: { path: 'a.md', key: 'tags', value: ['x', 'y'] }
    })
    expect(parseDataParams('files.setField', { path: 'a.md', key: 'k', value: null }).ok).toBe(true)
  })

  it('T-241: every write but create and move takes ifMtime; setKeyLines takes the key and its text; readFile a frontmatter flag', () => {
    const t = 1763500000123.4567
    expect(parseDataParams('files.write', { path: 'a.md', content: 'x', ifMtime: t })).toEqual({ ok: true, params: { path: 'a.md', content: 'x', ifMtime: t } })
    expect(parseDataParams('files.setBody', { path: 'a.md', body: 'x', ifMtime: t })).toEqual({ ok: true, params: { path: 'a.md', body: 'x', ifMtime: t } })
    expect(parseDataParams('files.setField', { path: 'a.md', key: 'k', value: 1, ifMtime: t })).toEqual({
      ok: true,
      params: { path: 'a.md', key: 'k', value: 1, ifMtime: t }
    })
    expect(parseDataParams('files.removeField', { path: 'a.md', key: 'k', ifMtime: t })).toEqual({ ok: true, params: { path: 'a.md', key: 'k', ifMtime: t } })
    expect(parseDataParams('files.setKeyLines', { path: 'a.md', key: 'repeat', text: 'repeat:\n  once: 2026-12-01' })).toEqual({
      ok: true,
      params: { path: 'a.md', key: 'repeat', text: 'repeat:\n  once: 2026-12-01' }
    })
    expect(parseDataParams('files.readFile', { path: 'a.md', frontmatter: true })).toEqual({ ok: true, params: { path: 'a.md', frontmatter: true } })
    expect(parseDataParams('files.readFile', { path: 'a.md' })).toEqual({ ok: true, params: { path: 'a.md', frontmatter: false } })
  })

  it.each<[string, Parameters<typeof parseDataParams>[0], unknown, string]>([
    ['escape', 'files.write', { path: '../x', content: '' }, 'outside-workspace'],
    ['absolute', 'files.readFile', { path: '/etc/hosts' }, 'outside-workspace'],
    ['the root', 'files.create', { path: '' }, 'invalid-params'],
    ['the root after normalizing', 'files.readFile', { path: 'a/..' }, 'invalid-params'],
    ['missing path', 'files.readFile', {}, 'invalid-params'],
    ['NUL', 'files.readFile', { path: 'a\0b' }, 'invalid-params'],
    ['non-string content', 'files.write', { path: 'a', content: 1 }, 'invalid-params'],
    ['missing content', 'files.write', { path: 'a' }, 'invalid-params'],
    ['missing body', 'files.setBody', { path: 'a' }, 'invalid-params'],
    ['missing value', 'files.setField', { path: 'a', key: 'k' }, 'invalid-params'],
    ['object value', 'files.setField', { path: 'a', key: 'k', value: { x: 1 } }, 'invalid-params'],
    ['mixed list', 'files.setField', { path: 'a', key: 'k', value: ['x', 1] }, 'invalid-params'],
    ['missing key', 'files.removeField', { path: 'a' }, 'invalid-params'],
    ['string ifMtime', 'files.setField', { path: 'a', key: 'k', value: 'v', ifMtime: '1' }, 'invalid-params'],
    ['non-finite ifMtime', 'files.write', { path: 'a', content: '', ifMtime: Infinity }, 'invalid-params'],
    ['missing key lines', 'files.setKeyLines', { path: 'a', key: 'k' }, 'invalid-params'],
    ['missing key name', 'files.setKeyLines', { path: 'a', text: 'k: 1' }, 'invalid-params'],
    ['non-boolean frontmatter flag', 'files.readFile', { path: 'a', frontmatter: 'yes' }, 'invalid-params'],
    ['missing to', 'files.move', { from: 'a' }, 'invalid-params'],
    ['escaping to', 'files.move', { from: 'a', to: '../b' }, 'outside-workspace'],
    ['array params', 'files.readFile', ['a'], 'invalid-params']
  ])('refuses %s', (_label, method, params, code) => {
    const r = parseDataParams(method, params)
    expect(!r.ok && r.error.code).toBe(code)
  })

  it('names the offending key in the message', () => {
    const r = parseDataParams('files.move', { from: 'a', to: 3 })
    expect(!r.ok && r.error.message).toBe('"to" must be a string')
  })
})

describe('T-236 files.delete params', () => {
  it('takes a list of strings as given (each checked on its own later), up to the limit', () => {
    expect(parseDataParams('files.delete', { paths: ['./a.md', '../b.md'], x: 1 })).toEqual({
      ok: true,
      params: { paths: ['./a.md', '../b.md'] }
    })
    expect(parseDataParams('files.delete', { paths: [] })).toEqual({ ok: true, params: { paths: [] } })
    const max = Array.from({ length: FILES_DELETE_MAX_PATHS }, (_, i) => `f${i}.md`)
    expect(parseDataParams('files.delete', { paths: max }).ok).toBe(true)
  })
  it.each([
    ['no paths', {}],
    ['a string', { paths: 'a.md' }],
    ['a non-string entry', { paths: ['a.md', 1] }],
    ['too many', { paths: Array.from({ length: FILES_DELETE_MAX_PATHS + 1 }, (_, i) => `f${i}.md`) }]
  ])('refuses the whole call: %s', (_name, params) => {
    const r = parseDataParams('files.delete', params)
    expect(!r.ok && r.error.code).toBe('invalid-params')
  })
  it.each([
    ['./a//b/../c.md', { ok: true, path: 'a/c.md' }],
    ['', 'invalid-params'],
    ['.', 'invalid-params'],
    ['../x.md', 'outside-workspace'],
    ['/etc/hosts', 'outside-workspace'],
    ['.pomade/workspace.json', 'capability-denied'],
    ['a\0b', 'invalid-params']
  ] as const)('checks one path %j', (raw, expected) => {
    const r = deletePath(raw)
    if (typeof expected === 'string') expect(!r.ok && r.error.code).toBe(expected)
    else expect(r).toEqual(expected)
  })
})

describe('fieldWriteError', () => {
  it("maps the kit's refusals onto error codes", () => {
    expect(fieldWriteError('unreadable-frontmatter', 'a.md', 'bad').code).toBe('unreadable-frontmatter')
    expect(fieldWriteError('unsupported-key', 'a.md', 'bad').code).toBe('unsupported-key')
    expect(fieldWriteError('invalid-value', 'a.md', 'bad')).toEqual({ code: 'invalid-params', message: '"a.md": bad' })
  })
})

describe('isSelfOrInside', () => {
  it('is true for the folder itself and anything below it, never for a sibling prefix', () => {
    expect(isSelfOrInside('a/b', 'a/b')).toBe(true)
    expect(isSelfOrInside('a/b', 'a/b/c')).toBe(true)
    expect(isSelfOrInside('a/b', 'a/bc')).toBe(false)
    expect(isSelfOrInside('a/b', 'a')).toBe(false)
  })
})

describe('files.reveal params', () => {
  it('a file or folder path, the workspace root included; optional projectId; needs files.read', () => {
    expect(parseDataParams('files.reveal', { path: 'Apps/hello/jobs/', projectId: 'p1' })).toEqual({
      ok: true,
      params: { path: 'Apps/hello/jobs', projectId: 'p1' }
    })
    expect(parseDataParams('files.reveal', { path: '' })).toEqual({ ok: true, params: { path: '' } })
    for (const params of [{}, { path: 1 }, { path: 'a', projectId: 3 }]) {
      const r = parseDataParams('files.reveal', params)
      expect(!r.ok && r.error.code).toBe('invalid-params')
    }
    const out = parseDataParams('files.reveal', { path: '../x' })
    expect(!out.ok && out.error.code).toBe('outside-workspace')
    expect(gateMethod('files.reveal', ['tabs.open']).ok).toBe(false)
    expect(gateMethod('files.reveal', ['files.read']).ok).toBe(true)
  })
})

describe('git.reveal params (T-320)', () => {
  it('an absolute path, kept as given; optional projectId; needs git.read', () => {
    expect(parseDataParams('git.reveal', { path: '/Users/me/ws/Projects/x', projectId: 'p1', extra: 1 })).toEqual({
      ok: true,
      params: { path: '/Users/me/ws/Projects/x', projectId: 'p1' }
    })
    expect(parseDataParams('git.reveal', { path: '/ws/' })).toEqual({ ok: true, params: { path: '/ws/' } })
    for (const params of [{}, { path: 1 }, { path: '' }, { path: 'Projects/x' }, { path: './x' }, { path: '/ws', projectId: 3 }, null, []]) {
      const r = parseDataParams('git.reveal', params)
      expect(!r.ok && r.error.code, JSON.stringify(params)).toBe('invalid-params')
    }
    expect(gateMethod('git.reveal', ['files.read', 'tabs.open']).ok).toBe(false)
    expect(gateMethod('git.reveal', ['git.read']).ok).toBe(true)
  })

  it('revealRepoRoot: the workspace-relative root, "" for the workspace itself, null outside it', () => {
    expect(revealRepoRoot('/ws', '/ws')).toBe('')
    expect(revealRepoRoot('/ws/Projects/x', '/ws')).toBe('Projects/x')
    expect(revealRepoRoot('/ws/a/b/c', '/ws')).toBe('a/b/c')
    expect(revealRepoRoot('/wsx/a', '/ws')).toBeNull()
    expect(revealRepoRoot('/', '/ws')).toBeNull()
    expect(revealRepoRoot('/other', '/ws')).toBeNull()
    expect(revealRepoRoot('/ws/..a', '/ws')).toBe('..a')
  })
})

describe('project.activate params (T-324)', () => {
  it('a project id, extra keys dropped; the Workspace id passes; needs tabs.open', () => {
    expect(parseDataParams('project.activate', { projectId: 'p1', extra: 1 })).toEqual({ ok: true, params: { projectId: 'p1' } })
    expect(parseDataParams('project.activate', { projectId: '__workspace__' })).toEqual({ ok: true, params: { projectId: '__workspace__' } })
    for (const params of [{}, { projectId: 3 }, { projectId: null }, null, [], 'p1']) {
      const r = parseDataParams('project.activate', params)
      expect(!r.ok && r.error.code, JSON.stringify(params)).toBe('invalid-params')
    }
    expect(gateMethod('project.activate', ['project.read', 'project.write', 'files.read']).ok).toBe(false)
    expect(gateMethod('project.activate', ['tabs.open']).ok).toBe(true)
  })
})

describe('tabs params', () => {
  it('openFile: a file path below the root, optional projectId', () => {
    expect(parseDataParams('tabs.openFile', { path: 'a/b.md', projectId: 'p1' })).toEqual({
      ok: true,
      params: { path: 'a/b.md', projectId: 'p1' }
    })
    expect(parseDataParams('tabs.openFile', { path: 'a/b.md' })).toEqual({ ok: true, params: { path: 'a/b.md' } })
    const bad = parseDataParams('tabs.openFile', { path: 'a', projectId: 3 })
    expect(!bad.ok && bad.error.code).toBe('invalid-params')
  })

  it('openTerminal: cwd may be the root; command is one line; title is trimmed', () => {
    expect(parseDataParams('tabs.openTerminal', { cwd: '', command: 'npm run dev', title: ' Dev ' })).toEqual({
      ok: true,
      params: { cwd: '', command: 'npm run dev', title: 'Dev' }
    })
    for (const params of [{}, { cwd: '', command: 'a\nb' }, { cwd: '', command: ' ' }, { cwd: '', title: '' }, { cwd: 1 }]) {
      const r = parseDataParams('tabs.openTerminal', params)
      expect(!r.ok && r.error.code).toBe('invalid-params')
    }
    const out = parseDataParams('tabs.openTerminal', { cwd: '../x' })
    expect(!out.ok && out.error.code).toBe('outside-workspace')
  })

  it('tabs.* need tabs.open', () => {
    expect(gateMethod('tabs.openFile', ['files.read', 'files.write', 'project.read']).ok).toBe(false)
    expect(gateMethod('tabs.openTerminal', ['tabs.open']).ok).toBe(true)
  })
})

describe('project settings and agents params', () => {
  it('settings must be a JSON object; agents are normalized', () => {
    expect(parseDataParams('project.setSettings', { projectId: 'p', settings: { a: [1, { b: null }] } })).toEqual({
      ok: true,
      params: { projectId: 'p', settings: { a: [1, { b: null }] } }
    })
    expect(parseDataParams('project.setAgents', { projectId: 'p', visibleAgents: [' claude', 'claude'] })).toEqual({
      ok: true,
      params: { projectId: 'p', visibleAgents: ['claude'] }
    })
    for (const [method, params] of [
      ['project.getSettings', {}],
      ['project.setSettings', { projectId: 'p' }],
      ['project.setSettings', { projectId: 'p', settings: [] }],
      ['project.setSettings', { projectId: 'p', settings: { n: NaN } }],
      ['project.setAgents', { projectId: 'p', visibleAgents: ['*', 'x'] }],
      ['project.getAgents', { projectId: 1 }]
    ] as const) {
      const r = parseDataParams(method, params)
      expect(!r.ok && r.error.code).toBe('invalid-params')
    }
  })

  it('reads need project.read, writes project.write', () => {
    expect(gateMethod('project.getSettings', ['project.read']).ok).toBe(true)
    expect(gateMethod('project.setSettings', ['project.read']).ok).toBe(false)
    expect(gateMethod('project.setAgents', ['project.write']).ok).toBe(true)
  })
})

describe('symlink params', () => {
  it('a link path and a target path, both below the root; needs files.symlink', () => {
    expect(parseDataParams('files.symlink', { path: 'Agents/a/skills/x', target: 'Apps/p/skill' })).toEqual({
      ok: true,
      params: { path: 'Agents/a/skills/x', target: 'Apps/p/skill' }
    })
    const r = parseDataParams('files.symlink', { path: 'Agents/a/skills/x', target: '' })
    expect(!r.ok && r.error.code).toBe('invalid-params')
    const out = parseDataParams('files.removeSymlink', { path: '../x' })
    expect(!out.ok && out.error.code).toBe('outside-workspace')
    expect(gateMethod('files.symlink', ['files.write', 'files.read']).ok).toBe(false)
    expect(gateMethod('files.removeSymlink', ['files.symlink']).ok).toBe(true)
  })
})

describe('pickFolder params and start', () => {
  it('root is a project id; initial may be the workspace root', () => {
    expect(parseDataParams('files.pickFolder', {})).toEqual({ ok: true, params: {} })
    expect(parseDataParams('files.pickFolder', { root: 'p1', initial: 'Projects/x/' })).toEqual({
      ok: true,
      params: { root: 'p1', initial: 'Projects/x' }
    })
    const bad = parseDataParams('files.pickFolder', { root: 1 })
    expect(!bad.ok && bad.error.code).toBe('invalid-params')
    const out = parseDataParams('files.pickFolder', { initial: '/tmp' })
    expect(!out.ok && out.error.code).toBe('outside-workspace')
    expect(gateMethod('files.pickFolder', ['files.read']).ok).toBe(true)
  })

  it('starts at initial when it lies inside the root, else at the root', () => {
    expect(pickStart('Projects/x', 'Projects/x/docs')).toBe('Projects/x/docs')
    expect(pickStart('Projects/x', 'Projects/x')).toBe('Projects/x')
    expect(pickStart('Projects/x', 'Projects/xy')).toBe('Projects/x')
    expect(pickStart('Projects/x', undefined)).toBe('Projects/x')
    expect(pickStart('', 'anything/here')).toBe('anything/here')
  })
})

describe('pickFile params and extensions', () => {
  it('under may be the workspace root; extensions are lowercased bare extensions', () => {
    expect(parseDataParams('files.pickFile', {})).toEqual({ ok: true, params: {} })
    expect(parseDataParams('files.pickFile', { under: 'Projects/x/', extensions: ['MD', 'txt'] })).toEqual({
      ok: true,
      params: { under: 'Projects/x', extensions: ['md', 'txt'] }
    })
    expect(parseDataParams('files.pickFile', { under: '' })).toEqual({ ok: true, params: { under: '' } })
    for (const extensions of ['md', [], ['.md'], ['md', 3], ['a b'], ['']]) {
      const bad = parseDataParams('files.pickFile', { extensions })
      expect(!bad.ok && bad.error.code, JSON.stringify(extensions)).toBe('invalid-params')
    }
    const wrong = parseDataParams('files.pickFile', { under: 1 })
    expect(!wrong.ok && wrong.error.code).toBe('invalid-params')
    const out = parseDataParams('files.pickFile', { under: '/tmp' })
    expect(!out.ok && out.error.code).toBe('outside-workspace')
    expect(gateMethod('files.pickFile', ['files.read']).ok).toBe(true)
    expect(gateMethod('files.pickFile', ['project.read']).ok).toBe(false)
  })

  it('matches the last extension, case-insensitively; a dotfile has none', () => {
    expect(hasExtension('a/b/Day.MD', ['md'])).toBe(true)
    expect(hasExtension('a/b/x.tar.gz', ['gz'])).toBe(true)
    expect(hasExtension('a/b/x.txt', ['md'])).toBe(false)
    expect(hasExtension('a/b.d/x', ['d'])).toBe(false)
    expect(hasExtension('a/.md', ['md'])).toBe(false)
    expect(hasExtension('a/anything', undefined)).toBe(true)
  })
})
