// modules: core, tabs
// E-027 e2e — an app opens its own tab at a route (docs/HOST-API.md §4 `tabs.openApp`, event
// `route.changed`). The hello fixture declares strip icons `panel` (panel), `tab` (route "tab")
// and `both` (route "board"): a route an icon's tab renders opens that icon's tab; any other route
// is the app's one icon-less tab, navigated in place. `projectId` opens it in another project and
// brings the user there.

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import {
  activeProjectOf,
  activeTabOf,
  callIn,
  connectedFrame,
  eventsOf,
  HELLO_DIR,
  openHelloFromMenu,
  routeOf,
  tabsOf,
  welcomeOf
} from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

test.describe('E-027 tabs.openApp — the app opens its own tab at a route', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let panel: Frame

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    // The calls come from the app's side panel, as "Open in full tab" would.
    await page.getByTestId('strip-app-hello-panel').click()
    panel = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const appTabs = async (projectId: string) => (await tabsOf(page, projectId)).filter((t) => t.kind === 'app')

  test("a route an icon's tab renders opens that icon's tab", async () => {
    expect(await callIn(panel, 'tabs.openApp', { route: 'board' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => appTabs(fixture.projects.alpha)).toEqual([
      expect.objectContaining({ appId: 'hello', icon: 'both', title: 'Hello board' })
    ])
    const tabs = await appTabs(fixture.projects.alpha)
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(tabs[0].id)
    expect(tabs[0].route).toBeUndefined()
    const frame = await connectedFrame(page.getByTestId(`app-pane-${tabs[0].id}`).locator('iframe'))
    expect(await welcomeOf(frame)).toEqual({ surface: 'tab', icon: 'both', route: 'board' })
  })

  test('any other route opens the icon-less tab at that route', async () => {
    expect(await callIn(panel, 'tabs.openApp', { route: 'roadmap/T-001' })).toEqual({ ok: true, value: {} })
    await expect.poll(async () => (await appTabs(fixture.projects.alpha)).length).toBe(2)
    const tab = (await appTabs(fixture.projects.alpha)).find((t) => t.icon === undefined)!
    expect(tab).toMatchObject({ title: 'Hello', route: 'roadmap/T-001' })
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
    const frame = await connectedFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    expect(await welcomeOf(frame)).toEqual({ surface: 'tab', route: 'roadmap/T-001' })
    expect((await callIn(frame, 'host.info')).value).toMatchObject({ surface: 'tab', route: 'roadmap/T-001' })
  })

  test('a second route navigates the same tab in place: route.changed, host.info follows, a reload opens there', async () => {
    const tab = (await appTabs(fixture.projects.alpha)).find((t) => t.icon === undefined)!
    const frame = await connectedFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    // Away to the icon tab first, so the navigation also has to focus it again.
    expect((await callIn(panel, 'tabs.openApp', { route: 'board' })).ok).toBe(true)
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).not.toBe(tab.id)

    expect(await callIn(panel, 'tabs.openApp', { route: 'roadmap/T-002' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
    await expect.poll(() => routeOf(frame)).toBe('roadmap/T-002')
    expect(await eventsOf(frame, 'route.changed')).toEqual([{ route: 'roadmap/T-002' }])
    expect(await appTabs(fixture.projects.alpha)).toHaveLength(2)
    expect((await callIn(frame, 'host.info')).value).toMatchObject({ route: 'roadmap/T-002' })
    // The same route again changes nothing.
    expect((await callIn(panel, 'tabs.openApp', { route: 'roadmap/T-002' })).ok).toBe(true)
    expect(await eventsOf(frame, 'route.changed')).toHaveLength(1)

    await frame.evaluate(() => location.reload())
    const reloaded = await connectedFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    expect(await welcomeOf(reloaded)).toEqual({ surface: 'tab', route: 'roadmap/T-002' })
  })

  test('the new-tab menu focuses the icon-less tab and leaves its route', async () => {
    await page.getByTestId('tabstrip').getByText('Hello board').click()
    await openHelloFromMenu(page)
    const tab = (await appTabs(fixture.projects.alpha)).find((t) => t.icon === undefined)!
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
    expect(tab.route).toBe('roadmap/T-002')
  })

  test('projectId opens the tab in that project and brings the user there', async () => {
    expect(await callIn(panel, 'tabs.openApp', { projectId: fixture.projects.beta })).toEqual({ ok: true, value: {} })
    await expect.poll(() => activeProjectOf(page)).toBe(fixture.projects.beta)
    const tabs = await appTabs(fixture.projects.beta)
    expect(tabs).toEqual([expect.objectContaining({ appId: 'hello', title: 'Hello' })])
    expect(tabs[0].route).toBeUndefined()
    expect(await activeTabOf(page, fixture.projects.beta)).toBe(tabs[0].id)
    const frame = await connectedFrame(page.getByTestId(`app-pane-${tabs[0].id}`).locator('iframe'))
    expect(await welcomeOf(frame)).toEqual({ surface: 'tab', route: '' })
  })

  test('an unknown project is not-found and a malformed route invalid-params; nothing opens', async () => {
    const before = await appTabs(fixture.projects.beta)
    expect((await callIn(panel, 'tabs.openApp', { projectId: 'no-such-project' })).error?.code).toBe('not-found')
    expect((await callIn(panel, 'tabs.openApp', { route: 7 })).error?.code).toBe('invalid-params')
    expect(await appTabs(fixture.projects.beta)).toEqual(before)
    expect(await activeProjectOf(page)).toBe(fixture.projects.beta)
  })
})
