// modules: core, tabs
// T-268 e2e — keyed app tabs (docs/HOST-API.md §4 "Own tab"): `tabs.openApp` with `key` opens one
// tab per (app, key, project), titled by the app or by its app tab kind (manifest `tabKinds`), with
// the kind's icon; opened again it is focused and navigated in place. A tab frame knows its key and
// kind (`welcome`), retitles its own tab (`tabs.setTitle`, unless the user renamed it) and closes it
// (`tabs.close`). Keyed tabs come back after a restart at their routes and titles. The hello fixture
// declares `tabKinds.output` ("Output", output.svg).
// Screenshots go to POMADE_T268_SHOTS when set, else e2e/artifacts/app-keyed-tabs/ (gitignored).

import { resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp, relaunchApp } from './fixtures/app'
import {
  activeTabOf,
  callIn,
  connectedFrame,
  eventsOf,
  HELLO_DIR,
  routeOf,
  tabsOf
} from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

interface KeyedTab {
  id: string
  appId?: string
  key?: string
  tabKind?: string
  route?: string
  title: string
  renamed?: boolean
  appTitled?: boolean
}

const SHOTS = process.env['POMADE_T268_SHOTS'] || resolve(__dirname, 'artifacts/app-keyed-tabs')

test.describe('T-268 keyed app tabs', () => {
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

  const keyedTabs = (projectId = fixture.projects.alpha): Promise<KeyedTab[]> =>
    page.evaluate((pid) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      return s
        .tabsFor(pid)
        .filter((t) => t.kind === 'app' && t.key !== undefined)
        .map((t) => ({
          id: t.id,
          appId: t.appId,
          key: t.key,
          tabKind: t.tabKind,
          route: t.route,
          title: t.title,
          renamed: t.renamed,
          appTitled: t.appTitled
        }))
    }, projectId)
  const tabByKey = async (key: string): Promise<KeyedTab> => {
    const tab = (await keyedTabs()).find((t) => t.key === key)
    expect(tab, `keyed tab ${key}`).toBeDefined()
    return tab!
  }
  const frameOf = (tabId: string) => connectedFrame(page.getByTestId(`app-pane-${tabId}`).locator('iframe'))
  const welcomeOf = (frame: Frame) =>
    frame.evaluate(() => {
      const w = window.__hello.welcome!
      return { surface: w.surface, icon: w.icon, route: w.route, key: w.key, kind: w.kind }
    })
  const tabIcon = (tabId: string) => page.getByTestId(`tab-${tabId}`).locator('[data-app-icon]')

  test('two keys → two tabs with the kind\'s icon and their titles, right of the active tab', async () => {
    expect(
      await callIn(panel, 'tabs.openApp', { key: 'a', kind: 'output', title: 'Scraper · output', route: 'output/a' })
    ).toEqual({ ok: true, value: {} })
    expect(await callIn(panel, 'tabs.openApp', { key: 'b', kind: 'output', route: 'output/b' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => keyedTabs()).toEqual([
      expect.objectContaining({ appId: 'hello', key: 'a', tabKind: 'output', route: 'output/a', title: 'Scraper · output' }),
      expect.objectContaining({ appId: 'hello', key: 'b', tabKind: 'output', route: 'output/b', title: 'Output' })
    ])
    const [a, b] = await keyedTabs()
    // b opened right of a (the active tab then) and is focused.
    const order = (await tabsOf(page, fixture.projects.alpha)).map((t) => t.id)
    expect(order.indexOf(b.id)).toBe(order.indexOf(a.id) + 1)
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(b.id)
    for (const t of [a, b]) await expect(tabIcon(t.id)).toHaveAttribute('data-icon-url', 'pomade-app://hello/output.svg')
    await expect(page.getByTestId(`tab-title-${a.id}`)).toHaveText('Scraper · output')
    await expect(page.getByTestId(`tab-title-${b.id}`)).toHaveText('Output')
    await page.getByTestId('tabstrip').screenshot({ path: `${SHOTS}/T-268-keyed-tabs-strip.png` })
  })

  test("a keyed tab's welcome carries its key and kind; other frames carry neither", async () => {
    const a = await tabByKey('a')
    await page.getByTestId(`tab-${a.id}`).click()
    const frame = await frameOf(a.id)
    expect(await welcomeOf(frame)).toEqual({ surface: 'tab', icon: undefined, route: 'output/a', key: 'a', kind: 'output' })
    expect((await callIn(frame, 'host.info')).value).toMatchObject({ surface: 'tab', route: 'output/a', key: 'a', kind: 'output' })
    const panelWelcome = await welcomeOf(panel)
    expect([panelWelcome.key, panelWelcome.kind]).toEqual([undefined, undefined])
    await page.screenshot({ path: `${SHOTS}/T-268-keyed-tab-a.png` })
  })

  test('the same key again with another route: focused, route.changed, no third tab', async () => {
    const a = await tabByKey('a')
    const b = await tabByKey('b')
    const frame = await frameOf(a.id)
    await page.getByTestId(`tab-${b.id}`).click()
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(b.id)
    expect(await callIn(panel, 'tabs.openApp', { key: 'a', route: 'output/a2' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(a.id)
    await expect.poll(() => routeOf(frame)).toBe('output/a2')
    expect(await eventsOf(frame, 'route.changed')).toEqual([{ route: 'output/a2' }])
    expect(await keyedTabs()).toHaveLength(2)
    // No title given: the app's title stays.
    expect((await tabByKey('a')).title).toBe('Scraper · output')
    expect((await callIn(frame, 'host.info')).value).toMatchObject({ route: 'output/a2' })
  })

  test('setTitle from tab b retitles it; once the user renames it, setTitle leaves it', async () => {
    const b = await tabByKey('b')
    await page.getByTestId(`tab-${b.id}`).click()
    const frame = await frameOf(b.id)
    expect(await callIn(frame, 'tabs.setTitle', { title: ' Deploy · output ' })).toEqual({ ok: true, value: {} })
    await expect(page.getByTestId(`tab-title-${b.id}`)).toHaveText('Deploy · output')

    await page.getByTestId(`tab-title-${b.id}`).dblclick()
    const input = page.getByTestId(`tab-rename-input-${b.id}`)
    await input.fill('My deploy')
    await input.press('Enter')
    await expect(page.getByTestId(`tab-title-${b.id}`)).toHaveText('My deploy')
    expect(await callIn(frame, 'tabs.setTitle', { title: 'Deploy · done' })).toEqual({ ok: true, value: {} })
    expect(await callIn(panel, 'tabs.openApp', { key: 'b', route: 'output/b', title: 'Deploy · again' })).toEqual({ ok: true, value: {} })
    await expect(page.getByTestId(`tab-title-${b.id}`)).toHaveText('My deploy')
    expect(await tabByKey('b')).toMatchObject({ title: 'My deploy', renamed: true })
  })

  test('bad calls are invalid-params and open nothing: kind without key, a bad key, an unknown kind, setTitle/close from a panel', async () => {
    const before = await tabsOf(page, fixture.projects.alpha)
    for (const params of [{ kind: 'output' }, { title: 'A' }, { key: 'a/b' }, { key: 'c', kind: 'log' }, { key: 'c', title: ' ' }]) {
      expect((await callIn(panel, 'tabs.openApp', params)).error?.code, JSON.stringify(params)).toBe('invalid-params')
    }
    expect((await callIn(panel, 'tabs.setTitle', { title: 'A' })).error?.code).toBe('invalid-params')
    expect((await callIn(panel, 'tabs.close')).error?.code).toBe('invalid-params')
    expect(await tabsOf(page, fixture.projects.alpha)).toEqual(before)
  })

  test('a restart brings both keyed tabs back at their routes, titles and icons', async () => {
    ;({ app, page } = await relaunchApp(app, fixture, env))
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => keyedTabs()).toEqual([
      expect.objectContaining({ key: 'a', tabKind: 'output', route: 'output/a2', title: 'Scraper · output' }),
      expect.objectContaining({ key: 'b', tabKind: 'output', route: 'output/b', title: 'My deploy', renamed: true })
    ])
    const a = await tabByKey('a')
    await page.getByTestId(`tab-${a.id}`).click()
    expect(await welcomeOf(await frameOf(a.id))).toEqual({ surface: 'tab', icon: undefined, route: 'output/a2', key: 'a', kind: 'output' })
    await expect(tabIcon(a.id)).toHaveAttribute('data-icon-url', 'pomade-app://hello/output.svg')
    await expect(page.getByTestId(`tab-title-${a.id}`)).toHaveText('Scraper · output')
    // The restored tab is still the keyed tab for its key.
    await openPanel()
    expect((await callIn(panel, 'tabs.openApp', { key: 'b', route: 'output/b' })).ok).toBe(true)
    await expect.poll(() => keyedTabs()).toHaveLength(2)
  })

  test('tabs.close() from tab b closes it, as the user\'s close does', async () => {
    const b = await tabByKey('b')
    await page.getByTestId(`tab-${b.id}`).click()
    const frame = await frameOf(b.id)
    expect(await callIn(frame, 'tabs.close')).toEqual({ ok: true, value: {} })
    await expect.poll(async () => (await keyedTabs()).map((t) => t.key)).toEqual(['a'])
    await expect(page.getByTestId(`tab-${b.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`app-pane-${b.id}`)).toHaveCount(0)
  })
})
