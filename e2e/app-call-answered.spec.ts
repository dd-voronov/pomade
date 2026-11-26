// modules: core
// T-271 e2e — every Host API call a live frame makes is answered (docs/HOST-API.md §3 "Calls", §5).
// A panel just shown again answers at once; a call still in flight when the frame starts a new
// handshake is answered before that handshake's welcome (its result, or `not-ready` when it was a
// renderer-served call whose work had not begun), never twice; a frame closed mid-call is answered
// nothing and leaves Pomade's console clean. A click sent before a just-shown frame is drawn is
// dropped by Chromium (HOST-API §5), so the click test waits 5 animation frames, as §5 says.

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { afterFiveFrames, connectedFrame, HELLO_DIR, tabsOf, type CallResult } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

/** Make the calls, then (same task) send `hello` again; each call's outcome, or "unanswered" after 3 s. */
function callsAcrossHandshake(frame: Frame, calls: [string, unknown][]): Promise<(CallResult | 'unanswered')[]> {
  return frame.evaluate((list) => {
    const hello = window.__hello
    const outcomes = list.map(([method, params]) =>
      Promise.race([
        hello.call(method, params).then((r) => ({ ok: r.ok, ...(r.ok ? { value: r.value } : { error: r.error }) })),
        new Promise<'unanswered'>((done) => setTimeout(() => done('unanswered'), 3000))
      ])
    )
    window.parent.postMessage({ channel: 'pomade', type: 'hello', hostApi: 0 }, '*')
    return Promise.all(outcomes)
  }, calls)
}

test.describe('T-271 — a call from a live frame is always answered', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let panel: Frame
  const consoleErrors: string[] = []

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(e.message))
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.getByTestId('strip-app-hello-panel').click()
    panel = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  const appTabs = async () => (await tabsOf(page, fixture.projects.alpha)).filter((t) => t.kind === 'app')

  /** A renderer-served `tabs.openApp` that raced a new handshake has two correct outcomes: served on
   *  the session that asked (one more app tab than `before`), or not served and `not-ready` (no new
   *  tab). Which one depends on whether its work had begun; anything else fails. */
  async function expectServedOrNotReady(opened: CallResult | 'unanswered', before: number): Promise<void> {
    if (opened !== 'unanswered' && opened.ok) {
      await expect.poll(async () => (await appTabs()).length).toBe(before + 1)
      return
    }
    expect(opened).toEqual({
      ok: false,
      error: { code: 'not-ready', message: 'The frame started a new handshake before this call was answered' }
    })
    expect(await appTabs()).toHaveLength(before)
  }

  async function showAgain(): Promise<void> {
    await page.getByTestId('strip-notices').click()
    await expect(page.getByTestId('notices-panel')).toBeVisible()
    await page.getByTestId('strip-app-hello-panel').click()
    await expect(page.getByTestId('panel-frame-app-hello-panel')).toBeVisible()
  }

  test('a panel shown again after another panel answers a call made at once: the app tab opens', async () => {
    await showAgain()
    const r = await panel.evaluate(() => window.__hello.call('tabs.openApp', { route: 'tab' }))
    expect(r).toMatchObject({ ok: true })
    await expect.poll(appTabs).toEqual([expect.objectContaining({ appId: 'hello', icon: 'tab' })])
  })

  test('a click in a panel shown again, once drawn, makes its call: the overlay opens, no retry', async () => {
    await showAgain()
    await afterFiveFrames(page)
    await page.frameLocator('[data-testid="panel-frame-app-hello-panel"]').getByRole('button', { name: 'Quick add…' }).click()
    await expect(page.getByTestId('app-overlay')).toBeVisible()
    // Esc goes to the focused overlay frame: press it once the overlay has the keyboard.
    const overlay = await connectedFrame(page.getByTestId('overlay-frame-hello'))
    await expect.poll(() => overlay.evaluate(() => document.activeElement?.id ?? '')).toBe('quick-add-text')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('app-overlay')).toHaveCount(0)
  })

  test('calls in flight when the frame sends hello again are each answered before the new welcome, once', async () => {
    const before = (await appTabs()).length
    const outcomes = await callsAcrossHandshake(panel, [
      ['project.getActive', undefined],
      ['host.info', undefined],
      ['tabs.openApp', { route: 'roadmap/T-271' }]
    ])
    expect(outcomes[0]).toMatchObject({ ok: true, value: { id: fixture.projects.alpha } })
    expect(outcomes[1]).toMatchObject({ ok: true, value: { surface: 'panel' } })
    await expectServedOrNotReady(outcomes[2], before)
    // The new session answers too.
    const after = await panel.evaluate(() => window.__hello.call('project.getActive'))
    expect(after).toMatchObject({ ok: true, value: { id: fixture.projects.alpha } })
  })

  test("a frame closed mid-call is answered nothing and leaves no error in Pomade's console", async () => {
    expect((await panel.evaluate(() => window.__hello.call('tabs.openApp', { route: 'tab' }))).ok).toBe(true)
    await expect.poll(async () => (await appTabs()).some((t) => t.icon === 'tab')).toBe(true)
    const tab = (await appTabs()).find((t) => t.icon === 'tab')!
    const frame = await connectedFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    consoleErrors.length = 0
    // Calls the frame never hears back from: the tab closes while they are in flight.
    void frame
      .evaluate(() => {
        const hello = window.__hello
        void hello.call('files.readFolder', { path: 'Projects/alpha', recursive: true })
        void hello.call('tabs.openApp', { route: 'roadmap/T-001' })
      })
      .catch(() => undefined)
    await page.getByTestId(`close-${tab.id}`).click()
    await expect.poll(async () => (await appTabs()).some((t) => t.id === tab.id)).toBe(false)
    // Whatever the in-flight calls do, Pomade's own window keeps working and logs nothing.
    await afterFiveFrames(page)
    expect((await panel.evaluate(() => window.__hello.call('project.getActive'))).ok).toBe(true)
    expect(consoleErrors).toEqual([])
  })
})
