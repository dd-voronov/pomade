import { describe, expect, it } from 'vitest'

import { compareKey, compareMode, compareTitle, rightIsLive, sameSource, sourcePath, type CompareSource } from './compare'

const now = new Date(2026, 10, 10, 12).getTime()
const c = (hash: string, mo: number, d: number, y = 2026): { hash: string; date: number; subject: string } => ({
  hash,
  date: new Date(y, mo, d, 10).getTime(),
  subject: 's'
})
const rev = (rev: string, path = 'docs/BACKLOG.md'): CompareSource => ({ kind: 'rev', repo: 'Projects/a', rev, path })
const file = (path = 'docs/BACKLOG.md'): CompareSource => ({ kind: 'file', path })
const disk = (path = 'docs/BACKLOG.md'): CompareSource => ({ kind: 'disk', path })

describe('compareMode', () => {
  it('names the four shapes', () => {
    expect(compareMode(rev('HEAD'), file())).toBe('version-current')
    expect(compareMode(rev('a'.repeat(40)), rev('b'.repeat(40)))).toBe('version-version')
    expect(compareMode({ kind: 'none' }, rev('b'.repeat(40)))).toBe('version-version')
    expect(compareMode(disk('a.md'), file('b.md'))).toBe('file-file')
    expect(compareMode(disk(), file())).toBe('disk-mine')
  })

  it('rightIsLive and sourcePath', () => {
    expect(rightIsLive(file())).toBe(true)
    expect(rightIsLive(rev('HEAD'))).toBe(false)
    expect(sourcePath({ kind: 'none' })).toBe('')
    expect(sourcePath(disk('x.md'))).toBe('x.md')
  })
})

describe('compareTitle', () => {
  it('version ↔ current: the version\'s day ↔ now', () => {
    expect(compareTitle(rev('HEAD'), file(), { left: c('a1b2c3d4', 9, 12) }, now)).toBe('BACKLOG.md · Oct 12 ↔ now')
    expect(compareTitle(rev('HEAD'), file(), {}, now)).toBe('BACKLOG.md · HEAD ↔ now')
    expect(compareTitle(rev('a1b2c3d4e5'), file(), {}, now)).toBe('BACKLOG.md · a1b2c3d ↔ now')
    expect(compareTitle(rev('HEAD'), file(), { left: c('a1', 0, 3, 2025) }, now)).toBe('BACKLOG.md · Jan 3, 2025 ↔ now')
  })

  it('version ↔ version: days, or short hashes when the days read the same', () => {
    const l = rev('1'.repeat(40), 'old-links.md')
    const r = rev('2'.repeat(40), 'links.md')
    expect(compareTitle(l, r, { left: c('1'.repeat(40), 9, 11), right: c('2'.repeat(40), 9, 12) }, now)).toBe(
      'links.md · Oct 11 ↔ Oct 12'
    )
    expect(compareTitle(l, r, { left: c('1'.repeat(40), 9, 12), right: c('2'.repeat(40), 9, 12) }, now)).toBe(
      'links.md · 1111111 ↔ 2222222'
    )
    expect(compareTitle({ kind: 'none' }, r, { right: c('2'.repeat(40), 9, 12) }, now)).toBe('links.md · Oct 12')
  })

  it('a deleted file in a commit names the file from the left', () => {
    expect(compareTitle(rev('1'.repeat(40), 'gone.md'), rev('2'.repeat(40), 'gone.md'), {}, now)).toBe(
      'gone.md · 1111111 ↔ 2222222'
    )
  })

  it('disk ↔ my edits, and file ↔ file', () => {
    expect(compareTitle(disk(), file(), {}, now)).toBe('BACKLOG.md · disk ↔ my edits')
    expect(compareTitle(disk('notes/doc-A-15-july.md'), file('notes/doc-A-18-july.md'), {}, now)).toBe(
      'doc-A-15-july.md ↔ doc-A-18-july.md'
    )
  })
})

describe('compareTitle — Document history sources', () => {
  const draft: CompareSource = { kind: 'draft', path: 'docs/BACKLOG.md', id: 'd1', at: new Date(2026, 10, 8, 14, 32).getTime() }

  it('a draft ↔ now, a version ↔ the saved file, two drafts', () => {
    expect(compareMode(draft, file())).toBe('version-current')
    expect(compareTitle(draft, file(), {}, now)).toBe('BACKLOG.md · draft Nov 8 14:32 ↔ now')
    expect(compareMode(rev('HEAD'), disk())).toBe('version-version')
    expect(compareTitle(rev('HEAD'), disk(), { left: c('a1', 9, 12) }, now)).toBe('BACKLOG.md · Oct 12 ↔ saved')
    expect(compareTitle(draft, rev('HEAD'), { right: c('a1', 9, 12) }, now)).toBe('BACKLOG.md · draft Nov 8 14:32 ↔ Oct 12')
  })

  it('a local-history snapshot ↔ now carries its day and time', () => {
    const snap: CompareSource = { kind: 'snapshot', path: 'docs/BACKLOG.md', id: 's1', at: new Date(2026, 10, 8, 11, 5).getTime(), origin: 'disk' }
    expect(compareMode(snap, file())).toBe('version-current')
    expect(compareTitle(snap, file(), {}, now)).toBe('BACKLOG.md · Nov 8 11:05 ↔ now')
  })

  it('a draft is a read-only source with a path', () => {
    expect(rightIsLive(draft)).toBe(false)
    expect(sourcePath(draft)).toBe('docs/BACKLOG.md')
    expect(compareKey(draft, file())).not.toBe(compareKey({ ...draft, id: 'd2' }, file()))
  })
})

describe('compareKey', () => {
  it('is stable for equal sources and differs otherwise', () => {
    expect(compareKey(rev('HEAD'), file())).toBe(compareKey(rev('HEAD'), file()))
    expect(compareKey(rev('HEAD'), file())).not.toBe(compareKey(disk(), file()))
  })
})

describe('sameSource (T-224)', () => {
  it('matches by identity, not by optional fields or key order', () => {
    const snap: CompareSource = { kind: 'snapshot', path: 'a.md', id: 's1', at: 1, origin: 'saved' }
    expect(sameSource(snap, { path: 'a.md', kind: 'snapshot', origin: 'saved', at: 1, id: 's1', pathThen: 'b.md' })).toBe(true)
    expect(sameSource(snap, { ...snap, id: 's2' })).toBe(false)
    expect(sameSource({ kind: 'rev', repo: 'r', rev: 'abc', path: 'a.md' }, { kind: 'rev', repo: 'r', rev: 'abc', path: 'a.md' })).toBe(true)
    expect(sameSource({ kind: 'rev', repo: 'r', rev: 'abc', path: 'a.md' }, { kind: 'rev', repo: 'r', rev: 'HEAD', path: 'a.md' })).toBe(false)
    expect(sameSource({ kind: 'file', path: 'a.md' }, { kind: 'disk', path: 'a.md' })).toBe(false)
    expect(sameSource({ kind: 'none' }, { kind: 'none' })).toBe(true)
  })
})
