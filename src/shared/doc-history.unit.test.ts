import { describe, expect, it } from 'vitest'

import {
  buildHistoryRows,
  currentRow,
  draftReasonLabel,
  earlierName,
  earlierPath,
  foldedGroups,
  groupRows,
  orderPair,
  pickForSide,
  rowOnSide,
  sideSource,
  LIVE_RIGHT_ONLY,
  LIVE_SWAP_BLOCKED,
  restoreUnderQuestion,
  restoreUnderTaken,
  rowSource,
  savedMeta,
  rowVsCurrent,
  versionTime,
  withGroupFolded,
  type DiskFile,
  type HistoryContext,
  type HistoryRow,
  type HistorySources,
  type SavedGit
} from './doc-history'
import type { FileCommit } from './git-history'
import type { SnapshotRef } from './local-history'

const commit = (hash: string, path: string, subject = 's'): FileCommit => ({
  hash,
  parents: [],
  author: 'A',
  authorEmail: 'a@x',
  date: 1_700_000_000_000,
  subject,
  path
})
const ctx: HistoryContext = { path: 'docs/new.md', repo: 'Projects/a' }
const c1 = commit('1'.repeat(40), 'docs/new.md')
const c2 = commit('2'.repeat(40), 'docs/old.md')
/** A file on disk whose text no snapshot holds. */
const D: DiskFile = { mtime: 1_700_000_000_000, size: 2048, hash: 'disk-hash' }
const rowsOf = (src: Partial<HistorySources>) =>
  buildHistoryRows({ dirty: false, disk: null, inRepo: true, saved: null, drafts: [], commits: [], snapshots: [], ...src })

describe('buildHistoryRows', () => {
  it('lists git discards as discarded-change rows, after the drafts', () => {
    const rows = rowsOf({
      dirty: false,
      disk: D, saved: { isNew: false },
      drafts: [
        { id: 'g1', discardedAt: 9, reason: 'git-discard' },
        { id: 'd', discardedAt: 5, reason: 'close' },
        { id: 'g2', discardedAt: 9, reason: 'git-discard-staged' }
      ],
      commits: [c1], snapshots: []
    })
    expect(rows.map((r) => r.kind)).toEqual(['saved', 'draft', 'discarded', 'discarded', 'commit'])
    const g2 = rows.find((r) => r.id === 'discarded:g2')
    expect(g2).toMatchObject({ kind: 'discarded', staged: true, at: 9 })
    expect(rowSource(g2!, ctx)).toEqual({ kind: 'draft', path: 'docs/new.md', id: 'g2', at: 9 })
  })

  it('orders unsaved, saved-not-committed, drafts newest first, commits', () => {
    const rows = rowsOf({
      dirty: true,
      disk: D, saved: { isNew: false },
      drafts: [
        { id: 'a', discardedAt: 100, reason: 'close' },
        { id: 'b', discardedAt: 200, reason: 'quit' }
      ],
      commits: [c1, c2], snapshots: []
    })
    expect(rows.map((r) => r.id)).toEqual(['unsaved', 'saved', 'draft:b', 'draft:a', `commit:${c1.hash}`, `commit:${c2.hash}`])
  })

  it('unsaved only while dirty, saved only when the file is on disk', () => {
    expect(rowsOf({ dirty: false, saved: null, drafts: [], commits: [], snapshots: [] })).toEqual([])
    expect(rowsOf({ dirty: false, saved: null, drafts: [], commits: [c1], snapshots: [] }).map((r) => r.kind)).toEqual(['commit'])
  })
})

