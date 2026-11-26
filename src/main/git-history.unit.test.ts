import { describe, expect, it } from 'vitest'

import { COMMIT_FILES_LIMIT, LOG_PAGE_SIZE, UNPUSHED_LIMIT } from '@shared/git-history'
import { isCommitHash, readCommit, readFileLog, readLog, readMergeInner, readRevisionFile, readUnpushed, type GitBufferRunner, type GitRunner } from './git-history'
import { COMPARE_MAX_BYTES } from '@shared/compare'

const US = '\x1f'
const RS = '\x1e'
const hash = (i: number): string => i.toString(16).padStart(40, '0')
const logRec = (i: number, parents: string[] = [hash(i + 1)]): string =>
  [hash(i), parents.join(' '), 'A', 'a@x', String(1_700_000_000 - i), `commit ${i}`].join(US) + RS + '\n'

function fake(reply: (args: readonly string[]) => string): { run: GitRunner; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  return {
    calls,
    run: async (_cwd, args) => {
      calls.push(args)
      return reply(args)
    }
  }
}

/** A repo whose branch has no upstream: `rev-parse @{upstream}` fails, `log` answers `reply`. */
function noUpstream(reply: (args: readonly string[]) => string): ReturnType<typeof fake> {
  return fake((args) => {
    if (args[0] === 'rev-parse') throw new Error('fatal: no upstream configured for branch')
    return reply(args)
  })
}

const logCalls = (calls: (readonly string[])[]): (readonly string[])[] => calls.filter((a) => a[0] === 'log')

describe('readLog', () => {
  it('asks for one page plus one, first-parent unless every commit is asked for', async () => {
    const f = noUpstream(() => Array.from({ length: LOG_PAGE_SIZE + 1 }, (_, i) => logRec(i)).join(''))
    const page = await readLog(f.run, '/r', { all: false, skip: 50 })
    expect(page.commits).toHaveLength(LOG_PAGE_SIZE)
    expect(page.more).toBe(true)
    const first = logCalls(f.calls)[0]
    expect(first).toContain('--first-parent')
    expect(first).toContain('--skip=50')
    expect(first).toContain(String(LOG_PAGE_SIZE + 1))
    expect(first).toContain('HEAD')

    await readLog(f.run, '/r', { all: true, skip: -3.5 })
    const second = logCalls(f.calls)[1]
    expect(second).not.toContain('--first-parent')
    expect(second).toContain('--skip=0')
  })

  it('reports the last page', async () => {
    const f = noUpstream(() => logRec(1) + logRec(2))
    expect(await readLog(f.run, '/r', { all: false, skip: 0 })).toMatchObject({ more: false })
  })

  it('with an upstream, starts where the branch meets it — the commits not pushed are left out', async () => {
    const f = fake((args) => {
      if (args[0] === 'rev-parse') return `${hash(7)}\n`
      if (args[0] === 'merge-base') return `${hash(3)}\n${hash(4)}\n`
      return logRec(3)
    })
    await readLog(f.run, '/r', { all: false, skip: 0 })
    expect(f.calls[1]).toEqual(['merge-base', '--all', 'HEAD', '@{upstream}'])
    const log = logCalls(f.calls)[0]
    expect(log).toEqual(expect.arrayContaining([hash(3), hash(4), '--first-parent']))
    expect(log).not.toContain('HEAD')
  })

  it('a branch sharing no commit with its upstream has no History: every commit is not pushed', async () => {
    const f = fake((args) => {
      if (args[0] === 'merge-base') throw new Error('exit 1')
      return args[0] === 'rev-parse' ? `${hash(7)}\n` : logRec(1)
    })
    expect(await readLog(f.run, '/r', { all: true, skip: 0 })).toEqual({ commits: [], more: false })
    expect(logCalls(f.calls)).toHaveLength(0)
  })
})

