// modules: core
// T-211 e2e — the strip icon's background-status tooltip: a plain first line ("Background: running
// (with Pomade)", "starting", "stopped", "crashed — restarting", "(always on)") and the detail on a
// muted second line, never a launchd label; the tip fits its box. Every state is shown by giving
// the hello app a backend status in the renderer's apps store (what `apps:changed` delivers); the
// real producers are checked against the backend fixture app (running, then crashed — restarting).
// Screenshots go to POMADE_T211_SHOTS when set, else e2e/artifacts/app-backend-tooltip/ (gitignored).

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import type { AppBackendStatus } from '../src/shared/types'
import { firstAppWindow, launchApp } from './fixtures/app'
import { HELLO_DIR } from './fixtures/hello-app'
import { alive } from './fixtures/keeper'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_T211_SHOTS'] || resolve(__dirname, 'artifacts/app-backend-tooltip')
const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const BACKEND_APP = resolve(__dirname, 'fixtures/apps/backend')

/** The tip's lines as shown: text and whether each is muted. */
async function tipLines(tip: Locator): Promise<{ text: string; muted: boolean }[]> {
  return tip.locator('span').evaluateAll((spans) =>
    spans.map((s) => ({ text: s.textContent ?? '', muted: (s as HTMLElement).dataset.muted === 'true' }))
  )
}

/** Every line fits inside the tip's box (nothing spills past the border). */
async function fits(tip: Locator): Promise<boolean> {
  return tip.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return [...el.querySelectorAll('span')].every((s) => {
      const r = s.getBoundingClientRect()
      return r.left >= box.left && r.right <= box.right && s.scrollWidth <= s.clientWidth + 1
    })
  })
}

test.describe('T-211 background status tooltip, every state', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect(page.getByTestId('strip-app-hello-panel')).toBeVisible()
    await fs.mkdir(SHOTS, { recursive: true })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  async function showStatus(status: AppBackendStatus): Promise<Locator> {
    await page.evaluate((st) => {
      const store = window.__pomadeStores.useAppsStore
      store.setState({ apps: store.getState().apps.map((a) => (a.id === 'hello' ? { ...a, backend: st } : a)) })
    }, status)
    await page.mouse.move(600, 400)
    await page.getByTestId('strip-app-hello-panel').hover()
    const tip = page.getByTestId('strip-tip-app-hello-panel')
    await expect(tip).toBeVisible()
    return tip
  }

  const CASES: { name: string; status: AppBackendStatus; lines: { text: string; muted: boolean }[] }[] = [
    {
      name: 'running-with-pomade',
      status: { mode: 'with-pomade', state: 'running', detail: 'pid 4182', pid: 4182, connected: true },
      lines: [{ text: 'Background: running (with Pomade)', muted: false }, { text: 'pid 4182', muted: true }]
    },
    {
      name: 'starting',
      status: { mode: 'with-pomade', state: 'starting', detail: null, pid: null, connected: false },
      lines: [{ text: 'Background: starting (with Pomade)', muted: false }]
    },
    {
      name: 'crashed-restarting',
      status: { mode: 'with-pomade', state: 'restarting', detail: 'exited with code 1 · crash 2', pid: null, connected: false },
      lines: [
        { text: 'Background: crashed — restarting (with Pomade)', muted: false },
        { text: 'exited with code 1 · crash 2', muted: true }
      ]
    },
    {
      name: 'stopped-always-on',
      status: { mode: 'always-on', state: 'stopped', detail: 'always-on backends are off in this Pomade', pid: null, connected: false },
      lines: [
        { text: 'Background: stopped (always on)', muted: false },
        { text: 'always-on backends are off in this Pomade', muted: true }
      ]
    },
    {
      name: 'running-always-on',
      status: { mode: 'always-on', state: 'running', detail: 'connected to Pomade', pid: null, connected: true },
      lines: [{ text: 'Background: running (always on)', muted: false }, { text: 'connected to Pomade', muted: true }]
    }
  ]

  for (const c of CASES) {
    test(`${c.name}: a plain line, the detail muted, fits its box`, async () => {
      const tip = await showStatus(c.status)
      expect(await tipLines(tip)).toEqual([{ text: 'Hello panel', muted: false }, ...c.lines])
      expect(await fits(tip)).toBe(true)
      const box = (await tip.boundingBox())!
      await page.screenshot({ path: join(SHOTS, `${c.name}.png`), clip: { x: 0, y: Math.max(0, box.y - 60), width: box.x + box.width + 24, height: box.height + 100 } })
    })
  }
})

test.describe('T-211 background status tooltip from a real backend', () => {
  let fixture: Fixture
  let app: ElectronApplication | null = null
  let page: Page
  const pids = new Set<number>()

  async function backendPid(): Promise<number | null> {
    try {
      const state = JSON.parse(await fs.readFile(join(fixture.userDataDir, 'app-state', 'e028-test', 'state.json'), 'utf8')) as {
        backend?: { pid: number }
      }
      if (state.backend) pids.add(state.backend.pid)
      return state.backend?.pid ?? null
    } catch {
      return null
    }
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close().catch(() => undefined)
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    await fixture?.cleanup()
  })

  test('running shows the pid muted; a crash reads "crashed — restarting"', async () => {
    execFileSync(POMADE_BIN, ['apps', 'link', BACKEND_APP], { env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir }, encoding: 'utf8' })
    const icon = page.getByTestId('strip-app-e028-test-main')
    const tip = page.getByTestId('strip-tip-app-e028-test-main')
    await expect(icon).toHaveAttribute('data-backend-state', 'running', { timeout: 20000 })
    await expect.poll(async () => { const pid = await backendPid(); return pid !== null && alive(pid) }, { timeout: 20000 }).toBe(true)
    const pid = (await backendPid())!
    await icon.hover()
    await expect(tip).toBeVisible()
    await expect.poll(() => tipLines(tip)).toEqual(expect.arrayContaining([
      { text: 'Background: running (with Pomade)', muted: false },
      { text: `pid ${pid}`, muted: true }
    ]))
    await page.mouse.move(600, 400)

    process.kill(pid, 'SIGKILL')
    await expect(icon).toHaveAttribute('data-backend-state', 'restarting')
    await icon.hover()
    await expect.poll(() => tipLines(tip)).toEqual(expect.arrayContaining([
      { text: 'Background: crashed — restarting (with Pomade)', muted: false },
      { text: 'stopped by SIGKILL · crash 1', muted: true }
    ]))
    expect((await tipLines(tip)).some((l) => l.text.includes('io.github'))).toBe(false)
  })
})
