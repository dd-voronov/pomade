// `pomade path install / remove / status` on temp folders: the rc file and the Pomade home are
// fixtures (POMADE_SHELL_RC, POMADE_HOME), so no real ~/.zprofile is ever read or written.

import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RC_MARKER, rcLine } from '../main/shell-path-line'
import { main } from './pomade'

let dir: string
let rc: string
let home: string
const saved: Record<string, string | undefined> = {}

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, (l) => out.push(l), (l) => err.push(l))
  return { code, out: out.join('\n'), err: err.join('\n') }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pomade-path-'))
  rc = join(dir, '.zprofile')
  home = join(dir, '.pomade-x')
  for (const k of ['POMADE_SHELL_RC', 'POMADE_HOME']) saved[k] = process.env[k]
  process.env.POMADE_SHELL_RC = rc
  process.env.POMADE_HOME = home
  await fs.writeFile(rc, 'export MINE=1\n')
})

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(dir, { recursive: true, force: true })
})

describe('pomade path', () => {
  it('status says off, install adds one line for the home, status says on, remove takes it out', async () => {
    expect((await run('path', 'status')).out).toContain('Off:')
    const install = await run('path', 'install')
    expect(install.code).toBe(0)
    expect(install.out).toContain(`On: ${rc} puts ${join(home, 'bin')} on PATH.`)
    expect(await fs.readFile(rc, 'utf8')).toBe(`export MINE=1\n${rcLine(join(home, 'bin'))}\n`)
    await run('path', 'install')
    expect((await fs.readFile(rc, 'utf8')).split('\n').filter((l) => l.includes(RC_MARKER))).toHaveLength(1)
    expect((await run('path', 'status')).out).toContain('On:')
    const remove = await run('path', 'remove')
    expect(remove.out).toBe(`Removed Pomade's line from ${rc}.`)
    expect(await fs.readFile(rc, 'utf8')).toBe('export MINE=1\n')
    expect((await run('path', 'remove')).out).toContain('Nothing to remove')
  })

  it("names another Pomade's line and repoints it on install", async () => {
    await fs.writeFile(rc, `${rcLine('/elsewhere/bin')}\n`)
    expect((await run('path', 'status')).out).toContain("another Pomade's commands on PATH (/elsewhere/bin)")
    await run('path', 'install')
    expect(await fs.readFile(rc, 'utf8')).toBe(`${rcLine(join(home, 'bin'))}\n`)
  })

  it('refuses unknown subcommands, extra arguments, and a test run without the rc hook', async () => {
    expect((await run('path', 'frobnicate')).code).toBe(1)
    expect((await run('path', 'install', 'x')).code).toBe(1)
    delete process.env.POMADE_SHELL_RC
    const r = await run('path', 'status')
    expect(r.code).toBe(1)
    expect(r.err).toContain('no shell rc file')
  })
})
