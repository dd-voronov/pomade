// modules: core, tabs
// T-236 e2e — an app opens its own overlay from a frame (docs/HOST-API.md §4 `overlay`, §5
// "Overlay"). The hello fixture's "Quick add…" button calls `overlay.open({ route: "quick-add" })`
// from its side panel: the overlay frame is welcomed on `surface: "overlay"` at that route, the
// same card a shortcut opens; Esc closes it and focus returns to the very button. A hidden tab
// frame's call and an overlay frame's call are refused. Screenshots go to POMADE_T236_SHOTS when
// set, else e2e/artifacts/app-overlay-open/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { afterFiveFrames, callIn, connectedFrame, HELLO_DIR, markOf, openHelloFromMenu, welcomeOf } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_T236_SHOTS'] || resolve(__dirname, 'artifacts/app-overlay-open')

test.describe('T-236 overlay.open', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
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

  async function openPanel(): Promise<Frame> {
    await page.getByTestId('strip-app-hello-panel').click()
    const frame = await connectedFrame(panelIframe())
    await afterFiveFrames(page)
    return frame
  }

  /** The id of the element focused inside `frame`, and whether its document has focus. */
  const focusIn = (frame: Frame) => frame.evaluate(() => `${document.activeElement?.id ?? ''}|${document.hasFocus()}`)

  test("the panel's Quick add… opens the overlay at its route; Esc returns focus to that button", async () => {
    const panel = await openPanel()
    await panelIframe().contentFrame().locator('#open-overlay').click()

    await expect(overlay()).toBeVisible()
    const frame = await connectedFrame(page.getByTestId('overlay-frame-hello'))
    expect(await welcomeOf(frame)).toEqual({ surface: 'overlay', route: 'quick-add' })
    expect((await callIn(frame, 'host.info')).value).toMatchObject({ surface: 'overlay', route: 'quick-add' })
    expect(await panel.evaluate(() => window.__hello.lastOverlayOpen)).toEqual({
      channel: 'pomade',
      type: 'result',
      id: expect.any(String),
      ok: true,
      value: {}
    })
    // The overlay has the keyboard; the panel's document lost it.
    await expect.poll(() => frame.evaluate(() => document.activeElement?.id ?? '')).toBe('quick-add-text')
    await expect.poll(() => panel.evaluate(() => document.hasFocus())).toBe(false)
    // The same card a shortcut opens: a 420×220 frame under a 14px handle, in a 1px border, named after the app.
    const card = (await page.getByTestId('app-overlay-card').boundingBox())!
    expect(card.width).toBe(422)
    expect(card.height).toBe(236)
    await expect(page.getByTestId('app-overlay-card')).toHaveAttribute('aria-label', 'Hello')
    await page.screenshot({ path: join(SHOTS, 'overlay-from-panel.png') })

    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
    await expect.poll(() => focusIn(panel)).toBe('open-overlay|true')
  })

  test('each call is a fresh overlay frame; overlay.close and the scrim close it too', async () => {
    const panel = await connectedFrame(panelIframe())
    expect(await callIn(panel, 'overlay.open', { route: 'quick-add' })).toMatchObject({ ok: true, value: {} })
    const first = await connectedFrame(page.getByTestId('overlay-frame-hello'))
    const firstMark = await markOf(first)
    // A second call while it is open replaces it with a new frame at the new route.
    expect(await callIn(panel, 'overlay.open', { route: 'other' })).toMatchObject({ ok: true })
    await expect.poll(async () => welcomeOf(await connectedFrame(page.getByTestId('overlay-frame-hello')))).toEqual({
      surface: 'overlay',
      route: 'other'
    })
    const second = await connectedFrame(page.getByTestId('overlay-frame-hello'))
    expect(await markOf(second)).not.toBe(firstMark)
    // The frame goes away right after its answer: fire the call without waiting on it.
    await second.evaluate(() => void window.__hello.call('overlay.close'))
    await expect(overlay()).toHaveCount(0)

    // Default route "" when none is given; a click on the scrim closes it.
    expect(await callIn(panel, 'overlay.open')).toMatchObject({ ok: true })
    expect(await welcomeOf(await connectedFrame(page.getByTestId('overlay-frame-hello')))).toEqual({ surface: 'overlay', route: '' })
    const host = (await page.getByTestId('panehost').boundingBox())!
    await page.mouse.click(host.x + 10, host.y + 10)
    await expect(overlay()).toHaveCount(0)
  })

  test('refused: from an overlay frame, from a hidden tab frame, a non-string route', async () => {
    const panel = await connectedFrame(panelIframe())
    expect(await callIn(panel, 'overlay.open', { route: 'quick-add' })).toMatchObject({ ok: true })
    const frame = await connectedFrame(page.getByTestId('overlay-frame-hello'))
    expect(await callIn(frame, 'overlay.open', { route: 'x' })).toEqual({
      ok: false,
      error: { code: 'invalid-params', message: 'overlay.open is for a tab or a panel frame; an overlay is already open' }
    })
    expect(await welcomeOf(await connectedFrame(page.getByTestId('overlay-frame-hello')))).toEqual({
      surface: 'overlay',
      route: 'quick-add'
    })
    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)

    expect((await callIn(panel, 'overlay.open', { route: 7 })).error?.code).toBe('invalid-params')

    // A tab frame in the background: its tab is not the active one.
    await openHelloFromMenu(page)
    const tab = await connectedFrame(page.getByTestId('app-frame-hello'))
    expect(await callIn(tab, 'overlay.open', { route: 'from-tab' })).toMatchObject({ ok: true })
    expect(await welcomeOf(await connectedFrame(page.getByTestId('overlay-frame-hello')))).toEqual({
      surface: 'overlay',
      route: 'from-tab'
    })
    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
    // The Files panel replaces Hello's panel in the column; a file tab replaces Hello's tab.
    await page.getByTestId('strip-files').click()
    await expect(panelIframe()).toBeHidden()
    await page.getByTestId('tree-node-Projects/alpha/README.md').click()
    await expect(page.getByTestId('app-frame-hello')).toBeHidden()
    const refused = { ok: false, error: { code: 'invalid-params', message: 'overlay.open needs a visible frame: an active tab or the shown panel' } }
    expect(await callIn(tab, 'overlay.open', { route: 'from-tab' })).toEqual(refused)
    expect(await callIn(panel, 'overlay.open', { route: 'quick-add' })).toEqual(refused)
    await expect(overlay()).toHaveCount(0)

    // Hello's panel shown, then the column collapsed: hidden again, refused again.
    await page.getByTestId('strip-app-hello-panel').click()
    await expect(panelIframe()).toBeVisible()
    await page.getByTestId('side-panel-collapse').click()
    await expect(panelIframe()).toBeHidden()
    expect(await callIn(panel, 'overlay.open', { route: 'quick-add' })).toEqual(refused)
    await expect(overlay()).toHaveCount(0)
  })
})
