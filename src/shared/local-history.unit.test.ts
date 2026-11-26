import { describe, expect, it } from 'vitest'

import {
  SNAPSHOT_CAP_BYTES,
  SNAPSHOT_TTL_MS,
  capBytesOf,
  capLabel,
  formatBytes,
  hasListedExtension,
  isLocalHistoryStorePath,
  isTrackablePath,
  localHistoryStoreDir,
  looksBinary,
  originLabel,
  pathBeforeMove,
  planPrune,
  planPurge,
  normalizeExtension,
  removalLabel,
  removalSize,
  snapshotId,
  versionRule,
  type PruneCandidate
} from './local-history'

describe('isTrackablePath', () => {
  it('tracks ordinary text paths, hidden files and extension-less names', () => {
    // A .log is a text file like any other here: the never-list setting keeps it out (versionRule).
    for (const p of ['docs/a.md', 'Projects/alpha/src/x.ts', '.env', 'Makefile', 'notes/a.b.c.txt', 'data.CSV', 'build.log']) {
      expect(isTrackablePath(p), p).toBe(true)
    }
  })

  it('skips binaries, caches, node_modules, .git and editor temp files', () => {
    for (const p of [
      'img/a.PNG',
      'a/b.zip',
      'x.pdf',
      'a/node_modules/x/index.js',
      'node_modules/a.md',
      '.git/config',
      'a/.git/HEAD',
      '.pomade/state/x.json',
      'a/.DS_Store',
      'doc.md~',
      'x.md.123abc.tmp',
      'db.sqlite',
      'package-lock.lock',
      ''
    ]) {
      expect(isTrackablePath(p), p).toBe(false)
    }
  })

  it('never tracks either flavor\'s own store, but tracks the rest of Apps/Pomade', () => {
    expect(localHistoryStoreDir('stable')).toBe('Apps/Pomade/local-history')
    expect(localHistoryStoreDir('dev')).toBe('Apps/Pomade/dev/local-history')
    for (const p of [
      'Apps/Pomade/local-history/paths/abc.json',
      'Apps/Pomade/local-history/blobs/abc.txt',
      'Apps/Pomade/local-history/.gitignore',
      'Apps/Pomade/dev/local-history/paths/abc.json'
    ]) {
      expect(isLocalHistoryStorePath(p), p).toBe(true)
      expect(isTrackablePath(p), p).toBe(false)
    }
    for (const p of ['Apps/Pomade/notes.md', 'Apps/Pomade/local-history.md', 'Projects/x/Apps/Pomade/local-history/a.md']) {
      expect(isLocalHistoryStorePath(p), p).toBe(false)
      expect(isTrackablePath(p), p).toBe(true)
    }
  })
})

describe('looksBinary', () => {
  it('is a NUL byte within the first 8000 bytes', () => {
    expect(looksBinary(new TextEncoder().encode('plain text\n'))).toBe(false)
    expect(looksBinary(new Uint8Array([104, 0, 105]))).toBe(true)
    const late = new Uint8Array(9000).fill(97)
    late[8500] = 0
    expect(looksBinary(late)).toBe(false)
  })
})

