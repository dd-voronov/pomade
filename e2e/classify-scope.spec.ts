// modules: core
// Pomade T-101 (E-021) — direct unit coverage for the classifyScope helper.
//
// The repo ships no separate unit runner (Playwright is the only test harness), so this pure-logic
// spec imports the shared function straight from source and asserts it — no Electron app launched.
// It pins all three states, absolute (outside-workspace) paths, and the Workspace project
// (rootPath '').

import { test, expect } from '@playwright/test'

import { classifyScope } from '../src/shared/paths'

test.describe('T-101 classifyScope', () => {
  test('a path under the project root is in-project (root itself and nested)', () => {
    expect(classifyScope('Projects/alpha', 'Projects/alpha')).toBe('in-project')
    expect(classifyScope('Projects/alpha/README.md', 'Projects/alpha')).toBe('in-project')
    expect(classifyScope('Projects/alpha/docs/deep/note.md', 'Projects/alpha')).toBe('in-project')
  })

  test('a workspace-relative path outside the project root is outside-project', () => {
    expect(classifyScope('Projects/beta/README.md', 'Projects/alpha')).toBe('outside-project')
    // A sibling whose name PREFIXES the root must not be mistaken for in-project.
    expect(classifyScope('Projects/alpha-extra/x.md', 'Projects/alpha')).toBe('outside-project')
    expect(classifyScope('welcome.md', 'Projects/alpha')).toBe('outside-project')
  })

  test('an absolute path is outside-workspace regardless of project', () => {
    expect(classifyScope('/etc/hosts', 'Projects/alpha')).toBe('outside-workspace')
    // …even for the Workspace project (rootPath '').
    expect(classifyScope('/Users/someone/x.md', '')).toBe('outside-workspace')
  })

  test('the Workspace project (rootPath "") treats every workspace-relative path as in-project', () => {
    expect(classifyScope('Projects/alpha/README.md', '')).toBe('in-project')
    expect(classifyScope('welcome.md', '')).toBe('in-project')
    expect(classifyScope('', '')).toBe('in-project')
  })
})
