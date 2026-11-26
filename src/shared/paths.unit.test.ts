// T-176 — pure-logic seed suite for shared/paths.ts (workspace-relative path normalization +
// in/outside-project scope classification). Table-driven; see paths.ts for the contract.

import { describe, expect, it } from 'vitest'
import {
  ancestorsWithin,
  classifyScope,
  normalizeWorkspaceRelPath,
  scopeFolderOf,
  scopeRelativePath,
  treePathUnderRoot,
  type Scope
} from './paths'

describe('normalizeWorkspaceRelPath', () => {
  const cases: [name: string, input: string, expected: string][] = [
    ['plain relative path unchanged', 'sub/dir', 'sub/dir'],
    ['leading slash dropped (typed-absolute means workspace-relative)', '/sub/dir', 'sub/dir'],
    ['multiple leading slashes dropped', '///sub/dir', 'sub/dir'],
    ['trailing slash stripped', 'sub/dir/', 'sub/dir'],
    ['multiple trailing slashes stripped', 'sub/dir///', 'sub/dir'],
    ['surrounding whitespace trimmed', '  sub/dir  ', 'sub/dir'],
    ['backslashes tolerated as separators', 'sub\\dir', 'sub/dir'],
    ['mixed backslash + forward slash', 'sub\\dir/leaf', 'sub/dir/leaf'],
    ['repeated internal slashes collapsed', 'sub//dir', 'sub/dir'],
    ['empty input → workspace root', '', ''],
    ['only slashes → workspace root', '///', ''],
    ['only whitespace → workspace root', '   ', ''],
    // Edge case not previously exercised: a lone leading slash with nothing else must not survive
    // as a stray '/' after the leading-slash strip runs before the trailing-slash strip.
    ['single slash → workspace root (not a stray "/")', '/', '']
  ]

  it.each(cases)('%s', (_name, input, expected) => {
    expect(normalizeWorkspaceRelPath(input)).toBe(expected)
  })
})

describe('classifyScope', () => {
  const cases: [name: string, path: string, projectRoot: string, expected: Scope][] = [
    ['absolute path is always outside-workspace', '/etc/hosts', 'proj', 'outside-workspace'],
    ['absolute path outside-workspace even against Workspace project (root "")', '/etc/hosts', '', 'outside-workspace'],
    ['Workspace project (root "") — everything relative is in-project', 'anything/here', '', 'in-project'],
    ['path equal to project root is in-project', 'proj', 'proj', 'in-project'],
    ['path nested under project root is in-project', 'proj/sub/file.md', 'proj', 'in-project'],
    ['sibling path outside the project root is outside-project', 'other/file.md', 'proj', 'outside-project'],
    // Edge case not previously exercised: a project whose root is a STRING PREFIX of another
    // path (but not a real path-segment ancestor) must NOT be misclassified as in-project — the
    // startsWith check is guarded by an explicit '/' separator, not a bare prefix match.
    ['sibling with root as a bare string prefix (not a path ancestor) is outside-project', 'projects-other/file.md', 'proj', 'outside-project']
  ]

  it.each(cases)('%s', (_name, path, projectRoot, expected) => {
    expect(classifyScope(path, projectRoot)).toBe(expected)
  })
})

describe('classifyScope with in-scope folders', () => {
  const cases: [name: string, path: string, projectRoot: string, folders: string[], expected: Scope][] = [
    ['file under an in-scope workspace folder is in-project', 'Notes/alpha/t.md', 'Projects/alpha', ['Notes/alpha'], 'in-project'],
    ['the in-scope folder itself is in-project', 'Notes/alpha', 'Projects/alpha', ['Notes/alpha'], 'in-project'],
    ['a sibling of the in-scope folder stays outside-project', 'Notes/beta/t.md', 'Projects/alpha', ['Notes/alpha'], 'outside-project'],
    ['a bare string prefix of the folder is not inside it', 'Notes/alpha-old/t.md', 'Projects/alpha', ['Notes/alpha'], 'outside-project'],
    ['an absolute file under an in-scope absolute folder is in-project', '/Users/me/notes/a.md', 'Projects/alpha', ['/Users/me/notes'], 'in-project'],
    ['an absolute file no in-scope folder covers stays outside-workspace', '/Users/me/other/a.md', 'Projects/alpha', ['/Users/me/notes', 'Notes'], 'outside-workspace'],
    ['a workspace-relative folder never covers an absolute path', '/Notes/a.md', 'Projects/alpha', ['Notes'], 'outside-workspace'],
    ['the workspace root as a folder covers every workspace-relative path', 'Knowledge/x.md', 'Projects/alpha', [''], 'in-project'],
    ['the workspace root as a folder does not cover an absolute path', '/etc/hosts', 'Projects/alpha', [''], 'outside-workspace'],
    ['the Workspace project with an in-scope absolute folder', '/Users/me/notes/a.md', '', ['/Users/me/notes'], 'in-project'],
    ['no folders keeps the root-only behaviour', 'Notes/alpha/t.md', 'Projects/alpha', [], 'outside-project']
  ]

  it.each(cases)('%s', (_name, path, projectRoot, folders, expected) => {
    expect(classifyScope(path, projectRoot, folders)).toBe(expected)
  })
})

