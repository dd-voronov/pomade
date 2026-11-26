// modules: core
// E-028 e2e — always-on backends (docs/HOST-API.md §2 "Backends"): a per-user launchd agent with a
// throwaway test label (`io.github.dd-voronov.pomade.test.<random>.`), its plist in a temp folder
// (`POMADE_LAUNCH_AGENTS`) — never ~/Library/LaunchAgents. The test app's backend is loaded when the
// app appears, keeps running after Pomade quits, launches Pomade on request (the test build, as
// Pomade recorded in its temp home) and is reached through it; an app update leaves it running
// unless the manifest asks for a restart. "Starts at login" is checked on the plist (RunAtLoad).
// Teardown boots the job out, kills whatever the portable build runs and asserts none of this run's
// jobs is left. Long-lived processes → heavy project.
//
// macOS privacy protection keeps a process launchd started from reading ~/Documents (where this
// repo lives). So the job runs nothing from there: the spec runs Pomade from a portable copy in a
// temp folder (APFS clones of Electron.app, `out/`, node-pty), and the app's copy carries the
// packages its backend imports.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow } from './fixtures/app'
import { clientAs } from './fixtures/socket-client'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const FIXTURE = resolve(__dirname, 'fixtures/apps/always')
const APP_ID = 'e028-always'
const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const PREFIX = `io.github.dd-voronov.pomade.test.${randomBytes(4).toString('hex')}.`
const LABEL = `${PREFIX}${APP_ID}`
const UID = process.getuid?.() ?? 501

interface Report {
  pid: number
  connected: boolean
  connections: number
  launched: { launched: boolean; pid: number | null } | { error: string } | null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function launchctl(...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    return { ok: false, out: String((err as { stdout?: string }).stdout ?? '') }
  }
}

