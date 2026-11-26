// modules: core, tabs
// T-240 e2e — a tab frame's `welcome.project` is the project the tab belongs to (docs/HOST-API.md
// §3 `welcome`): at first open, after a restart that restores tabs of several projects, and on a
// reload while another project is in front. A panel frame is welcomed with the active project
// (docs/PLATFORM.md rule 9).

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow, launchApp, relaunchApp } from './fixtures/app'
import {
  activeProjectOf,
  connectedFrame,
  HELLO_DIR,
  openHelloFromMenu,
  setActiveProject,
  tabsOf,
  welcomeProjectOf
} from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

test.describe('T-240 an app tab is welcomed with its own project', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  const env = { POMADE_DEV_APPS: HELLO_DIR }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, env)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const tabIn = async (projectId: string): Promise<string> => {
    const tab = (await tabsOf(page, projectId)).find((t) => t.kind === 'app')
    expect(tab, `an app tab in ${projectId}`).toBeDefined()
    return tab!.id
  }
  const frameOf = (tabId: string) => connectedFrame(page.getByTestId(`app-pane-${tabId}`).locator('iframe'))

  test('first open: each tab is welcomed with the project it was opened in', async () => {
    const { alpha, beta } = fixture.projects
    for (const id of [alpha, beta]) {
      await page.getByTestId(`project-${id}`).click()
      await expect.poll(() => activeProjectOf(page)).toBe(id)
      await openHelloFromMenu(page)
      expect(await welcomeProjectOf(await frameOf(await tabIn(id)))).toBe(id)
    }
    await page.getByTestId(`project-${alpha}`).click()
    await expect.poll(() => activeProjectOf(page)).toBe(alpha)
  })

  test('after a restart each restored tab is welcomed with its own project, not the active one', async () => {
    const { alpha, beta } = fixture.projects
    ;({ app, page } = await relaunchApp(app, fixture, env))
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => activeProjectOf(page)).toBe(alpha)
    // Both tabs are restored while Alpha is in front; Beta's frame is hidden.
    await expect.poll(() => tabsOf(page, beta).then((t) => t.length)).toBeGreaterThan(0)
    expect(await welcomeProjectOf(await frameOf(await tabIn(alpha)))).toBe(alpha)
    expect(await welcomeProjectOf(await frameOf(await tabIn(beta)))).toBe(beta)
    expect(await activeProjectOf(page)).toBe(alpha)
  })

  test('a reload welcomes the tab with its own project while another project is in front', async () => {
    const { alpha, beta } = fixture.projects
    const betaTab = await tabIn(beta)
    const before = await frameOf(betaTab)
    await before.evaluate(() => location.reload())
    const reloaded = await frameOf(betaTab)
    expect(await welcomeProjectOf(reloaded)).toBe(beta)
    expect(await activeProjectOf(page)).toBe(alpha)
  })

  test('a panel frame is welcomed with the active project', async () => {
    const { alpha, beta } = fixture.projects
    await page.getByTestId('strip-app-hello-panel').click()
    const panel = page.getByTestId('panel-frame-app-hello-panel')
    expect(await welcomeProjectOf(await connectedFrame(panel))).toBe(alpha)
    await setActiveProject(page, beta)
    await (await connectedFrame(panel)).evaluate(() => location.reload())
    expect(await welcomeProjectOf(await connectedFrame(panel))).toBe(beta)
  })
})
