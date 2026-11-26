// modules: core
// E-028 e2e — with-Pomade app backends (docs/HOST-API.md §2 "Backends"): the test app's Node backend
// (e2e/fixtures/apps/backend/backend/main.mjs, built on pomade-kit's `stayConnected`) starts when it
// is linked and when Pomade starts, connects over the Host API socket (it records its pid in the app
// state), is restarted after a kill, stops when Pomade quits and when the app is unlinked, and a
// backend a crashed Pomade left behind is stopped on the next start. Status shows on the strip
// icon. Long-lived child processes → heavy project.

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const APP_DIR = resolve(__dirname, 'fixtures/apps/backend')
const APP_ID = 'e028-test'
const POMADE_BIN = resolve(__dirname, '../bin/pomade')

interface BackendRecord {
  pid: number
  connections: number
  surface: string
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.describe('E-028 with-Pomade backends', () => {
  let fixture: Fixture
  let app: ElectronApplication | null = null
  let page: Page
  const pids = new Set<number>()

  const pomade = (...args: string[]): string =>
    execFileSync(POMADE_BIN, ['apps', ...args], { env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir }, encoding: 'utf8' })

  async function backendRecord(): Promise<BackendRecord | null> {
    try {
      const state = JSON.parse(await fs.readFile(join(fixture.userDataDir, 'app-state', APP_ID, 'state.json'), 'utf8')) as {
        backend?: BackendRecord
      }
      if (state.backend) pids.add(state.backend.pid)
      return state.backend ?? null
    } catch {
      return null
    }
  }

  /** Wait for a backend other than `not` to record itself, alive. */
  async function runningBackend(not?: number): Promise<BackendRecord> {
    await expect
      .poll(async () => {
        const r = await backendRecord()
        return r !== null && r.pid !== not && alive(r.pid)
      }, { timeout: 20000 })
      .toBe(true)
    return (await backendRecord())!
  }

  async function launch(): Promise<void> {
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  }

  const stripIcon = (): ReturnType<Page['getByTestId']> => page.getByTestId(`strip-app-${APP_ID}-main`)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await fixture?.cleanup()
  })

  test('a linked app\'s backend starts while Pomade runs, connects as "backend", and shows running', async () => {
    await launch()
    const out = pomade('link', APP_DIR)
    expect(out).toContain('Backend:       backend/main.mjs — runs while Pomade runs, restarted if it crashes')
    expect(out).toContain('Outside the workspace: ~/.e028-test/')
    const b = await runningBackend()
    // Its machine-local state folder comes in its environment, created by Pomade.
    expect(b).toMatchObject({ connections: 1, surface: 'backend', appState: join(fixture.userDataDir, 'app-state', APP_ID) })
    expect((await fs.stat(join(fixture.userDataDir, 'app-state', APP_ID))).isDirectory()).toBe(true)
    await expect(stripIcon()).toHaveAttribute('data-backend-state', 'running')
    await expect(page.getByTestId(`strip-backend-down-app-${APP_ID}-main`)).toHaveCount(0)
    const log = join(fixture.userDataDir, 'app-logs', APP_ID, 'backend.log')
    await expect(fs.stat(log)).resolves.toBeTruthy()
  })

  test('a killed backend is restarted; the icon shows it down meanwhile', async () => {
    const before = (await backendRecord())!
    process.kill(before.pid, 'SIGKILL')
    await expect(stripIcon()).toHaveAttribute('data-backend-state', 'restarting')
    await expect(page.getByTestId(`strip-backend-down-app-${APP_ID}-main`)).toBeVisible()
    const after = await runningBackend(before.pid)
    expect(after.pid).not.toBe(before.pid)
    await expect(stripIcon()).toHaveAttribute('data-backend-state', 'running')
    await expect(page.getByTestId(`strip-backend-down-app-${APP_ID}-main`)).toHaveCount(0)
  })

  test('quitting Pomade stops the backend; the next start starts it again', async () => {
    const before = (await backendRecord())!
    await app!.close()
    app = null
    await expect.poll(() => alive(before.pid)).toBe(false)
    await launch()
    const after = await runningBackend(before.pid)
    expect(alive(after.pid)).toBe(true)
  })

  test('a backend a crashed Pomade left running is stopped on the next start', async () => {
    const orphan = (await backendRecord())!
    app!.process().kill('SIGKILL')
    app = null
    // The backend outlives the crash (reconnecting to nothing) …
    await new Promise((r) => setTimeout(r, 500))
    expect(alive(orphan.pid)).toBe(true)
    // … until the next Pomade starts.
    await launch()
    await expect.poll(() => alive(orphan.pid), { timeout: 10000 }).toBe(false)
    await runningBackend(orphan.pid)
  })

  test('unlinking the app stops its backend', async () => {
    const last = (await backendRecord())!
    pomade('unlink', APP_ID)
    await expect.poll(() => alive(last.pid), { timeout: 10000 }).toBe(false)
    await expect(stripIcon()).toHaveCount(0)
  })
})