describe('snapshot rows (E-044)', () => {
  const snap = (id: string, at: number, origin: 'disk' | 'saved' = 'disk', hash = id): SnapshotRef => ({ id, at, hash, size: 10, origin })
  // c1 and c2 are both dated 1_700_000_000_000.
  const T = 1_700_000_000_000

  it('lists the snapshots newest first, all above the commits, whatever their times', () => {
    const older = { ...c2, date: T - 5000 }
    const rows = rowsOf({
      dirty: false,
      saved: null,
      drafts: [],
      commits: [c1, older],
      snapshots: [snap('s-old', T - 9000), snap('s-mid', T - 2000, 'saved'), snap('s-new', T + 1000), snap('s-tie', T)]
    })
    expect(rows.map((r) => r.id)).toEqual([
      'snapshot:s-new',
      'snapshot:s-tie',
      'snapshot:s-mid',
      'snapshot:s-old',
      `commit:${c1.hash}`,
      `commit:${older.hash}`
    ])
  })

  it('snapshots sit below unsaved, saved-not-committed and drafts', () => {
    const rows = rowsOf({
      dirty: true,
      disk: D, saved: { isNew: false },
      drafts: [{ id: 'd', discardedAt: 1, reason: 'close' }],
      commits: [],
      snapshots: [snap('a', T)]
    })
    expect(rows.map((r) => r.kind)).toEqual(['unsaved', 'saved', 'draft', 'snapshot'])
  })

  it('a rename snapshot carries its old path and whether it holds the text of the version below it', () => {
    const renamed = (id: string, at: number, hash: string): SnapshotRef => ({ ...snap(id, at, 'disk', hash), origin: 'renamed', from: 'docs/T-2.md' })
    const rows = rowsOf({
      dirty: false,
      saved: null,
      drafts: [],
      commits: [],
      snapshots: [snap('a', 1, 'saved', 'h1'), renamed('r', 2, 'h1'), renamed('r2', 3, 'h9'), renamed('r3', 0, 'h0')]
    })
    expect(rows.map((r) => (r.kind === 'snapshot' ? [r.snapshotId, r.from ?? null, r.sameText ?? null] : null))).toEqual([
      ['r2', 'docs/T-2.md', false],
      ['r', 'docs/T-2.md', true],
      ['a', null, null],
      ['r3', 'docs/T-2.md', false]
    ])
    expect(rowSource(rows[1], ctx)).toEqual({
      kind: 'snapshot',
      path: 'docs/new.md',
      id: 'r',
      at: 2,
      origin: 'renamed',
      from: 'docs/T-2.md',
      pathThen: 'docs/T-2.md'
    })
  })

  it('a version kept before a rename is under the old path: the rename row and every older one, up to the next rename', () => {
    const renamed = (id: string, at: number, from: string): SnapshotRef => ({ ...snap(id, at, 'disk', id), origin: 'renamed', from })
    const rows = rowsOf({
      dirty: false,
      saved: null,
      drafts: [],
      commits: [],
      // new.md ← mid.md ← docs/new.md (renamed back to the name it has now) ← older saves
      snapshots: [
        snap('s0', 1, 'saved'),
        renamed('r1', 2, 'docs/new.md'),
        snap('s1', 3, 'saved'),
        renamed('r2', 4, 'docs/mid.md'),
        snap('s2', 5, 'saved')
      ]
    })
    expect(rows.map((r) => (r.kind === 'snapshot' ? [r.snapshotId, earlierPath(r, ctx)] : null))).toEqual([
      ['s2', null],
      ['r2', 'docs/mid.md'],
      ['s1', 'docs/mid.md'],
      ['r1', null],
      ['s0', null]
    ])
    expect(rowSource(rows[2], ctx)).toMatchObject({ kind: 'snapshot', path: 'docs/new.md', id: 's1', pathThen: 'docs/mid.md' })
    expect(rowSource(rows[0], ctx)).not.toHaveProperty('pathThen')
    expect(rowSource(rows[3], ctx)).not.toHaveProperty('pathThen')
  })

  it('a doc with snapshots only (no commits, outside git) lists them newest first', () => {
    const rows = rowsOf({ dirty: false, saved: null, drafts: [], commits: [], snapshots: [snap('a', 1), snap('b', 2)] })
    expect(rows.map((r) => r.id)).toEqual(['snapshot:b', 'snapshot:a'])
  })

  it('a snapshot row is its own comparison source and compares with the current document', () => {
    const rows = rowsOf({ dirty: false, saved: null, drafts: [], commits: [], snapshots: [snap('a', 7, 'saved')] })
    const src = { kind: 'snapshot', path: 'docs/new.md', id: 'a', at: 7, origin: 'saved' }
    expect(rowSource(rows[0], ctx)).toEqual(src)
    expect(rowVsCurrent(rows[0], ctx)).toEqual([src, { kind: 'file', path: 'docs/new.md' }])
  })
})

