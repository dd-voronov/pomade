// modules: core, tabs
// T-238, T-326 e2e — the overlay's geometry and focus (docs/HOST-API.md §4 `overlay`, §5 "Overlay").
// The hello fixture's panel and tab call `overlay.open` (with a height and an anchor), its overlay
// frame calls `overlay.resize`: the app sizes the frame (clamped by Pomade), the user drags the card
// by its handle anywhere in the window below the title bar — over the Projects panel, the strip, the
// side panel — kept whole inside it; where it is left is where the app's next overlay that names no
// place opens (the shortcut, `overlay.open` without an anchor), also after a restart, clamped into a
// smaller window. `anchor: "panel"` opens it beside the side panel whatever place is remembered, and
// closing returns focus to the frame that called `overlay.open`. Screenshots go to POMADE_T238_SHOTS
// when set, else e2e/artifacts/app-overlay-geometry/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp, relaunchApp } from './fixtures/app'
import { callIn, connectedFrame, HELLO_DIR, openHelloFromMenu } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_T238_SHOTS'] || resolve(__dirname, 'artifacts/app-overlay-geometry')

// The card's chrome: a 1px border on each side and the 14px handle above the frame.
const CHROME_W = 2
const CHROME_H = 16
const MARGIN = 16

/** The window's content size: a window that fits any screen, so a drag never leaves it. */
async function setWindowSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height)
  }, { width, height })
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

