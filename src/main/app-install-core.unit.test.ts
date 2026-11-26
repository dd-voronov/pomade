import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BUILDS_DIR,
  clearRemoval,
  collectRetiredBuilds,
  installBuild,
  installedIds,
  readRemovals,
  recordRemoval,
  removeInstalled
} from './app-install-core'

let tmp: string
let ud: string

async function build(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmp, 'src-'))
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ id: 'a', version }))
  await fs.mkdir(join(dir, 'bin'))
  await fs.writeFile(join(dir, 'bin', 'helper'), version, { mode: 0o755 })
  return dir
}

const builds = (): Promise<string[]> => fs.readdir(join(ud, 'apps', BUILDS_DIR)).then((n) => n.sort())
const current = (): Promise<string> => fs.realpath(join(ud, 'apps', 'a'))
const none = (): Promise<string[]> => Promise.resolve([])

beforeEach(async () => {
  tmp = await fs.realpath(await mkdtemp(join(tmpdir(), 'pomade-install-')))
  ud = join(tmp, 'ud')
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('installBuild', () => {
  it('installs into a build folder the app id links to, executable bits kept', async () => {
    const r = await installBuild(ud, 'a', await build('1'))
    expect(r).toEqual({ replaced: false, dest: join(ud, 'apps', 'a') })
    expect((await fs.lstat(join(ud, 'apps', 'a'))).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(join(ud, 'apps', 'a'))).toMatch(/^\.builds\/a-/)
    expect(await fs.readFile(join(ud, 'apps', 'a', 'bin', 'helper'), 'utf8')).toBe('1')
    expect((await fs.stat(join(ud, 'apps', 'a', 'bin', 'helper'))).mode & 0o777).toBe(0o755)
    expect(await installedIds(ud)).toEqual(['a'])
  })

  it('an update swaps the link; the earlier build stays until no process uses it', async () => {
    await installBuild(ud, 'a', await build('1'))
    const first = await current()
    expect((await installBuild(ud, 'a', await build('2'))).replaced).toBe(true)
    expect(await fs.readFile(join(ud, 'apps', 'a', 'bin', 'helper'), 'utf8')).toBe('2')
    // The earlier build's files are where a process started from it finds them.
    expect(await fs.readFile(join(first, 'bin', 'helper'), 'utf8')).toBe('1')
    expect(await builds()).toHaveLength(2)

    // A process holds a file in it (a keeper's mapped library, its working directory): kept.
    expect(await collectRetiredBuilds(ud, () => Promise.resolve([join(first, 'bin', 'helper')]))).toEqual([])
    expect(await builds()).toHaveLength(2)
    // Unused: deleted; the current build never is.
    expect(await collectRetiredBuilds(ud, none)).toEqual([first.split('/').pop()])
    expect(await builds()).toEqual([(await current()).split('/').pop()])
  })

  it('takes over an install that is a real folder: it becomes a retired build', async () => {
    await fs.mkdir(join(ud, 'apps', 'a', 'bin'), { recursive: true })
    await fs.writeFile(join(ud, 'apps', 'a', 'bin', 'helper'), 'old')
    expect((await installBuild(ud, 'a', await build('2'))).replaced).toBe(true)
    expect(await fs.readFile(join(ud, 'apps', 'a', 'bin', 'helper'), 'utf8')).toBe('2')
    expect(await builds()).toHaveLength(2)
    await collectRetiredBuilds(ud, none)
    expect(await builds()).toHaveLength(1)
  })

  it('a staging folder of an install under way is not collected', async () => {
    await installBuild(ud, 'a', await build('1'))
    await fs.mkdir(join(ud, 'apps', BUILDS_DIR, '.staging-a-x'))
    expect(await collectRetiredBuilds(ud, none)).toEqual([])
  })
})

describe('removeInstalled', () => {
  it('removes the link; the build is retired', async () => {
    await installBuild(ud, 'a', await build('1'))
    expect(await removeInstalled(ud, 'a')).toBe(true)
    expect(await installedIds(ud)).toEqual([])
    expect(await builds()).toHaveLength(1)
    await collectRetiredBuilds(ud, none)
    expect(await builds()).toEqual([])
    expect(await removeInstalled(ud, 'a')).toBe(false)
  })
})

describe('removals', () => {
  it('are recorded with the removed version and cleared on a new install', async () => {
    expect(await readRemovals(ud)).toEqual({})
    await recordRemoval(ud, 'a', '0.1.0')
    await recordRemoval(ud, 'b', '0.2.0')
    expect(await readRemovals(ud)).toEqual({ a: '0.1.0', b: '0.2.0' })
    await clearRemoval(ud, 'a')
    expect(await readRemovals(ud)).toEqual({ b: '0.2.0' })
  })
})
