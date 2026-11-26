import { describe, expect, it } from 'vitest'

import {
  buildGitTreeIndex,
  parseRemotes,
  parseStatusV2,
  pickRemoteUrl,
  repoOfPath,
  reposInScope,
  scopeRepoChanges,
  summarizeScope,
  type GitSnapshot,
  type RepoState
} from './git-state'

const z = (...records: string[]): string => records.join('\0') + '\0'

function repo(partial: Partial<RepoState> & Pick<RepoState, 'root'>): RepoState {
  return {
    name: partial.root.split('/').pop() || 'ws',
    absPath: `/ws/${partial.root}`,
    remoteUrl: null,
    branch: 'main',
    head: 'a'.repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    hasCommits: true,
    changes: [],
    ignored: [],
    ignoredHolders: [],
    ...partial
  }
}

describe('parseStatusV2', () => {
  it('reads branch headers, ahead/behind and every record kind — and what of each change is staged', () => {
    const out = parseStatusV2(
      z(
        '# branch.oid 0123456789abcdef',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -1',
        '1 .M N... 100644 100644 100644 aaa bbb docs/a.md',
        '1 M. N... 100644 100644 100644 aaa bbb staged.md',
        '1 MM N... 100644 100644 100644 aaa bbb partly.md',
        '1 A. N... 000000 100644 100644 000 bbb added.md',
        '1 .D N... 100644 100644 000000 aaa aaa gone.md',
        '1 D. N... 100644 000000 000000 aaa 000 dir/removed.md',
        '2 R. N... 100644 100644 100644 aaa aaa R100 new name.md',
        'old name.md',
        'u UU N... 100644 100644 100644 100644 a b c clash.md',
        '? fresh.txt',
        '? newdir/',
        '! out/',
        '! debug.log'
      ),
      'Projects/p'
    )
    expect(out.branch).toBe('main')
    expect(out.upstream).toBe('origin/main')
    expect(out.ahead).toBe(2)
    expect(out.behind).toBe(1)
    expect(out.hasCommits).toBe(true)
    expect(out.changes).toEqual([
      { path: 'Projects/p/docs/a.md', status: 'modified' },
      { path: 'Projects/p/staged.md', status: 'modified', staged: 'all' },
      { path: 'Projects/p/partly.md', status: 'modified', staged: 'part' },
      { path: 'Projects/p/added.md', status: 'new', staged: 'all' },
      { path: 'Projects/p/gone.md', status: 'deleted' },
      { path: 'Projects/p/dir/removed.md', status: 'deleted', staged: 'all' },
      { path: 'Projects/p/new name.md', status: 'renamed', from: 'Projects/p/old name.md', staged: 'all' },
      { path: 'Projects/p/clash.md', status: 'conflict' },
      { path: 'Projects/p/fresh.txt', status: 'new' },
      { path: 'Projects/p/newdir', status: 'new', dir: true }
    ])
    expect(out.ignored).toEqual([{ path: 'Projects/p/out', dir: true }, { path: 'Projects/p/debug.log' }])
  })

  it('handles an unborn branch, a detached head, no upstream and the workspace-root repo', () => {
    const unborn = parseStatusV2(z('# branch.oid (initial)', '# branch.head main', '? a.md'), '')
    expect(unborn.hasCommits).toBe(false)
    expect(unborn.upstream).toBeNull()
    expect(unborn.ahead).toBe(0)
    expect(unborn.changes).toEqual([{ path: 'a.md', status: 'new' }])
    const detached = parseStatusV2(z('# branch.oid abc', '# branch.head (detached)'), '')
    expect(detached.branch).toBeNull()
  })

  it('treats a copy as new and skips unknown or malformed records', () => {
    const out = parseStatusV2(
      z('2 C. N... 100644 100644 100644 a a C90 copy.md', 'orig.md', '1 broken', 'x what'),
      ''
    )
    expect(out.changes).toEqual([{ path: 'copy.md', status: 'new', staged: 'all' }])
  })
})

describe('scopeRepoChanges', () => {
  it('drops entries inside nested repos and asks to expand untracked dirs that hold one', () => {
    const scoped = scopeRepoChanges(
      {
        changes: [
          { path: 'notes.md', status: 'modified' },
          { path: 'Knowledge', status: 'new', dir: true },
          { path: 'Projects', status: 'new', dir: true },
          { path: 'Projects/Pomade/x.md', status: 'modified' }
        ],
        ignored: [{ path: 'Knowledge', dir: true }, { path: 'Archive', dir: true }, { path: 'tmp.log' }]
      },
      ['Knowledge', 'Projects/Pomade']
    )
    expect(scoped.changes).toEqual([{ path: 'notes.md', status: 'modified' }])
    expect(scoped.expand).toEqual(['Projects'])
    expect(scoped.ignored).toEqual([{ path: 'Archive', dir: true }, { path: 'tmp.log' }])
    expect(scoped.ignoredHolders).toEqual([])
  })

  it('reports ignored folders that hold a nested repo, apart from the dimmed ones', () => {
    const scoped = scopeRepoChanges(
      { changes: [], ignored: [{ path: 'Projects', dir: true }, { path: 'Archive', dir: true }] },
      ['Projects/Pomade', 'Projects/pomade-kit']
    )
    expect(scoped.ignored).toEqual([{ path: 'Archive', dir: true }])
    expect(scoped.ignoredHolders).toEqual(['Projects'])
  })
})