describe('planPrune', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 100 * DAY
  const c = (ref: string, ageDays: number, hash: string, size = 100): PruneCandidate => ({
    ref,
    at: now - ageDays * DAY,
    hash,
    size
  })

  it('removes what is older than the retention', () => {
    const gone = planPrune([c('a', 8, 'h1'), c('b', 6.9, 'h2'), c('c', 7.1, 'h3')], now, SNAPSHOT_TTL_MS, 1e9)
    expect([...gone].sort()).toEqual(['a', 'c'])
  })

  it('removes a snapshot whose time is unreadable', () => {
    const gone = planPrune([{ ref: 'x', at: NaN, hash: 'h', size: 1 }], now, SNAPSHOT_TTL_MS, 1e9)
    expect([...gone]).toEqual(['x'])
  })

  it('under the cap removes nothing more', () => {
    expect(planPrune([c('a', 1, 'h1'), c('b', 2, 'h2')], now, SNAPSHOT_TTL_MS, 200).size).toBe(0)
  })

  it('over the cap removes the oldest first, until the distinct content fits', () => {
    const all = [c('new', 1, 'h1'), c('mid', 3, 'h2'), c('old', 5, 'h3'), c('oldest', 6, 'h4')]
    expect([...planPrune(all, now, SNAPSHOT_TTL_MS, 250)].sort()).toEqual(['old', 'oldest'])
    expect([...planPrune(all, now, SNAPSHOT_TTL_MS, 150)].sort()).toEqual(['mid', 'old', 'oldest'])
  })

  it('shared content counts once and is freed only with its last snapshot', () => {
    // h1 appears in 'old' and 'new'; removing 'old' frees nothing, so the next oldest goes too.
    const all = [c('old', 5, 'h1'), c('mid', 3, 'h2'), c('new', 1, 'h1')]
    const gone = planPrune(all, now, SNAPSHOT_TTL_MS, 100)
    expect([...gone].sort()).toEqual(['mid', 'old'])
  })

  it('expiry and cap combine', () => {
    const all = [c('exp', 9, 'h0', 500), c('a', 2, 'h1'), c('b', 1, 'h2')]
    const gone = planPrune(all, now, SNAPSHOT_TTL_MS, 100)
    expect([...gone].sort()).toEqual(['a', 'exp'])
  })
})

