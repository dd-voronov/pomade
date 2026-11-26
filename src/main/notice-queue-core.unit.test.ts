import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { drainQueueDir, queueFiles } from './notice-queue-core'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pomade-queue-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const notice = (title: string, extra: object = {}): string =>
  JSON.stringify({ title, source: 'pomade-git', postedAt: '2026-11-10T08:00:00.000Z', ...extra })

describe('queueFiles', () => {
  it('takes *.json in name order, never a dot-file being written', () => {
    expect(queueFiles(['002-b.json', '.003-c.json.tmp', '001-a.json', 'x.invalid', 'note.txt'])).toEqual(['001-a.json', '002-b.json'])
  })
})

describe('drainQueueDir', () => {
  it('returns the valid notices in posting order and deletes their files', async () => {
    await fs.writeFile(join(dir, '002-b.json'), notice('Second'))
    await fs.writeFile(join(dir, '001-a.json'), notice('First', { action: { kind: 'openApp', route: 'runs' } }))
    await fs.writeFile(join(dir, '.003-c.json.tmp'), notice('Half written'))
    const drained = await drainQueueDir(dir)
    expect(drained.map((n) => n.title)).toEqual(['First', 'Second'])
    expect(drained[0]).toEqual({
      title: 'First',
      action: { kind: 'openApp', route: 'runs' },
      source: 'pomade-git',
      postedAt: '2026-11-10T08:00:00.000Z'
    })
    expect(await fs.readdir(dir)).toEqual(['.003-c.json.tmp'])
    expect(await drainQueueDir(dir)).toEqual([])
  })

  it('sets an invalid file aside as .invalid and keeps draining', async () => {
    await fs.writeFile(join(dir, '001-a.json'), '{ not json')
    await fs.writeFile(join(dir, '002-b.json'), notice(''))
    await fs.writeFile(join(dir, '003-c.json'), notice('Fine'))
    const warnings: string[] = []
    expect((await drainQueueDir(dir, (m) => warnings.push(m))).map((n) => n.title)).toEqual(['Fine'])
    expect((await fs.readdir(dir)).sort()).toEqual(['001-a.json.invalid', '002-b.json.invalid'])
    expect(warnings).toHaveLength(2)
  })

  it('a missing folder is an empty queue', async () => {
    expect(await drainQueueDir(join(dir, 'nope'))).toEqual([])
  })
})