describe('readUnpushed', () => {
  it('lists every commit the upstream lacks, capped', async () => {
    const f = fake((args) => (args[0] === 'rev-parse' ? `${hash(7)}\n` : Array.from({ length: UNPUSHED_LIMIT + 1 }, (_, i) => logRec(i)).join('')))
    const page = await readUnpushed(f.run, '/r')
    expect(page.commits).toHaveLength(UNPUSHED_LIMIT)
    expect(page.more).toBe(true)
    const log = logCalls(f.calls)[0]
    expect(log).toContain('@{upstream}..HEAD')
    expect(log).not.toContain('--first-parent')
  })

  it('no upstream: nothing, without reading the log', async () => {
    const f = noUpstream(() => logRec(1))
    expect(await readUnpushed(f.run, '/r')).toEqual({ commits: [], more: false })
    expect(logCalls(f.calls)).toHaveLength(0)
  })
})

describe('readMergeInner', () => {
  it('lists what the merge brought in, excluding its first parent\'s history', async () => {
    const f = fake(() => logRec(5))
    const page = await readMergeInner(f.run, '/r', hash(9))
    expect(page.commits.map((c) => c.subject)).toEqual(['commit 5'])
    expect(f.calls[0]).toEqual(expect.arrayContaining([`${hash(9)}^@`, `^${hash(9)}^1`]))
  })

  it('refuses anything but a hash', async () => {
    const f = fake(() => '')
    await expect(readMergeInner(f.run, '/r', 'HEAD; rm -rf')).rejects.toThrow('Not a commit')
    expect(f.calls).toHaveLength(0)
  })
})

describe('readCommit', () => {
  const header = (parents: string[]): string =>
    [hash(1), parents.join(' '), 'Alex', 'd@x', '1700000000', 'Subject', 'Subject\n\nBody'].join(US) + RS + '\n'

  it('diffs against the first parent and joins the file lists', async () => {
    const f = fake((args) => {
      if (args[0] === 'show') return header([hash(2), hash(3)])
      if (args.includes('--name-status')) return 'M\0a.md\0'
      return '2\t1\ta.md\0'
    })
    const c = await readCommit(f.run, '/r', hash(1))
    expect(c.message).toBe('Subject\n\nBody')
    expect(c.files).toEqual([{ path: 'a.md', status: 'modified', added: 2, removed: 1 }])
    expect(f.calls[1].slice(-2)).toEqual([hash(2), hash(1)])
    expect(c.totalFiles).toBeUndefined()
  })

  it('diffs a root commit with --root', async () => {
    const f = fake((args) => (args[0] === 'show' ? header([]) : ''))
    await readCommit(f.run, '/r', hash(1))
    expect(f.calls[1].slice(-2)).toEqual(['--root', hash(1)])
  })

  it('caps a huge file list and says how many there were', async () => {
    const n = COMMIT_FILES_LIMIT + 5
    const f = fake((args) => {
      if (args[0] === 'show') return header([hash(2)])
      if (args.includes('--name-status')) return Array.from({ length: n }, (_, i) => `A\0f${i}\0`).join('')
      return ''
    })
    const c = await readCommit(f.run, '/r', hash(1))
    expect(c.files).toHaveLength(COMMIT_FILES_LIMIT)
    expect(c.totalFiles).toBe(n)
  })

  it('names a commit that is not there', async () => {
    const f = fake(() => {
      throw new Error('fatal: bad object')
    })
    await expect(readCommit(f.run, '/r', hash(1))).rejects.toThrow('Commit 0000000 is not in this repository.')
  })

  it('isCommitHash', () => {
    expect(isCommitHash(hash(1))).toBe(true)
    expect(isCommitHash('abc1234')).toBe(true)
    expect(isCommitHash('abc')).toBe(false)
    expect(isCommitHash('HEAD')).toBe(false)
    expect(isCommitHash(7)).toBe(false)
  })
})