describe('labels', () => {
  it('names who wrote a version', () => {
    expect(originLabel('disk')).toBe('changed on disk')
    expect(originLabel('saved')).toBe('saved in Pomade')
  })
  it('names a rename by the old name, a move by the old folder or path', () => {
    expect(originLabel('renamed', 'p/docs/T-2.md', 'p/docs/T-3.md')).toBe('renamed from T-2.md')
    expect(originLabel('renamed', 'p/old/T-2.md', 'p/docs/T-2.md')).toBe('moved from p/old/')
    expect(originLabel('renamed', 'T-2.md', 'docs/T-2.md')).toBe('moved from ./')
    expect(originLabel('renamed', 'p/old/T-2.md', 'p/docs/T-3.md')).toBe('moved from p/old/T-2.md')
    expect(originLabel('renamed', 'p/docs/T-2.md')).toBe('renamed from T-2.md')
  })
  it('pathBeforeMove maps a file or a file under a moved folder back', () => {
    expect(pathBeforeMove('a/new.md', 'a/old.md', 'a/new.md')).toBe('a/old.md')
    expect(pathBeforeMove('b/sub/x.md', 'a/dir', 'b')).toBe('a/dir/sub/x.md')
    expect(pathBeforeMove('bc/x.md', 'a', 'b')).toBeNull()
  })
  it('ids differ for the same content at different times', () => {
    expect(snapshotId({ at: 1, hash: 'h' })).not.toBe(snapshotId({ at: 2, hash: 'h' }))
  })
  it('formats sizes', () => {
    expect(formatBytes(640)).toBe('640 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('version lists (T-274)', () => {
  const lists = { always: ['.md', '.txt'], never: ['.log', '.jsonl', '.ndjson'] }

  it('normalizes a typed extension to a leading dot, lower case', () => {
    expect(normalizeExtension('md')).toBe('.md')
    expect(normalizeExtension(' .LOG ')).toBe('.log')
    expect(normalizeExtension('tar.gz')).toBe('.tar.gz')
    for (const bad of ['', ' ', '.', 'a/b', '.a b', 'md.']) expect(normalizeExtension(bad), bad).toBeNull()
  })

  it('matches the end of the file name, case-insensitive, never the whole name', () => {
    expect(hasListedExtension('Projects/a/README.MD', ['.md'])).toBe(true)
    expect(hasListedExtension('out/x.tar.gz', ['.tar.gz'])).toBe(true)
    expect(hasListedExtension('a.md/notes.ts', ['.md'])).toBe(false)
    expect(hasListedExtension('dir/.md', ['.md'])).toBe(false)
    expect(hasListedExtension('a.mdx', ['.md'])).toBe(false)
  })

  it('orders the rules: open document and always-list first, then never-list, then bursts', () => {
    expect(versionRule('notes.md', lists, false)).toBe('every')
    expect(versionRule('server.log', lists, false)).toBe('none')
    expect(versionRule('events.JSONL', lists, false)).toBe('none')
    expect(versionRule('src/gen.ts', lists, false)).toBe('bursts')
    expect(versionRule('src/gen.ts', lists, true)).toBe('every')
    expect(versionRule('server.log', lists, true)).toBe('every')
    expect(versionRule('both.log', { always: ['.log'], never: ['.log'] }, false)).toBe('every')
  })

  it('follows edited lists at once (no cached verdict)', () => {
    expect(versionRule('src/gen.ts', lists, false)).toBe('bursts')
    expect(versionRule('src/gen.ts', { ...lists, never: [...lists.never, '.ts'] }, false)).toBe('none')
    expect(versionRule('src/gen.ts', { ...lists, always: ['.ts'] }, false)).toBe('every')
    expect(versionRule('notes.md', { always: [], never: [] }, false)).toBe('bursts')
  })
})

describe('limits (T-234)', () => {
  const c = (ref: string, at: number, hash: string, size: number): PruneCandidate => ({ ref, at, hash, size })

  it('planPurge removes what was kept before the moment, and unreadable times; never the rest', () => {
    const all = [c('a', 100, 'h1', 10), c('b', 200, 'h2', 10), c('c', 300, 'h3', 10), c('d', Number.NaN, 'h4', 10)]
    expect([...planPurge(all, 200)].sort()).toEqual(['a', 'd'])
    expect([...planPurge(all, 301)].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect([...planPurge(all, 0)]).toEqual(['d'])
    expect(planPurge([], 1000).size).toBe(0)
  })

  it('removalSize counts every version that goes, but frees content only when nothing left shares it', () => {
    const all = [c('a', 1, 'h1', 10), c('b', 2, 'h1', 10), c('c', 3, 'h2', 7), c('d', 4, 'h3', 5)]
    expect(removalSize(all, new Set(['a']))).toEqual({ versions: 1, bytes: 0 })
    expect(removalSize(all, new Set(['a', 'b']))).toEqual({ versions: 2, bytes: 10 })
    expect(removalSize(all, new Set(['a', 'b', 'c', 'd']))).toEqual({ versions: 4, bytes: 22 })
    expect(removalSize(all, new Set())).toEqual({ versions: 0, bytes: 0 })
  })

  it('removalSize of a prune plan is what the plan frees', () => {
    const all = [c('a', 10, 'h1', 10), c('b', 20, 'h2', 10), c('c', 30, 'h3', 10)]
    const gone = planPrune(all, 40, SNAPSHOT_TTL_MS, 15)
    expect(removalSize(all, gone)).toEqual({ versions: 2, bytes: 20 })
  })

  it('capBytesOf reads the setting in MB; anything but a positive number is the default', () => {
    expect(capBytesOf(64)).toBe(64 * 1024 * 1024)
    expect(capBytesOf(256)).toBe(SNAPSHOT_CAP_BYTES)
    for (const bad of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '64']) {
      expect(capBytesOf(bad)).toBe(SNAPSHOT_CAP_BYTES)
    }
  })

  it('labels', () => {
    expect(capLabel(64)).toBe('64 MB')
    expect(capLabel(1024)).toBe('1 GB')
    expect(capLabel(2048)).toBe('2 GB')
    expect(capLabel(1500)).toBe('1500 MB')
    expect(removalLabel({ versions: 1, bytes: 640 })).toBe('1 version, 640 B')
    expect(removalLabel({ versions: 3, bytes: 1258291 })).toBe('3 versions, 1.2 MB')
    expect(removalLabel({ versions: 0, bytes: 0 })).toBe('0 versions, 0 B')
  })
})
