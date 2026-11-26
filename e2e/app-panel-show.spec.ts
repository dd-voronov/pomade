// modules: core
// T-325 e2e — an app shows its own side panel (docs/HOST-API.md §4 `panel`). From the hello
// fixture's overlay, with the side panel on Files, `panel.show({ route })` brings Hello's panel
// forward at that route — a frame the call mounts is welcomed there, a mounted one gets
// `route.changed` — and the overlay keeps the keyboard. A collapsed side panel expands; from the
// tab frame focus stays in the tab; a hidden panel frame may call it. Refusals (an icon without a
// panel, an unknown icon, an app without a panel icon, bad types) leave the side panel as it was.
// Screenshots go to POMADE_T325_SHOTS when set, else e2e/artifacts/app-panel-show/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import type { CallResult } from './fixtures/globals'
import { firstAppWindow, launchApp } from './fixtures/app'
import {
  afterFiveFrames,
  callIn,
  connectedFrame,
  eventsOf,
  HELLO_DIR,
  markOf,
  openHelloFromMenu,
  routeOf,
  tabsOf,
  welcomeOf
} from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_T325_SHOTS'] || resolve(__dirname, 'artifacts/app-panel-show')
const AGENTS_DIR = resolve(__dirname, 'fixtures/apps/agents')

