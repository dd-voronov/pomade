import { describe, expect, it } from 'vitest'

import {
  isDocTabOf,
  isVersionSource,
  replaceQuestion,
  retargetVersion,
  sameDocTab,
  sameVersion,
  versionLabel,
  versionPath,
  versionTabTitle
} from './doc-version'

const now = new Date(2026, 10, 17, 15, 0).getTime()
const at = new Date(2026, 10, 17, 12, 49).getTime()

describe('doc-version', () => {
  it('labels a commit by its short hash, HEAD as HEAD', () => {
    expect(versionLabel({ kind: 'rev', repo: 'r', rev: '0b8e744c0ffee', path: 'r/notes.md' }, now)).toBe('0b8e744')
    expect(versionLabel({ kind: 'rev', repo: 'r', rev: 'HEAD', path: 'r/notes.md' }, now)).toBe('HEAD')
  })

  it('labels a snapshot by its time and a draft as a draft', () => {
    expect(versionLabel({ kind: 'snapshot', path: 'n.md', id: 's', at, origin: 'disk' }, now)).toBe('Nov 17 12:49')
    expect(versionLabel({ kind: 'draft', path: 'n.md', id: 'd', at }, now)).toBe('draft Nov 17 12:49')
  })

  it('titles the tab `name @ label`', () => {
    expect(versionTabTitle('Projects/a/docs/notes.md', '0b8e744')).toBe('notes.md @ 0b8e744')
  })

  it('only fixed versions open as a version tab', () => {
    expect(isVersionSource({ kind: 'file', path: 'n.md' })).toBe(false)
    expect(isVersionSource({ kind: 'disk', path: 'n.md' })).toBe(false)
    expect(isVersionSource({ kind: 'none' })).toBe(false)
    expect(isVersionSource({ kind: 'draft', path: 'n.md', id: 'd', at })).toBe(true)
  })

  it('tells the same version from another', () => {
    const a = { kind: 'rev', repo: 'r', rev: 'abc', path: 'r/n.md' } as const
    expect(sameVersion(a, { ...a })).toBe(true)
    expect(sameVersion(a, { ...a, rev: 'def' })).toBe(false)
    expect(sameVersion({ kind: 'draft', path: 'n.md', id: 'd', at }, { kind: 'draft', path: 'n.md', id: 'd', at: 1 })).toBe(true)
    expect(sameVersion(a, { kind: 'draft', path: 'n.md', id: 'd', at })).toBe(false)
  })

  it('names a version by the path the document had in it (T-230)', () => {
    const snap = { kind: 'snapshot', path: 'd/T-3.md', id: 's', at, origin: 'saved' } as const
    expect(versionPath(snap, 'd/T-3.md')).toBe('d/T-3.md')
    expect(versionPath({ ...snap, pathThen: 'd/T-2.md' }, 'd/T-3.md')).toBe('d/T-2.md')
    expect(versionPath({ kind: 'rev', repo: 'r', rev: 'abc', path: 'd/old.md' }, 'd/T-3.md')).toBe('d/old.md')
    expect(versionPath({ kind: 'draft', path: 'd/T-3.md', id: 'x', at }, 'd/T-3.md')).toBe('d/T-3.md')
    expect(versionTabTitle(versionPath({ ...snap, pathThen: 'd/T-2.md' }, 'd/T-3.md'), 'Nov 17 12:49')).toBe('T-2.md @ Nov 17 12:49')
  })

  it('a local version follows its document when it moves; commits and drafts stay put', () => {
    const snap = { kind: 'snapshot', path: 'd/T-3.md', id: 's', at, origin: 'saved', pathThen: 'd/T-2.md' } as const
    expect(retargetVersion(snap, 'd/T-4.md')).toEqual({ ...snap, path: 'd/T-4.md' })
    expect(retargetVersion(snap, 'd/T-2.md')).toEqual({ kind: 'snapshot', path: 'd/T-2.md', id: 's', at, origin: 'saved' })
    const rev = { kind: 'rev', repo: 'r', rev: 'abc', path: 'd/T-3.md' } as const
    expect(retargetVersion(rev, 'd/T-4.md')).toBe(rev)
  })

  it('asks plainly', () => {
    expect(replaceQuestion('docs/notes.md')).toBe('Replace notes.md with this version? The current text stays in History.')
  })
})

describe('doc-version tab lookups', () => {
  const v = { source: { kind: 'rev', repo: 'r', rev: 'abc', path: 'r/n.md' } as const, label: 'abc' }
  it('a version tab is not the document tab', () => {
    expect(isDocTabOf({ kind: 'doc', path: 'r/n.md' }, 'r/n.md')).toBe(true)
    expect(isDocTabOf({ kind: 'doc', path: 'r/n.md', version: v }, 'r/n.md')).toBe(false)
  })
  it('dedupes a doc with a doc and a version with the same version only', () => {
    expect(sameDocTab({ kind: 'doc', path: 'r/n.md' }, { kind: 'doc', path: 'r/n.md' })).toBe(true)
    expect(sameDocTab({ kind: 'doc', path: 'r/n.md' }, { kind: 'doc', path: 'r/n.md', version: v })).toBe(false)
    expect(sameDocTab({ kind: 'doc', path: 'r/n.md', version: v }, { kind: 'doc', path: 'r/n.md', version: { ...v } })).toBe(true)
  })
})
