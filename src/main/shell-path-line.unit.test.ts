import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  RC_MARKER,
  installPathLine,
  rcLine,
  rcLineTarget,
  readPathLine,
  removePathLine,
  shQuote,
  withRcLine,
  withoutRcLine
} from './shell-path-line'

describe('rc line text', () => {
  const bin = '/Users/u/.pomade/bin'

  it('quotes for sh', () => {
    expect(shQuote("a b'c")).toBe(`'a b'\\''c'`)
  })

  it('is appended once, idempotently, and removed without touching the rest', () => {
    const user = 'export A=1\n# mine\n'
    const once = withRcLine(user, bin)
    expect(once).toBe(`${user}${rcLine(bin)}\n`)
    expect(withRcLine(once, bin)).toBe(once)
    expect(withoutRcLine(once)).toBe(user)
    expect(withRcLine('no newline', bin)).toBe(`no newline\n${rcLine(bin)}\n`)
    expect(withRcLine('', bin)).toBe(`${rcLine(bin)}\n`)
  })

  it('replaces another Pomade line in place and drops duplicates', () => {
    const old = `a\n${rcLine('/old/bin')}\nb\n${rcLine('/old/bin')}\n`
    expect(withRcLine(old, bin)).toBe(`a\n${rcLine(bin)}\nb\n`)
  })

  it('steps aside in Pomade terminals and is marked', () => {
    expect(rcLine(bin)).toBe(`[ -n "$POMADE_HOME" ] || export PATH='/Users/u/.pomade/bin'":$PATH" ${RC_MARKER}`)
  })

  it('names the folder it puts on PATH, quotes included; null without a line, empty when edited', () => {
    expect(rcLineTarget(`x\n${rcLine(bin)}\n`)).toBe(bin)
    expect(rcLineTarget(rcLine("/Users/o'neil/.pomade/bin"))).toBe("/Users/o'neil/.pomade/bin")
    expect(rcLineTarget('export A=1\n')).toBeNull()
    expect(rcLineTarget(`export PATH=/x:$PATH ${RC_MARKER}`)).toBe('')
  })
})

describe('rc file changes', () => {
  let dir: string
  let rc: string
  const bin = '/Users/u/.pomade/bin'

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pomade-rc-'))
    rc = join(dir, '.zprofile')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads a missing file as no line', async () => {
    expect(await readPathLine(rc, bin)).toEqual({ rcFile: rc, binDir: bin, lineTarget: null })
  })

  it('install creates the file or adds one line; remove takes it out and keeps the rest', async () => {
    expect((await installPathLine(rc, bin)).lineTarget).toBe(bin)
    expect(await fs.readFile(rc, 'utf8')).toBe(`${rcLine(bin)}\n`)
    await fs.writeFile(rc, `export MINE=1\n${rcLine(bin)}\nalias ll='ls -l'\n`)
    await installPathLine(rc, bin)
    expect((await fs.readFile(rc, 'utf8')).split('\n').filter((l) => l.includes(RC_MARKER))).toHaveLength(1)
    expect((await removePathLine(rc, bin)).lineTarget).toBeNull()
    expect(await fs.readFile(rc, 'utf8')).toBe(`export MINE=1\nalias ll='ls -l'\n`)
  })

  it('install repoints another Pomade line; remove of a file without a line writes nothing', async () => {
    await fs.writeFile(rc, `${rcLine('/Users/u/.pomade-dev/bin')}\n`)
    expect((await readPathLine(rc, bin)).lineTarget).toBe('/Users/u/.pomade-dev/bin')
    expect((await installPathLine(rc, bin)).lineTarget).toBe(bin)
    await fs.writeFile(rc, 'export MINE=1\n')
    const before = (await fs.stat(rc)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    await removePathLine(rc, bin)
    expect((await fs.stat(rc)).mtimeMs).toBe(before)
    await removePathLine(join(dir, 'absent'), bin)
    await expect(fs.access(join(dir, 'absent'))).rejects.toThrow()
  })
})