test.describe('T-325 panel.show', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let tab: Frame

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${HELLO_DIR};${AGENTS_DIR}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await fs.mkdir(SHOTS, { recursive: true })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const overlay = () => page.getByTestId('app-overlay')
  const panelIframe = () => page.getByTestId('panel-frame-app-hello-panel')
  const boardIframe = () => page.getByTestId('panel-frame-app-hello-both')

  /** The id of the element focused inside `frame`, and whether its document has focus. */
  const focusIn = (frame: Frame) => frame.evaluate(() => `${document.activeElement?.id ?? ''}|${document.hasFocus()}`)
  /** The id of the element focused inside `frame` (an overlay frame Playwright never gave input to has no
   *  focus emulation, so its `document.hasFocus()` says nothing; Pomade's own focused element does). */
  const focusedId = (frame: Frame) => frame.evaluate(() => document.activeElement?.id ?? '')
  /** The test id of the element focused in Pomade's own document (an app frame's `<iframe>`). */
  const pomadeFocus = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')
  const collapsed = () => page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().layout.fileTreeCollapsed)

  /** Bring Files forward without moving keyboard focus (a synthetic click, as from a script). */
  async function showFiles(): Promise<void> {
    await page.getByTestId('strip-files').dispatchEvent('click')
    await expect(page.getByTestId('strip-files')).toHaveAttribute('aria-pressed', 'true')
  }

  test('from the overlay, with Files shown: the panel comes forward at the route and the overlay keeps the keyboard', async () => {
    await expect(page.getByTestId('strip-files')).toHaveAttribute('aria-pressed', 'true')
    await expect(panelIframe()).toHaveCount(0)
    await openHelloFromMenu(page)
    tab = await connectedFrame(page.getByTestId('app-frame-hello'))
    expect(await callIn(tab, 'overlay.open', { route: 'quick-add' })).toMatchObject({ ok: true })
    const quick = await connectedFrame(page.getByTestId('overlay-frame-hello'))
    await expect.poll(() => focusedId(quick)).toBe('quick-add-text')
    await expect.poll(pomadeFocus).toBe('overlay-frame-hello')

    expect(await callIn(quick, 'panel.show', { route: 'note/7' })).toEqual({ ok: true, value: {} })
    await expect(panelIframe()).toBeVisible()
    await expect(page.getByTestId('strip-app-hello-panel')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('side-panel-files')).toBeHidden()
    // The frame this call mounted is welcomed at the route.
    const panel = await connectedFrame(panelIframe())
    expect(await welcomeOf(panel)).toEqual({ surface: 'panel', icon: 'panel', route: 'note/7' })
    expect((await callIn(panel, 'host.info')).value).toMatchObject({ surface: 'panel', icon: 'panel', route: 'note/7' })
    // The overlay is still open and still has the keyboard.
    await expect(overlay()).toBeVisible()
    expect(await focusedId(quick)).toBe('quick-add-text')
    expect(await pomadeFocus()).toBe('overlay-frame-hello')
    await page.screenshot({ path: join(SHOTS, 'panel-from-overlay.png') })

    // Files again; a new route reaches the mounted frame as route.changed — the same frame, not a new one.
    const mark = await markOf(panel)
    await showFiles()
    await expect(panelIframe()).toBeHidden()
    expect(await callIn(quick, 'panel.show', { route: 'note/8' })).toEqual({ ok: true, value: {} })
    await expect(panelIframe()).toBeVisible()
    await expect.poll(() => routeOf(panel)).toBe('note/8')
    expect(await markOf(panel)).toBe(mark)
    expect(await eventsOf(panel, 'route.changed')).toEqual([{ route: 'note/8' }])
    expect((await callIn(panel, 'host.info')).value).toMatchObject({ route: 'note/8' })
    expect(await focusedId(quick)).toBe('quick-add-text')
    expect(await pomadeFocus()).toBe('overlay-frame-hello')

    // Already shown at that route: nothing changes. No route: the panel stays where it is.
    expect(await callIn(quick, 'panel.show', { route: 'note/8' })).toEqual({ ok: true, value: {} })
    expect(await callIn(quick, 'panel.show')).toEqual({ ok: true, value: {} })
    expect(await eventsOf(panel, 'route.changed')).toEqual([{ route: 'note/8' }])
    expect(await routeOf(panel)).toBe('note/8')
    await expect(overlay()).toBeVisible()
    expect(await focusedId(quick)).toBe('quick-add-text')
    expect(await pomadeFocus()).toBe('overlay-frame-hello')

    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
  })

  test('a collapsed side panel expands; from the tab frame, focus stays in the tab', async () => {
    await showFiles()
    await page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().setFileTreeCollapsed(true))
    await expect(page.getByTestId('side-panel')).toBeHidden()
    await afterFiveFrames(page)
    await page.getByTestId('app-frame-hello').contentFrame().locator('#copy').click()
    await expect.poll(() => focusIn(tab)).toBe('copy|true')
    const tabsBefore = await tabsOf(page, fixture.projects.alpha)

    // `both`: its panel, never its tab; no route → the icon's panel route.
    expect(await callIn(tab, 'panel.show', { icon: 'both' })).toEqual({ ok: true, value: {} })
    await expect(page.getByTestId('side-panel')).toBeVisible()
    expect(await collapsed()).toBe(false)
    await expect(boardIframe()).toBeVisible()
    await expect(page.getByTestId('strip-app-hello-both')).toHaveAttribute('aria-pressed', 'true')
    expect(await welcomeOf(await connectedFrame(boardIframe()))).toEqual({ surface: 'panel', icon: 'both', route: 'needs-you' })
    expect(await tabsOf(page, fixture.projects.alpha)).toEqual(tabsBefore)
    expect(await focusIn(tab)).toBe('copy|true')
    expect(await pomadeFocus()).toBe('app-frame-hello')
    await page.screenshot({ path: join(SHOTS, 'panel-from-tab-expanded.png') })
  })

  test('a hidden panel frame may call it; no icon is the first panel icon, at the route it was left at', async () => {
    const panel = await connectedFrame(panelIframe())
    await expect(panelIframe()).toBeHidden()
    expect(await callIn(panel, 'panel.show')).toEqual({ ok: true, value: {} })
    await expect(panelIframe()).toBeVisible()
    await expect(boardIframe()).toBeHidden()
    expect(await routeOf(panel)).toBe('note/8')
    expect(await focusIn(tab)).toBe('copy|true')
  })

  test('refused: an icon without a panel, an unknown icon, an app without a panel icon, bad types — the side panel stays as it was', async () => {
    await showFiles()
    await page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().setFileTreeCollapsed(true))
    await expect(page.getByTestId('side-panel')).toBeHidden()

    expect(await callIn(tab, 'panel.show', { icon: 'tab' })).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'No strip icon "tab" with a panel (action "panel" or "both") in the manifest' }
    })
    expect((await callIn(tab, 'panel.show', { icon: 'nope', route: 'x' })).error?.code).toBe('not-found')
    expect((await callIn(tab, 'panel.show', { icon: 1 })).error?.code).toBe('invalid-params')
    expect((await callIn(tab, 'panel.show', { route: 7 })).error?.code).toBe('invalid-params')

    // The agents fixture declares no strip icons.
    await openHelloFromMenu(page, 'pomade-agents')
    const iframe = page.getByTestId('app-frame-pomade-agents')
    await expect
      .poll(async () => (await (await iframe.elementHandle())?.contentFrame())?.evaluate(() => window.__agents?.status).catch(() => ''))
      .toBe('connected')
    const agents = (await (await iframe.elementHandle())!.contentFrame())!
    const refused: CallResult = await agents.evaluate(() => window.__agents.call('panel.show', { route: 'x' }))
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'not-found', message: 'The app has no strip icon with a panel (action "panel" or "both")' }
    })

    await expect(page.getByTestId('side-panel')).toBeHidden()
    expect(await collapsed()).toBe(true)
    await expect(page.getByTestId('strip-files')).toHaveAttribute('aria-pressed', 'true')
    expect(await routeOf(await connectedFrame(panelIframe()))).toBe('note/8')
  })
})
