import { describe, expect, it } from 'vitest'

import type { GitSnapshot, RepoState } from '@shared/git-state'
import { appRepos, toAppRepo } from './app-git'

function repo(root: string, extra: Partial<RepoState> = {}): RepoState {
  return {
    root,
    name: root === '' ? 'ws' : root.slice(root.lastIndexOf('/') + 1),
    absPath: root === '' ? '/Users/me/ws' : `/Users/me/ws/${root}`,
    remoteUrl: root === '' ? null : `git@github.com:me/${root}.git`,
    branch: 'main',
    head: 'a'.repeat(40),
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    hasCommits: true,
    changes: [],
    ignored: [],
    ignoredHolders: ['Projects'],
    ...extra
  }
}

const SNAPSHOT: GitSnapshot = {
  repos: [
    repo('', { changes: [{ path: 'notes.md', status: 'modified' }], ignored: [{ path: 'tmp', dir: true }] }),
    repo('Knowledge', { ahead: 2 }),
    repo('Projects/Pomade', { changes: [{ path: 'Projects/Pomade/b.md', status: 'renamed', from: 'Projects/Pomade/a.md' }] }),
    repo('Projects/kit', { branch: null, upstream: null, error: 'fatal: bad object HEAD' })
  ]
}

describe('toAppRepo', () => {
  it('carries everything but the ignored entries and the panel-only head / ignoredHolders; an error only when set', () => {
    expect(toAppRepo(SNAPSHOT.repos[0])).toEqual({
      name: 'ws',
      root: '',
      absPath: '/Users/me/ws',
      remoteUrl: null,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      hasCommits: true,
      changes: [{ path: 'notes.md', status: 'modified' }]
    })
    expect(toAppRepo(SNAPSHOT.repos[3])).toMatchObject({ branch: null, upstream: null, error: 'fatal: bad object HEAD' })
    expect('error' in toAppRepo(SNAPSHOT.repos[1])).toBe(false)
  })

  it('copies the changes: an app-side edit never reaches the snapshot', () => {
    const out = toAppRepo(SNAPSHOT.repos[2])
    out.changes[0].path = 'x'
    expect(SNAPSHOT.repos[2].changes[0].path).toBe('Projects/Pomade/b.md')
  })
})

describe('appRepos', () => {
  it.each([
    ['', ['', 'Knowledge', 'Projects/Pomade', 'Projects/kit']],
    ['Projects/Pomade', ['Projects/Pomade']],
    ['Projects/Pomade/docs', ['Projects/Pomade']],
    ['Projects', ['', 'Projects/Pomade', 'Projects/kit']],
    ['Apps/planner', ['']]
  ])('scope %j → %j', (scope, roots) => {
    expect(appRepos(SNAPSHOT, scope).map((r) => r.root)).toEqual(roots)
  })

  it('an empty snapshot has no repos', () => {
    expect(appRepos({ repos: [] }, '')).toEqual([])
  })
})