describe('rows as comparison sources', () => {
  const rows = rowsOf({
    dirty: true,
    disk: D, saved: { isNew: false, from: 'docs/was.md' },
    drafts: [{ id: 'd', discardedAt: 5, reason: 'close' }],
    commits: [c2], snapshots: []
  })
  const byKind = (k: string) => rows.find((r) => r.kind === k)!

  it('a commit row is its version at the path it had then', () => {
    expect(rowSource(byKind('commit'), ctx)).toEqual({ kind: 'rev', repo: 'Projects/a', rev: c2.hash, path: 'docs/old.md' })
  })

  it('the unsaved row is the live document, the saved row the disk, a draft its own source', () => {
    expect(rowSource(byKind('unsaved'), ctx)).toEqual({ kind: 'file', path: 'docs/new.md' })
    expect(rowSource(byKind('saved'), ctx)).toEqual({ kind: 'disk', path: 'docs/new.md' })
    expect(rowSource(byKind('draft'), ctx)).toEqual({ kind: 'draft', path: 'docs/new.md', id: 'd', at: 5 })
  })

  it('a click compares with the current document; the saved row, not committed, compares HEAD (from the old name)', () => {
    const current = { kind: 'file', path: 'docs/new.md' }
    expect(rowVsCurrent(byKind('commit'), ctx)).toEqual([rowSource(byKind('commit'), ctx), current])
    expect(rowVsCurrent(byKind('unsaved'), ctx)).toEqual([current, current])
    expect(rowVsCurrent(byKind('saved'), ctx)).toEqual([
      { kind: 'rev', repo: 'Projects/a', rev: 'HEAD', path: 'docs/was.md' },
      current
    ])
  })
})

describe('groupRows (T-223)', () => {
  it('groups in list order — current, discarded, local versions, commits — and leaves empty groups out', () => {
    const rows = rowsOf({
      dirty: true,
      disk: D, saved: { isNew: false },
      drafts: [
        { id: 'g', discardedAt: 9, reason: 'git-discard' },
        { id: 'd', discardedAt: 5, reason: 'close' }
      ],
      commits: [c1],
      snapshots: [{ id: 's', at: 1, hash: 'h', size: 1, origin: 'disk' }]
    })
    expect(groupRows(rows).map((g) => [g.group, g.rows.map((r) => r.kind)])).toEqual([
      ['current', ['unsaved', 'saved']],
      ['discarded', ['draft', 'discarded']],
      ['local', ['snapshot']],
      ['commits', ['commit']]
    ])
    expect(groupRows(rowsOf({ dirty: false, saved: null, drafts: [], commits: [c1], snapshots: [] })).map((g) => g.group)).toEqual([
      'commits'
    ])
  })
})

describe('orderPair', () => {
  const rows = rowsOf({ dirty: true, saved: null, drafts: [], commits: [c1, c2], snapshots: [] })
  it('puts the older row (lower in the list) first', () => {
    const [older, newer] = orderPair(rows, `commit:${c1.hash}`, `commit:${c2.hash}`)!
    expect([older.id, newer.id]).toEqual([`commit:${c2.hash}`, `commit:${c1.hash}`])
    expect(orderPair(rows, 'unsaved', `commit:${c1.hash}`)!.map((r) => r.id)).toEqual([`commit:${c1.hash}`, 'unsaved'])
  })
  it('orders a pair across groups by time: a snapshot older than a commit goes left of it', () => {
    const T = 1_700_000_000_000
    const across = rowsOf({
      dirty: false,
      disk: D, saved: { isNew: false },
      drafts: [{ id: 'd', discardedAt: T + 50, reason: 'close' }],
      commits: [c1],
      snapshots: [
        { id: 'old', at: T - 1000, hash: 'a', size: 1, origin: 'disk' },
        { id: 'new', at: T + 1000, hash: 'b', size: 1, origin: 'disk' }
      ]
    })
    expect(orderPair(across, 'snapshot:old', `commit:${c1.hash}`)!.map((r) => r.id)).toEqual(['snapshot:old', `commit:${c1.hash}`])
    expect(orderPair(across, `commit:${c1.hash}`, 'snapshot:new')!.map((r) => r.id)).toEqual([`commit:${c1.hash}`, 'snapshot:new'])
    expect(orderPair(across, 'saved', 'draft:d')!.map((r) => r.id)).toEqual(['draft:d', 'saved'])
    expect(orderPair(across, 'draft:d', 'snapshot:new')!.map((r) => r.id)).toEqual(['draft:d', 'snapshot:new'])
  })
  it('refuses the same row twice or an unknown one', () => {
    expect(orderPair(rows, 'unsaved', 'unsaved')).toBeNull()
    expect(orderPair(rows, 'unsaved', 'nope')).toBeNull()
  })
})