describe('buildGitTreeIndex', () => {
  const snap: GitSnapshot = {
    repos: [
      repo({
        root: '',
        name: 'git-base',
        changes: [
          { path: 'top.md', status: 'modified' },
          { path: 'Fresh', status: 'new', dir: true },
          { path: 'docs/old/a.md', status: 'deleted' },
          { path: 'docs/old/deep/b.md', status: 'deleted' },
          { path: 'docs/kept.md', status: 'deleted' },
          { path: 'docs/kept.md', status: 'new' }
        ],
        ignored: [{ path: 'build', dir: true }, { path: 'x.log' }]
      }),
      repo({ root: 'Fresh/inner', changes: [{ path: 'Fresh/inner/z.md', status: 'modified' }] }),
      repo({ root: 'Projects/Pomade', changes: [{ path: 'Projects/Pomade/src/a.ts', status: 'renamed', from: 'Projects/Pomade/src/b.ts' }] })
    ]
  }
  const idx = buildGitTreeIndex(snap)

  it('resolves exact, inherited and nearest-repo statuses', () => {
    expect(idx.statusOf('top.md')?.status).toBe('modified')
    expect(idx.statusOf('Fresh/any/file.md')?.status).toBe('new')
    // Inheritance stops at a nested repo root.
    expect(idx.statusOf('Fresh/inner')).toBeNull()
    expect(idx.statusOf('Fresh/inner/other.md')).toBeNull()
    expect(idx.statusOf('Fresh/inner/z.md')?.status).toBe('modified')
    expect(idx.statusOf('Projects/Pomade/src/a.ts')).toMatchObject({ status: 'renamed', from: 'Projects/Pomade/src/b.ts' })
    // The renamed-from path is not a change of its own.
    expect(idx.statusOf('Projects/Pomade/src/b.ts')).toBeNull()
    // Deleted then re-created untracked: the file row reads new.
    expect(idx.statusOf('docs/kept.md')?.status).toBe('new')
  })

  it('marks every ancestor directory dirty, across repo boundaries', () => {
    expect(idx.hasChangesInside('')).toBe(true)
    expect(idx.hasChangesInside('Projects')).toBe(true)
    expect(idx.hasChangesInside('Projects/Pomade/src')).toBe(true)
    expect(idx.hasChangesInside('docs/old/deep')).toBe(true)
    expect(idx.hasChangesInside('elsewhere')).toBe(false)
  })

  it('answers ignored paths, including descendants of an ignored dir', () => {
    expect(idx.isIgnored('x.log')).toBe(true)
    expect(idx.isIgnored('build')).toBe(true)
    expect(idx.isIgnored('build/out/app.js')).toBe(true)
    expect(idx.isIgnored('top.md')).toBe(false)
  })

  it('offers ghost files and ghost folders per parent directory', () => {
    expect(idx.ghostsIn('docs/old')).toEqual(
      expect.arrayContaining([
        { name: 'a.md', path: 'docs/old/a.md', kind: 'file' },
        { name: 'deep', path: 'docs/old/deep', kind: 'dir' }
      ])
    )
    expect(idx.ghostsIn('docs/old/deep')).toEqual([{ name: 'b.md', path: 'docs/old/deep/b.md', kind: 'file' }])
    expect(idx.ghostsIn('docs')).toEqual(
      expect.arrayContaining([
        { name: 'old', path: 'docs/old', kind: 'dir' },
        { name: 'kept.md', path: 'docs/kept.md', kind: 'file' }
      ])
    )
    expect(idx.ghostsIn('')).toEqual([{ name: 'docs', path: 'docs', kind: 'dir' }])
    expect(idx.ghostsIn('Projects')).toEqual([])
  })
})

