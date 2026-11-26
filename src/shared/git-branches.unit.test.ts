import { describe, expect, it } from 'vitest'

import type { LiveSession, RepoSession } from 'pomade-kit/protocol'

import {
  countStatusEntries,
  joinLiveAgents,
  parseWorktrees,
  pickBranchSession,
  pullRequestUrl,
  readAgentState,
  squashMessage,
  statusPaths,
  tildePath,
  worktreeSlug,
  type LiveAgent
} from './git-branches'

describe('pullRequestUrl', () => {
  it('GitHub over ssh, scp-style and https: the compare page', () => {
    const want = 'https://github.com/dd-voronov/pomade/compare/main...feature/login?expand=1'
    expect(pullRequestUrl('git@github.com:dd-voronov/pomade.git', 'feature/login', 'main')).toBe(want)
    expect(pullRequestUrl('ssh://git@github.com/dd-voronov/pomade.git', 'feature/login', 'main')).toBe(want)
    expect(pullRequestUrl('https://github.com/dd-voronov/pomade', 'feature/login', 'main')).toBe(want)
    expect(pullRequestUrl('https://user@github.com/dd-voronov/pomade.git/', 'feature/login', 'main')).toBe(want)
  })
  it('GitLab (groups too): the new merge request page', () => {
    expect(pullRequestUrl('git@gitlab.com:team/sub/app.git', 'fix-typo', 'main')).toBe(
      'https://gitlab.com/team/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix-typo&merge_request%5Btarget_branch%5D=main'
    )
  })
  it('any other host, or a local path: none', () => {
    expect(pullRequestUrl('git@git.example.com:a/b.git', 'x', 'main')).toBeNull()
    expect(pullRequestUrl('/Users/me/remotes/beta.git', 'x', 'main')).toBeNull()
    expect(pullRequestUrl('git@github.com:nopath.git', 'x', 'main')).toBeNull()
  })
})