describe('labels', () => {
  const now = new Date(2026, 10, 10, 12).getTime()
  it('versionTime: day and time, the year only when it is not this one', () => {
    expect(versionTime(new Date(2026, 10, 8, 14, 32).getTime(), now)).toBe('Nov 8 14:32')
    expect(versionTime(new Date(2025, 0, 3, 9, 5).getTime(), now)).toBe('Jan 3, 2025 09:05')
  })
  it('draftReasonLabel', () => {
    expect(draftReasonLabel('close')).toBe('closed without saving')
    expect(draftReasonLabel('load-disk')).toBe('replaced by the disk version')
    expect(draftReasonLabel('unknown')).toBe('discarded')
  })
})

describe('restore under an earlier path (T-230)', () => {
  it('names the earlier path by its name in the same folder, by its workspace path in another', () => {
    expect(earlierName('docs/roadmap/T-2.md', 'docs/roadmap/T-2b.md')).toBe('T-2.md')
    expect(earlierName('docs/old/T-2.md', 'docs/roadmap/T-2.md')).toBe('docs/old/T-2.md')
  })

  it('asks before renaming back, and says why it refuses', () => {
    expect(restoreUnderQuestion('docs/roadmap/T-2b.md', 'docs/roadmap/T-2.md')).toBe(
      'Restore T-2b.md as it was, under its earlier name T-2.md?'
    )
    expect(restoreUnderTaken('docs/roadmap/T-2b.md', 'docs/roadmap/T-2.md')).toBe(
      'Can’t restore under T-2.md — a file with that name is already there. Rename or move that file first.'
    )
  })

  it('only a local version has an earlier path', () => {
    expect(earlierPath({ kind: 'commit', id: 'c', commit: c2 }, ctx)).toBeNull()
    expect(earlierPath({ kind: 'draft', id: 'd', draftId: 'd', at: 1, reason: 'close' }, ctx)).toBeNull()
  })
})