describe('summarizeScope', () => {
  const snap: GitSnapshot = {
    repos: [
      repo({
        root: '',
        name: 'git-base',
        upstream: 'origin/main',
        ahead: 1,
        changes: [
          { path: 'Agents/pm/CLAUDE.md', status: 'modified' },
          { path: 'top.md', status: 'new' }
        ]
      }),
      repo({ root: 'Knowledge', upstream: null, ahead: 0, changes: [{ path: 'Knowledge/a.md', status: 'new' }] }),
      repo({
        root: 'Projects/Pomade',
        name: 'Pomade',
        upstream: 'origin/main',
        ahead: 2,
        changes: [
          { path: 'Projects/Pomade/a.ts', status: 'modified' },
          { path: 'Projects/Pomade/b.ts', status: 'deleted' }
        ]
      })
    ]
  }

  it('sums every repo for the Workspace row', () => {
    const s = summarizeScope(snap, null)
    expect(s.uncommitted).toBe(5)
    expect(s.unpushed).toBe(3)
    expect(s.repos.map((r) => r.name)).toEqual(['git-base', 'Knowledge', 'Pomade'])
    expect(s.repos[1].unpushed).toBeNull()
  })

  it('scopes a repo-rooted project to its repo', () => {
    const s = summarizeScope(snap, 'Projects/Pomade')
    expect(s).toMatchObject({ uncommitted: 2, unpushed: 2 })
    expect(s.repos.map((r) => r.name)).toEqual(['Pomade'])
  })

  it('counts a sub-folder project by path and reports its enclosing repo', () => {
    const s = summarizeScope(snap, 'Agents/pm')
    expect(s).toMatchObject({ uncommitted: 1, unpushed: 1 })
    expect(s.repos.map((r) => r.name)).toEqual(['git-base'])
  })

  it('is empty for a clean, pushed scope outside every repo', () => {
    expect(summarizeScope({ repos: [] }, 'Projects/x')).toEqual({ uncommitted: 0, unpushed: 0, repos: [] })
  })

  describe('a project folder the enclosing repo ignores', () => {
    const ahead = { upstream: 'origin/main', ahead: 1 }
    const empty = { uncommitted: 0, unpushed: 0, repos: [] }
    const ignoredDir: GitSnapshot = { repos: [repo({ root: '', name: 'git-base', ...ahead, ignored: [{ path: 'Projects', dir: true }] })] }

    it('has no badge from that repo — an ignored directory above it', () => {
      expect(summarizeScope(ignoredDir, 'Projects/Job-hunt')).toEqual(empty)
      expect(reposInScope(ignoredDir, 'Projects/Job-hunt')).toEqual([])
    })

    it('has no badge from that repo — the folder itself ignored, or an ignored holder above it', () => {
      const exact: GitSnapshot = { repos: [repo({ root: '', ...ahead, ignored: [{ path: 'scratch' }] })] }
      expect(summarizeScope(exact, 'scratch')).toEqual(empty)
      const holder: GitSnapshot = { repos: [repo({ root: '', ...ahead, ignoredHolders: ['Projects'] })] }
      expect(summarizeScope(holder, 'Projects/Job-hunt')).toEqual(empty)
    })

    it('counts the enclosing repo when the folder is not ignored', () => {
      const tracked: GitSnapshot = { repos: [repo({ root: '', name: 'git-base', ...ahead, ignored: [{ path: 'Other', dir: true }] })] }
      const s = summarizeScope(tracked, 'Projects/Job-hunt')
      expect(s).toMatchObject({ uncommitted: 0, unpushed: 1 })
      expect(s.repos.map((r) => r.name)).toEqual(['git-base'])
      expect(reposInScope(tracked, 'Projects/Job-hunt').map((r) => r.root)).toEqual([''])
    })

    it('two projects sharing the ignored folder both show no badge', () => {
      expect(summarizeScope(ignoredDir, 'Projects/a')).toEqual(empty)
      expect(summarizeScope(ignoredDir, 'Projects/b')).toEqual(empty)
    })

    it('a project that is a repo keeps its own badge and the Workspace row still sums every repo', () => {
      const s: GitSnapshot = {
        repos: [...ignoredDir.repos, repo({ root: 'Projects/own', name: 'own', upstream: 'origin/main', ahead: 2 })]
      }
      expect(summarizeScope(s, 'Projects/own')).toMatchObject({ unpushed: 2 })
      expect(summarizeScope(s, null)).toMatchObject({ unpushed: 3 })
    })
  })
})

describe('parseStatusV2 — HEAD oid', () => {
  it('reports the commit HEAD points at, null before the first commit', () => {
    const oid = '0123456789abcdef0123456789abcdef01234567'
    expect(parseStatusV2(z(`# branch.oid ${oid}`, '# branch.head main'), '').head).toBe(oid)
    expect(parseStatusV2(z('# branch.oid (initial)', '# branch.head main'), '').head).toBeNull()
    expect(parseStatusV2('', '').head).toBeNull()
  })
})

