// `pomade apps install / remove / link` with app-shipped skills, end to end on temp folders: the
// user data, a workspace with agents' skills folders and a built-in Claude config folder are all
// fixtures, so the test can prove nothing is linked anywhere.

import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { main } from './pomade'

let root: string
let ud: string
let ws: string
let claude: string
let build: string
let savedUserData: string | undefined

async function write(path: string, text: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, text, 'utf8')
}

async function writeBuild(skills: string[], withSkillFile = true): Promise<void> {
  await write(join(build, 'index.html'), '<!doctype html>')
  for (const s of skills) {
    if (withSkillFile) await write(join(build, s, 'SKILL.md'), `# ${s}\n`)
    else await fs.mkdir(join(build, s), { recursive: true })
  }
  await write(
    join(build, 'manifest.json'),
    JSON.stringify({ id: 'runner', name: 'Runner', version: '0.1.0', hostApi: 0, capabilities: [], skills })
  )
}

async function run(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(args, (l) => out.push(l), (l) => err.push(l))
  return { code, out, err }
}

/** Every path under `dir` (recursive, lstat — links are listed, never followed). */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      out.push(e.isSymbolicLink() ? `${p} -> link` : p)
      if (e.isDirectory()) await walk(p)
    }
  }
  await walk(dir)
  return out.sort()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pomade-skills-'))
  ud = join(root, 'userData')
  ws = join(root, 'ws')
  claude = join(root, 'claude-home')
  build = join(root, 'build')
  savedUserData = process.env['POMADE_USER_DATA']
  process.env['POMADE_USER_DATA'] = ud
  await write(join(ws, 'Agents/claude-coder/CLAUDE.md'), '# coder')
  await fs.mkdir(join(ws, 'Agents/claude-coder/skills'), { recursive: true })
  await fs.mkdir(join(claude, 'skills'), { recursive: true })
  await write(join(ud, 'app.json'), JSON.stringify({ workspaceRoot: ws }))
})

afterEach(async () => {
  if (savedUserData === undefined) delete process.env['POMADE_USER_DATA']
  else process.env['POMADE_USER_DATA'] = savedUserData
  await fs.rm(root, { recursive: true, force: true })
})

const LINE = (name: string, dir: string): string =>
  `Skill ${name} is at ${dir}. To give it to an agent, copy or link this folder into the agent's skills folder.`

describe('pomade apps install with skills', () => {
  it('reports each skill at its folder in the installed build, and links nothing anywhere', async () => {
    await writeBuild(['skills/runner-jobs', 'skills/runner-hooks'])
    const before = { ws: await tree(ws), claude: await tree(claude) }
    const r = await run('apps', 'install', build)
    expect(r.code).toBe(0)
    expect(r.out).toContain('  Skills:        runner-jobs (skills/runner-jobs), runner-hooks (skills/runner-hooks)')
    expect(r.out).toContain(LINE('runner-jobs', join(ud, 'apps/runner/skills/runner-jobs')))
    expect(r.out).toContain(LINE('runner-hooks', join(ud, 'apps/runner/skills/runner-hooks')))
    await expect(fs.access(join(ud, 'apps/runner/skills/runner-jobs/SKILL.md'))).resolves.toBeUndefined()
    expect({ ws: await tree(ws), claude: await tree(claude) }).toEqual(before)
    // The only link is the install itself (apps/<id> → its build folder); no skill is linked.
    expect((await tree(ud)).filter((p) => p.endsWith('-> link'))).toEqual([`${join(ud, 'apps/runner')} -> link`])
  })

  it('remove deletes the app and touches nothing else', async () => {
    await writeBuild(['skills/runner-jobs'])
    await run('apps', 'install', build)
    const before = { ws: await tree(ws), claude: await tree(claude) }
    const r = await run('apps', 'remove', 'runner')
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['Removed runner'])
    expect({ ws: await tree(ws), claude: await tree(claude) }).toEqual(before)
  })

  it('refuses an app whose skill folder has no SKILL.md, before copying anything', async () => {
    await writeBuild(['skills/runner-jobs'], false)
    const r = await run('apps', 'install', build)
    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('no SKILL.md in the skill folder skills/runner-jobs')
    await expect(fs.access(join(ud, 'apps/runner'))).rejects.toThrow()
  })

  it('an app without skills prints no skill lines', async () => {
    await writeBuild([])
    const r = await run('apps', 'install', build)
    expect(r.code).toBe(0)
    expect(r.out).toContain('  Skills:        (none)')
    expect(r.out.some((l) => l.startsWith('Skill '))).toBe(false)
  })
})

describe('pomade apps link with skills', () => {
  it('validates and reports the skills at the linked build folder; links nothing', async () => {
    await writeBuild(['skills/runner-jobs'])
    const before = { ws: await tree(ws), claude: await tree(claude) }
    const r = await run('apps', 'link', build)
    expect(r.code).toBe(0)
    expect(r.out).toContain(LINE('runner-jobs', join(build, 'skills/runner-jobs')))
    expect({ ws: await tree(ws), claude: await tree(claude) }).toEqual(before)
  })

  it('refuses a linked build whose skill folder has no SKILL.md', async () => {
    await writeBuild(['skills/runner-jobs'], false)
    const r = await run('apps', 'link', build)
    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('no SKILL.md')
  })
})
