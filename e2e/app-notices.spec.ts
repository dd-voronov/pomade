// modules: core, tabs
// E-032 e2e — notices for apps (docs/HOST-API.md §4 `notices`): an app posts a notice, Pomade shows
// it as a toast in the shared toast host and keeps it in the Notices panel; a click runs its action
// — the app's own tab at a route (exactly `tabs.openApp`), a file tab (needs `tabs.open`) — and an
// invalid notice is refused. Screenshots land in E032_SHOTS when set.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeTabOf, callIn, connectedFrame, HELLO_DIR, openHelloFromMenu, tabsOf } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'
import { readSettingsJson } from './fixtures/settings'

const SHOTS = process.env.E032_SHOTS

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, name) })
}

/** A close-up of one element (the toast's icon buttons, T-214). */
async function shotOf(el: Locator, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await el.screenshot({ path: join(SHOTS, name) })
}

test.describe('E-032 notices from apps', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let otherDir: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    otherDir = await tempDir('pomade-hello-tabs-')
    await fs.cp(HELLO_DIR, otherDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(otherDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(otherDir, 'manifest.json'),
      JSON.stringify({ ...manifest, id: 'hello-tabs', name: 'Runner', strip: [], shortcuts: [], capabilities: ['tabs.open'] })
    )
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${HELLO_DIR};${otherDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(otherDir, { recursive: true, force: true })
  })

  async function helloPanel(): Promise<Frame> {
    await page.getByTestId('strip-app-hello-panel').click()
    return connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  }

  /** Dismiss every notice toast still on screen (they stay 6 s), so a test starts with none. */
  async function clearToasts(): Promise<void> {
    const dismiss = page.getByTestId('notice-toast-dismiss')
    while ((await dismiss.count()) > 0) await dismiss.first().click()
  }

  async function runnerTab(): Promise<Frame> {
    if ((await page.getByTestId('app-frame-hello-tabs').count()) === 0) await openHelloFromMenu(page, 'hello-tabs')
    return connectedFrame(page.getByTestId('app-frame-hello-tabs'))
  }

  test('a notice shows as a toast; its click opens the app’s own tab at the route', async () => {
    const panel = await helloPanel()
    expect(
      await callIn(panel, 'notices.post', {
        title: '  Roadmap ready ',
        body: '3 tickets need a decision.\nT-001 is overdue.',
        action: { kind: 'openApp', route: 'roadmap/T-001' }
      })
    ).toEqual({ ok: true, value: {} })
    const toast = page.getByTestId('notice-toast')
    await expect(toast).toHaveCount(1)
    await expect(toast.getByTestId('notice-toast-source')).toHaveText('Hello')
    await expect(toast.getByTestId('notice-toast-title')).toHaveText('Roadmap ready')
    await expect(toast.getByTestId('notice-toast-body')).toHaveText('3 tickets need a decision.\nT-001 is overdue.')
    await shot(page, 'notice-toast.png')

    await toast.getByTestId('notice-toast-open').click()
    await expect(toast).toHaveCount(0)
    await expect
      .poll(async () => (await tabsOf(page, fixture.projects.alpha)).filter((t) => t.appId === 'hello' && t.route === 'roadmap/T-001'))
      .toHaveLength(1)
    const tab = (await tabsOf(page, fixture.projects.alpha)).find((t) => t.route === 'roadmap/T-001')!
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(tab.id)
  })

  test('a dismissed notice stays in the Notices panel, where a click runs it again', async () => {
    const runner = await runnerTab()
    await callIn(runner, 'notices.post', {
      title: 'Nightly commit-push failed',
      body: 'Knowledge: conflict in README.md',
      action: { kind: 'openFile', path: 'Projects/beta/README.md', projectId: fixture.projects.beta }
    })
    const toast = page.getByTestId('notice-toast')
    await expect(toast.getByTestId('notice-toast-source')).toHaveText('Runner')
    await toast.getByTestId('notice-toast-dismiss').click()
    await expect(toast).toHaveCount(0)

    await page.getByTestId('strip-notices').click()
    const rows = page.getByTestId('notice-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByTestId('notice-row-title')).toHaveText('Nightly commit-push failed')
    await expect(rows.nth(1).getByTestId('notice-row-title')).toHaveText('Roadmap ready')
    await shot(page, 'notices-panel.png')

    await rows.nth(0).click()
    await expect
      .poll(async () => (await tabsOf(page, fixture.projects.beta)).filter((t) => t.kind === 'doc' && t.title === 'README.md'))
      .toHaveLength(1)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__pomadeStores.useWorkspaceStore.getState().activeProjectId
        )
      )
      .toBe(fixture.projects.beta)
  })

  test('a notice without an action is only read; Clear empties the list', async () => {
    const runner = await runnerTab()
    await callIn(runner, 'notices.post', { title: 'Backup finished' })
    const toast = page.getByTestId('notice-toast')
    await expect(toast).toHaveCount(1)
    const tabsBefore = await tabsOf(page, fixture.projects.beta)
    await toast.getByTestId('notice-toast-open').click()
    await expect(toast).toHaveCount(0)
    expect(await tabsOf(page, fixture.projects.beta)).toEqual(tabsBefore)
    await page.getByTestId('strip-notices').click()
    await expect(page.getByTestId('notice-row')).toHaveCount(3)
    await page.getByTestId('notices-clear').click()
    await expect(page.getByTestId('notices-empty')).toBeVisible()
  })

  test('refusals: an invalid notice; opening a file without tabs.open; a path outside the workspace', async () => {
    const panel = await helloPanel()
    const code = async (params: unknown): Promise<string | undefined> => (await callIn(panel, 'notices.post', params)).error?.code
    expect(await code({ title: '' })).toBe('invalid-params')
    expect(await code({ title: 'x', action: { kind: 'launch' } })).toBe('invalid-params')
    expect(await code({ title: 'x', action: { kind: 'openFile', path: 'Projects/alpha/README.md' } })).toBe('capability-denied')
    const runner = await runnerTab()
    expect((await callIn(runner, 'notices.post', { title: 'x', action: { kind: 'openFile', path: '../etc' } })).error?.code).toBe(
      'outside-workspace'
    )
    await expect(page.getByTestId('notice-toast')).toHaveCount(0)
  })

  test('the Notices icon badges the unread notices — the same marks as app badges — until the panel is looked at', async () => {
    await page.getByTestId('strip-files').click()
    const badge = page.getByTestId('strip-badge-notices')
    await expect(badge).toHaveCount(0)
    const runner = await runnerTab()
    await callIn(runner, 'notices.post', { title: 'One' })
    await expect(badge).toHaveText('1')
    await callIn(runner, 'notices.post', { title: 'Two' })
    await expect(badge).toHaveText('2')
    await expect(page.getByTestId('strip-notices')).toHaveAttribute('aria-label', 'Notices (2)')
    // An app badge on its own icon rides the same mechanism, side by side.
    const panel = await helloPanel()
    await callIn(panel, 'strip.setBadge', { icon: 'both', count: 4, urgent: true })
    await expect(page.getByTestId('strip-badge-app-hello-both')).toHaveText('4')
    await expect(page.getByTestId('strip-badge-app-hello-both')).toHaveAttribute('data-urgent', 'true')
    // The Git icon carries no mark: no badge.
    await expect(page.getByTestId('strip-badge-git')).toHaveCount(0)
    await shot(page, 'strip-badges.png')
    await page.getByTestId('strip-notices').click()
    await expect(badge).toHaveCount(0)
    await expect(page.getByTestId('notice-row')).toHaveCount(2)
  })

  test('a burst from one source is one toast — the newest, "N more from Runner" — never a storm', async () => {
    await clearToasts()
    const runner = await runnerTab()
    const panel = await helloPanel()
    for (let i = 1; i <= 6; i++) await callIn(runner, 'notices.post', { title: `Run ${i} failed` })
    await callIn(panel, 'notices.post', { title: 'Roadmap changed' })
    const toasts = page.getByTestId('notice-toast')
    await expect(toasts).toHaveCount(2)
    const runnerToast = toasts.filter({ has: page.getByTestId('notice-toast-source').getByText('Runner', { exact: true }) })
    await expect(runnerToast.getByTestId('notice-toast-title')).toHaveText('Run 6 failed')
    await expect(runnerToast.getByTestId('notice-toast-more')).toHaveText('5 more from Runner')
    await expect(toasts.filter({ hasText: 'Roadmap changed' }).getByTestId('notice-toast-more')).toHaveCount(0)
    await shot(page, 'notice-coalesced.png')
    // "5 more" opens the Notices panel, where every one of them is listed.
    await runnerToast.getByTestId('notice-toast-more').click()
    await expect(page.getByTestId('notices-panel')).toBeVisible()
    await expect(page.getByTestId('notice-row').filter({ hasText: /Run \d failed/ })).toHaveCount(6)
    await page.getByTestId('notice-toast-dismiss').click()
    await expect(toasts).toHaveCount(0)
  })

  test('muting a source: no toast, still listed, its unread counted grey (T-213); Unmute in the panel brings it back; it persists', async () => {
    await clearToasts()
    const runner = await runnerTab()
    await page.getByTestId('strip-files').click()
    const badge = page.getByTestId('strip-badge-notices')
    await callIn(runner, 'notices.post', { title: 'Before mute' })
    const toast = page.getByTestId('notice-toast')
    await expect(toast).toHaveCount(1)
    await expect(badge).toHaveText('1')
    await expect(badge).not.toHaveAttribute('data-quiet')
    await toast.getByTestId('notice-toast-mute').click()
    await expect(toast).toHaveCount(0)
    // Every unread notice is from a muted app: the count stays, grey.
    await expect(badge).toHaveText('1')
    await expect(badge).toHaveAttribute('data-quiet', 'true')
    await callIn(runner, 'notices.post', { title: 'While muted' })
    await expect(badge).toHaveText('2')
    await expect(badge).toHaveAttribute('data-quiet', 'true')
    await expect(toast).toHaveCount(0)
    await shot(page, 'notices-badge-grey.png')
    // Another source still shows; mixed, the badge counts all of them in the normal colour.
    const panel = await helloPanel()
    await page.getByTestId('strip-files').click()
    await callIn(panel, 'notices.post', { title: 'Hello still talks' })
    await expect(toast.getByTestId('notice-toast-title')).toHaveText('Hello still talks')
    await expect(badge).toHaveText('3')
    await expect(badge).not.toHaveAttribute('data-quiet')
    await shot(page, 'notices-badge-mixed.png')
    // Persisted in the workspace's preferences.
    await expect
      .poll(async () => (await readSettingsJson(fixture.workspaceRoot)).mutedNoticeSources)
      .toEqual(['hello-tabs'])
    await page.getByTestId('strip-notices').click()
    await expect(page.getByTestId('notice-row').filter({ hasText: 'While muted' })).toHaveCount(1)
    await expect(page.getByTestId('notices-muted-hello-tabs')).toContainText('Runner')
    await shot(page, 'notices-muted.png')
    await page.getByTestId('notices-unmute-hello-tabs').click()
    await expect(page.getByTestId('notices-muted')).toHaveCount(0)
    await page.getByTestId('notice-toast-dismiss').click()
    await callIn(runner, 'notices.post', { title: 'After unmute' })
    await expect(toast.getByTestId('notice-toast-title')).toHaveText('After unmute')
  })

  test('T-213: unmuting turns a grey count back to the normal colour', async () => {
    await clearToasts()
    const runner = await runnerTab()
    await page.getByTestId('strip-files').click()
    const badge = page.getByTestId('strip-badge-notices')
    await expect(badge).toHaveCount(0)
    const setMuted = (muted: boolean): Promise<void> =>
      page.evaluate(async (m) => {
        await window.__pomadeStores.useAppSettingsStore
          .getState()
          .setNoticeSourceMuted('hello-tabs', m)
      }, muted)
    await setMuted(true)
    await callIn(runner, 'notices.post', { title: 'Quiet one' })
    await expect(badge).toHaveText('1')
    await expect(badge).toHaveAttribute('data-quiet', 'true')
    await setMuted(false)
    await expect(badge).toHaveText('1')
    await expect(badge).not.toHaveAttribute('data-quiet')
  })

  test('acceptance: an app badge count updates live — every call redraws it, from a hidden frame too', async () => {
    const panel = await helloPanel()
    await page.getByTestId('strip-files').click() // the panel frame is hidden now
    const badge = page.getByTestId('strip-badge-app-hello-panel')
    for (const count of [1, 2, 7, 120]) {
      await callIn(panel, 'strip.setBadge', { icon: 'panel', count })
      await expect(badge).toHaveText(count > 99 ? '99+' : String(count))
      await expect(page.getByTestId('strip-app-hello-panel')).toHaveAttribute('aria-label', `Hello panel (${count})`)
    }
    await callIn(panel, 'strip.setBadge', { icon: 'panel', count: 3, urgent: true })
    await expect(badge).toHaveText('3')
    await expect(badge).toHaveAttribute('data-urgent', 'true')
    await callIn(panel, 'strip.setBadge', { icon: 'panel', count: 0 })
    await expect(badge).toHaveCount(0)
  })

  test('T-212: delete one notice from its row, a Cmd/Shift-click selection with Delete or Backspace, all with the trash icon', async () => {
    const runner = await runnerTab()
    await callIn(runner, 'notices.post', { title: 'Old' })
    await clearToasts()
    await page.getByTestId('strip-notices').click()
    await page.getByTestId('notices-clear').click()
    for (const title of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6']) await callIn(runner, 'notices.post', { title })
    await clearToasts()
    await page.getByTestId('strip-notices').click()
    const titles = page.getByTestId('notice-row-title')
    await expect(titles).toHaveText(['N6', 'N5', 'N4', 'N3', 'N2', 'N1'])
    const row = (title: string) => page.getByTestId('notices-list').locator('li').filter({ hasText: title })

    // One, from its × on hover (it takes the time's place).
    await row('N5').hover()
    await expect(row('N5').getByTestId('notice-row-delete')).toBeVisible()
    await shot(page, 'notices-row-hover.png')
    await row('N5').getByTestId('notice-row-delete').click()
    await expect(titles).toHaveText(['N6', 'N4', 'N3', 'N2', 'N1'])

    // A selection: Cmd-click, then Shift-click a range — selecting runs nothing; the bar counts it.
    const tabsBefore = await tabsOf(page, fixture.projects.beta)
    await row('N4').getByTestId('notice-row').click({ modifiers: ['Meta'] })
    await row('N2').getByTestId('notice-row').click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('notice-row').and(page.locator('[data-selected]'))).toHaveCount(3)
    await expect(page.getByTestId('notices-selection-count')).toHaveText('3 selected')
    expect(await tabsOf(page, fixture.projects.beta)).toEqual(tabsBefore)
    await page.mouse.move(0, 0)
    await shot(page, 'notices-selection.png')
    await page.keyboard.press('Backspace')
    await expect(titles).toHaveText(['N6', 'N1'])
    await expect(page.getByTestId('notices-selection')).toHaveCount(0)

    // Cmd-click toggles; the bar's Delete removes the selection; Delete works as Backspace does.
    await row('N6').getByTestId('notice-row').click({ modifiers: ['Meta'] })
    await page.getByTestId('notices-delete-selected').click()
    await expect(titles).toHaveText(['N1'])
    await callIn(runner, 'notices.post', { title: 'N7' })
    await clearToasts()
    await row('N7').getByTestId('notice-row').click({ modifiers: ['Meta'] })
    await page.keyboard.press('Delete')
    await expect(titles).toHaveText(['N1'])

    // The trash icon still deletes all.
    await callIn(runner, 'notices.post', { title: 'N8' })
    await clearToasts()
    await expect(titles).toHaveText(['N8', 'N1'])
    await page.getByTestId('notices-clear').click()
    await expect(page.getByTestId('notices-empty')).toBeVisible()
  })

  test('T-214: the toast’s mute and dismiss are standard icon buttons — 24 px, 16 px glyphs, level', async () => {
    await clearToasts()
    const panel = await helloPanel()
    await callIn(panel, 'notices.post', { title: 'Roadmap ready', body: '3 tickets need a decision.\nT-001 is overdue.' })
    const toast = page.getByTestId('notice-toast')
    const mute = toast.getByTestId('notice-toast-mute')
    const dismiss = toast.getByTestId('notice-toast-dismiss')
    const [m, d] = [await mute.boundingBox(), await dismiss.boundingBox()]
    expect([m?.width, m?.height, d?.width, d?.height]).toEqual([24, 24, 24, 24])
    expect(m?.y).toBe(d?.y)
    expect((await mute.locator('svg').boundingBox())?.width).toBe(16)
    expect((await dismiss.locator('svg').boundingBox())?.width).toBe(16)
    await mute.hover()
    await shotOf(toast, 'notice-toast-closeup.png')
    await dismiss.click()
    await expect(toast).toHaveCount(0)
  })
})
