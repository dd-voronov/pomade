import { describe, expect, it } from 'vitest'

import {
  DRAFT_TTL_MS,
  contentHash,
  discardedRowShown,
  docKeyOf,
  draftsBefore,
  draftsToPrune,
  formatRecoveredAt,
  recoveryFileName,
  recoveryKey,
  recoveryVerdict,
  syncVerdict
} from './recovery'

describe('recovery keying', () => {
  it('keys a path doc by its path and an Untitled doc by its tab id', () => {
    expect(docKeyOf('Projects/a/x.md', 'tab-1')).toBe('path:Projects/a/x.md')
    expect(docKeyOf('', 'tab-1')).toBe('untitled:tab-1')
  })

  it('a path doc keeps its key across tabs; an Untitled doc does not', () => {
    expect(recoveryKey('/ws', 'a.md', 't1')).toBe(recoveryKey('/ws', 'a.md', 't2'))
    expect(recoveryKey('/ws', '', 't1')).not.toBe(recoveryKey('/ws', '', 't2'))
  })

  it('separates workspaces and never confuses a path named like an untitled key', () => {
    expect(recoveryKey('/ws1', 'a.md', 't')).not.toBe(recoveryKey('/ws2', 'a.md', 't'))
    expect(recoveryKey('/ws', 'untitled:t', 't')).not.toBe(recoveryKey('/ws', '', 't'))
  })

  it('the file name is stable, path-safe and distinct per key', () => {
    const k = recoveryKey('/ws', 'Projects/a/../b/x y.md', 't')
    expect(recoveryFileName(k)).toBe(recoveryFileName(k))
    expect(recoveryFileName(k)).toMatch(/^[0-9a-f]{28}\.json$/)
    const names = new Set<string>()
    for (let i = 0; i < 2000; i++) names.add(recoveryFileName(recoveryKey('/ws', `doc-${i}.md`, 't')))
    expect(names.size).toBe(2000)
  })
})

describe('contentHash', () => {
  it('is deterministic and sensitive to any byte', () => {
    expect(contentHash('hello\n')).toBe(contentHash('hello\n'))
    expect(contentHash('hello\n')).not.toBe(contentHash('hello'))
    expect(contentHash('a\r\nb')).not.toBe(contentHash('a\nb'))
    expect(contentHash('')).toMatch(/^[0-9a-f]{14}$/)
  })
})

describe('syncVerdict — hash/mtime staleness', () => {
  const sync = { mtimeMs: 1000, hash: contentHash('mine') }

  it('same mtime is in sync without reading the file', () => {
    expect(syncVerdict(sync, { mtimeMs: 1000 })).toBe('in-sync')
  })

  it('a different mtime asks for the bytes', () => {
    expect(syncVerdict(sync, { mtimeMs: 2000 })).toBe('needs-hash')
  })

  it('a different mtime over the same bytes is in sync (touch, own write, identical checkout)', () => {
    expect(syncVerdict(sync, { mtimeMs: 2000, hash: contentHash('mine') })).toBe('in-sync')
  })

  it('different bytes are a change', () => {
    expect(syncVerdict(sync, { mtimeMs: 2000, hash: contentHash('theirs') })).toBe('changed')
  })

  it('a vanished file is missing', () => {
    expect(syncVerdict(sync, null)).toBe('missing')
  })
})

describe('recoveryVerdict — relaunch over a changed disk', () => {
  const base = { mtimeMs: 1000, hash: contentHash('v1') }
  it('same bytes as the base → plain recovery, even with a new mtime', () => {
    expect(recoveryVerdict(base, contentHash('v1'))).toBe('recovered')
  })
  it('different bytes → amber', () => {
    expect(recoveryVerdict(base, contentHash('v2'))).toBe('changed')
  })
  it('Untitled (no base) and a vanished file are plain recoveries', () => {
    expect(recoveryVerdict(null, contentHash('x'))).toBe('recovered')
    expect(recoveryVerdict(base, null)).toBe('recovered')
  })
})

describe('draftsToPrune — 7-day retention', () => {
  const now = Date.UTC(2026, 10, 9, 12)
  const day = 24 * 60 * 60 * 1000
  it('keeps drafts up to 7 days old and prunes older ones', () => {
    const drafts = [
      { id: 'fresh', discardedAt: now - day },
      { id: 'edge', discardedAt: now - DRAFT_TTL_MS },
      { id: 'old', discardedAt: now - DRAFT_TTL_MS - 1 },
      { id: 'ancient', discardedAt: now - 30 * day }
    ]
    expect(draftsToPrune(drafts, now).map((d) => d.id)).toEqual(['old', 'ancient'])
  })
  it('prunes a draft whose timestamp is unreadable', () => {
    expect(draftsToPrune([{ id: 'bad', discardedAt: Number.NaN }], now)).toHaveLength(1)
  })
})

describe('formatRecoveredAt', () => {
  it('shows HH:MM for today and adds the date otherwise', () => {
    const now = new Date(2026, 10, 9, 18, 0).getTime()
    expect(formatRecoveredAt(new Date(2026, 10, 9, 14, 32).getTime(), now)).toBe('14:32')
    expect(formatRecoveredAt(new Date(2026, 10, 8, 9, 5).getTime(), now)).toBe('Nov 8, 09:05')
  })
})

describe('discardedRowShown (T-310)', () => {
  const base = { latestAt: 1000, kept: 'kept\n' }
  it('a file that is gone shows', () => {
    expect(discardedRowShown({ ...base, file: null })).toBe(true)
    expect(discardedRowShown({ ...base, restoredAt: 2000, file: null })).toBe(true)
  })
  it('a file holding the kept copy is back', () => {
    expect(discardedRowShown({ ...base, file: { mtimeMs: 500, content: 'kept\n' } })).toBe(false)
  })
  it('a file restored from Document history and saved since is back', () => {
    expect(discardedRowShown({ ...base, restoredAt: 2000, file: { mtimeMs: 2500, content: 'other\n' } })).toBe(false)
  })
  it('restored but not saved since, restored before a newer discard, or never restored: shows', () => {
    expect(discardedRowShown({ ...base, restoredAt: 2000, file: { mtimeMs: 1500, content: 'other\n' } })).toBe(true)
    expect(discardedRowShown({ ...base, restoredAt: 900, file: { mtimeMs: 2500, content: 'other\n' } })).toBe(true)
    expect(discardedRowShown({ ...base, file: { mtimeMs: 2500, content: 'other\n' } })).toBe(true)
    expect(discardedRowShown({ ...base, file: { mtimeMs: 2500, content: null } })).toBe(true)
  })
})

describe('draftsBefore (T-234)', () => {
  it('picks drafts discarded before the moment, and unreadable times', () => {
    const drafts = [{ id: 'a', discardedAt: 100 }, { id: 'b', discardedAt: 200 }, { id: 'c', discardedAt: Number.NaN }]
    expect(draftsBefore(drafts, 200).map((d) => d.id)).toEqual(['a', 'c'])
    expect(draftsBefore(drafts, 201).map((d) => d.id)).toEqual(['a', 'b', 'c'])
    expect(draftsBefore(drafts, 0).map((d) => d.id)).toEqual(['c'])
  })
})