describe('readRevisionFile — the comparison source resolver', () => {
  const commitLog = logRec(1)
  const make = (opts: { log?: () => string; size?: () => string; blob?: Buffer }) => {
    const calls: (readonly string[])[] = []
    const run: GitRunner = async (_c, args) => {
      calls.push(args)
      if (args[0] === 'log') return (opts.log ?? (() => commitLog))()
      if (args[0] === 'cat-file') return (opts.size ?? (() => '12\n'))()
      return ''
    }
    const runBuf = async (_c: string, args: readonly string[]): Promise<Buffer> => {
      calls.push(args)
      return opts.blob ?? Buffer.from('hello\n')
    }
    return { run, runBuf, calls }
  }

  it('reads text at a revision, with the commit for the label', async () => {
    const f = make({})
    const out = await readRevisionFile(f.run, f.runBuf, '/r', 'HEAD', 'docs/a.md')
    expect(out).toEqual({ kind: 'text', content: 'hello\n', commit: { hash: hash(1), date: (1_700_000_000 - 1) * 1000, subject: 'commit 1' } })
    expect(f.calls[1]).toEqual(['cat-file', '-s', `${hash(1)}:docs/a.md`])
  })

  it('a revision that does not resolve (missing, or git fails) is no-revision', async () => {
    expect(await readRevisionFile(make({ log: () => '' }).run, make({}).runBuf, '/r', 'abcdef1', 'a.md')).toEqual({ kind: 'no-revision' })
    const failing = make({
      log: () => {
        throw new Error('bad revision')
      }
    })
    expect(await readRevisionFile(failing.run, failing.runBuf, '/r', 'abcdef1', 'a.md')).toEqual({ kind: 'no-revision' })
    expect(await readRevisionFile(failing.run, failing.runBuf, '/r', 'HEAD~1; rm', 'a.md')).toEqual({ kind: 'no-revision' })
  })

  it('a file absent at the revision', async () => {
    const f = make({
      size: () => {
        throw new Error('fatal: path not in tree')
      }
    })
    expect(await readRevisionFile(f.run, f.runBuf, '/r', 'HEAD', 'new.md')).toMatchObject({ kind: 'absent' })
  })

  it('refuses binary content', async () => {
    const f = make({ blob: Buffer.from([0x89, 0x50, 0x00, 0x47]) })
    expect(await readRevisionFile(f.run, f.runBuf, '/r', 'HEAD', 'logo.png')).toMatchObject({ kind: 'binary', size: 4 })
  })

  it('refuses over 2 MB without reading the content', async () => {
    const f = make({ size: () => String(COMPARE_MAX_BYTES + 1) })
    expect(await readRevisionFile(f.run, f.runBuf, '/r', 'HEAD', 'big.log')).toMatchObject({ kind: 'too-big', size: COMPARE_MAX_BYTES + 1 })
    expect(f.calls.some((a) => a[1] === 'blob')).toBe(false)
  })

  it('refuses a path that leaves the repo', async () => {
    const f = make({})
    await expect(readRevisionFile(f.run, f.runBuf, '/r', 'HEAD', '../secret')).rejects.toThrow('Not a path')
    await expect(readRevisionFile(f.run, f.runBuf, '/r', 'HEAD', '')).rejects.toThrow('Not a path')
  })
})

