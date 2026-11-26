import { describe, expect, it } from 'vitest'

import { parseParams, workspacePath } from './host-api-core'
import { parseDataParams } from './host-api-data-core'

// Rule 3: no Host API path may be at or inside the workspace's .pomade folder. Every path param of
// every method goes through `workspacePath`; this is the lexical half as a matrix (the real-path
// half — symlinks into .pomade — is covered end to end in app-workspace-data.spec.ts).

const DENIED = ['.pomade', '.pomade/', '.pomade/workspace.json', './.pomade/state/p1.json', 'Projects/../.pomade/x', '.POMADE/x']
const ALLOWED = ['.pomaderc', 'pomade/x', 'Projects/a/.pomade/own.md', '.pomade-old/x']

describe('workspacePath — the .pomade rule', () => {
  it.each(DENIED)('%j is capability-denied', (path) => {
    expect(workspacePath(path)).toMatchObject({ ok: false, error: { code: 'capability-denied' } })
  })
  it.each(ALLOWED)('%j is allowed', (path) => {
    expect(workspacePath(path)).toMatchObject({ ok: true })
  })
  it('an escape is still outside-workspace, not denied', () => {
    expect(workspacePath('../.pomade')).toMatchObject({ ok: false, error: { code: 'outside-workspace' } })
  })
})

type DataMethodName = Parameters<typeof parseDataParams>[0]

describe('every path param of every method refuses .pomade', () => {
  const core: [Parameters<typeof parseParams>[0], (p: string) => Record<string, unknown>][] = [
    ['files.readFolder', (path) => ({ path })],
    ['files.watch', (path) => ({ path })]
  ]
  const data: [DataMethodName, (p: string) => Record<string, unknown>][] = [
    ['files.readFile', (path) => ({ path })],
    ['files.create', (path) => ({ path })],
    ['files.write', (path) => ({ path, content: '' })],
    ['files.setBody', (path) => ({ path, body: '' })],
    ['files.setField', (path) => ({ path, key: 'k', value: 'v' })],
    ['files.removeField', (path) => ({ path, key: 'k' })],
    ['files.setKeyLines', (path) => ({ path, key: 'k', text: 'k:\n  a: 1' })],
    ['files.move', (path) => ({ from: path, to: 'a/b' })],
    ['files.move', (path) => ({ from: 'a/b', to: path })],
    ['files.symlink', (path) => ({ path, target: 'a/b' })],
    ['files.symlink', (path) => ({ path: 'Agents/x/skills/s', target: path })],
    ['files.removeSymlink', (path) => ({ path })],
    ['files.pickFolder', (path) => ({ initial: path })],
    ['files.pickFile', (path) => ({ under: path })],
    ['files.reveal', (path) => ({ path })],
    ['tabs.openFile', (path) => ({ path })],
    ['tabs.openTerminal', (path) => ({ cwd: path })]
  ]
  // `.pomade/` normalizes to `.pomade`; the root-refusing params see it as an entry, so every
  // spelling reaches the rule.
  for (const [method, params] of core) {
    it.each(DENIED)(`${method} %j`, (path) => {
      expect(parseParams(method, params(path))).toMatchObject({ ok: false, error: { code: 'capability-denied' } })
    })
  }
  for (const [method, params] of data) {
    it.each(DENIED)(`${method} ${JSON.stringify(params('…'))} with %j`, (path) => {
      expect(parseDataParams(method, params(path))).toMatchObject({ ok: false, error: { code: 'capability-denied' } })
    })
  }
  it('the same params elsewhere pass the rule', () => {
    for (const [method, params] of data) {
      const r = parseDataParams(method, params('Projects/a/.pomade/own.md'))
      expect(r.ok ? null : r.error.code, method).not.toBe('capability-denied')
    }
  })
})
