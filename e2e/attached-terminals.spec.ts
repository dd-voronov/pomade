// modules: terminal, tabs, core
// E-034 e2e — attached terminals (docs/modules/terminal/attached-terminals.md): a Pomade tab on a
// session an app's keeper holds. The keeper is pomade-kit's library, started by the spec on
// Pomade's Electron binary in Node mode for the app `attach-demo` ("Demo Runner"), bound at the
// fixed per-app socket under the test's user data. Another app (`attach-viewer`) opens the tabs by
// reference over the Host API socket — the owner is never asked. Everything the keeper starts is
// killed in teardown. Long-lived processes and real PTYs → heavy project.
//
// Screenshots land in e2e/artifacts/attached-terminals/.

import { promises as fs, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { HostClient } from 'pomade-kit/sdk'
import type { KeeperClient } from 'pomade-kit/node'
import type { SessionInfo } from 'pomade-kit/protocol'

import { firstAppWindow, launchApp } from './fixtures/app'
import { alive, startTestKeeper, type TestKeeper } from './fixtures/keeper'
import { clientAs, waitForSocket } from './fixtures/socket-client'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import type { AttachedTab } from '../src/shared/types'
import { tempDir } from './fixtures/temp'

const HELLO_DIR = resolve(__dirname, 'fixtures/apps/hello')
const PROBE = resolve(__dirname, 'fixtures/keeper/query-probe.cjs')
const ARTIFACTS = resolve(__dirname, 'artifacts/attached-terminals')
const OWNER = 'attach-demo'
const VIEWER = 'attach-viewer'
// A service: a numbered tick a second; a typed line is echoed back at once.
const TICKER = 'i=0; while :; do i=$((i+1)); echo "tick $i"; if read -t 1 line; then echo "got: $line"; fi; done'

/** A hello copy with an idle with-Pomade backend (a backend may use the Host API socket), which
 *  records the keeper socket Pomade gives it. */
async function appCopy(root: string, id: string, name: string, patch: Record<string, unknown>): Promise<string> {
  const dir = join(root, id)
  await fs.cp(HELLO_DIR, dir, { recursive: true })
  const m = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  delete m.shortcuts
  const backend = { entry: 'backend/main.mjs', mode: 'with-pomade' }
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...m, id, name, backend, ...patch }))
  await fs.mkdir(join(dir, 'backend'), { recursive: true })
  await fs.writeFile(
    join(dir, 'backend/main.mjs'),
    "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('../keeper-socket.txt', import.meta.url), process.env.POMADE_KEEPER_SOCKET ?? '')\nsetInterval(() => {}, 60000)\n"
  )
  return dir
}

function attachedTabs(page: Page, projectId: string): Promise<AttachedTab[]> {
  return page.evaluate(
    (pid) =>
      (window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []).filter(
        (t): t is AttachedTab => t.kind === 'attached'
      ),
    projectId
  )
}

function buffer(page: Page, tabId: string): Promise<string> {
  return page.evaluate(
    (id) => window.__pomadeAttachedBuffer?.[id]?.() ?? '',
    tabId
  )
}

/** The highest tick number on screen. */
async function lastTick(page: Page, tabId: string): Promise<number> {
  const ticks = [...(await buffer(page, tabId)).matchAll(/tick (\d+)/g)].map((m) => Number(m[1]))
  return ticks.length ? Math.max(...ticks) : 0
}

async function sessionOf(owner: KeeperClient, id: string): Promise<SessionInfo | undefined> {
  return (await owner.list()).find((s) => s.id === id)
}

/** The attached tab for `session` in the project, once it is there. */
async function tabFor(page: Page, projectId: string, session: string): Promise<AttachedTab> {
  await expect.poll(async () => (await attachedTabs(page, projectId)).some((t) => t.session.session === session)).toBe(true)
  return (await attachedTabs(page, projectId)).find((t) => t.session.session === session) as AttachedTab
}