describe('scopeFolderOf', () => {
  it('picks the deepest containing folder', () => {
    expect(scopeFolderOf('Notes/alpha/sub/t.md', ['Notes', 'Notes/alpha', 'Notes/alpha/other'])).toBe('Notes/alpha')
  })
  it('returns null when no folder contains the path', () => {
    expect(scopeFolderOf('Other/t.md', ['Notes'])).toBeNull()
  })
})

describe('scopeRelativePath', () => {
  const ws = '/Users/me/git-base'
  const cases: [name: string, path: string, projectRoot: string, folders: string[], expected: string | null][] = [
    ['under the project root: from the root', 'Projects/alpha/docs/a.md', 'Projects/alpha', ['Notes/alpha'], 'docs/a.md'],
    ['the Workspace project: workspace-relative', 'Knowledge/a.md', '', [], 'Knowledge/a.md'],
    ['under an in-scope folder: <folder name>/…', 'Notes/alpha/T-1.md', 'Projects/alpha', ['Notes/alpha'], 'alpha/T-1.md'],
    ['under an in-scope absolute folder: <folder name>/…', '/Users/me/notes/x/a.md', 'Projects/alpha', ['/Users/me/notes'], 'notes/x/a.md'],
    ['the deepest folder names the path', 'Notes/alpha/sub/a.md', 'Projects/alpha', ['Notes', 'Notes/alpha/sub'], 'sub/a.md'],
    ['the workspace root as a folder: named after the workspace', 'Knowledge/a.md', 'Projects/alpha', [''], 'git-base/Knowledge/a.md'],
    ['outside the project scope: null', 'Other/a.md', 'Projects/alpha', ['Notes/alpha'], null],
    ['an absolute path outside the scope: null', '/etc/hosts', '', [], null]
  ]

  it.each(cases)('%s', (_name, path, projectRoot, folders, expected) => {
    expect(scopeRelativePath(path, projectRoot, folders, ws)).toBe(expected)
  })
})

describe('treePathUnderRoot', () => {
  const cases: [name: string, abs: string, root: { path: string; canonAbs: string }, expected: string | null][] = [
    ['an outside root typed non-canonically', '/private/var/x/m/a/b.md', { path: '/var/x/m', canonAbs: '/private/var/x/m' }, '/var/x/m/a/b.md'],
    ['the root itself', '/private/var/x/m', { path: '/var/x/m', canonAbs: '/private/var/x/m' }, '/var/x/m'],
    ['a workspace mount', '/ws/Knowledge/a.md', { path: 'Knowledge', canonAbs: '/ws/Knowledge' }, 'Knowledge/a.md'],
    ['the workspace root as a root', '/ws/a/b.md', { path: '', canonAbs: '/ws' }, 'a/b.md'],
    ['a sibling sharing the prefix', '/ws/Knowledge2/a.md', { path: 'Knowledge', canonAbs: '/ws/Knowledge' }, null],
    ['outside the root', '/etc/hosts', { path: '/var/x/m', canonAbs: '/private/var/x/m' }, null],
    ['the filesystem root as a root', '/etc/hosts', { path: '/', canonAbs: '/' }, '/etc/hosts']
  ]

  it.each(cases)('%s', (_name, abs, root, expected) => {
    expect(treePathUnderRoot(abs, root)).toBe(expected)
  })
})

describe('ancestorsWithin', () => {
  const cases: [name: string, path: string, rootPath: string, expected: string[]][] = [
    ['under a project root', 'Projects/alpha/docs/sub/a.md', 'Projects/alpha', ['Projects/alpha/docs', 'Projects/alpha/docs/sub']],
    ['under the workspace root', 'docs/sub/a.md', '', ['docs', 'docs/sub']],
    ['under an outside root', '/Users/me/git-base/K/a.md', '/Users/me/git-base', ['/Users/me/git-base/K']],
    ['a direct child', 'Projects/alpha/a.md', 'Projects/alpha', []],
    ['the root itself', '/Users/me/git-base', '/Users/me/git-base', []],
    ['under the filesystem root', '/etc/ssh/a', '/', ['/etc', '/etc/ssh']]
  ]

  it.each(cases)('%s', (_name, path, rootPath, expected) => {
    expect(ancestorsWithin(path, rootPath)).toEqual(expected)
  })
})