describe('the Current group (T-266)', () => {
  const T = 1_700_000_000_000
  const snap = (id: string, at: number, hash: string, origin: SnapshotRef['origin'] = 'saved'): SnapshotRef => ({ id, at, hash, size: 10, origin })
  const saved = (rows: ReturnType<typeof rowsOf>) => rows.find((r) => r.kind === 'saved')

  it('saved, not committed, the newest snapshot holding the disk text: one Saved row with its time, gone from Local versions', () => {
    const rows = rowsOf({ disk: D, saved: { isNew: false }, commits: [c1], snapshots: [snap('old', T - 50, 'h0'), snap('new', T - 10, 'disk-hash')] })
    const groups = groupRows(rows)
    expect(groups.map((g) => [g.group, g.rows.map((r) => r.id)])).toEqual([
      ['current', ['saved']],
      ['local', ['snapshot:old']],
      ['commits', [`commit:${c1.hash}`]]
    ])
    expect(saved(rows)).toEqual({
      kind: 'saved',
      id: 'saved',
      at: T - 10,
      size: 2048,
      git: { state: 'changed', isNew: false },
      snapshot: { snapshotId: 'new', origin: 'saved' }
    })
    expect(currentRow(rows)?.id).toBe('saved')
  })

  it('the Saved row meta is short: not committed, new file, renamed, same as <hash>, local version', () => {
    const row = (git: SavedGit): Extract<HistoryRow, { kind: 'saved' }> => ({ kind: 'saved', id: 'saved', at: T, size: 2048, git })
    expect(savedMeta(row({ state: 'changed', isNew: false }))).toBe('not committed')
    expect(savedMeta(row({ state: 'changed', isNew: true }))).toBe('new file · not committed')
    expect(savedMeta(row({ state: 'changed', isNew: false, from: 'docs/plan.md' }))).toBe('renamed from plan.md · not committed')
    expect(savedMeta(row({ state: 'committed', hash: 'abcdef0123456789' }))).toBe('same as abcdef0')
    expect(savedMeta(row({ state: 'none' }))).toBe('local version · 2.0 KB')
  })

  it('the disk changed since the newest snapshot: the snapshots stay, the Saved row takes the modified time', () => {
    const rows = rowsOf({ disk: { ...D, mtime: T + 99 }, saved: { isNew: false }, snapshots: [snap('new', T - 10, 'h1'), snap('old', T - 50, 'disk-hash')] })
    expect(rows.map((r) => r.id)).toEqual(['saved', 'snapshot:new', 'snapshot:old'])
    expect(saved(rows)).toMatchObject({ at: T + 99 })
    expect(saved(rows)).not.toHaveProperty('snapshot')
  })

  it('no snapshot kept, or the disk text not read: nothing is absorbed', () => {
    expect(saved(rowsOf({ disk: D, saved: { isNew: true } }))).toMatchObject({ at: D.mtime, git: { state: 'changed', isNew: true } })
    const unread = rowsOf({ disk: { ...D, hash: null }, snapshots: [snap('s', 1, 'disk-hash')] })
    expect(unread.map((r) => r.id)).toEqual(['saved', 'snapshot:s'])
  })

  it('a rename’s snapshot is not absorbed: it stands for the file under its old name', () => {
    const rows = rowsOf({ disk: D, snapshots: [{ ...snap('r', 5, 'disk-hash', 'renamed'), from: 'docs/old.md' }] })
    expect(rows.map((r) => r.id)).toEqual(['saved', 'snapshot:r'])
  })

  it('dirty: Unsaved edits is current, the Saved row is not', () => {
    const rows = rowsOf({ dirty: true, disk: D, saved: { isNew: false }, snapshots: [snap('s', 1, 'disk-hash')] })
    expect(groupRows(rows)[0]).toEqual({ group: 'current', rows: [rows[0], rows[1]] })
    expect(rows.map((r) => r.kind)).toEqual(['unsaved', 'saved'])
    expect(currentRow(rows)?.id).toBe('unsaved')
  })

  it('clean in git: the Saved row names the newest commit, which stays in Commits', () => {
    const rows = rowsOf({ disk: D, commits: [c1, c2], snapshots: [snap('s', 1, 'disk-hash')] })
    expect(saved(rows)).toMatchObject({ git: { state: 'committed', hash: c1.hash }, at: 1 })
    expect(groupRows(rows).map((g) => [g.group, g.rows.length])).toEqual([
      ['current', 1],
      ['commits', 2]
    ])
    expect(rowVsCurrent(saved(rows)!, ctx)).toEqual([{ kind: 'disk', path: 'docs/new.md' }, { kind: 'file', path: 'docs/new.md' }])
  })

  it('outside a repo, or in one with no commit of the file: no git to say', () => {
    expect(saved(rowsOf({ disk: D, inRepo: false }))).toMatchObject({ git: { state: 'none' }, size: 2048 })
    expect(saved(rowsOf({ disk: D }))).toMatchObject({ git: { state: 'none' } })
  })

  it('an Untitled document (not on disk) has no Saved row', () => {
    const rows = rowsOf({ dirty: true, disk: null, snapshots: [snap('s', 1, 'disk-hash')] })
    expect(rows.map((r) => r.id)).toEqual(['unsaved', 'snapshot:s'])
    expect(currentRow(rowsOf({ disk: null }))).toBeNull()
  })

  it('a saved `changes` fold reads as `current`; folding or unfolding Current drops the old name', () => {
    expect(foldedGroups(['changes', 'local', 'nope', 'current'])).toEqual(['current', 'local'])
    expect(withGroupFolded(['changes', 'local'], 'current', false)).toEqual(['local'])
    expect(withGroupFolded(['changes'], 'current', true)).toEqual(['current'])
    expect(withGroupFolded(['local'], 'commits', true)).toEqual(['local', 'commits'])
  })
})