test.describe('T-238 overlay moves, sizes, anchors', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await setWindowSize(app, 1280, 760)
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await fs.mkdir(SHOTS, { recursive: true })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const overlay = () => page.getByTestId('app-overlay')
  const card = () => page.getByTestId('app-overlay-card')
  const overlayIframe = () => page.getByTestId('overlay-frame-hello')
  const panelIframe = () => page.getByTestId('panel-frame-app-hello-panel')
  const uiFile = () => join(fixture.workspaceRoot, '.pomade', 'state', 'workspace-ui.json')

  async function box(l: Locator): Promise<Box> {
    const b = await l.boundingBox()
    if (!b) throw new Error('no bounding box')
    return b
  }
  /** The card's position inside the pane area, and its size. */
  async function placed(): Promise<{ left: number; top: number; width: number; height: number }> {
    const [c, host] = [await box(card()), await box(page.getByTestId('panehost'))]
    return { left: c.x - host.x, top: c.y - host.y, width: c.width, height: c.height }
  }
  /** The pane area's inner size: what the anchors place against. */
  const paneSize = () => page.getByTestId('panehost').evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }))
  /** The card's position and size in the window. */
  async function at(): Promise<{ left: number; top: number; width: number; height: number }> {
    const c = await box(card())
    return { left: c.x, top: c.y, width: c.width, height: c.height }
  }
  /** The window below the title bar: what Pomade clamps the card against. */
  const bounds = () =>
    page.evaluate(() => {
      const y = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h'))
      return { x: 0, y, w: window.innerWidth, h: window.innerHeight - y }
    })
  /** The testid of what takes a click at the card's centre, or of the card around it. */
  const hitAtCardCentre = () =>
    page.evaluate(() => {
      const r = document.querySelector('[data-testid="app-overlay-card"]')!.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return hit?.closest('[data-testid="app-overlay-card"]') ? 'app-overlay-card' : (hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? '')
    })
  const remembered = async (): Promise<{ left: number; top: number } | undefined> => {
    const ui = JSON.parse(await fs.readFile(uiFile(), 'utf8')) as { overlayPositions?: Record<string, { left: number; top: number }> }
    return ui.overlayPositions?.hello
  }

  async function openPanel(): Promise<Frame> {
    await page.getByTestId('strip-app-hello-panel').click()
    return connectedFrame(panelIframe())
  }
  async function openFromPanel(params: Record<string, unknown> = { route: 'quick-add' }): Promise<Frame> {
    const panel = await connectedFrame(panelIframe())
    expect(await callIn(panel, 'overlay.open', params)).toMatchObject({ ok: true })
    return connectedFrame(overlayIframe())
  }
  async function closeOverlay(): Promise<void> {
    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
  }
  const focusIn = (frame: Frame) => frame.evaluate(() => `${document.activeElement?.id ?? ''}|${document.hasFocus()}`)
  /** The id of the element focused inside `frame`. */
  const activeIn = (frame: Frame) => frame.evaluate(() => document.activeElement?.id ?? '')

  async function dragHandle(dx: number, dy: number): Promise<void> {
    const h = await box(page.getByTestId('app-overlay-handle'))
    const [x, y] = [h.x + h.width / 2, h.y + h.height / 2]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
    await page.mouse.move(x + dx, y + dy, { steps: 4 })
    await page.mouse.up()
  }

  test('opens centred at 420×220 under a handle; the app was never opened', async () => {
    await openPanel()
    const frame = await openFromPanel()
    await expect.poll(() => activeIn(frame)).toBe('quick-add-text')

    const c = await placed()
    const pane = await paneSize()
    expect(c.width).toBe(420 + CHROME_W)
    expect(c.height).toBe(220 + CHROME_H)
    expect(Math.abs(c.left - (pane.w - c.width) / 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(c.top - (pane.h - c.height) / 2)).toBeLessThanOrEqual(1)
    // The frame is exactly 420×220 under the 14px handle, inside the 1px border.
    const f = await box(overlayIframe())
    const cb = await box(card())
    expect(f).toEqual({ x: cb.x + 1, y: cb.y + 1 + 14, width: 420, height: 220 })
    expect(await frame.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([420, 220])
    const handle = await box(page.getByTestId('app-overlay-handle'))
    expect(handle).toEqual({ x: cb.x + 1, y: cb.y + 1, width: 420, height: 14 })
    await page.screenshot({ path: join(SHOTS, 'overlay-default.png') })
    await closeOverlay()
  })

  test('the app sizes the frame: in overlay.open, by overlay.resize; clamped to 60% of the window below the title bar and a minimum', async () => {
    const win = await bounds()
    const cap = Math.floor(win.h * 0.6)

    const frame = await openFromPanel({ route: 'quick-add', height: 260.4 })
    expect(await frame.evaluate(() => window.innerHeight)).toBe(260)
    const top = (await placed()).top

    // Growing: the frame follows, the card's top stays.
    expect(await callIn(frame, 'overlay.resize', { height: 300 })).toMatchObject({ ok: true, value: {} })
    await expect.poll(() => frame.evaluate(() => window.innerHeight)).toBe(300)
    expect(await frame.evaluate(() => window.innerWidth)).toBe(420)
    expect((await placed()).top).toBe(top)
    expect((await placed()).height).toBe(300 + CHROME_H)
    await page.screenshot({ path: join(SHOTS, 'overlay-grown.png') })

    // Beyond the cap: the cap. Below the minimum: the minimum.
    expect(await callIn(frame, 'overlay.resize', { height: 5000 })).toMatchObject({ ok: true })
    await expect.poll(() => frame.evaluate(() => window.innerHeight)).toBe(cap)
    const grownBox = await at()
    expect(grownBox.top + grownBox.height).toBeLessThanOrEqual(win.y + win.h - MARGIN)
    expect(await callIn(frame, 'overlay.resize', { height: 10 })).toMatchObject({ ok: true })
    await expect.poll(() => frame.evaluate(() => window.innerHeight)).toBe(120)
    expect(await callIn(frame, 'overlay.resize', { height: 220 })).toMatchObject({ ok: true })
    await expect.poll(() => frame.evaluate(() => window.innerHeight)).toBe(220)

    // Refused: a bad height; from a tab or a panel frame.
    expect(await callIn(frame, 'overlay.resize', { height: 0 })).toEqual({
      ok: false,
      error: { code: 'invalid-params', message: '"height" must be a positive number' }
    })
    expect((await callIn(frame, 'overlay.resize', { height: '300' })).error?.code).toBe('invalid-params')
    expect((await callIn(frame, 'overlay.resize')).error?.code).toBe('invalid-params')
    expect((await callIn(frame, 'overlay.open', { route: 'x', height: -1 })).error?.code).toBe('invalid-params')
    const panel = await connectedFrame(panelIframe())
    expect(await callIn(panel, 'overlay.resize', { height: 300 })).toEqual({
      ok: false,
      error: { code: 'invalid-params', message: 'overlay.resize is only for an overlay frame' }
    })
    expect((await callIn(panel, 'overlay.open', { height: 'tall' })).error?.code).toBe('invalid-params')
    expect((await callIn(panel, 'overlay.open', { anchor: 'left' })).error?.code).toBe('invalid-params')
    expect(await frame.evaluate(() => window.innerHeight)).toBe(220)
    await closeOverlay()
  })

  test('anchor "panel" opens beside the side panel; an open without an anchor is centred; a collapsed column falls back to centre', async () => {
    await openFromPanel({ route: 'quick-add', anchor: 'panel' })
    let c = await placed()
    expect(c.left).toBe(MARGIN)
    expect(c.top).toBe(MARGIN)
    // Beside the panel: the card's left edge is the pane area's, next to the side panel.
    const col = await box(page.getByTestId('side-panel'))
    expect((await box(card())).x).toBe(col.x + col.width + MARGIN)
    await page.screenshot({ path: join(SHOTS, 'overlay-beside-panel.png') })
    await closeOverlay()

    await openFromPanel({ route: 'quick-add', anchor: 'center' })
    const pane = await paneSize()
    c = await placed()
    expect(Math.abs(c.left - (pane.w - c.width) / 2)).toBeLessThanOrEqual(1)
    await closeOverlay()

    // The tab frame asks for the panel anchor while the column is collapsed: nothing to sit beside.
    await openHelloFromMenu(page)
    const tab = await connectedFrame(page.getByTestId('app-frame-hello'))
    await page.getByTestId('side-panel-collapse').click()
    await expect(page.getByTestId('side-panel')).toBeHidden()
    expect(await callIn(tab, 'overlay.open', { route: 'quick-add', anchor: 'panel' })).toMatchObject({ ok: true })
    await expect(overlay()).toBeVisible()
    c = await placed()
    const wide = await paneSize()
    expect(Math.abs(c.left - (wide.w - c.width) / 2)).toBeLessThanOrEqual(1)
    await closeOverlay()
    await page.getByTestId('filetree-expand').click()
    await expect(page.getByTestId('side-panel')).toBeVisible()
  })

  test('the user drags the card by its handle anywhere in the window — over the side panel, the strip, the Projects panel — kept whole inside it; the frame keeps focus', async () => {
    const frame = await openFromPanel({ route: 'quick-add', anchor: 'panel' })
    await expect.poll(() => activeIn(frame)).toBe('quick-add-text')
    const before = await placed()
    expect(before.left).toBe(MARGIN)

    await dragHandle(240, 120)
    const after = await placed()
    expect(after.left).toBe(before.left + 240)
    expect(after.top).toBe(before.top + 120)
    // The frame still has the keyboard: typing goes to its field.
    expect(await activeIn(frame)).toBe('quick-add-text')
    await page.keyboard.type('still here')
    await expect.poll(() => frame.evaluate(() => (document.getElementById('quick-add-text') as HTMLInputElement).value)).toBe('still here')
    await page.screenshot({ path: join(SHOTS, 'overlay-moved.png') })

    // Over the side panel: the card stacks above it and takes the clicks there.
    const side = await box(page.getByTestId('side-panel'))
    let w = await at()
    await dragHandle(side.x + 20 - w.left, 0)
    w = await at()
    expect(w.left).toBe(Math.round(side.x + 20))
    expect(await hitAtCardCentre()).toBe('app-overlay-card')
    expect(await activeIn(frame)).toBe('quick-add-text')
    await page.screenshot({ path: join(SHOTS, 'overlay-over-side-panel.png') })

    // Past the window's left and top edges, over the Projects panel: clamped, the margin kept, below the title bar.
    const b = await bounds()
    await dragHandle(-60 - w.left, b.y - 40 - w.top)
    w = await at()
    expect(w.left).toBe(b.x + MARGIN)
    expect(w.top).toBe(b.y + MARGIN)
    // It spans the Projects panel (left of the strip) and the strip.
    const strip = await box(page.getByTestId('icon-strip'))
    expect(w.left).toBeLessThan(strip.x)
    expect(w.left + w.width).toBeGreaterThan(strip.x + strip.width)
    expect(await hitAtCardCentre()).toBe('app-overlay-card')
    await page.screenshot({ path: join(SHOTS, 'overlay-over-projects-panel.png') })

    // Past the window's right and bottom edges: clamped, the margin kept.
    await dragHandle(b.w + 60 - w.left, b.y + b.h + 60 - w.top)
    w = await at()
    expect(w.left).toBe(b.x + b.w - w.width - MARGIN)
    expect(w.top).toBe(b.y + b.h - w.height - MARGIN)

    // A last move over the Projects panel and the strip, left for the next open.
    await dragHandle(40 - w.left, 200 - w.top)
    expect(await at()).toMatchObject({ left: 40, top: 200 })
    await closeOverlay()
  })

  test('the shortcut and an open naming no place open where it was left; "panel" wins over it and leaves it unchanged; growth keeps it inside the window', async () => {
    await expect.poll(remembered).toEqual({ left: 40, top: 200 })

    // The shortcut, from the active tab: the remembered place, over the Projects panel.
    await page.keyboard.press('Meta+Shift+J')
    await expect(overlay()).toBeVisible()
    await connectedFrame(overlayIframe())
    expect(await at()).toMatchObject({ left: 40, top: 200 })
    expect(await hitAtCardCentre()).toBe('app-overlay-card')
    await closeOverlay()

    // An explicit "panel" anchor: beside the side panel, whatever is remembered.
    await openFromPanel({ route: 'quick-add', anchor: 'panel' })
    expect(await placed()).toMatchObject({ left: MARGIN, top: MARGIN })
    await closeOverlay()
    expect(await remembered()).toEqual({ left: 40, top: 200 })

    // The shortcut again: the remembered place, unchanged by the anchored open.
    await page.keyboard.press('Meta+Shift+J')
    await expect(overlay()).toBeVisible()
    await connectedFrame(overlayIframe())
    expect(await at()).toMatchObject({ left: 40, top: 200 })
    await closeOverlay()

    // `overlay.open` without an anchor names no place: the remembered one.
    await openFromPanel({ route: 'quick-add' })
    expect(await at()).toMatchObject({ left: 40, top: 200 })
    await closeOverlay()

    // Growing past the window's bottom edge shifts the card up to keep its margin; the place it was
    // left at is unchanged.
    const b = await bounds()
    const frame = await openFromPanel({ route: 'quick-add' })
    await dragHandle(0, b.y + b.h - 300 - 200)
    const low = await at()
    expect(low.top).toBe(b.y + b.h - 300)
    await expect.poll(remembered).toEqual({ left: 40, top: low.top })
    expect(await callIn(frame, 'overlay.resize', { height: 5000 })).toMatchObject({ ok: true })
    await expect.poll(async () => (await at()).height).toBe(Math.floor(b.h * 0.6) + CHROME_H)
    const grown = await at()
    expect(grown.left).toBe(40)
    expect(grown.top + grown.height).toBe(b.y + b.h - MARGIN)
    await closeOverlay()
    expect(await remembered()).toEqual({ left: 40, top: low.top })
  })

  test('a remembered place outside a now smaller window is clamped inside it', async () => {
    // Leave it at the window's bottom-right corner, then shrink the window.
    const frame = await openFromPanel({ route: 'quick-add' })
    await expect.poll(() => activeIn(frame)).toBe('quick-add-text')
    let b = await bounds()
    let w = await at()
    await dragHandle(b.w - w.left, b.y + b.h - w.top)
    w = await at()
    const corner = { left: b.w - w.width - MARGIN, top: b.y + b.h - w.height - MARGIN }
    expect(w).toMatchObject(corner)
    await closeOverlay()
    await expect.poll(remembered).toEqual(corner)

    await setWindowSize(app, 980, 600)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(980)
    await page.keyboard.press('Meta+Shift+J')
    await expect(overlay()).toBeVisible()
    await connectedFrame(overlayIframe())
    b = await bounds()
    w = await at()
    expect(w.left).toBe(b.w - w.width - MARGIN)
    expect(w.top).toBe(b.y + b.h - w.height - MARGIN)
    await page.screenshot({ path: join(SHOTS, 'overlay-clamped-smaller-window.png') })

    // Back to the full window, and to the place the restart test expects.
    await setWindowSize(app, 1280, 760)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280)
    w = await at()
    await dragHandle(40 - w.left, 200 - w.top)
    expect(await at()).toMatchObject({ left: 40, top: 200 })
    await closeOverlay()
    await expect.poll(remembered).toEqual({ left: 40, top: 200 })
  })

  test('closing returns focus to the frame that called overlay.open — the panel, while the tab frame held focus', async () => {
    // The Hello tab is the active tab and its panel is shown. The tab's frame has the keyboard; the
    // panel's button is pressed without taking it (a click whose mousedown is cancelled).
    await openHelloFromMenu(page)
    await expect(panelIframe()).toBeVisible()
    const tab = await connectedFrame(page.getByTestId('app-frame-hello'))
    const panel = await connectedFrame(panelIframe())
    await tab.locator('body').click()
    await expect.poll(() => tab.evaluate(() => document.hasFocus())).toBe(true)
    await panel.evaluate(() => (document.getElementById('open-overlay') as HTMLButtonElement).click())
    await expect(overlay()).toBeVisible()
    await connectedFrame(overlayIframe())
    expect(await page.evaluate(() => (document.activeElement as HTMLIFrameElement).dataset.testid)).toBe('overlay-frame-hello')

    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
    await expect.poll(() => panel.evaluate(() => document.hasFocus())).toBe(true)
    expect(await tab.evaluate(() => document.hasFocus())).toBe(false)
    expect(await page.evaluate(() => (document.activeElement as HTMLIFrameElement).dataset.testid)).toBe('panel-frame-app-hello-panel')
  })

  test('closing returns focus to the panel button after a real click on it, too', async () => {
    const tab = await connectedFrame(page.getByTestId('app-frame-hello'))
    const panel = await connectedFrame(panelIframe())
    await tab.locator('body').click()
    await expect.poll(() => tab.evaluate(() => document.hasFocus())).toBe(true)
    await panelIframe().contentFrame().locator('#open-overlay').click()
    await expect(overlay()).toBeVisible()
    await connectedFrame(overlayIframe())
    await page.keyboard.press('Escape')
    await expect(overlay()).toHaveCount(0)
    await expect.poll(() => focusIn(panel)).toBe('open-overlay|true')
    expect(await tab.evaluate(() => document.hasFocus())).toBe(false)
  })

  test('a shortcut open still returns focus to the element that had it', async () => {
    await page.getByTestId('strip-files').click()
    await page.getByTestId('tree-node-Projects/alpha/README.md').click()
    const editor = page.locator('[data-testid^="pane-"][data-visible="true"]').locator('[contenteditable="true"]').first()
    await editor.click()
    await page.evaluate(() => ((document.activeElement as HTMLElement).dataset.focusMark = 'before'))
    await page.keyboard.press('Meta+Shift+J')
    await expect(overlay()).toBeVisible()
    // Escape reaches the app once its frame is connected: it forwards it.
    await connectedFrame(overlayIframe())
    await closeOverlay()
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.focusMark)).toBe('before')
  })

  test('the spot survives a restart', async () => {
    const left = 40
    const top = 200
    const relaunched = await relaunchApp(app, fixture, { POMADE_DEV_APPS: HELLO_DIR })
    app = relaunched.app
    page = relaunched.page
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.keyboard.press('Meta+Shift+J')
    await expect(overlay()).toBeVisible()
    await connectedFrame(overlayIframe())
    // The window is back at its default size, so the spot is applied inside it unchanged.
    expect(await at()).toMatchObject({ left, top })
    await closeOverlay()
  })
})