describe('worktrees and status', () => {
  it('parses git worktree list --porcelain', () => {
    const text = [
      'worktree /r/alpha',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /w/alpha/fix',
      'HEAD bbb',
      'branch refs/heads/fix/login',
      'locked',
      '',
      'worktree /w/alpha/det',
      'HEAD ccc',
      'detached',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n')
    expect(parseWorktrees(text)).toEqual([
      { path: '/r/alpha', head: 'aaa', branch: 'main', bare: false, locked: false, prunable: false },
      { path: '/w/alpha/fix', head: 'bbb', branch: 'fix/login', bare: false, locked: true, prunable: false },
      { path: '/w/alpha/det', head: 'ccc', branch: null, bare: false, locked: false, prunable: true }
    ])
  })
  it('counts and lists porcelain v1 -z entries, a rename once', () => {
    const z = ' M a.md\0R  new.md\0old.md\0?? n.txt\0'
    expect(countStatusEntries(z)).toBe(3)
    expect(statusPaths(z)).toEqual(['a.md', 'new.md', 'n.txt'])
    expect(countStatusEntries('')).toBe(0)
  })
  it('slugs, messages, ~ paths', () => {
    expect(worktreeSlug('feature/login form')).toBe('feature-login-form')
    expect(worktreeSlug('..')).toBe('worktree')
    expect(squashMessage('feature', ['One', 'Two'])).toBe('feature\n\n- One\n- Two\n')
    expect(squashMessage('feature', [])).toBe('feature')
    expect(tildePath('/Users/me/.pomade/worktrees/a', '/Users/me')).toBe('~/.pomade/worktrees/a')
    expect(tildePath('/tmp/x', '/Users/me')).toBe('/tmp/x')
  })
})

describe('pickBranchSession', () => {
  const at = (id: string, live: RepoSession['live'], lastActiveAt: string): RepoSession => ({
    id,
    agent: 'claude',
    name: null,
    status: 'active',
    live,
    cwd: '/ws/repo',
    branch: null,
    project: null,
    startedAt: '2026-11-01T10:00:00Z',
    lastActiveAt
  })
  it('none without sessions', () => {
    expect(pickBranchSession([])).toBeNull()
  })
  it('the latest when none is live', () => {
    expect(pickBranchSession([at('a', 'closed', '2026-11-02T10:00:00Z'), at('b', 'closed', '2026-11-03T10:00:00Z')])?.id).toBe('b')
  })
  it('a live one before a newer closed one; the latest of the live ones', () => {
    const sessions = [at('old-live', 'idle', '2026-11-01T10:00:00Z'), at('new-closed', 'closed', '2026-11-05T10:00:00Z'), at('live', 'working', '2026-11-02T10:00:00Z')]
    expect(pickBranchSession(sessions)?.id).toBe('live')
    expect(pickBranchSession([at('x', 'needs-you', '2026-11-01T10:00:00Z'), at('y', 'closed', '2026-11-09T10:00:00Z')])?.id).toBe('x')
  })
})

describe('readAgentState (T-323)', () => {
  it('idle only on the scanner reading idle; nothing known before its first reading', () => {
    expect(readAgentState(undefined)).toBeUndefined()
    expect(readAgentState({ kind: 'unknown' })).toBeUndefined()
    expect(readAgentState({ kind: 'working' })).toBe('working')
    expect(readAgentState({ kind: 'waiting', prompt: 'unknown', lines: [] })).toBe('needs-you')
    expect(readAgentState({ kind: 'waiting', prompt: 'question', lines: ['☐ Pick'], highlighted: 'Yes' })).toBe('needs-you')
    expect(readAgentState({ kind: 'idle', background: false })).toBe('idle')
    expect(readAgentState({ kind: 'idle', background: true })).toBe('idle')
  })
})

describe('joinLiveAgents (T-323)', () => {
  const tab = (state?: LiveSession['state'], cwd = '/ws/repo'): LiveSession => ({ sessionId: 's1', agent: 'claude', cwd, source: 'tab', job: null, ...(state ? { state } : {}) })
  const run = (state?: LiveSession['state']): LiveSession => ({ sessionId: null, agent: 'claude', cwd: '/ws/repo', source: 'run', job: 'Nightly', ...(state ? { state } : {}) })
  const own = (state?: LiveAgent['state'], pid = 101, cwd = '/ws/repo'): LiveAgent => ({ agentId: 'claude', cwd, ...(state ? { state } : {}), terminalPids: [pid] })

  it('passes each side through when alone, each agent and folder once', () => {
    expect(joinLiveAgents(null, [])).toEqual([])
    expect(joinLiveAgents(null, [own('idle'), own(undefined, 202, '/ws/repo/sub')])).toEqual([own('idle'), own(undefined, 202, '/ws/repo/sub')])
    expect(joinLiveAgents([tab('working'), tab()], [])).toEqual([{ agentId: 'claude', cwd: '/ws/repo', state: 'working' }])
    expect(joinLiveAgents([tab()], [])).toEqual([{ agentId: 'claude', cwd: '/ws/repo' }])
  })

  it("a tab the app gives no state for takes Pomade's reading of its terminal", () => {
    expect(joinLiveAgents([tab()], [own('idle')])).toEqual([own('idle')])
    expect(joinLiveAgents([tab()], [own()])).toEqual([own()])
  })

  it('the busier state wins: working, then not known, then needs-you, then idle', () => {
    expect(joinLiveAgents([tab('idle')], [own('working')])).toEqual([own('working')])
    expect(joinLiveAgents([tab('working')], [own('idle')])).toEqual([own('working')])
    expect(joinLiveAgents([tab('needs-you')], [own('idle')])).toEqual([own('needs-you')])
    expect(joinLiveAgents([tab('needs-you')], [own()])).toEqual([own()])
    expect(joinLiveAgents([tab('idle')], [own('idle'), own('working', 202)])).toEqual([{ ...own('working'), terminalPids: [101, 202] }])
    expect(joinLiveAgents([], [own('idle'), own('idle', 202), own('idle', 101)])).toEqual([{ ...own('idle'), terminalPids: [101, 202] }])
  })

  it('a run is never idle: its missing state is not known, its idle is not taken', () => {
    expect(joinLiveAgents([run()], [own('idle')])).toEqual([own()])
    expect(joinLiveAgents([run('idle')], [own('idle')])).toEqual([own()])
    expect(joinLiveAgents([run('idle')], [])).toEqual([{ agentId: 'claude', cwd: '/ws/repo' }])
    expect(joinLiveAgents([run('needs-you')], [own('idle')])).toEqual([own('needs-you')])
  })
})
