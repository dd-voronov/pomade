// modules: core, tabs
// T-208 e2e — a notice belongs to the project it was posted from (docs/HOST-API.md §4 `notices`):
// an action without a `projectId` opens in the posting frame's project — a tab frame's tab's
// project, else the project active when it posted; a backend's or a command's notice, the Workspace project
// (PLATFORM rule 9) — whichever project is in front at the click. From the toast, from the
// Notices panel row, from a hidden tab frame, and for a queued notice.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'
import { postNotice } from 'pomade-kit/node'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeProjectOf, activeTabOf, callIn, connectedFrame, HELLO_DIR, openHelloFromMenu, tabsOf } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const WORKSPACE = '__workspace__'

test.describe('T-208 a notice opens in the project it was posted from', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let otherDir: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    otherDir = await tempDir('pomade-hello-tabs-')
    await fs.cp(HELLO_DIR, otherDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(otherDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(otherDir, 'manifest.json'),
      JSON.stringify({ ...manifest, id: 'hello-tabs', name: 'Runner', strip: [], shortcuts: [], capabilities: ['tabs.open'] })
    )
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${HELLO_DIR};${otherDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(otherDir, { recursive: true, force: true })
  })

  async function showProject(id: string): Promise<void> {
    await page.getByTestId(`project-${id}`).click()
    await expect.poll(() => activeProjectOf(page)).toBe(id)
  }

  async function helloPanel(): Promise<Frame> {
    await page.getByTestId('strip-app-hello-panel').click()
    return connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  }

  /** Hello's tab at `route` in `projectId`, active there. */
  async function expectHelloTabAt(projectId: string, route: string): Promise<void> {
    await expect.poll(() => activeProjectOf(page)).toBe(projectId)
    await expect
      .poll(async () => (await tabsOf(page, projectId)).filter((t) => t.appId === 'hello' && t.route === route))
      .toHaveLength(1)
    const tab = (await tabsOf(page, projectId)).find((t) => t.appId === 'hello' && t.route === route)!
    expect(await activeTabOf(page, projectId)).toBe(tab.id)
  }

  test('the toast: posted in alpha, clicked in beta — Hello opens in alpha', async () => {
    await showProject(fixture.projects.alpha)
    const panel = await helloPanel()
    await callIn(panel, 'notices.post', { title: 'Roadmap ready', action: { kind: 'openApp', route: 'roadmap/toast' } })
    await showProject(fixture.projects.beta)
    await page.getByTestId('notice-toast').getByTestId('notice-toast-open').click()
    await expectHelloTabAt(fixture.projects.alpha, 'roadmap/toast')
    expect((await tabsOf(page, fixture.projects.beta)).filter((t) => t.appId === 'hello')).toHaveLength(0)
  })

  test('the Notices panel row: posted in alpha, clicked in beta — Hello opens in alpha', async () => {
    const panel = await helloPanel()
    await callIn(panel, 'notices.post', { title: 'Roadmap changed', action: { kind: 'openApp', route: 'roadmap/row' } })
    await page.getByTestId('notice-toast').getByTestId('notice-toast-dismiss').click()
    await showProject(fixture.projects.beta)
    await page.getByTestId('strip-notices').click()
    const row = page.getByTestId('notice-row').filter({ hasText: 'Roadmap changed' })
    await expect(row).toHaveCount(1)
    await row.click()
    await expectHelloTabAt(fixture.projects.alpha, 'roadmap/row')
  })

  test('a tab frame posts from its own project, even while another project is in front', async () => {
    await showProject(fixture.projects.beta)
    await openHelloFromMenu(page, 'hello-tabs')
    const runner = await connectedFrame(page.getByTestId('app-frame-hello-tabs'))
    await showProject(fixture.projects.alpha)
    // The Runner tab lives in beta; alpha is in front when it posts.
    await callIn(runner, 'notices.post', { title: 'Report written', action: { kind: 'openFile', path: 'Projects/beta/README.md' } })
    await page.getByTestId('notice-toast').getByTestId('notice-toast-open').click()
    await expect.poll(() => activeProjectOf(page)).toBe(fixture.projects.beta)
    await expect
      .poll(async () => (await tabsOf(page, fixture.projects.beta)).filter((t) => t.kind === 'doc' && t.title === 'README.md'))
      .toHaveLength(1)
    expect((await tabsOf(page, fixture.projects.alpha)).filter((t) => t.kind === 'doc' && t.title === 'README.md')).toHaveLength(0)
  })

  test('a queued notice belongs to the Workspace project, whichever project is in front when it shows', async () => {
    await showProject(fixture.projects.alpha)
    await postNotice({ title: 'Nightly run finished', action: { kind: 'openApp', route: 'roadmap/queued' } }, { source: 'hello', userData: fixture.userDataDir })
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'Nightly run finished' })
    await expect(toast).toHaveCount(1)
    await showProject(fixture.projects.beta)
    await toast.getByTestId('notice-toast-open').click()
    await expectHelloTabAt(WORKSPACE, 'roadmap/queued')
    expect((await tabsOf(page, fixture.projects.alpha)).filter((t) => t.appId === 'hello' && t.route === 'roadmap/queued')).toHaveLength(0)
  })
})