test.describe('E-034 attached terminals', () => {
  let fixture: Fixture
  let app: ElectronApplication | null = null
  let page: Page
  let appsRoot: string
  let keeper: TestKeeper
  let owner: KeeperClient
  let viewer: HostClient
  let alpha: string

  async function launch(): Promise<void> {
    app = await launchApp(fixture, { POMADE_DEV_APPS: [join(appsRoot, OWNER), join(appsRoot, VIEWER)].join(';') })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await waitForSocket(fixture.userDataDir, VIEWER)
    viewer = await clientAs(fixture.userDataDir, VIEWER, 'backend')
    await page.getByTestId(`project-${alpha}`).click()
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    appsRoot = await tempDir('pomade-attach-')
    await appCopy(appsRoot, OWNER, 'Demo Runner', { capabilities: [], events: { subscribe: ['attachedTab.action'] } })
    await appCopy(appsRoot, VIEWER, 'Viewer', { capabilities: ['tabs.open'], events: { subscribe: ['attachedTab.action'] } })
    keeper = await startTestKeeper(fixture.userDataDir, OWNER)
    owner = await keeper.owner()
    await owner.spawn({
      id: 'svc',
      title: 'Ticker',
      command: TICKER,
      cwd: fixture.workspaceRoot,
      actions: [{ id: 'restart', title: 'Restart' }]
    })
    await fs.mkdir(ARTIFACTS, { recursive: true })
    await launch()
  })

  test.afterAll(async () => {
    await app?.close()
    keeper?.stop()
    await fixture?.cleanup()
    if (appsRoot) await fs.rm(appsRoot, { recursive: true, force: true })
  })

  test('acceptance: the session outlives Pomade; the reopened tab shows earlier and live output, takes input, and closing it leaves the session running', async () => {
    await viewer.tabs.openAttached({ session: { app: OWNER, session: 'svc' }, projectId: alpha })
    await expect.poll(async () => (await attachedTabs(page, alpha)).length).toBe(1)
    const [tab] = await attachedTabs(page, alpha)
    const id = tab.id
    // The owner's title and name: in the tab and in the header.
    await expect(page.getByTestId(`tab-title-${id}`)).toHaveText('Ticker · Demo Runner')
    await expect(page.getByTestId(`attached-title-${id}`)).toHaveText('Ticker')
    await expect(page.getByTestId(`attached-owner-${id}`)).toHaveText('· Demo Runner')
    await expect(page.getByTestId(`attached-status-${id}`)).toHaveText('Running')
    await expect.poll(() => lastTick(page, id)).toBeGreaterThan(0)
    // Pomade told the owner's backend where its keeper binds — where Pomade attached.
    await expect.poll(() => fs.readFile(join(appsRoot, OWNER, 'keeper-socket.txt'), 'utf8').catch(() => '')).toBe(keeper.socketPath)

    // Typing reaches the session.
    await page.getByTestId(`attached-xterm-${id}`).click()
    await page.keyboard.type('hello-before-quit')
    await page.keyboard.press('Enter')
    await expect.poll(() => buffer(page, id)).toContain('got: hello-before-quit')
    await page.screenshot({ path: join(ARTIFACTS, 'running.png') })

    // Pomade quits; the session keeps running.
    const pid = (await sessionOf(owner, 'svc'))?.pid
    await app?.close()
    app = null
    viewer.close()
    await new Promise((r) => setTimeout(r, 1500))
    expect(alive(pid)).toBe(true)
    expect(await sessionOf(owner, 'svc')).toMatchObject({ state: 'running', clients: 0 })

    // Reopen Pomade: the tab is restored, attached, with the output from before the quit and live output.
    await launch()
    await expect.poll(async () => (await attachedTabs(page, alpha)).map((t) => t.id)).toEqual([id])
    await page.getByTestId(`tab-${id}`).click()
    await expect(page.getByTestId(`attached-status-${id}`)).toHaveText('Running')
    await expect.poll(() => buffer(page, id)).toContain('got: hello-before-quit')
    const first = await lastTick(page, id)
    await expect.poll(() => lastTick(page, id)).toBeGreaterThan(first)
    await page.getByTestId(`attached-xterm-${id}`).click()
    await page.keyboard.type('hello-after-restart')
    await page.keyboard.press('Enter')
    await expect.poll(() => buffer(page, id)).toContain('got: hello-after-restart')

    // Closing the tab detaches; the session runs on.
    await page.getByTestId(`close-${id}`).click()
    await expect.poll(async () => (await attachedTabs(page, alpha)).length).toBe(0)
    await expect.poll(async () => (await sessionOf(owner, 'svc'))?.clients).toBe(0)
    expect(await sessionOf(owner, 'svc')).toMatchObject({ state: 'running', pid })
  })

  test('the keeper answers the program’s terminal queries; the tab never forwards its own answers', async () => {
    const log = join(appsRoot, 'probe.log')
    await fs.writeFile(log, '')
    await owner.spawn({ id: 'probe', title: 'Probe', argv: [process.execPath, PROBE], cwd: fixture.workspaceRoot, env: { PROBE_LOG: log } })
    await viewer.tabs.openAttached({ session: { app: OWNER, session: 'probe' }, projectId: alpha })
    const tab = await tabFor(page, alpha, 'probe')
    await expect.poll(() => buffer(page, tab.id)).toContain('probe ready')
    await page.getByTestId(`attached-xterm-${tab.id}`).click()
    await page.keyboard.type('q')
    // The view has drawn the questions (they come in the same write); anything it forwarded would
    // reach the program before the next keystroke.
    await expect.poll(() => buffer(page, tab.id)).toContain('asking')
    await page.keyboard.type('x')
    // The program logs each read; under load the keeper's answers and the key share one read.
    const readsJoined = (): string =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string)
        .join('')
    await expect.poll(readsJoined).toMatch(/x$/)
    const received = readsJoined()
    expect(received.match(/\x1b\[\d+;\d+R/g) ?? []).toHaveLength(1)
    expect(received.match(/\x1b\[\?[\d;]*c/g) ?? []).toHaveLength(1)
    await page.getByTestId(`close-${tab.id}`).click()
  })

  test('owner features: the Restart action reaches the owner only; Stop and Ctrl+C end it as stopped by you', async () => {
    const ownerHost = await clientAs(fixture.userDataDir, OWNER, 'backend')
    const heardByOwner: unknown[] = []
    const heardByViewer: unknown[] = []
    await ownerHost.events.subscribe('attachedTab.action', (p) => heardByOwner.push(p))
    await viewer.events.subscribe('attachedTab.action', (p) => heardByViewer.push(p))
    await owner.spawn({ id: 'web', title: 'Coda web', command: TICKER, cwd: fixture.workspaceRoot, actions: [{ id: 'restart', title: 'Restart' }] })
    // Opened by another app, by reference, with the caller's own title.
    await viewer.tabs.openAttached({ session: { app: OWNER, session: 'web' }, title: 'Web server', projectId: alpha })
    const tab = await tabFor(page, alpha, 'web')
    expect(tab.title).toBe('Web server')
    await expect(page.getByTestId(`tab-title-${tab.id}`)).toHaveText('Web server · Demo Runner')
    await expect(page.getByTestId('attached-action-restart')).toBeVisible()

    await page.getByTestId('attached-action-restart').click()
    await expect.poll(() => heardByOwner).toEqual([{ session: { app: OWNER, session: 'web' }, action: 'restart', projectId: alpha }])
    expect(heardByViewer).toEqual([])
    // The owner restarts it (same id): the tab follows the new session.
    const before = (await sessionOf(owner, 'web'))?.startedAt
    await owner.stop('web')
    await expect.poll(async () => (await sessionOf(owner, 'web'))?.state).toBe('exited')
    await owner.spawn({ id: 'web', title: 'Coda web', command: TICKER, cwd: fixture.workspaceRoot, actions: [{ id: 'restart', title: 'Restart' }] })
    await expect(page.getByTestId(`attached-status-${tab.id}`)).toHaveText('Running')
    expect((await sessionOf(owner, 'web'))?.startedAt).toBeGreaterThan(before ?? 0)
    await expect.poll(() => lastTick(page, tab.id)).toBeGreaterThan(0)

    // Stop in the header → stopped by you.
    await page.getByTestId('attached-stop').click()
    await expect(page.getByTestId(`attached-status-${tab.id}`)).toHaveText('Stopped by you')
    await expect(page.getByTestId('attached-stop')).toHaveCount(0)
    await page.screenshot({ path: join(ARTIFACTS, 'stopped-by-you.png') })
    expect((await sessionOf(owner, 'web'))?.exit).toMatchObject({ reason: 'stopped-by-you' })

    // Ctrl+C typed through the tab, then the exit → stopped by you.
    await owner.spawn({ id: 'web', title: 'Coda web', command: 'sleep 600', cwd: fixture.workspaceRoot })
    await expect(page.getByTestId(`attached-status-${tab.id}`)).toHaveText('Running')
    await page.getByTestId(`attached-xterm-${tab.id}`).click()
    await page.keyboard.press('Control+C')
    await expect(page.getByTestId(`attached-status-${tab.id}`)).toHaveText('Stopped by you')
    expect((await sessionOf(owner, 'web'))?.exit).toMatchObject({ reason: 'stopped-by-you', code: 130 })
    ownerHost.close()
    await page.getByTestId(`close-${tab.id}`).click()
  })

  test('a session that is not there, a keeper that is not running: a clear state, attached once it appears', async () => {
    await viewer.tabs.openAttached({ session: { app: OWNER, session: 'later' }, projectId: alpha })
    const later = await tabFor(page, alpha, 'later')
    await expect(page.getByTestId(`attached-status-${later.id}`)).toHaveText('Session not found')
    await expect(page.getByTestId(`attached-notice-${later.id}`)).toBeVisible()
    await page.screenshot({ path: join(ARTIFACTS, 'session-not-found.png') })
    await owner.spawn({ id: 'later', title: 'Later', command: TICKER, cwd: fixture.workspaceRoot })
    await expect(page.getByTestId(`attached-status-${later.id}`)).toHaveText('Running', { timeout: 15000 })
    await expect(page.getByTestId(`attached-notice-${later.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-title-${later.id}`)).toHaveText('Later · Demo Runner')

    await viewer.tabs.openAttached({ session: { app: 'nobody-home', session: 'x' }, projectId: alpha })
    const nobody = await tabFor(page, alpha, 'x')
    await expect(page.getByTestId(`attached-status-${nobody.id}`)).toHaveText('Keeper not running')
    await expect(page.getByTestId(`tab-title-${nobody.id}`)).toHaveText('x · nobody-home')
    await page.screenshot({ path: join(ARTIFACTS, 'keeper-not-running.png') })
    // Invalid references are refused by the Host API.
    await expect(viewer.tabs.openAttached({ session: { app: 'Bad', session: 'x' } })).rejects.toMatchObject({ code: 'invalid-params' })
    for (const t of [later, nobody]) await page.getByTestId(`close-${t.id}`).click()
  })

  test('a keeper update hands the session to a new keeper; the tab reconnects and output goes on', async () => {
    await viewer.tabs.openAttached({ session: { app: OWNER, session: 'svc' }, projectId: alpha })
    const tab = await tabFor(page, alpha, 'svc')
    await expect(page.getByTestId(`attached-status-${tab.id}`)).toHaveText('Running')
    const pid = (await sessionOf(owner, 'svc'))?.pid
    const keeperPid = owner.keeper.pid
    await owner.upgrade(resolve(__dirname, 'fixtures/keeper/keeper.mjs'), ['v2'])
    let next: KeeperClient | null = null
    await expect
      .poll(async () => {
        try {
          next = await keeper.owner()
          return next.keeper.pid !== keeperPid
        } catch {
          return false
        }
      })
      .toBe(true)
    owner = next as unknown as KeeperClient
    expect(owner.keeper.version).toBe('v2')
    expect((await sessionOf(owner, 'svc'))?.pid).toBe(pid)
    await expect(page.getByTestId(`attached-status-${tab.id}`)).toHaveText('Running')
    const at = await lastTick(page, tab.id)
    await expect.poll(() => lastTick(page, tab.id)).toBeGreaterThan(at)
    await page.getByTestId(`attached-xterm-${tab.id}`).click()
    await page.keyboard.type('after-update')
    await page.keyboard.press('Enter')
    await expect.poll(() => buffer(page, tab.id)).toContain('got: after-update')
  })
})
