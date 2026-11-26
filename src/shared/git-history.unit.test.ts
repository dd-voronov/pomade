import { describe, expect, it } from 'vitest'

import {
  DETAILS_FORMAT,
  FILE_LOG_FORMAT,
  LOG_FORMAT,
  commitDateLabel,
  commitTimestamp,
  isMerge,
  parseCommitFiles,
  parseCommitHeader,
  parseFileLog,
  parseLog,
  relativeTime,
  remoteLabel,
  textSimilarity
} from './git-history'

const US = '\x1f'
const RS = '\x1e'
const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const H3 = 'c'.repeat(40)

const rec = (...f: string[]): string => f.join(US) + RS

describe('formats', () => {
  it('separate fields with US and end records with RS', () => {
    expect(LOG_FORMAT).toBe('--format=%H\x1f%P\x1f%an\x1f%ae\x1f%at\x1f%s\x1f%(trailers:key=Pomade-Job,valueonly,separator=%x1d)\x1e')
    expect(DETAILS_FORMAT.endsWith('%s\x1f%B\x1e')).toBe(true)
  })
})

describe('parseLog', () => {
  it('reads records git separates with newlines', () => {
    const out = [
      rec(H1, `${H2} ${H3}`, 'Alex', 'd@x.io', '1700000000', 'Merge branch T-197'),
      '\n',
      rec(H2, H3, 'Agent', 'a@x.io', '1699990000', 'T-198: markdown file links'),
      '\n',
      rec(H3, '', 'Agent', 'a@x.io', '1699980000', 'root'),
      '\n'
    ].join('')
    const commits = parseLog(out)
    expect(commits).toHaveLength(3)
    expect(commits[0]).toEqual({
      hash: H1,
      parents: [H2, H3],
      author: 'Alex',
      authorEmail: 'd@x.io',
      date: 1_700_000_000_000,
      subject: 'Merge branch T-197'
    })
    expect(isMerge(commits[0])).toBe(true)
    expect(isMerge(commits[1])).toBe(false)
    expect(commits[2].parents).toEqual([])
  })

  it('keeps subjects with odd characters and skips malformed records', () => {
    const out = rec(H1, '', 'A', 'e', '1', 'fix: "quotes" | pipes\ttabs') + rec('nothash', '', 'A', 'e', '1', 'x') + '\n'
    const commits = parseLog(out)
    expect(commits).toHaveLength(1)
    expect(commits[0].subject).toBe('fix: "quotes" | pipes\ttabs')
  })

  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([])
    expect(parseLog(rec(H1, H2, 'Runner', 'r@x.io', '1700000000', 'Committed automatically', 'Knowledge twice daily\x1dsecond'))[0].job).toBe(
      'Knowledge twice daily'
    )
    expect(parseLog(rec(H1, H2, 'A', 'a@x.io', '1700000000', 'plain', ''))[0]).not.toHaveProperty('job')
    expect(parseLog('\n')).toEqual([])
  })
})

describe('parseCommitHeader', () => {
  it('returns the summary and the full message with trailing whitespace trimmed', () => {
    const msg = 'T-197: terminal Cmd+click fix\n\n- **bold** body\n- second line\n\n'
    const c = parseCommitHeader(rec(H1, H2, 'Alex', 'd@x.io', '1700000000', 'T-197: terminal Cmd+click fix', msg) + '\n')
    expect(c?.message).toBe('T-197: terminal Cmd+click fix\n\n- **bold** body\n- second line')
    expect(c?.parents).toEqual([H2])
  })

  it('keeps a message that itself contains the unit separator', () => {
    const c = parseCommitHeader(rec(H1, '', 'A', 'e', '1', 's', `a${US}b`))
    expect(c?.message).toBe(`a${US}b`)
  })

  it('is null for malformed output', () => {
    expect(parseCommitHeader('')).toBeNull()
    expect(parseCommitHeader('fatal: bad object')).toBeNull()
  })
})

describe('parseCommitFiles', () => {
  const z = (...r: string[]): string => r.join('\0') + '\0'

  it('joins letters and counts, renames and binaries included', () => {
    const nameStatus = z('M', 'docs/BACKLOG.md', 'A', 'new.md', 'D', 'gone.md', 'R087', 'old name.md', 'new name.md', 'M', 'logo.png', 'T', 'link')
    const numstat = z('3\t1\tdocs/BACKLOG.md', '10\t0\tnew.md', '0\t4\tgone.md', '1\t1\t', 'old name.md', 'new name.md', '-\t-\tlogo.png', '1\t1\tlink')
    expect(parseCommitFiles(nameStatus, numstat)).toEqual([
      { path: 'docs/BACKLOG.md', status: 'modified', added: 3, removed: 1 },
      { path: 'new.md', status: 'added', added: 10, removed: 0 },
      { path: 'gone.md', status: 'deleted', added: 0, removed: 4 },
      { path: 'new name.md', status: 'renamed', from: 'old name.md', added: 1, removed: 1 },
      { path: 'logo.png', status: 'modified', added: null, removed: null },
      { path: 'link', status: 'modified', added: 1, removed: 1 }
    ])
  })

  it('reads a copy as added (at its new path)', () => {
    expect(parseCommitFiles(z('C100', 'a.md', 'b.md'), z('0\t0\t', 'a.md', 'b.md'))).toEqual([
      { path: 'b.md', status: 'added', added: 0, removed: 0 }
    ])
  })

  it('tolerates a missing numstat and empty output', () => {
    expect(parseCommitFiles(z('M', 'a.md'), '')).toEqual([{ path: 'a.md', status: 'modified', added: null, removed: null }])
    expect(parseCommitFiles('', '')).toEqual([])
  })
})

