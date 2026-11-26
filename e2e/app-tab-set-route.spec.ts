// modules: core, tabs
// T-269 e2e — `tabs.setRoute` (docs/HOST-API.md §4 "Own tab"): an app tab tells Pomade the route it
// navigated to by itself. Pomade records it for that tab with no `route.changed` back; a later
// notice click / `tabs.openApp` / app shortcut to another route — the one Pomade last sent included —
// navigates the tab again; `host.info` and a restart use the recorded route. An icon's tab clicked
// from its strip icon is only focused. From a panel the call is `invalid-params`.
// Screenshots go to POMADE_T269_SHOTS when set, else e2e/artifacts/app-tab-set-route/ (gitignored).

import { resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp, relaunchApp } from './fixtures/app'
import {
  activeTabOf,
  callIn,
  connectedFrame,
  eventsOf,
  HELLO_DIR,
  openHelloFromMenu,
  tabsOf,
  welcomeOf,
  type TabInfo
} from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_T269_SHOTS'] || resolve(__dirname, 'artifacts/app-tab-set-route')

test.describe('T-269 tabs.setRoute', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let panel: Frame
  const env = { POMADE_DEV_APPS: HELLO_DIR }

  const openPanel = async (): Promise<void> => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.getByTestId('strip-app-hello-panel').click()
    panel = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, env)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await openPanel()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const helloTabs = async (): Promise<TabInfo[]> =>
    (await tabsOf(page, fixture.projects.alpha)).filter((t) => t.appId === 'hello' && t.kind === 'app')
  const iconLessTab = async (): Promise<TabInfo> => {
    const tab = (await helloTabs()).find((t) => t.icon === undefined)
    expect(tab, 'the icon-less hello tab').toBeDefined()
    return tab!
  }
  const iconTab = async (icon: string): Promise<TabInfo> => {
    const tab = (await helloTabs()).find((t) => t.icon === icon)
    expect(tab, `the hello ${icon} tab`).toBeDefined()
    return tab!
  }
  const frameOf = (tabId: string) => connectedFrame(page.getByTestId(`app-pane-${tabId}`).locator('iframe'))
  const routeChanges = async (frame: Frame): Promise<string[]> =>
    ((await eventsOf(frame, 'route.changed')) as { route: string }[]).map((e) => e.route)
  const infoRoute = async (frame: Frame): Promise<unknown> => ((await callIn(frame, 'host.info')).value as { route: string }).route

  test('a notice navigates the tab; setRoute records "" with no route.changed; the same notice navigates it again', async () => {
    await openHelloFromMenu(page)
    const tab = await iconLessTab()
    const frame = await frameOf(tab.id)
    expect((await welcomeOf(frame))?.route).toBe('')

    expect(await callIn(panel, 'notices.post', { title: 'Card 1 failed', action: { kind: 'openApp', route: 'card/1' } })).toEqual({
      ok: true,
      value: {}
    })
    const toast = page.getByTestId('notice-toast')
    await toast.getByTestId('notice-toast-open').click()
    await expect(toast).toHaveCount(0)
    await expect.poll(() => routeChanges(frame)).toEqual(['card/1'])
    expect((await iconLessTab()).route).toBe('card/1')

    // The app closes the card by itself and tells Pomade.
    expect(await callIn(frame, 'tabs.setRoute', { route: '' })).toEqual({ ok: true, value: {} })
    await expect.poll(async () => (await iconLessTab()).route).toBe('')
    expect(await infoRoute(frame)).toBe('')
    expect(await routeChanges(frame)).toEqual(['card/1'])

    // The same notice again, from the Notices panel: the tab moves back to the card.
    await page.getByTestId('strip-notices').click()
    await page.getByTestId('notice-row').first().click()
    await expect.poll(() => routeChanges(frame)).toEqual(['card/1', 'card/1'])
    expect((await iconLessTab()).route).toBe('card/1')
    expect(await infoRoute(frame)).toBe('card/1')
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
    expect(await helloTabs()).toHaveLength(1)
    await page.screenshot({ path: `${SHOTS}/T-269-notice-again.png` })
  })

  test('tabs.openApp to the route Pomade last sent navigates after setRoute too', async () => {
    const tab = await iconLessTab()
    const frame = await frameOf(tab.id)
    expect(await callIn(frame, 'tabs.setRoute', { route: 'card/1/log' })).toEqual({ ok: true, value: {} })
    expect(await callIn(panel, 'tabs.openApp', { route: 'card/1' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => routeChanges(frame)).toEqual(['card/1', 'card/1', 'card/1'])
    // Unchanged route: nothing to send.
    expect(await callIn(panel, 'tabs.openApp', { route: 'card/1' })).toEqual({ ok: true, value: {} })
    expect(await callIn(frame, 'tabs.setRoute', { route: 'card/1' })).toEqual({ ok: true, value: {} })
    expect(await routeChanges(frame)).toEqual(['card/1', 'card/1', 'card/1'])
  })

  test("an icon's tab: its strip icon only focuses it where the app is; the app shortcut navigates it back", async () => {
    expect(await callIn(panel, 'tabs.openApp', { route: 'board' })).toEqual({ ok: true, value: {} })
    const board = await iconTab('both')
    const frame = await frameOf(board.id)
    expect((await welcomeOf(frame))?.route).toBe('board')
    expect(await callIn(frame, 'tabs.setRoute', { route: 'board/card/3' })).toEqual({ ok: true, value: {} })
    await expect.poll(async () => (await iconTab('both')).route).toBe('board/card/3')
    expect(await infoRoute(frame)).toBe('board/card/3')

    // Away, then back from the strip icon: a plain focus.
    await page.getByTestId(`tab-${(await iconLessTab()).id}`).click()
    await page.getByTestId('strip-app-hello-both').click()
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(board.id)
    expect((await iconTab('both')).route).toBe('board/card/3')
    expect(await routeChanges(frame)).toEqual([])
    await page.screenshot({ path: `${SHOTS}/T-269-icon-tab-focused.png` })

    // The app shortcut to the icon's route navigates the tab back to it.
    await page.getByTestId(`tab-${board.id}`).click()
    await page.keyboard.press('Meta+Shift+Y')
    await expect.poll(() => routeChanges(frame)).toEqual(['board'])
    expect((await iconTab('both')).route).toBe('board')
    expect(await infoRoute(frame)).toBe('board')
    expect((await helloTabs()).filter((t) => t.icon === 'both')).toHaveLength(1)
  })

  test('from a panel, or with a route that is not a string: invalid-params, nothing recorded', async () => {
    const before = await helloTabs()
    expect((await callIn(panel, 'tabs.setRoute', { route: 'x' })).error?.code).toBe('invalid-params')
    const frame = await frameOf((await iconLessTab()).id)
    for (const params of [{}, { route: 1 }]) {
      expect((await callIn(frame, 'tabs.setRoute', params)).error?.code, JSON.stringify(params)).toBe('invalid-params')
    }
    expect(await helloTabs()).toEqual(before)
  })

  test('a restart reopens both tabs at the routes the app recorded', async () => {
    const tab = await iconLessTab()
    expect(await callIn(await frameOf(tab.id), 'tabs.setRoute', { route: 'card/2' })).toEqual({ ok: true, value: {} })
    const board = await iconTab('both')
    expect(await callIn(await frameOf(board.id), 'tabs.setRoute', { route: 'board/card/9' })).toEqual({ ok: true, value: {} })
    await expect.poll(async () => (await iconTab('both')).route).toBe('board/card/9')

    ;({ app, page } = await relaunchApp(app, fixture, env))
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(async () => (await iconLessTab()).route).toBe('card/2')
    await page.getByTestId(`tab-${tab.id}`).click()
    const frame = await frameOf(tab.id)
    expect((await welcomeOf(frame))?.route).toBe('card/2')
    expect(await infoRoute(frame)).toBe('card/2')

    await page.getByTestId(`tab-${board.id}`).click()
    const boardFrame = await frameOf(board.id)
    expect(await welcomeOf(boardFrame)).toMatchObject({ icon: 'both', route: 'board/card/9' })
    await page.screenshot({ path: `${SHOTS}/T-269-after-restart.png` })
  })
})
