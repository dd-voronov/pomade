import { cpSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalHistoryStore } from './local-history-store'

const DAY = 24 * 60 * 60 * 1000
let dir: string
let clock: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pomade-lh-'))
  clock = 1_000 * DAY
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (capBytes?: number): LocalHistoryStore => new LocalHistoryStore({ dir, now: () => clock, capBytes })
const blobs = (): string[] => readdirSync(join(dir, 'blobs'))

describe('LocalHistoryStore', () => {
  it('keeps a snapshot per change, newest first, and reads each back', async () => {
    const s = make()
    expect(await s.record('a.md', 'one', 'disk')).not.toBeNull()
    clock += 1000
    await s.record('a.md', 'two', 'saved')
    clock += 1000
    await s.record('a.md', 'three', 'disk')
    const list = await s.list('a.md')
    expect(list.map((e) => e.origin)).toEqual(['disk', 'saved', 'disk'])
    expect(await Promise.all(list.map((e) => s.read('a.md', e.id)))).toEqual(['three', 'two', 'one'])
    expect(list.map((e) => e.size)).toEqual([5, 3, 3])
  })

  it('keeps no snapshot when the newest one already holds the content', async () => {
    const s = make()
    await s.record('a.md', 'same', 'disk')
    expect(await s.record('a.md', 'same', 'saved')).toBeNull()
    expect(await s.list('a.md')).toHaveLength(1)
    // …even through a fresh instance reading the same directory.
    expect(await make().record('a.md', 'same', 'disk')).toBeNull()
  })

  it('keeps A → B → A as three snapshots sharing two blobs', async () => {
    const s = make()
    for (const c of ['A', 'B', 'A']) {
      await s.record('a.md', c, 'disk')
      clock += 10
    }
    expect(await s.list('a.md')).toHaveLength(3)
    expect(blobs()).toHaveLength(2)
  })

  it('keys records by the workspace-relative path alone, and keeps itself out of git', async () => {
    const s = make()
    await s.record('a.md', 'x', 'disk')
    await s.record('b.md', 'z', 'disk')
    expect(await s.list('a.md')).toHaveLength(1)
    expect(await s.list('c.md')).toEqual([])
    const only = (await s.list('a.md'))[0]
    expect(await s.read('a.md', only.id)).toBe('x')
    expect(await s.read('b.md', only.id)).toBeNull()
    const rec = JSON.parse(readFileSync(join(dir, 'paths', readdirSync(join(dir, 'paths')).sort()[0]), 'utf8')) as object
    expect(Object.keys(rec).sort()).toEqual(['entries', 'path'])
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('reads the same store from another folder: a copied store keeps its versions', async () => {
    await make().record('docs/a.md', 'kept', 'disk')
    const copy = mkdtempSync(join(tmpdir(), 'pomade-lh-copy-'))
    try {
      cpSync(dir, copy, { recursive: true })
      const t = new LocalHistoryStore({ dir: copy, now: () => clock })
      const [only] = await t.list('docs/a.md')
      expect(await t.read('docs/a.md', only.id)).toBe('kept')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('gives every snapshot a distinct time even when the clock stands still', async () => {
    const s = make()
    await s.record('a.md', '1', 'disk')
    await s.record('a.md', '2', 'disk')
    const [b, a] = await s.list('a.md')
    expect(b.at).toBeGreaterThan(a.at)
  })

  it('prune removes snapshots older than 7 days and the blobs only they held', async () => {
    const s = make()
    await s.record('a.md', 'old content', 'disk')
    clock += 5 * DAY
    await s.record('a.md', 'middle', 'disk')
    clock += 3 * DAY
    await s.record('a.md', 'fresh', 'disk')
    await s.prune()
    const list = await s.list('a.md')
    expect(await Promise.all(list.map((e) => s.read('a.md', e.id)))).toEqual(['fresh', 'middle'])
    expect(blobs()).toHaveLength(2)
  })

  it('prune drops a path whose snapshots all expired', async () => {
    const s = make()
    await s.record('gone.md', 'x', 'disk')
    clock += 8 * DAY
    await s.prune()
    expect(await s.list('gone.md')).toEqual([])
    expect(readdirSync(join(dir, 'paths'))).toEqual([])
    expect(blobs()).toEqual([])
    // A later change starts a fresh history.
    expect(await s.record('gone.md', 'x', 'disk')).not.toBeNull()
  })

  it('prune applies the size cap oldest first across paths', async () => {
    const s = make(25)
    await s.record('a.md', 'a'.repeat(10), 'disk')
    clock += 1000
    await s.record('b.md', 'b'.repeat(10), 'disk')
    clock += 1000
    await s.record('c.md', 'c'.repeat(10), 'disk')
    await s.prune()
    expect(await s.list('a.md')).toEqual([])
    expect(await s.list('b.md')).toHaveLength(1)
    expect(await s.list('c.md')).toHaveLength(1)
    expect(blobs()).toHaveLength(2)
  })

  it('prune clears unreadable path files and stray temp files', async () => {
    const s = make()
    await s.record('a.md', 'x', 'disk')
    writeFileSync(join(dir, 'paths', 'broken.json'), '{nope')
    writeFileSync(join(dir, 'blobs', 'half.txt.abc.tmp'), 'partial')
    await s.prune()
    expect(readdirSync(join(dir, 'paths'))).toHaveLength(1)
    expect(blobs()).toHaveLength(1)
    expect(readFileSync(join(dir, 'blobs', blobs()[0]), 'utf8')).toBe('x')
  })

  it('records while a prune runs without losing a blob', async () => {
    const s = make()
    await s.record('a.md', 'one', 'disk')
    clock += 8 * DAY
    const pruning = s.prune()
    const recording = s.record('a.md', 'two', 'disk')
    await Promise.all([pruning, recording])
    const list = await s.list('a.md')
    expect(list).toHaveLength(1)
    expect(await s.read('a.md', list[0].id)).toBe('two')
  })

  it('move carries a path\'s snapshots to the new path; a rename snapshot of the same text is kept', async () => {
    const s = make()
    await s.record('docs/T-2.md', 'one', 'disk')
    clock += 1000
    await s.record('docs/T-2.md', 'two', 'saved')
    clock += 1000
    expect(await s.move('docs/T-2.md', 'docs/T-3.md')).toBe(true)
    expect(await s.list('docs/T-2.md')).toEqual([])
    expect(await s.newestHash('docs/T-2.md')).toBeNull()
    const marker = await s.record('docs/T-3.md', 'two', 'renamed', 'docs/T-2.md')
    expect(marker).toMatchObject({ origin: 'renamed', from: 'docs/T-2.md' })
    const list = await s.list('docs/T-3.md')
    expect(list.map((e) => [e.origin, e.from ?? null])).toEqual([
      ['renamed', 'docs/T-2.md'],
      ['saved', null],
      ['disk', null]
    ])
    expect(await s.read('docs/T-3.md', list[2].id)).toBe('one')
    // The same text again is no new version.
    expect(await s.record('docs/T-3.md', 'two', 'disk')).toBeNull()
    // Nothing to carry: false.
    expect(await s.move('docs/none.md', 'docs/x.md')).toBe(false)
  })

  it('move merges with what the destination already has, by time', async () => {
    const s = make()
    await s.record('b.md', 'b-old', 'disk')
    clock += 1000
    await s.record('a.md', 'a1', 'disk')
    await s.move('a.md', 'b.md')
    expect((await s.list('b.md')).map((e) => e.size)).toEqual([2, 5])
  })

  it('known finds the paths under a folder and the paths whose newest snapshot holds a content', async () => {
    const s = make()
    await s.record('dir/a.md', 'A', 'disk')
    await s.record('dir/sub/b.md', 'B', 'disk')
    await s.record('dirx/c.md', 'A', 'disk')
    // A fresh instance builds its index from disk.
    const t = make()
    expect((await t.known({ under: 'dir' })).sort()).toEqual(['dir/a.md', 'dir/sub/b.md'])
    const { blobHash } = await import('@shared/local-history')
    expect((await t.known({ newest: blobHash('A') })).sort()).toEqual(['dir/a.md', 'dirx/c.md'])
    await t.move('dir/a.md', 'moved/a.md')
    await t.record('dirx/c.md', 'C', 'disk')
    expect((await t.known({ newest: blobHash('A') })).sort()).toEqual(['moved/a.md'])
    clock += 8 * DAY
    await t.prune()
    expect(await t.known({ under: '' + 'moved' })).toEqual([])
  })

  it('purge removes every snapshot kept before the moment, whatever the cap, and reports what went', async () => {
    const s = make()
    await s.record('a.md', 'a1', 'disk')
    clock += DAY
    await s.record('a.md', 'shared', 'disk')
    await s.record('b.md', 'shared', 'disk')
    clock += DAY
    const cut = clock
    await s.record('a.md', 'a3', 'disk')
    const before = await s.measurePurge(cut)
    // a1 + both 'shared' go; 'shared' is one blob.
    expect(before).toEqual({ versions: 3, bytes: 2 + 6 })
    const { removed, paths } = await s.purge(cut)
    expect(removed).toEqual(before)
    expect(paths.sort()).toEqual(['a.md', 'b.md'])
    expect(await Promise.all((await s.list('a.md')).map((e) => s.read('a.md', e.id)))).toEqual(['a3'])
    expect(await s.list('b.md')).toEqual([])
    expect(blobs()).toHaveLength(1)
    expect(await s.measurePurge(cut)).toEqual({ versions: 0, bytes: 0 })
  })

  it('a lower cap measures, then prunes, the oldest first', async () => {
    const s = make()
    for (const c of ['a', 'b', 'c']) {
      await s.record(`${c}.md`, c.repeat(10), 'disk')
      clock += 1000
    }
    expect(await s.measurePrune(1000)).toEqual({ versions: 0, bytes: 0 })
    expect(await s.measurePrune(15)).toEqual({ versions: 2, bytes: 20 })
    expect(await s.prune()).toEqual([])
    s.setCap(15)
    expect(await s.prune()).toEqual(['a.md', 'b.md'])
    expect(await s.list('c.md')).toHaveLength(1)
    expect(blobs()).toHaveLength(1)
  })
})
