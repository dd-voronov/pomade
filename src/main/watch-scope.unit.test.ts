import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { diffReadings, readScope } from './watch-scope'

describe('readScope', () => {
  let root: string
  const absOf = (rel: string): string => (rel ? join(root, rel) : root)
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-scope-'))
    await mkdir(join(root, 'plans/sub/deep'), { recursive: true })
    await mkdir(join(root, 'plans/node_modules/pkg'), { recursive: true })
    await mkdir(join(root, 'plans/skip'), { recursive: true })
    await writeFile(join(root, 'plans/a.md'), 'a')
    await writeFile(join(root, 'plans/sub/b.md'), 'b')
    await writeFile(join(root, 'plans/sub/deep/c.md'), 'c')
    await writeFile(join(root, 'plans/node_modules/pkg/i.js'), 'i')
    await writeFile(join(root, 'plans/skip/s.md'), 's')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads the folder and, recursively, everything below it but the ignored names', async () => {
    const r = await readScope('plans', true, new Set(['skip']), absOf)
    expect([...(r?.keys() ?? [])].sort()).toEqual([
      'plans',
      'plans/a.md',
      'plans/sub',
      'plans/sub/b.md',
      'plans/sub/deep',
      'plans/sub/deep/c.md'
    ])
    expect(r?.get('plans/sub')).toBe('d')
  })

  it('non-recursive: the folder and its direct entries only', async () => {
    const r = await readScope('plans', false, new Set(['skip']), absOf)
    expect([...(r?.keys() ?? [])].sort()).toEqual(['plans', 'plans/a.md', 'plans/sub'])
  })

  it('a watched file is only itself; a missing path is an empty reading', async () => {
    expect([...((await readScope('plans/a.md', true, new Set(), absOf))?.keys() ?? [])]).toEqual(['plans/a.md'])
    expect((await readScope('nope', true, new Set(), absOf))?.size).toBe(0)
  })

  it('gives up past the cap', async () => {
    expect(await readScope('plans', true, new Set(), absOf, 3)).toBeNull()
  })
})

describe('diffReadings', () => {
  it('reports appeared and vanished paths as structural, content changes as not', () => {
    const before = new Map([
      ['p', 'd'],
      ['p/a.md', 'f:1:10'],
      ['p/gone.md', 'f:1:10'],
      ['p/same.md', 'f:1:10'],
      ['p/x', 'd']
    ])
    const after = new Map([
      ['p', 'd'],
      ['p/a.md', 'f:2:20'],
      ['p/new.md', 'f:1:30'],
      ['p/same.md', 'f:1:10'],
      ['p/x', 'f:0:40']
    ])
    expect(Object.fromEntries(diffReadings(before, after))).toEqual({
      'p/a.md': false,
      'p/new.md': true,
      'p/gone.md': true,
      'p/x': true
    })
  })
})
