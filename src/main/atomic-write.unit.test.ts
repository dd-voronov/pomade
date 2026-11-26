import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ChangedOnDiskError, writeFileAtomic } from './atomic-write'

describe('writeFileAtomic — ifMtime (T-241 conditional writes)', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pomade-atomic-'))
    file = join(dir, 'T-1.md')
    await writeFile(file, 'read\n')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes while the mtime is the one read', async () => {
    const { mtimeMs } = await stat(file)
    await writeFileAtomic(file, 'mine\n', { ifMtime: mtimeMs })
    expect(await readFile(file, 'utf8')).toBe('mine\n')
  })

  it('refuses when the file changed since the read: the other write stays, no tmp file is left', async () => {
    const { mtimeMs } = await stat(file)
    await writeFile(file, 'theirs\n')
    const now = await stat(file)
    expect(now.mtimeMs).not.toBe(mtimeMs)
    await expect(writeFileAtomic(file, 'mine\n', { ifMtime: mtimeMs })).rejects.toBeInstanceOf(ChangedOnDiskError)
    expect(await readFile(file, 'utf8')).toBe('theirs\n')
    expect((await stat(file)).mtimeMs).toBe(now.mtimeMs)
    expect(await readdir(dir)).toEqual(['T-1.md'])
  })

  it('a missing file is ENOENT, not a write', async () => {
    await rm(file)
    await expect(writeFileAtomic(file, 'mine\n', { ifMtime: 1 })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(dir)).toEqual([])
  })
})
