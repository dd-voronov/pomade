import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { main } from './pomade'
import { projectLines, projectsWorkspace, readProjects } from './projects'

let dir: string
let ws: string
let home: string
let ud: string

function writeProjects(projects: unknown): void {
  mkdirSync(join(ws, '.pomade'), { recursive: true })
  writeFileSync(join(ws, '.pomade', 'workspace.json'), JSON.stringify({ groups: [], projects }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pomade-projects-'))
  ws = join(dir, 'ws')
  home = join(dir, 'home')
  ud = join(dir, 'ud')
  for (const d of [ws, home, ud]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('projectsWorkspace', () => {
  it('POMADE_WORKSPACE, else the home pointer, else app.json; null when none names an absolute folder', async () => {
    expect(await projectsWorkspace({}, home, ud)).toBeNull()
    writeFileSync(join(ud, 'app.json'), JSON.stringify({ workspaceRoot: '/from/app-json' }))
    expect(await projectsWorkspace({}, home, ud)).toBe('/from/app-json')
    writeFileSync(join(home, 'workspace'), '/from/pointer\n')
    expect(await projectsWorkspace({}, home, ud)).toBe('/from/pointer')
    expect(await projectsWorkspace({ POMADE_WORKSPACE: '/from/env/' }, home, ud)).toBe('/from/env')
    expect(await projectsWorkspace({ POMADE_WORKSPACE: 'relative' }, home, ud)).toBe('/from/pointer')
    writeFileSync(join(home, 'workspace'), 'relative\n')
    writeFileSync(join(ud, 'app.json'), JSON.stringify({ workspaceRoot: null }))
    expect(await projectsWorkspace({}, home, ud)).toBeNull()
  })
})

describe('readProjects', () => {
  it('the projects by name, with absolute folders; malformed entries skipped; no file → none', async () => {
    expect(await readProjects(ws)).toEqual([])
    writeProjects([
      { id: 'p-b', name: 'beta', rootPath: 'Projects/beta', visibleAgents: ['*'], order: 0 },
      { id: 'p-a', name: 'Alpha', rootPath: 'Projects/alpha', order: 1 },
      { id: 'p-root', name: 'Root', rootPath: '' },
      { id: 3, name: 'Bad', rootPath: 'x' },
      { name: 'No id', rootPath: 'y' },
      null
    ])
    expect(await readProjects(ws)).toEqual([
      { id: 'p-a', name: 'Alpha', root: 'Projects/alpha', path: join(ws, 'Projects/alpha') },
      { id: 'p-b', name: 'beta', root: 'Projects/beta', path: join(ws, 'Projects/beta') },
      { id: 'p-root', name: 'Root', root: '', path: ws }
    ])
  })

  it('throws on a file that is not JSON', async () => {
    mkdirSync(join(ws, '.pomade'), { recursive: true })
    writeFileSync(join(ws, '.pomade', 'workspace.json'), '{ nope')
    await expect(readProjects(ws)).rejects.toThrow()
  })
})

describe('projectLines', () => {
  it('aligned rows; "." for the workspace root; a line for none', () => {
    expect(
      projectLines('/ws', [
        { id: 'a1', name: 'Alpha', root: 'Projects/alpha', path: '/ws/Projects/alpha' },
        { id: 'root-id', name: 'R', root: '', path: '/ws' }
      ])
    ).toEqual(['Workspace: /ws', '  a1       Alpha  Projects/alpha', '  root-id  R      .'])
    expect(projectLines('/ws', [])).toEqual(['Workspace: /ws', '  (no projects)'])
  })
})

describe('pomade projects', () => {
  const run = async (argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = []
    const err: string[] = []
    const code = await main(argv, (l) => out.push(l), (l) => err.push(l))
    return { code, out, err }
  }
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = { POMADE_WORKSPACE: process.env.POMADE_WORKSPACE, POMADE_HOME: process.env.POMADE_HOME, POMADE_USER_DATA: process.env.POMADE_USER_DATA }
    delete process.env.POMADE_WORKSPACE
    process.env.POMADE_HOME = home
    process.env.POMADE_USER_DATA = ud
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('prints the table, or JSON with --json', async () => {
    writeFileSync(join(home, 'workspace'), `${ws}\n`)
    writeProjects([{ id: 'p-a', name: 'Alpha', rootPath: 'Projects/alpha' }])
    expect(await run(['projects'])).toEqual({ code: 0, out: [`Workspace: ${ws}`, '  p-a  Alpha  Projects/alpha'], err: [] })
    const json = await run(['projects', '--json'])
    expect(json.code).toBe(0)
    expect(JSON.parse(json.out.join('\n'))).toEqual({
      workspace: ws,
      projects: [{ id: 'p-a', name: 'Alpha', root: 'Projects/alpha', path: join(ws, 'Projects/alpha') }]
    })
  })

  it('no workspace, an unreadable file, extra arguments and --json elsewhere are errors', async () => {
    const none = await run(['projects'])
    expect(none.code).toBe(1)
    expect(none.err[0]).toMatch(/^pomade: no workspace/)
    writeFileSync(join(home, 'workspace'), `${ws}\n`)
    mkdirSync(join(ws, '.pomade'), { recursive: true })
    writeFileSync(join(ws, '.pomade', 'workspace.json'), '{ nope')
    expect((await run(['projects'])).err[0]).toMatch(/^pomade: cannot read the projects of /)
    expect((await run(['projects', 'x'])).err[0]).toMatch(/^pomade: wrong arguments for "projects"/)
    expect((await run(['apps', 'list', '--json'])).err[0]).toMatch(/^pomade: --json is only for "projects"/)
  })
})