test.describe('E-028 always-on backends', () => {
  let fixture: Fixture
  let app: ElectronApplication | null = null
  let page: Page
  let tmp: string
  let appDir: string
  let pomadeHome: string
  let agentsDir: string
  const pids = new Set<number>()
  let env: Record<string, string>

  const report = async (): Promise<Report | null> => {
    try {
      const r = JSON.parse(await fs.readFile(join(pomadeHome, 'e028-always.json'), 'utf8')) as Report
      pids.add(r.pid)
      return r
    } catch {
      return null
    }
  }

  /** Pomade outside ~/Documents: cloned Electron.app, built `out/`, package.json, node-pty. */
  async function portableBuild(): Promise<{ executablePath: string; main: string }> {
    const root = resolve(__dirname, '..')
    const build = join(tmp, 'build')
    await fs.mkdir(join(build, 'node_modules'), { recursive: true })
    execFileSync('/bin/cp', ['-c', '-R', join(root, 'node_modules/electron/dist/Electron.app'), join(build, 'Electron.app')])
    execFileSync('/bin/cp', ['-c', '-R', join(root, 'out'), join(build, 'out')])
    execFileSync('/bin/cp', ['-c', '-R', join(root, 'node_modules/node-pty'), join(build, 'node_modules/node-pty')])
    await fs.copyFile(join(root, 'package.json'), join(build, 'package.json'))
    return { executablePath: join(build, 'Electron.app/Contents/MacOS/Electron'), main: join(build, 'out/main/index.js') }
  }
  let portable: { executablePath: string; main: string }

  async function launch(): Promise<void> {
    app = await electron.launch({
      executablePath: portable.executablePath,
      args: [portable.main],
      env: { ...process.env, POMADE_WORKSPACE: fixture.workspaceRoot, POMADE_USER_DATA: fixture.userDataDir, NODE_ENV: 'test', ...env }
    })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  }

  const pomade = (...args: string[]): string =>
    execFileSync(POMADE_BIN, ['apps', ...args], { env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir }, encoding: 'utf8' })

  /** Update the app: change its manifest and reinstall, as an app's install script does. */
  async function update(patch: Record<string, unknown>): Promise<void> {
    const file = join(appDir, 'manifest.json')
    const m = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    await fs.writeFile(file, JSON.stringify({ ...m, ...patch }))
    pomade('install', appDir)
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    tmp = await tempDir('pomade-always-')
    pomadeHome = join(tmp, 'home')
    agentsDir = join(tmp, 'LaunchAgents')
    // A copy of the fixture the spec can update, with its own copy of what the backend imports
    // (pomade-kit and js-yaml): a launchd job must read nothing under ~/Documents — macOS privacy
    // protection blocks a process launchd started from reading there.
    appDir = join(tmp, 'app')
    await fs.cp(FIXTURE, appDir, { recursive: true })
    for (const pkg of ['pomade-kit', 'js-yaml', 'argparse']) {
      await fs.cp(resolve(__dirname, '../node_modules', pkg), join(appDir, 'node_modules', pkg), { recursive: true, dereference: true })
    }
    pomade('install', appDir)
    env = { POMADE_HOME: pomadeHome, POMADE_LAUNCH_AGENTS: agentsDir, POMADE_LAUNCHD_PREFIX: PREFIX }
    portable = await portableBuild()
    await launch()
  })

  test.afterAll(async () => {
    // The job first, then every process the portable build runs (this spec's Pomade, one the
    // backend launched, the backend): none of it waits on a quit, which can be slow under load.
    launchctl('bootout', `gui/${UID}/${LABEL}`)
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    if (tmp) spawnSync('/usr/bin/pkill', ['-KILL', '-f', `${basename(tmp)}/build/`])
    await app?.close().catch(() => undefined)
    await fixture?.cleanup()
    await fs.rm(tmp, { recursive: true, force: true })
    await expect.poll(() => launchctl('list').out.split('\n').filter((l) => l.includes(PREFIX))).toEqual([])
  })

  test('the login item is written and loaded: it starts at login and is restarted after a crash', async () => {
    const plist = join(agentsDir, `${LABEL}.plist`)
    await expect.poll(() => fs.stat(plist).then(() => true, () => false), { timeout: 15000 }).toBe(true)
    const text = await fs.readFile(plist, 'utf8')
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(text).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(text).toContain(`<string>${join(fixture.userDataDir, 'apps', APP_ID, 'backend/main.mjs')}</string>`)
    expect(execFileSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' })).toContain('OK')
    await expect.poll(() => launchctl('print', `gui/${UID}/${LABEL}`).ok, { timeout: 15000 }).toBe(true)
    await expect.poll(async () => (await report())?.connected, { timeout: 20000 }).toBe(true)
    await expect(page.getByTestId(`strip-app-${APP_ID}-main`)).toHaveAttribute('data-backend-state', 'running')
  })

  test('it keeps running after Pomade quits', async () => {
    const before = (await report())!
    await app!.close()
    app = null
    await expect.poll(async () => (await report())?.connected, { timeout: 10000 }).toBe(false)
    expect(alive(before.pid)).toBe(true)
    expect((await report())!.pid).toBe(before.pid)
  })

  test('it launches Pomade on request and reaches it', async () => {
    await fs.writeFile(join(pomadeHome, 'launch-request'), '')
    await expect.poll(async () => (await report())?.launched, { timeout: 60000 }).toMatchObject({ launched: true })
    const launched = (await report())!.launched as { pid: number | null }
    expect(typeof launched.pid).toBe('number')
    pids.add(launched.pid!)
    await expect.poll(async () => (await report())?.connected, { timeout: 20000 }).toBe(true)
    // The launched Pomade serves the socket: the platform reaches the backend's API through it.
    const platform = await clientAs(fixture.userDataDir, 'pomade', 'command')
    await expect(platform.apps.call(APP_ID, 'ping')).resolves.toEqual({ pong: (await report())!.pid })
    platform.close()
    process.kill(launched.pid!, 'SIGTERM')
    await expect.poll(() => alive(launched.pid!), { timeout: 15000 }).toBe(false)
  })

  test('an update leaves the running backend alone unless the app asks for a restart', async () => {
    await launch()
    const first = (await report())!
    await expect.poll(async () => (await report())?.connected, { timeout: 20000 }).toBe(true)
    await update({ version: '0.2.0' })
    await expect.poll(async () => (await fs.readFile(join(fixture.userDataDir, 'run', `always-on-${APP_ID}.stamp`), 'utf8')).startsWith('0.2.0'), { timeout: 15000 }).toBe(true)
    expect((await report())!.pid).toBe(first.pid)
    expect(alive(first.pid)).toBe(true)

    await update({ version: '0.3.0', backend: { entry: 'backend/main.mjs', mode: 'always-on', restartOnUpdate: true } })
    await expect.poll(async () => (await report())?.pid, { timeout: 30000 }).not.toBe(first.pid)
    await expect.poll(() => alive(first.pid), { timeout: 10000 }).toBe(false)
  })

  test('removing the app boots the job out and removes its plist', async () => {
    const last = (await report())!
    pomade('remove', APP_ID)
    await expect.poll(() => launchctl('print', `gui/${UID}/${LABEL}`).ok, { timeout: 15000 }).toBe(false)
    // The plist goes right after the bootout completes.
    await expect
      .poll(() => fs.stat(join(agentsDir, `${LABEL}.plist`)).then(() => 'present', (e: NodeJS.ErrnoException) => e.code), { timeout: 5000 })
      .toBe('ENOENT')
    await expect.poll(() => alive(last.pid), { timeout: 10000 }).toBe(false)
  })
})
