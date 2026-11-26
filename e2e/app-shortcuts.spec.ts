// modules: core, tabs, editor
// E-027 e2e — keys and app shortcuts (docs/HOST-API.md §1 `shortcuts`, §3 "Keys"). The hello
// fixture declares Cmd+Shift+Y (tab "board" = its `both` icon's tab), Cmd+Alt+P (tab
// "roadmap/T-001") and Cmd+W (Pomade's Close Tab — a conflict, so it does nothing). An app
// shortcut works from any tab: an editor, Pomade's chrome, and inside an app frame (a forwarded
// key); Pomade's own shortcuts keep working from inside a panel frame too.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeTabOf, connectedFrame, HELLO_DIR, routeOf, tabsOf, welcomeOf } from './fixtures/hello-app'
import { toggleSidePanelKeys } from './fixtures/keys'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

test.describe('E-027 app shortcuts and key forwarding', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const appTabs = async () => (await tabsOf(page, fixture.projects.alpha)).filter((t) => t.kind === 'app')
  const collapsed = () =>
    page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().layout.fileTreeCollapsed)

  test("a chord Pomade uses is not the app's: listed as a conflict, the others are live", async () => {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hello = window.__pomadeStores.useAppsStore.getState().apps.find((a) => a.id === 'hello')
          return hello ? { keys: hello.shortcuts.map((s) => s.key), conflicts: hello.shortcutConflicts } : null
        })
      )
      .toEqual({ keys: ['Cmd+Shift+Y', 'Cmd+Alt+P', 'Cmd+Shift+J'], conflicts: ['Cmd+W ("Close") is Pomade\'s Close Tab'] })
  })

  test('from an editor: the shortcut opens the app tab and the keystroke never reaches the document', async () => {
    await page.getByTestId('tree-node-Projects/alpha/README.md').click()
    const editor = page.locator('[data-testid^="pane-"][data-visible="true"] [contenteditable="true"]').first()
    await editor.click()
    await page.keyboard.press('Meta+Shift+Y')
    await expect.poll(appTabs).toEqual([expect.objectContaining({ appId: 'hello', icon: 'both' })])
    const [tab] = await appTabs()
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
    const frame = await connectedFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    expect(await welcomeOf(frame)).toEqual({ surface: 'tab', icon: 'both', route: 'board' })
    await page.getByTestId('tabstrip').getByText('README.md').click()
    await expect(page.locator('[data-testid^="pane-"][data-visible="true"]')).toContainText('Alpha project.')
    await expect(page.locator('[data-testid^="pane-"][data-visible="true"]')).not.toContainText('Y')
  })

  test('from inside an app frame: the forwarded chord reaches the app shortcut', async () => {
    const board = (await appTabs()).find((t) => t.icon === 'both')!
    await page.getByTestId('tabstrip').getByText('Hello board').click()
    const frameEl = page.getByTestId(`app-pane-${board.id}`).locator('iframe')
    await frameEl.contentFrame().locator('h1').click()
    await connectedFrame(frameEl)
    // The page's focused element is the frame, so the next key goes into it. (The frame's own
    // document.hasFocus() also needs OS focus on this window, which parallel test windows take.)
    await expect
      .poll(() => page.evaluate((id) => document.activeElement?.closest(`[data-testid="app-pane-${id}"]`) !== null && document.activeElement?.tagName === 'IFRAME', board.id))
      .toBe(true)
    await page.keyboard.press('Meta+Alt+P')
    await expect.poll(async () => (await appTabs()).length).toBe(2)
    const roadmap = (await appTabs()).find((t) => t.icon === undefined)!
    expect(roadmap.route).toBe('roadmap/T-001')
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(roadmap.id)
    const frame = await connectedFrame(page.getByTestId(`app-pane-${roadmap.id}`).locator('iframe'))
    expect(await routeOf(frame)).toBe('roadmap/T-001')
  })

  test('the conflicting chord does nothing for the app', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    const before = await appTabs()
    await page.keyboard.press('Meta+W')
    // Native menu accelerators are not synthesized by Playwright; what must hold is that the app's
    // shortcut did not run: no tab opened or changed.
    expect(await appTabs()).toEqual(before)
  })

  test("a Pomade shortcut works while an app's panel frame has focus", async () => {
    await page.getByTestId('strip-app-hello-panel').click()
    const frameEl = page.getByTestId('panel-frame-app-hello-panel')
    await connectedFrame(frameEl)
    await frameEl.contentFrame().locator('h1').click()
    const before = await collapsed()
    await toggleSidePanelKeys(app)
    await expect.poll(collapsed).toBe(!before)
    await page.getByTestId('filetree-expand').click()
    await expect.poll(collapsed).toBe(before)
  })
})
