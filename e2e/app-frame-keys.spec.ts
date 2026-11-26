// modules: core, tabs
// T-207 e2e — Cmd+Shift+B toggles the side panel exactly once whatever has focus: an app tab's
// frame (with the Files or the Git panel showing), an app panel's frame, an overlay frame. Main
// takes the chord before the page (main/window-shortcuts.ts), so neither Pomade's document nor
// the frame sees the keystroke — no frame forwards it, no menu key-equivalent matches it. A frame
// that does forward a chord main runs (a menu accelerator; here a CDP press that skipped main) is
// not relayed by the bridge: in the app that chord already reached main natively.

import { expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeTabOf, connectedFrame, HELLO_DIR, tabsOf } from './fixtures/hello-app'
import { toggleSidePanelKeys } from './fixtures/keys'
import { expectQuiet } from './fixtures/timing'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { showGitPanel } from './fixtures/panels'

test.describe('T-207 Cmd+Shift+B from inside app frames', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    // Every side-panel toggle, and every Cmd/Ctrl+Shift+B keydown Pomade's document sees.
    await page.evaluate(() => {
      window.__toggles = 0
      window.__keyB = 0
      window.__pomadeStores.useAppSettingsStore.subscribe((s, p) => {
        if (s.layout.fileTreeCollapsed !== p.layout.fileTreeCollapsed) window.__toggles++
      })
      window.addEventListener('keydown', (e) => { if (e.code === 'KeyB' && e.shiftKey) window.__keyB++ }, true)
    })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const collapsed = () => page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().layout.fileTreeCollapsed)
  const toggles = () => page.evaluate(() => window.__toggles)
  const pageSawKeyB = () => page.evaluate(() => window.__keyB)

  /** Click into the frame and wait until it holds the page's focus; count the frame's own KeyB keydowns. */
  async function focusFrame(el: Locator): Promise<Frame> {
    const frame = await connectedFrame(el)
    await el.contentFrame().locator(':is(h1, input):visible').first().click()
    await expect.poll(() => el.evaluate((node) => document.activeElement === node)).toBe(true)
    await frame.evaluate(() => {
      if (window.__keyB !== undefined) return
      window.__keyB = 0
      window.addEventListener('keydown', (e) => { if (e.code === 'KeyB') window.__keyB = (window.__keyB ?? 0) + 1 }, true)
    })
    return frame
  }
  const frameSawKeyB = (frame: Frame) => frame.evaluate(() => window.__keyB)

  /** Press Cmd+Shift+B twice: collapsed and stays collapsed, then expanded — one toggle each. */
  async function toggleTwiceOnce(frame: Frame): Promise<void> {
    const start = await toggles()
    const before = await collapsed()
    await toggleSidePanelKeys(app)
    await expect.poll(collapsed).toBe(!before)
    await expectQuiet(async () => {
      expect(await collapsed()).toBe(!before)
      expect(await toggles()).toBe(start + 1)
    }, 500)
    await toggleSidePanelKeys(app)
    await expect.poll(collapsed).toBe(before)
    await expectQuiet(async () => expect(await toggles()).toBe(start + 2), 500)
    expect(await pageSawKeyB()).toBe(0)
    expect(await frameSawKeyB(frame)).toBe(0)
  }

  test('an app tab focused: one toggle per press, with Files and with Git showing', async () => {
    await page.keyboard.press('Meta+Shift+Y')
    await expect.poll(async () => (await tabsOf(page, fixture.projects.alpha)).filter((t) => t.kind === 'app').length).toBe(1)
    const tab = (await tabsOf(page, fixture.projects.alpha)).find((t) => t.kind === 'app')!
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
    const frameEl = page.getByTestId(`app-pane-${tab.id}`).locator('iframe')

    const frame = await focusFrame(frameEl)
    await toggleTwiceOnce(frame)

    await showGitPanel(page)
    await expect(page.getByTestId('side-panel-git')).toBeVisible()
    await focusFrame(frameEl)
    await toggleTwiceOnce(frame)
    await expect(page.getByTestId('side-panel-git')).toBeVisible()
  })

  test("an app panel's frame focused: one toggle per press", async () => {
    await page.getByTestId('strip-app-hello-panel').click()
    const frameEl = page.getByTestId('panel-frame-app-hello-panel')
    const frame = await focusFrame(frameEl)
    await toggleTwiceOnce(frame)
    await expect(frameEl).toBeVisible()
  })

  test('an overlay frame focused: one toggle per press', async () => {
    await page.keyboard.press('Meta+Shift+J')
    await expect(page.getByTestId('app-overlay')).toBeVisible()
    const frame = await focusFrame(page.getByTestId('overlay-frame-hello'))
    await toggleTwiceOnce(frame)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('app-overlay')).toHaveCount(0)
  })

  test('a forwarded chord main runs is not relayed; a forwarded app chord still runs once', async () => {
    // The board tab in front (opened here when an earlier test's failure restarted the app).
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Meta+Shift+Y')
    await expect.poll(async () => (await tabsOf(page, fixture.projects.alpha)).filter((t) => t.kind === 'app').map((t) => t.icon)).toEqual(['both'])
    const tab = (await tabsOf(page, fixture.projects.alpha)).find((t) => t.kind === 'app')!
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
    await focusFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    const start = await toggles()
    // CDP presses skip main, so the frame gets them and forwards both, in order.
    await page.keyboard.press('Meta+Shift+B')
    await page.keyboard.press('Meta+Alt+P')
    await expect.poll(async () => (await tabsOf(page, fixture.projects.alpha)).filter((t) => t.kind === 'app').length).toBe(2)
    const roadmap = (await tabsOf(page, fixture.projects.alpha)).find((t) => t.kind === 'app' && t.icon === undefined)!
    await expect.poll(() => activeTabOf(page, fixture.projects.alpha)).toBe(roadmap.id)
    expect(await toggles()).toBe(start)
  })
})
