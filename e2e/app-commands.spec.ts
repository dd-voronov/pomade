// modules: core
// E-028 e2e — app commands on PATH (docs/HOST-API.md §2 "Commands"). Everything lands in temp
// folders: this Pomade's home (`POMADE_HOME`: bin/, workspace, host.json) and a fake user HOME whose
// `.zprofile` (`POMADE_SHELL_RC`) Pomade never writes on its own — the PATH line goes in and out only
// through Settings ▸ General. A fresh login zsh with that HOME runs the test app's command, which asks
// the app's API — its backend — through Pomade's socket and the broker. With Pomade closed the command
// says so and still finds the workspace from the pointer, its state folder, and `pomade projects` lists
// the projects with their ids.
// Spawns zsh and backends → heavy project.

import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const APP_DIR = resolve(__dirname, 'fixtures/apps/backend')
const APP_ID = 'e028-test'
const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const MARKER = '# Pomade: its commands on PATH'
const SHOTS = process.env.POMADE_E028_SHOTS

/** A screenshot into POMADE_E028_SHOTS, when set. */
async function shot(target: Locator, name: string): Promise<void> {
  if (SHOTS) await target.screenshot({ path: join(SHOTS, name) })
}

test.describe('E-028 commands on PATH', () => {
  let fixture: Fixture
  let app: ElectronApplication | null = null
  let page: Page
  let tmp: string
  let userHome: string
  let pomadeHome: string
  let rc: string

  /** A fresh login shell of the fake user: only /etc and the fake HOME's startup files. */
  function shell(command: string): Promise<{ code: number; out: string }> {
    return new Promise((done) => {
      execFile(
        '/bin/zsh',
        ['-l', '-c', command],
        { env: { HOME: userHome, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', USER: process.env.USER ?? 'user', TMPDIR: tmpdir() }, timeout: 30000 },
        (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })
      )
    })
  }

  async function launch(): Promise<void> {
    app = await launchApp(fixture, { POMADE_HOME: pomadeHome, POMADE_SHELL_RC: rc })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  }

  async function backendServing(): Promise<void> {
    await expect
      .poll(async () => {
        const text = await fs.readFile(join(fixture.userDataDir, 'app-state', APP_ID, 'state.json'), 'utf8').catch(() => '{}')
        return (JSON.parse(text) as { backend?: unknown }).backend !== undefined
      }, { timeout: 20000 })
      .toBe(true)
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    tmp = await tempDir('pomade-cmd-')
    userHome = join(tmp, 'home')
    pomadeHome = join(userHome, '.pomade-e2e')
    rc = join(userHome, '.zprofile')
    await fs.mkdir(join(pomadeHome, 'bin'), { recursive: true })
    await fs.writeFile(rc, 'export MINE=1\n')
    // A file of the user's own in the command folder: Pomade never touches it.
    await fs.writeFile(join(pomadeHome, 'bin', 'mine'), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    execFileSync(POMADE_BIN, ['apps', 'link', APP_DIR], { env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir } })
    await launch()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(tmp, { recursive: true, force: true })
  })

  async function settingsGeneral(): Promise<void> {
    await page.getByTestId('projects-panel-settings').click()
    await expect(page.getByTestId('settings-general')).toBeVisible()
  }

  async function closeSettings(): Promise<void> {
    await page.getByTestId('modal-close').click()
    await expect(page.getByTestId('settings-modal')).toHaveCount(0)
  }

  test("Pomade's home holds the shims, the workspace pointer and the host record; the rc is left alone", async () => {
    const bin = join(pomadeHome, 'bin')
    await expect.poll(() => fs.readdir(bin).then((n) => n.sort())).toEqual(['e028-test', 'mine', 'pomade', 'pomade-git'])
    // E-042 — Pomade's own pomade-git: the built command, run with Pomade's runtime, this Pomade's home and user data.
    const git = await fs.readFile(join(bin, 'pomade-git'), 'utf8')
    expect(git.split('\n')[1]).toMatch(/^# Pomade command shim — pomade-git, Pomade's own command/)
    expect(git).toContain(`POMADE_HOME='${pomadeHome}'`)
    expect(git).toContain('ELECTRON_RUN_AS_NODE=')
    expect(git).toMatch(/out\/main\/pomade-git\.js' "\$@"\n$/)
    // The shim runs: Pomade's runtime as Node, the bundled command, no Pomade needed.
    const help = spawnSync(join(bin, 'pomade-git'), ['--help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(help.status).toBe(0)
    expect(help.stdout).toMatch(/^Usage: pomade-git <operation> <repo…>/)
    const shim = await fs.readFile(join(bin, 'e028-test'), 'utf8')
    expect(shim.split('\n')[1]).toMatch(/^# Pomade command shim — e028-test of the app e028-test/)
    expect(shim).toContain(`POMADE_APP_ID='e028-test'`)
    expect(shim).toContain(`POMADE_CLIENT='command'`)
    expect(shim).toContain(`POMADE_APP_STATE='${join(fixture.userDataDir, 'app-state', APP_ID)}'`)
    expect(shim).toContain(`ELECTRON_RUN_AS_NODE='1'`)
    expect((await fs.stat(join(bin, 'e028-test'))).mode & 0o777).toBe(0o755)
    expect(await fs.readFile(join(pomadeHome, 'workspace'), 'utf8')).toBe(`${fixture.workspaceRoot}\n`)
    const record = JSON.parse(await fs.readFile(join(pomadeHome, 'host.json'), 'utf8')) as { socket: string; launch: { argv: string[]; env: Record<string, string> } }
    expect(record.socket).toBe(join(fixture.userDataDir, 'run', 'pomade.sock'))
    expect(record.launch.env).toMatchObject({ POMADE_HOME: pomadeHome, POMADE_USER_DATA: fixture.userDataDir, NODE_ENV: 'test' })
    expect(await fs.readFile(rc, 'utf8')).toBe('export MINE=1\n')
    expect((await shell('e028-test echo x')).code).not.toBe(0)
  })

  test('Settings adds the PATH line on request: one marked line, the rest of the file kept', async () => {
    await settingsGeneral()
    const status = page.getByTestId('setting-path-line-status')
    const toggle = page.getByTestId('setting-path-line-toggle')
    await expect(status).toHaveText(`Off — ${rc} has no Pomade line.`)
    await expect(toggle).toHaveText('Add line')
    await toggle.click()
    await expect(status).toHaveText(`On — ${rc} puts ${join(pomadeHome, 'bin')} on PATH.`)
    await expect(toggle).toHaveText('Remove line')
    const text = await fs.readFile(rc, 'utf8')
    expect(text.startsWith('export MINE=1\n')).toBe(true)
    expect(text.split('\n').filter((l) => l.includes(MARKER))).toHaveLength(1)
    await shot(page.getByTestId('settings-modal'), 'settings-path-line-on.png')
    await closeSettings()
  })

  test("a fresh login shell runs the app's command; it gets an answer from the app's API through Pomade", async () => {
    await backendServing()
    const r = await shell('e028-test echo hello there')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out.trim())).toMatchObject({ echo: { text: 'hello there' }, from: APP_ID })
    const own = await shell('mine')
    expect(own.out.trim()).toBe('mine')
    // The platform's own `pomade` command targets this Pomade's user data.
    const list = await shell('pomade apps list')
    expect(list.out).toContain(`User data: ${fixture.userDataDir}`)
    expect(list.out).toContain(`e028-test  → ${APP_DIR}`)
  })

  test('with Pomade closed the command says so and still finds the workspace', async () => {
    await app!.close()
    app = null
    const r = await shell('e028-test echo x')
    expect(r.code).toBe(3)
    expect(r.out).toContain('not running')
    expect(r.out).toContain(`workspace ${fixture.workspaceRoot}`)
    expect((await shell('e028-test workspace')).out.trim()).toBe(fixture.workspaceRoot)
    // Its state folder: in the environment, created by Pomade, there with Pomade closed.
    expect((await shell('e028-test state')).out.trim()).toBe(`${join(fixture.userDataDir, 'app-state', APP_ID)} exists`)
  })

  test('with Pomade closed `pomade projects` lists the workspace\'s projects with their stable ids', async () => {
    await app?.close()
    app = null
    const r = await shell('pomade projects')
    expect(r.code).toBe(0)
    const rows = r.out.trim().split('\n')
    expect(rows[0]).toBe(`Workspace: ${fixture.workspaceRoot}`)
    expect(rows.slice(1).map((l) => l.trim().split(/\s+/))).toEqual([
      [fixture.projects.alpha, 'Alpha', 'Projects/alpha'],
      [fixture.projects.beta, 'Beta', 'Projects/beta']
    ])
    const json = await shell('pomade projects --json')
    expect(JSON.parse(json.out)).toEqual({
      workspace: fixture.workspaceRoot,
      projects: [
        { id: fixture.projects.alpha, name: 'Alpha', root: 'Projects/alpha', path: join(fixture.workspaceRoot, 'Projects/alpha') },
        { id: fixture.projects.beta, name: 'Beta', root: 'Projects/beta', path: join(fixture.workspaceRoot, 'Projects/beta') }
      ]
    })
    // A rename while Pomade is closed keeps the id: the list reads the workspace's file as it is.
    const file = join(fixture.workspaceRoot, '.pomade', 'workspace.json')
    const original = await fs.readFile(file, 'utf8')
    const config = JSON.parse(original) as { projects: { id: string; name: string }[] }
    const renamedBeta = config.projects.map((p) => ({ ...p, name: p.id === fixture.projects.beta ? 'Aardvark' : p.name }))
    await fs.writeFile(file, JSON.stringify({ ...config, projects: renamedBeta }))
    const renamed = await shell('pomade projects --json')
    expect((JSON.parse(renamed.out) as { projects: { id: string; name: string }[] }).projects.map((p) => [p.id, p.name])).toEqual([
      [fixture.projects.beta, 'Aardvark'],
      [fixture.projects.alpha, 'Alpha']
    ])
    await fs.writeFile(file, original)
  })

  test('a restart leaves the line as it was; Settings removes it; unlinking the app removes its shim only', async () => {
    const before = await fs.readFile(rc, 'utf8')
    await launch()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await settingsGeneral()
    await expect(page.getByTestId('setting-path-line-status')).toHaveText(`On — ${rc} puts ${join(pomadeHome, 'bin')} on PATH.`)
    expect(await fs.readFile(rc, 'utf8')).toBe(before)
    await page.getByTestId('setting-path-line-toggle').click()
    await expect(page.getByTestId('setting-path-line-status')).toHaveText(`Off — ${rc} has no Pomade line.`)
    expect(await fs.readFile(rc, 'utf8')).toBe('export MINE=1\n')
    await closeSettings()
    execFileSync(POMADE_BIN, ['apps', 'unlink', APP_ID], { env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir } })
    await expect.poll(() => fs.readdir(join(pomadeHome, 'bin')).then((n) => n.sort())).toEqual(['mine', 'pomade', 'pomade-git'])
    expect((await shell('e028-test echo x')).code).not.toBe(0)
  })
})