describe('parseRemotes / pickRemoteUrl', () => {
  it('reads remotes in config order; dotted names; the first url of a remote wins', () => {
    const out = parseRemotes(
      z(
        'remote.origin.url\ngit@github.com:dd/pomade.git',
        'remote.my.fork.url\nhttps://example.com/fork.git',
        'remote.origin.url\n/second',
        'remote.local.url\n/Users/me/bare repo'
      )
    )
    expect(out).toEqual([
      { name: 'origin', url: 'git@github.com:dd/pomade.git' },
      { name: 'my.fork', url: 'https://example.com/fork.git' },
      { name: 'local', url: '/Users/me/bare repo' }
    ])
    expect(parseRemotes('')).toEqual([])
  })

  const remotes = [
    { name: 'up', url: 'U' },
    { name: 'origin', url: 'O' },
    { name: 'my', url: 'M' },
    { name: 'my/fork', url: 'MF' }
  ]
  it.each<[string | null, string | null]>([
    ['up/main', 'U'],
    ['origin/feature/x', 'O'],
    ['my/fork/main', 'MF'],
    ['my/main', 'M'],
    ['gone/main', 'O'],
    [null, 'O']
  ])('upstream %j → %j', (upstream, url) => {
    expect(pickRemoteUrl(remotes, upstream)).toBe(url)
  })

  it('no origin: the first remote; no remote: null (local only)', () => {
    expect(pickRemoteUrl([{ name: 'b', url: 'B' }, { name: 'a', url: 'A' }], null)).toBe('B')
    expect(pickRemoteUrl([], 'origin/main')).toBeNull()
  })
})

describe('reposInScope', () => {
  const snap: GitSnapshot = {
    repos: [
      repo({ root: '', ignored: [{ path: 'Projects', dir: true }] }),
      repo({ root: 'Knowledge' }),
      repo({ root: 'Projects/alpha' }),
      repo({ root: 'Projects/alpha/sub' }),
      repo({ root: 'Projects/group/one' }),
      repo({ root: 'Projects/group/two' })
    ]
  }
  const roots = (scope: string | null): string[] => reposInScope(snap, scope).map((r) => r.root)

  it('the Workspace project lists every repo', () => {
    expect(roots(null)).toEqual(['', 'Knowledge', 'Projects/alpha', 'Projects/alpha/sub', 'Projects/group/one', 'Projects/group/two'])
  })

  it('a project that is a repo lists itself and its nested repos', () => {
    expect(roots('Projects/alpha')).toEqual(['Projects/alpha', 'Projects/alpha/sub'])
    expect(roots('Projects/alpha/sub')).toEqual(['Projects/alpha/sub'])
  })

  it('a plain folder with repos inside lists those, not a parent repo that ignores it', () => {
    expect(roots('Projects/group')).toEqual(['Projects/group/one', 'Projects/group/two'])
  })

  it('a plain folder inside a repo that tracks it lists that enclosing repo', () => {
    expect(roots('Knowledge/notes')).toEqual(['Knowledge'])
    expect(roots('Docs')).toEqual([''])
    expect(roots('Projects/alpha/docs')).toEqual(['Projects/alpha'])
  })

  it('a parent repo whose ignored folder holds nested repos stays out of a project inside it', () => {
    const s: GitSnapshot = {
      repos: [repo({ root: '', ignoredHolders: ['Projects'] }), repo({ root: 'Projects/g/one' }), repo({ root: 'Projects/g/two' })]
    }
    expect(reposInScope(s, 'Projects/g').map((r) => r.root)).toEqual(['Projects/g/one', 'Projects/g/two'])
    expect(reposInScope(s, 'Notes').map((r) => r.root)).toEqual([''])
  })

  it('an ignored exact path excludes the enclosing repo too', () => {
    const s: GitSnapshot = { repos: [repo({ root: '', ignored: [{ path: 'scratch' }] })] }
    expect(reposInScope(s, 'scratch')).toEqual([])
  })
})

describe('repoOfPath', () => {
  const snap: GitSnapshot = { repos: [repo({ root: '' }), repo({ root: 'Projects/a' }), repo({ root: 'Projects/a/vendor' })] }

  it('is the deepest repo holding the path', () => {
    expect(repoOfPath(snap, 'todo.txt')?.root).toBe('')
    expect(repoOfPath(snap, 'Projects/a/docs/x.md')?.root).toBe('Projects/a')
    expect(repoOfPath(snap, 'Projects/a/vendor/lib.md')?.root).toBe('Projects/a/vendor')
    expect(repoOfPath(snap, 'Projects/ab/x.md')?.root).toBe('')
  })

  it('is null for no repo, an Untitled doc and an outside-workspace path', () => {
    expect(repoOfPath({ repos: [repo({ root: 'Projects/a' })] }, 'elsewhere/x.md')).toBeNull()
    expect(repoOfPath(snap, '')).toBeNull()
    expect(repoOfPath(snap, '/Users/me/x.md')).toBeNull()
    expect(repoOfPath(snap, 'Projects/a')?.root).toBe('')
  })
})