describe('version chips (T-224)', () => {
  const dirty = rowsOf({ dirty: true, disk: D, saved: { isNew: false }, drafts: [{ id: 'd', discardedAt: 5, reason: 'close' }], commits: [c1] })
  const clean = rowsOf({ dirty: false, disk: D, saved: { isNew: false }, commits: [c1] })
  const by = (rows: HistoryRow[], kind: string) => rows.find((r) => r.kind === kind)!
  const live = { kind: 'file', path: ctx.path } as const
  const disk = { kind: 'disk', path: ctx.path } as const
  const rev1 = rowSource(by(dirty, 'commit'), ctx)
  const draft = rowSource(by(dirty, 'draft'), ctx)

  it('maps the row the editor holds to the live document on the right only', () => {
    expect(sideSource(by(dirty, 'unsaved'), 'right', dirty, ctx)).toEqual(live)
    expect(sideSource(by(dirty, 'saved'), 'right', dirty, ctx)).toEqual(disk)
    expect(sideSource(by(clean, 'saved'), 'right', clean, ctx)).toEqual(live)
    expect(sideSource(by(clean, 'saved'), 'left', clean, ctx)).toEqual(disk)
  })

  it('tells the row on each side, ignoring optional fields', () => {
    expect(rowOnSide(by(dirty, 'commit'), 'left', { ...rev1 }, dirty, ctx)).toBe(true)
    expect(rowOnSide(by(clean, 'saved'), 'right', live, clean, ctx)).toBe(true)
    expect(rowOnSide(by(clean, 'saved'), 'left', live, clean, ctx)).toBe(false)
    // A comparison opened from a Changes row holds HEAD, which no row names.
    expect(rowOnSide(by(dirty, 'commit'), 'left', { ...rev1, kind: 'rev', rev: 'HEAD' } as typeof rev1, dirty, ctx)).toBe(false)
  })

  it('sets a side, keeps a pick that is already there, swaps the other side’s version', () => {
    expect(pickForSide(by(dirty, 'draft'), 'left', { left: rev1, right: live }, dirty, ctx)).toEqual({ kind: 'set', left: draft, right: live })
    expect(pickForSide(by(dirty, 'draft'), 'right', { left: rev1, right: live }, dirty, ctx)).toEqual({ kind: 'set', left: rev1, right: draft })
    expect(pickForSide(by(dirty, 'commit'), 'left', { left: rev1, right: live }, dirty, ctx)).toEqual({ kind: 'same' })
    // An older version on the right is allowed.
    expect(pickForSide(by(dirty, 'commit'), 'right', { left: draft, right: disk }, dirty, ctx)).toEqual({ kind: 'set', left: draft, right: rev1 })
    expect(pickForSide(by(dirty, 'commit'), 'right', { left: rev1, right: draft }, dirty, ctx)).toEqual({ kind: 'swap', left: draft, right: rev1 })
    expect(pickForSide(by(dirty, 'draft'), 'left', { left: rev1, right: draft }, dirty, ctx)).toEqual({ kind: 'swap', left: draft, right: rev1 })
  })

  it('keeps the live document on the right', () => {
    expect(pickForSide(by(dirty, 'unsaved'), 'left', { left: rev1, right: draft }, dirty, ctx)).toEqual({ kind: 'blocked', reason: LIVE_RIGHT_ONLY })
    expect(pickForSide(by(clean, 'saved'), 'left', { left: rev1, right: live }, clean, ctx)).toEqual({ kind: 'blocked', reason: LIVE_RIGHT_ONLY })
    // While dirty, the saved row is the disk file: it may go left.
    expect(pickForSide(by(dirty, 'saved'), 'left', { left: rev1, right: live }, dirty, ctx)).toEqual({ kind: 'set', left: disk, right: live })
    // The left's version picked for the right would swap the live document to the left.
    expect(pickForSide(by(dirty, 'commit'), 'right', { left: rev1, right: live }, dirty, ctx)).toEqual({ kind: 'blocked', reason: LIVE_SWAP_BLOCKED })
  })
})
