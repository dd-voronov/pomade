// modules: core, tabs
// T-227 e2e — no project means the Workspace project (docs/PLATFORM.md rule 9, HOST-API §3 "Socket"): an app's
// backend or command is in no project, so what it does without naming one belongs to the Workspace project,
// never to the project in front. Its notice — over the socket while Pomade runs — reads
// "Runner · Workspace" on the toast and the Notices row, and a click switches to the Workspace project; its
// `tabs.openApp` / `tabs.openFile` without a `projectId` open in the Workspace project; with one, there. An app
// frame's notice keeps its project. Screenshots land in T227_SHOTS when set.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'
import type { HostClient } from 'pomade-kit/sdk'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeProjectOf, activeTabOf, callIn, connectedFrame, HELLO_DIR, tabsOf } from './fixtures/hello-app'
import { clientAs, waitForSocket } from './fixtures/socket-client'
import { tabsOf as storeTabsOf } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const SHOTS = process.env.T227_SHOTS
const WORKSPACE = '__workspace__'
const RUNNER = 't227-runner'

async function shotOf(el: Locator | Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await el.screenshot({ path: join(SHOTS, name) })
}

test.describe('T-227 no project means the Workspace project', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let otherDir: string
  let command: HostClient

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // "Runner": Hello's UI with `tabs.open` and a command, so the spec can connect as that command.
    otherDir = await tempDir('pomade-t227-')
    await fs.cp(HELLO_DIR, otherDir, { recursive: true })
    await fs.writeFile(join(otherDir, 'cli.mjs'), '')
    const manifest = JSON.parse(await fs.readFile(join(otherDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(otherDir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        id: RUNNER,
        name: 'Runner',
        strip: [],
        shortcuts: [],
        capabilities: ['tabs.open'],
        commands: [{ name: 't227-runner', entry: 'cli.mjs', title: 'Run' }]
      })
    )
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${HELLO_DIR};${otherDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await waitForSocket(fixture.userDataDir, RUNNER)
    command = await clientAs(fixture.userDataDir, RUNNER, 'command')
  })

  test.afterAll(async () => {
    command?.close()
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(otherDir, { recursive: true, force: true })
  })

  async function showProject(id: string): Promise<void> {
    await page.getByTestId(`project-${id}`).click()
    await expect.poll(() => activeProjectOf(page)).toBe(id)
  }

  async function clearToasts(): Promise<void> {
    const dismiss = page.getByTestId('notice-toast-dismiss')
    while ((await dismiss.count()) > 0) await dismiss.first().click()
  }

  /** Runner's tab at `route` in `projectId`, active there, with `projectId` in front. */
  async function expectRunnerTabAt(projectId: string, route: string, appId = RUNNER): Promise<void> {
    await expect.poll(() => activeProjectOf(page)).toBe(projectId)
    await expect
      .poll(async () => (await tabsOf(page, projectId)).filter((t) => t.appId === appId && t.route === route))
      .toHaveLength(1)
    const tab = (await tabsOf(page, projectId)).find((t) => t.appId === appId && t.route === route)!
    expect(await activeTabOf(page, projectId)).toBe(tab.id)
  }

  test("a command's notice reads Workspace and its click switches to the Workspace project", async () => {
    await showProject(fixture.projects.beta)
    await command.notices.post({ title: 'Nightly sync done', body: 'Three repos pushed.', action: { kind: 'openApp', route: 'roadmap/sync' } })
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'Nightly sync done' })
    await expect(toast.getByTestId('notice-toast-source')).toHaveText('Runner')
    await expect(toast.getByTestId('notice-toast-project')).toHaveText('Workspace')
    await shotOf(toast, 'toast-workspace.png')
    await showProject(fixture.projects.alpha)
    await toast.getByTestId('notice-toast-open').click()
    await expectRunnerTabAt(WORKSPACE, 'roadmap/sync')
    for (const p of [fixture.projects.alpha, fixture.projects.beta]) {
      expect((await tabsOf(page, p)).filter((t) => t.appId === RUNNER && t.route === 'roadmap/sync')).toHaveLength(0)
    }
  })

  test('its Notices panel row reads Workspace and switches there too', async () => {
    await showProject(fixture.projects.beta)
    await page.getByTestId('strip-notices').click()
    const row = page.getByTestId('notice-row').filter({ hasText: 'Nightly sync done' })
    await expect(row.getByTestId('notice-row-project')).toHaveText('Workspace')
    await shotOf(page.getByTestId('notices-panel'), 'panel-row-workspace.png')
    await row.click()
    await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
  })

  test("an app frame's notice keeps its project", async () => {
    await showProject(fixture.projects.beta)
    await page.getByTestId('strip-app-hello-panel').click()
    const panel: Frame = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
    await callIn(panel, 'notices.post', { title: 'From the panel' })
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'From the panel' })
    await expect(toast.getByTestId('notice-toast-project')).toHaveText('Beta')
    await clearToasts()
  })

  test('a command opens tabs without a project in the Workspace project; with one, there', async () => {
    await showProject(fixture.projects.beta)
    await command.tabs.openApp({ route: 'board/from-command' })
    await expectRunnerTabAt(WORKSPACE, 'board/from-command')
    expect((await tabsOf(page, fixture.projects.beta)).filter((t) => t.route === 'board/from-command')).toHaveLength(0)

    await showProject(fixture.projects.beta)
    await command.tabs.openFile({ path: 'Projects/alpha/README.md' })
    await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
    await expect
      .poll(async () => (await storeTabsOf(page, WORKSPACE)).filter((t) => t.kind === 'doc' && t.path === 'Projects/alpha/README.md'))
      .toHaveLength(1)
    expect((await storeTabsOf(page, fixture.projects.beta)).filter((t) => t.kind === 'doc' && t.path === 'Projects/alpha/README.md')).toHaveLength(0)

    // Naming a project still opens there.
    await command.tabs.openApp({ route: 'board/in-beta', projectId: fixture.projects.beta })
    await expectRunnerTabAt(fixture.projects.beta, 'board/in-beta')
  })
})
