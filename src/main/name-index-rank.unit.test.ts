// Pomade — T-188 unit coverage for the name-index fold + ranking pure logic (`name-index-rank.ts`).
// The index build/patch/watch machinery is exercised by the e2e layer (name-index-freshness,
// terminal-link-*); this layer pins the ORDERING rules that are pure and revert-provable by reading.

import { describe, expect, it } from 'vitest'

import { foldKey, rankMatches } from './name-index-rank'

describe('foldKey', () => {
  it('is a plain locale-independent lowercase fold', () => {
    expect(foldKey('README.md')).toBe('readme.md')
    expect(foldKey('Northwind')).toBe('northwind')
    expect(foldKey('already-low')).toBe('already-low')
  })
})

describe('rankMatches — exact-case first, then current-project, then walk order', () => {
  it('surfaces the exact-case basename before case-variant siblings', () => {
    const matches = ['docs/readme.md', 'README.md', 'sub/ReadMe.md']
    // Query is the exact case the user typed: `README.md` leads regardless of walk order.
    expect(rankMatches(matches, { query: 'README.md', projectRel: '' })).toEqual([
      'README.md',
      'docs/readme.md',
      'sub/ReadMe.md'
    ])
    // A different exact case promotes a different sibling; the rest stay in walk order.
    expect(rankMatches(matches, { query: 'ReadMe.md', projectRel: '' })).toEqual([
      'sub/ReadMe.md',
      'docs/readme.md',
      'README.md'
    ])
  })

  it('ranks current-project membership below exact-case but above the rest', () => {
    const matches = ['other/notes.md', 'proj/notes.md', 'proj/deep/notes.md']
    // No exact-case distinction (all lower `notes.md`), so project membership decides: the two
    // under `proj` come first (walk order among them), the outsider last.
    expect(rankMatches(matches, { query: 'notes.md', projectRel: 'proj' })).toEqual([
      'proj/notes.md',
      'proj/deep/notes.md',
      'other/notes.md'
    ])
  })

  it('lets exact-case outrank project membership (exact-case is the primary key)', () => {
    const matches = ['proj/config.md', 'other/Config.md']
    // The exact-case `Config.md` lives OUTSIDE the active project, yet still leads a same-project
    // case-variant — exact-case is primary, project secondary.
    expect(rankMatches(matches, { query: 'Config.md', projectRel: 'proj' })).toEqual([
      'other/Config.md',
      'proj/config.md'
    ])
  })

  it('projectRel="" applies no project bias (Workspace project)', () => {
    const matches = ['a/x.md', 'b/x.md']
    expect(rankMatches(matches, { query: 'x.md', projectRel: '' })).toEqual(['a/x.md', 'b/x.md'])
  })

  it('byStem compares the match STEM, so an extension-less query folds correctly', () => {
    const matches = ['a/northwind.md', 'b/Northwind.md', 'c/NORTHWIND.md']
    // `[[Northwind]]` → stem query `Northwind`; only `Northwind.md`'s stem matches exactly.
    expect(rankMatches(matches, { query: 'Northwind', projectRel: '', byStem: true })).toEqual([
      'b/Northwind.md',
      'a/northwind.md',
      'c/NORTHWIND.md'
    ])
  })

  it('is stable — equal-rank matches keep their input (walk) order', () => {
    const matches = ['z/a.md', 'y/a.md', 'x/a.md']
    expect(rankMatches(matches, { query: 'a.md', projectRel: '' })).toEqual(matches)
  })
})