describe('remoteLabel', () => {
  it('shows host/owner/name for scp-like and URL remotes', () => {
    expect(remoteLabel('git@github.com:octo-org/widgets.git')).toBe('github.com/octo-org/widgets')
    expect(remoteLabel('https://github.com/dd-voronov/pomade.git')).toBe('github.com/dd-voronov/pomade')
    expect(remoteLabel('ssh://git@gitlab.com:2222/team/x.git/')).toBe('gitlab.com:2222/team/x')
    expect(remoteLabel('https://user:token@github.com/a/b')).toBe('github.com/a/b')
  })

  it('shows a local remote as its path', () => {
    expect(remoteLabel('/tmp/pomade-remote-1/')).toBe('/tmp/pomade-remote-1')
    expect(remoteLabel('file:///srv/repos/x.git')).toBe('/srv/repos/x')
    expect(remoteLabel('../sibling.git')).toBe('../sibling')
  })
})

describe('dates', () => {
  const now = new Date(2026, 10, 10, 15, 0).getTime()
  const at = (d: number, h = 12, m = 0, y = 2026, mo = 10): number => new Date(y, mo, d, h, m).getTime()

  it('relativeTime walks from just now to a date', () => {
    expect(relativeTime(now - 30_000, now)).toBe('just now')
    expect(relativeTime(now + 60_000, now)).toBe('just now')
    expect(relativeTime(now - 12 * 60_000, now)).toBe('12 min ago')
    expect(relativeTime(at(10, 9), now)).toBe('6 h ago')
    expect(relativeTime(at(9, 23, 30), now)).toBe('yesterday')
    expect(relativeTime(at(6), now)).toBe('4 days ago')
    expect(relativeTime(at(3), now)).toBe('Nov 3')
    expect(relativeTime(at(12, 12, 0, 2025, 9), now)).toBe('Oct 12, 2025')
  })

  it('commitDateLabel and commitTimestamp', () => {
    expect(commitDateLabel(at(12, 9, 0, 2026, 9), now)).toBe('Oct 12')
    expect(commitDateLabel(at(1, 9, 0, 2025, 0), now)).toBe('Jan 1, 2025')
    expect(commitTimestamp(at(12, 9, 5, 2026, 9))).toBe('Oct 12, 2026, 09:05')
  })
})

describe('parseFileLog', () => {
  // `git log --follow --name-status -z FILE_LOG_FORMAT`: RS-led records; the header ends at a NUL, a
  // newline precedes the first status, and the next record's RS follows the last path's NUL.
  const head = (hash: string, subject: string): string => [hash, '', 'A', 'a@x', '1700000000', subject].join(US)
  const log = (...recs: [string, string, ...string[]][]): string =>
    recs.map(([hash, subject, ...files]) => `${RS}${head(hash, subject)}\0\n${files.map((f) => f + '\0').join('')}`).join('')

  it('reads each commit with the file path at that commit, across a rename', () => {
    const out = parseFileLog(
      log([H1, 'edit', 'M', 'docs/new name.md'], [H2, 'rename', 'R100', 'docs/a.md', 'docs/new name.md'], [H3, 'create', 'A', 'docs/a.md']),
      'docs/new name.md'
    )
    expect(out.map((c) => [c.subject, c.path])).toEqual([
      ['edit', 'docs/new name.md'],
      ['rename', 'docs/new name.md'],
      ['create', 'docs/a.md']
    ])
    expect(out[0]).toMatchObject({ hash: H1, author: 'A', date: 1_700_000_000_000 })
  })

  it('a commit with no listed file keeps the path in force; a rename moves it back for older commits', () => {
    const out = parseFileLog(log([H1, 'merge'], [H2, 'rename', 'R90', 'old.md', 'new.md'], [H3, 'older']), 'new.md')
    expect(out.map((c) => c.path)).toEqual(['new.md', 'new.md', 'old.md'])
  })

  it('the first-listed file wins; malformed records are skipped; empty output is empty', () => {
    expect(parseFileLog('', 'a.md')).toEqual([])
    expect(parseFileLog(`${RS}not-a-hash${US}x`, 'a.md')).toEqual([])
  })

  it('declares RS-led fields in LOG_FORMAT order', () => {
    expect(FILE_LOG_FORMAT.startsWith(`--format=${RS}%H${US}%P`)).toBe(true)
  })
})

describe('textSimilarity', () => {
  it('is 1 for the same text and falls with what changed', () => {
    expect(textSimilarity('a\nb\nc', 'a\nb\nc')).toBe(1)
    expect(textSimilarity('a\nb\nc\nd', 'a\nb\nc\nX')).toBe(0.75)
    expect(textSimilarity('a\nb', 'x\ny')).toBe(0)
  })

  it('counts repeated lines as many times as both texts hold them', () => {
    expect(textSimilarity('a\na\na', 'a')).toBe(0.5)
  })
})