describe('readFileLog', () => {
  const US = '\x1f'
  const RS = '\x1e'
  const rec = (i: number, ...files: string[]): string =>
    `${RS}${[hash(i), hash(i + 1), 'A', 'a@x', String(1_700_000_000 - i), `commit ${i}`].join(US)}\0\n${files.map((f) => f + '\0').join('')}`
  const noBuf: GitBufferRunner = async () => {
    throw new Error('no blob read expected')
  }
  const opts = { all: false, skip: 0 }

  it('asks for one page plus one of the file\'s history, first-parent unless every commit is asked for', async () => {
    const f = fake(() => Array.from({ length: LOG_PAGE_SIZE + 1 }, (_, i) => rec(i, 'M', 'docs/a.md')).join(''))
    const page = await readFileLog(f.run, noBuf, '/r', 'docs/a.md', { all: false, skip: 50 })
    expect(page.commits).toHaveLength(LOG_PAGE_SIZE)
    expect(page.more).toBe(true)
    expect(page.commits[0].path).toBe('docs/a.md')
    expect(f.calls[0]).toEqual(expect.arrayContaining(['--follow', '--name-status', '-z', '--first-parent', '--skip=50']))
    expect(f.calls[0].slice(-2)).toEqual(['--', 'docs/a.md'])

    await readFileLog(f.run, noBuf, '/r', 'docs/a.md', { all: true, skip: -2 })
    expect(f.calls[1]).not.toContain('--first-parent')
    expect(f.calls[1]).toContain('--skip=0')
  })

  it('follows a rename: the path each commit carries', async () => {
    const f = fake(() => rec(1, 'M', 'new.md') + rec(2, 'R100', 'old.md', 'new.md') + rec(3, 'A', 'old.md'))
    const page = await readFileLog(f.run, noBuf, '/r', 'new.md', opts)
    expect(page.commits.map((c) => c.path)).toEqual(['new.md', 'new.md', 'old.md'])
    expect(page.more).toBe(false)
    expect(page.renamedFrom).toBeUndefined()
  })

  it('a repository with no commits has no history; a path leaving the repo is refused', async () => {
    const failing: GitRunner = async () => {
      throw new Error('fatal: your current branch does not have any commits yet')
    }
    expect(await readFileLog(failing, noBuf, '/r', 'a.md', opts)).toEqual({ commits: [], more: false })
    const f = fake(() => '')
    await expect(readFileLog(f.run, noBuf, '/r', '../x.md', opts)).rejects.toThrow('Not a path')
    await expect(readFileLog(f.run, noBuf, '/r', '/abs.md', opts)).rejects.toThrow('Not a path')
    await expect(readFileLog(f.run, noBuf, '/r', 'a.md', { ...opts, via: '../x.md' })).rejects.toThrow('Not a path')
    expect(f.calls).toHaveLength(0)
  })

  describe('a file moved without git knowing', () => {
    const old = 'line one\nline two\nline three\nline four\n'
    const blobs: Record<string, string> = { 'HEAD:was.md': old, 'HEAD:other.md': 'unrelated\ntext\n' }
    const runner = (): { run: GitRunner; buf: GitBufferRunner; calls: string[][] } => {
      const calls: string[][] = []
      return {
        calls,
        run: async (_c, args) => {
          calls.push([...args])
          if (args[0] === 'cat-file') return String(blobs[args[2]]?.length ?? 0)
          return args[args.length - 1] === 'was.md' ? rec(1, 'M', 'was.md') + rec(2, 'A', 'was.md') : ''
        },
        buf: async (_c, args) => Buffer.from(blobs[args[2]] ?? '')
      }
    }

    it('finds the deleted file it was moved from by content and reads that history', async () => {
      const r = runner()
      const page = await readFileLog(r.run, r.buf, '/r', 'now.md', {
        ...opts,
        candidates: ['other.md', 'was.md'],
        readWorking: async () => 'line one\nline two\nline three EDITED\nline four\n'
      })
      expect(page.renamedFrom).toBe('was.md')
      expect(page.commits.map((c) => c.path)).toEqual(['was.md', 'was.md'])
    })

    it('does not guess when nothing is similar enough, when the file has history, or past page one', async () => {
      const r = runner()
      const base = { candidates: ['other.md'], readWorking: async () => 'line one\nline two\n' }
      expect((await readFileLog(r.run, r.buf, '/r', 'now.md', { ...opts, ...base })).renamedFrom).toBeUndefined()
      expect((await readFileLog(r.run, r.buf, '/r', 'was.md', { ...opts, candidates: ['was.md'], readWorking: async () => old })).renamedFrom).toBeUndefined()
      const calls = r.calls.length
      await readFileLog(r.run, r.buf, '/r', 'now.md', { all: false, skip: 50, candidates: ['was.md'], readWorking: async () => old })
      expect(r.calls.slice(calls).some((c) => c[0] === 'cat-file')).toBe(false)
    })

    it('`via` reads that path\'s history directly and says so', async () => {
      const r = runner()
      const page = await readFileLog(r.run, r.buf, '/r', 'now.md', { ...opts, via: 'was.md' })
      expect(page.renamedFrom).toBe('was.md')
      expect(page.commits).toHaveLength(2)
      expect(r.calls).toHaveLength(1)
    })
  })
})
