// modules: core, tabs, editor
// E-027 e2e — the app overlay (docs/HOST-API.md §1 `shortcuts`, action `overlay`; §4 `overlay`).
// The hello fixture's Cmd+Shift+J opens its quick-add form as a small frame (420×220) centred
// over whatever tab is active, even though the app was never opened; Esc, the scrim, or the
// app's `overlay.close` dismisses it and focus returns exactly where it was. Screenshots go to
// POMADE_E027_SHOTS when set, else e2e/artifacts/app-overlay/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { callIn, connectedFrame, HELLO_DIR, markOf, openHelloFromMenu, welcomeOf } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_E027_SHOTS'] || resolve(__dirname, 'artifacts/app-overlay')

test.describe('E-027 app overlay', () => {
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
  const visiblePane = () => page.locator('[data-testid^="pane-"][data-visible="true"]')

  async function openOverlay(): Promise<Frame> {
    await page.keyboard.press('Meta+Shift+J')
    await expect(overlay()).toBeVisible()
    const frame = await connectedFrame(page.getByTestId('overlay-frame-hello'))
    await expect.poll(() => frame.evaluate(() => document.activeElement?.id ?? '')).toBe('quick-add-text')
    return frame
  }

  /** Mark the focused element (in the window) so a later check can find exactly it. */
  function markFocus(): Promise<string> {
    return page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      el.dataset.focusMark = 'before'
      return `${el.tagName}.${el.className}`
    })
  }
  const focusIsMarked = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.focusMark === 'before')

  test('opens over an editor tab, centred, a 420×220 frame under its handle, focused — the app was never opened', async () => {
    await page.getByTestId('tree-node-Projects/alpha/README.md').click()
    const editor = visiblePane().locator('[contenteditable="true"]').first()
    await editor.click()
    await page.keyboard.press('End')
    await markFocus()
    await expect(page.locator('iframe[src^="pomade-app://hello/"]')).toHaveCount(0)

    const frame = await openOverlay()
    expect(await welcomeOf(frame)).toEqual({ surface: 'overlay', route: 'quick-add' })
    expect((await callIn(frame, 'host.info')).value).toMatchObject({ surface: 'overlay', route: 'quick-add' })

    const card = await page.getByTestId('app-overlay-card').boundingBox()
    const host = await page.getByTestId('panehost').boundingBox()
    expect(card && host).toBeTruthy()
    // A 420×220 frame under the 14px handle, inside the 1px border.
    expect(card!.width).toBe(422)
    expect(card!.height).toBe(236)
    expect(Math.abs(card!.x + card!.width / 2 - (host!.x + host!.width / 2))).toBeLessThanOrEqual(1)
    expect(Math.abs(card!.y + card!.height / 2 - (host!.y + host!.height / 2))).toBeLessThanOrEqual(1)
    const frameBox = await page.getByTestId('overlay-frame-hello').boundingBox()
    expect(frameBox).toEqual({ x: card!.x + 1, y: card!.y + 15, width: 420, height: 220 })

    await page.screenshot({ path: join(SHOTS, 'overlay-over-editor.png') })
    await page.screenshot({
      path: join(SHOTS, 'overlay-over-editor-detail.png'),
      clip: { x: card!.x - 24, y: card!.y - 24, width: card!.width + 48, height: card!.height + 48 }
    })
  })

  test('Esc in the overlay closes it; focus returns to the editor caret', async () => {
    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
    await expect.poll(focusIsMarked).toBe(true)
    await page.keyboard.type('Zq')
    // The caret was at the end of the first line when the overlay opened.
    await expect(visiblePane()).toContainText('AlphaZq')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await expect(visiblePane()).not.toContainText('Zq')
  })

  test("Enter saves through the app state and the app's overlay.close dismisses it; each open is a fresh frame", async () => {
    const first = await openOverlay()
    const firstMark = await markOf(first)
    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)

    const frame = await openOverlay()
    expect(await markOf(frame)).not.toBe(firstMark)
    await page.keyboard.type('Buy milk')
    await page.keyboard.press('Enter')
    await expect(overlay()).toHaveCount(0)
    await expect.poll(focusIsMarked).toBe(true)
    const state = JSON.parse(await fs.readFile(join(fixture.userDataDir, 'app-state/hello/state.json'), 'utf8')) as unknown
    expect(state).toEqual({ 'quick-add': 'Buy milk' })
  })

  test('a click on the scrim closes it; the same shortcut again only refocuses an open overlay', async () => {
    const frame = await openOverlay()
    const mark = await markOf(frame)
    await page.keyboard.press('Meta+Shift+J')
    await expect(page.getByTestId('overlay-frame-hello')).toHaveCount(1)
    expect(await markOf(await connectedFrame(page.getByTestId('overlay-frame-hello')))).toBe(mark)
    const host = (await page.getByTestId('panehost').boundingBox())!
    await page.mouse.click(host.x + 10, host.y + 10)
    await expect(overlay()).toHaveCount(0)
    await expect.poll(focusIsMarked).toBe(true)
  })

  test("over an app tab with focus inside its frame: the forwarded chord opens it, Esc returns focus into that frame", async () => {
    await openHelloFromMenu(page)
    const tabFrame = await connectedFrame(page.getByTestId('app-frame-hello'))
    await page.getByTestId('app-frame-hello').contentFrame().locator('h1').click()
    // Focus reaches the out-of-process frame asynchronously after the click.
    await expect.poll(() => tabFrame.evaluate(() => document.hasFocus())).toBe(true)

    await openOverlay()
    await expect.poll(() => tabFrame.evaluate(() => document.hasFocus())).toBe(false)
    const card = (await page.getByTestId('app-overlay-card').boundingBox())!
    await page.screenshot({ path: join(SHOTS, 'overlay-over-app-tab.png') })
    await page.screenshot({
      path: join(SHOTS, 'overlay-over-app-tab-detail.png'),
      clip: { x: card.x - 24, y: card.y - 24, width: card.width + 48, height: card.height + 48 }
    })

    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
    await expect.poll(() => tabFrame.evaluate(() => document.hasFocus())).toBe(true)
  })

  test('overlay.close from a tab frame is invalid-params', async () => {
    const tabFrame = await connectedFrame(page.getByTestId('app-frame-hello'))
    expect(await callIn(tabFrame, 'overlay.close')).toEqual({
      ok: false,
      error: { code: 'invalid-params', message: 'overlay.close is only for an overlay frame' }
    })
  })
})
