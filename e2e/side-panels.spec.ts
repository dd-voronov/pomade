// modules: core, filetree, tabs
// E-029 e2e — side panels: the icon strip, the panel slot, icon actions (panel · tab · both),
// badges, and app contributions from the manifest (docs/HOST-API.md §1 `strip`, §3 `welcome`,
// §4 `strip.setBadge`). The hello fixture app (e2e/fixtures/apps/hello) declares three icons:
// `panel` (fills the panel), `tab` (opens a tab), `both` (tab route "board" + panel route
// "needs-you"). Screenshots land in e2e/artifacts/side-panels/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import type { CallResult } from './fixtures/globals'
import { tempDir } from './fixtures/temp'

const HELLO_DIR = resolve(__dirname, 'fixtures/apps/hello')
const ARTIFACTS = resolve(__dirname, 'artifacts/side-panels')

interface Welcome {
  surface: string
  icon?: string
  route: string
}

interface TabInfo {
  id: string
  kind: string
  appId?: string
  icon?: string
  title: string
}

/** The hello frame inside `iframe` once its handshake has completed. */
async function connectedFrame(iframe: Locator): Promise<Frame> {
  await expect(iframe).toHaveCount(1)
  let frame: Frame | null = null
  await expect
    .poll(async () => {
      frame = (await (await iframe.elementHandle())?.contentFrame()) ?? null
      if (!frame) return 'no frame'
      return frame.evaluate(() => window.__hello?.status ?? 'loading').catch(() => 'loading')
    })
    .toBe('connected')
  return frame!
}

function welcomeOf(frame: Frame): Promise<Welcome | null> {
  return frame.evaluate(() => {
    const w = window.__hello?.welcome
    return w ? { surface: w.surface, icon: w.icon, route: w.route } : null
  })
}

function markOf(frame: Frame): Promise<string> {
  return frame.evaluate(() => window.__hello.mark)
}

function callIn(frame: Frame, method: string, params?: unknown): Promise<CallResult> {
  return frame.evaluate(
    ([m, p]) => window.__hello.call(m as string, p),
    [method, params] as const
  )
}

function tabsOf(page: Page, projectId: string): Promise<TabInfo[]> {
  return page.evaluate((pid) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return s.tabsFor(pid).map((t) => ({ id: t.id, kind: t.kind, appId: t.appId, icon: t.icon, title: t.title }))
  }, projectId)
}

function activeTabOf(page: Page, projectId: string): Promise<string | undefined> {
  return page.evaluate(
    (pid) =>
      window.__pomadeStores.useTabsStore.getState().activeTabByProject[pid],
    projectId
  )
}

function setActiveProject(page: Page, id: string): Promise<void> {
  return page.evaluate((pid) => {
    window.__pomadeStores.useWorkspaceStore.getState()
      .setActiveProject(pid)
  }, id)
}

function collapsedState(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      window.__pomadeStores.useAppSettingsStore.getState().layout.fileTreeCollapsed
  )
}

/** The strip's own app icons (no built-ins), as their test ids. */
const ICON = {
  files: 'strip-files',
  panel: 'strip-app-hello-panel',
  tab: 'strip-app-hello-tab',
  both: 'strip-app-hello-both'
}
const PANEL_FRAME = 'panel-frame-app-hello-panel'
const BOTH_PANEL_FRAME = 'panel-frame-app-hello-both'

async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS, name) })
}

type Rgb = [number, number, number]

/** `--text` (the hover / selected colour of every strip icon). */
let textColour: Rgb = [0, 0, 0]

function close(a: Rgb, b: Rgb, tolerance = 24): boolean {
  return a.every((v, k) => Math.abs(v - b[k]) <= tolerance)
}

/** What `el` draws, read from its screenshot: the share of pixels that differ from its corner
 *  (the button behind it) and the colour of the strongest of them — the icon's ink. */
async function inkOf(page: Page, el: Locator): Promise<{ ratio: number; ink: Rgb }> {
  const png = (await el.screenshot({ animations: 'disabled' })).toString('base64')
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const bg = [d[0], d[1], d[2]]
    let ink = 0
    let best = 0
    let colour: [number, number, number] = [bg[0], bg[1], bg[2]]
    for (let p = 0; p < d.length; p += 4) {
      const dist = Math.abs(d[p] - bg[0]) + Math.abs(d[p + 1] - bg[1]) + Math.abs(d[p + 2] - bg[2])
      if (dist > 30) ink += 1
      if (dist > best) {
        best = dist
        colour = [d[p], d[p + 1], d[p + 2]]
      }
    }
    return { ratio: ink / (d.length / 4), ink: colour }
  }, png)
}

async function seed(f: Fixture): Promise<void> {
  const dir = join(f.workspaceRoot, 'Projects/alpha/roadmap')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'T-001.md'), '---\nid: T-001\ntitle: First\nstatus: open\n---\n\nBody.\n')
}

test.describe('E-029 side panels with the hello app dev-linked', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seed(fixture)
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    textColour = await page.evaluate(() => {
      const el = document.createElement('div')
      el.style.color = 'var(--text)'
      document.body.appendChild(el)
      const m = getComputedStyle(el).color.match(/\d+/g)!.map(Number)
      el.remove()
      return [m[0], m[1], m[2]] as [number, number, number]
    })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('Files, Git, Notices and the app icons live in the strip; Files is the default panel', async () => {
    const strip = page.getByTestId('icon-strip')
    await expect(strip.getByRole('button')).toHaveCount(6)
    await expect(strip.getByRole('button').nth(0)).toHaveAttribute('data-testid', ICON.files)
    await expect(strip.getByRole('button').nth(1)).toHaveAttribute('data-testid', 'strip-git')
    await expect(strip.getByRole('button').nth(2)).toHaveAttribute('data-testid', 'strip-notices')
    await expect(strip.getByRole('button').nth(3)).toHaveAttribute('data-testid', ICON.panel)
    await expect(strip.getByRole('button').nth(4)).toHaveAttribute('data-testid', ICON.tab)
    await expect(strip.getByRole('button').nth(5)).toHaveAttribute('data-testid', ICON.both)
    await expect(page.getByTestId(ICON.files)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId(ICON.panel)).toHaveAttribute('aria-pressed', 'false')
    // A tab-only icon is never "selected".
    await expect(page.getByTestId(ICON.tab)).not.toHaveAttribute('aria-pressed', /.*/)
    // Each icon wears its manifest image; the tab icon (no image of its own) the app's icon. A
    // one-colour SVG (board.svg) is a mask Pomade tints; a multi-colour one is shown as it is.
    await expect(page.getByTestId(ICON.panel).locator('img')).toHaveAttribute('src', 'pomade-app://hello/panel.svg')
    await expect(page.getByTestId(ICON.both).locator('[data-app-icon]')).toHaveAttribute('data-icon-url', 'pomade-app://hello/board.svg')
    await expect(page.getByTestId(ICON.both).locator('img')).toHaveCount(0)
    await expect(page.getByTestId(ICON.tab).locator('img')).toHaveAttribute('src', 'pomade-app://hello/icon.svg')
    // The Files panel is the file tree, unchanged.
    await expect(page.getByTestId('side-panel-files')).toBeVisible()
    await expect(page.locator('aside[aria-label="Files"]')).toBeVisible()
    await expect(page.getByTestId('filetree-collapse')).toBeVisible()
    // No app frame exists until a panel is shown.
    await expect(page.getByTestId(PANEL_FRAME)).toHaveCount(0)
    await shot(page, 'strip-expanded.png')
  })

  test('a panel icon fills the panel with the app on the panel surface; the tab strip is unchanged', async () => {
    const alpha = fixture.projects.alpha
    const tabsBefore = await tabsOf(page, alpha)
    const activeBefore = await activeTabOf(page, alpha)
    await page.getByTestId(ICON.panel).click()
    await expect(page.getByTestId('side-panel-app-hello-panel')).toBeVisible()
    await expect(page.getByTestId('side-panel-files')).toBeHidden()
    await expect(page.getByTestId(ICON.panel)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId(ICON.files)).toHaveAttribute('aria-pressed', 'false')
    const frame = await connectedFrame(page.getByTestId(PANEL_FRAME))
    expect(await welcomeOf(frame)).toEqual({ surface: 'panel', icon: 'panel', route: 'panel' })
    const info = await callIn(frame, 'host.info')
    expect(info.value).toMatchObject({ appId: 'hello', surface: 'panel', icon: 'panel', route: 'panel' })
    await expect(page.frameLocator(`[data-testid="${PANEL_FRAME}"]`).locator('#surface')).toHaveText(
      'Surface: panel · icon panel · route "panel"'
    )
    // Panels never touch the tab strip.
    expect(await tabsOf(page, alpha)).toEqual(tabsBefore)
    expect(await activeTabOf(page, alpha)).toBe(activeBefore)
    await expect(page.getByTestId('tabstrip').getByTestId(/^app-icon-/)).toHaveCount(0)
    await shot(page, 'app-panel.png')
  })

  test('a tab icon opens the app in a tab (focused, not duplicated) and leaves the panel as it is', async () => {
    const alpha = fixture.projects.alpha
    await page.getByTestId(ICON.tab).click()
    await expect.poll(async () => (await tabsOf(page, alpha)).filter((t) => t.kind === 'app')).toHaveLength(1)
    const [tab] = (await tabsOf(page, alpha)).filter((t) => t.kind === 'app')
    expect(tab).toMatchObject({ appId: 'hello', icon: 'tab', title: 'Hello tab' })
    expect(await activeTabOf(page, alpha)).toBe(tab.id)
    const frame = await connectedFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    expect(await welcomeOf(frame)).toEqual({ surface: 'tab', icon: 'tab', route: 'tab' })
    await expect(page.getByTestId('tabstrip').locator('img[src="pomade-app://hello/icon.svg"]')).toBeVisible()
    // The panel still shows the hello panel.
    await expect(page.getByTestId('side-panel-app-hello-panel')).toBeVisible()
    // A second click focuses the same tab instead of opening another.
    await setActiveProject(page, fixture.projects.beta)
    await setActiveProject(page, alpha)
    await page.getByTestId(ICON.tab).click()
    expect((await tabsOf(page, alpha)).filter((t) => t.kind === 'app')).toHaveLength(1)
    expect(await activeTabOf(page, alpha)).toBe(tab.id)
  })

  test('a both icon opens its tab route AND fills the panel with its panel route', async () => {
    const alpha = fixture.projects.alpha
    await page.getByTestId(ICON.both).click()
    await expect
      .poll(async () => (await tabsOf(page, alpha)).filter((t) => t.kind === 'app' && t.icon === 'both'))
      .toHaveLength(1)
    const tab = (await tabsOf(page, alpha)).find((t) => t.icon === 'both')!
    expect(tab.title).toBe('Hello board')
    expect(await activeTabOf(page, alpha)).toBe(tab.id)
    const tabFrame = await connectedFrame(page.getByTestId(`app-pane-${tab.id}`).locator('iframe'))
    expect(await welcomeOf(tabFrame)).toEqual({ surface: 'tab', icon: 'both', route: 'board' })
    await expect(page.getByTestId('side-panel-app-hello-both')).toBeVisible()
    await expect(page.getByTestId('side-panel-app-hello-panel')).toBeHidden()
    const panelFrame = await connectedFrame(page.getByTestId(BOTH_PANEL_FRAME))
    expect(await welcomeOf(panelFrame)).toEqual({ surface: 'panel', icon: 'both', route: 'needs-you' })
    await expect(page.getByTestId(ICON.both)).toHaveAttribute('aria-pressed', 'true')
  })

  test('a badge shows, turns red when urgent, and clears', async () => {
    const frame = await connectedFrame(page.getByTestId(PANEL_FRAME))
    const badge = page.getByTestId('strip-badge-app-hello-panel')
    await expect(badge).toHaveCount(0)

    expect(await callIn(frame, 'strip.setBadge', { icon: 'panel', count: 3 })).toEqual(
      expect.objectContaining({ ok: true, value: {} })
    )
    await expect(badge).toHaveText('3')
    await expect(badge).not.toHaveAttribute('data-urgent', /.*/)
    await expect(page.getByTestId(ICON.panel)).toHaveAttribute('aria-label', 'Hello panel (3)')

    // Any frame of the app may badge any of its icons — here the panel frame badges `both`.
    await callIn(frame, 'strip.setBadge', { icon: 'both', count: 120, urgent: true })
    const urgent = page.getByTestId('strip-badge-app-hello-both')
    await expect(urgent).toHaveText('99+')
    await expect(urgent).toHaveAttribute('data-urgent', 'true')
    const colors = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      const probe = (v: string): string => {
        const el = document.createElement('div')
        el.style.background = css.getPropertyValue(v)
        document.body.appendChild(el)
        const c = getComputedStyle(el).backgroundColor
        el.remove()
        return c
      }
      return { danger: probe('--danger'), badge: probe('--accent-active') }
    })
    await expect(urgent).toHaveCSS('background-color', colors.danger)
    await expect(badge).toHaveCSS('background-color', colors.badge)
    await shot(page, 'badges.png')

    // Not its icon, or malformed: invalid-params, nothing drawn.
    expect((await callIn(frame, 'strip.setBadge', { icon: 'nope', count: 1 })).error?.code).toBe('invalid-params')
    expect((await callIn(frame, 'strip.setBadge', { icon: 'panel', count: -1 })).error?.code).toBe('invalid-params')

    await callIn(frame, 'strip.setBadge', { icon: 'panel', count: 0 })
    await callIn(frame, 'strip.setBadge', { icon: 'both', count: 0 })
    await expect(badge).toHaveCount(0)
    await expect(urgent).toHaveCount(0)
  })

  test('panels are hidden, never unmounted: app state survives panel and project switches', async () => {
    await page.getByTestId(ICON.panel).click()
    const frame = await connectedFrame(page.getByTestId(PANEL_FRAME))
    const mark = await markOf(frame)
    await page.getByTestId(ICON.files).click()
    await expect(page.getByTestId('side-panel-files')).toBeVisible()
    await expect(page.getByTestId(PANEL_FRAME)).toBeHidden()
    // Hidden, it still follows the active project.
    const before = await frame.evaluate(
      () => window.__hello.events.filter((e) => e.name === 'project.changed').length
    )
    await setActiveProject(page, fixture.projects.beta)
    await expect
      .poll(() =>
        frame.evaluate(() => window.__hello.events.filter((e) => e.name === 'project.changed').length)
      )
      .toBe(before + 1)
    await setActiveProject(page, fixture.projects.alpha)
    await page.getByTestId(ICON.panel).click()
    await expect(page.getByTestId(PANEL_FRAME)).toBeVisible()
    expect(await markOf(frame)).toBe(mark)
  })

  test('the selected icon is remembered per project', async () => {
    const { alpha, beta } = fixture.projects
    await page.getByTestId(ICON.panel).click()
    await setActiveProject(page, beta)
    // Beta never chose a panel: Files.
    await expect(page.getByTestId(ICON.files)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('side-panel-files')).toBeVisible()
    await page.getByTestId(ICON.both).click()
    await expect(page.getByTestId('side-panel-app-hello-both')).toBeVisible()
    await setActiveProject(page, alpha)
    await expect(page.getByTestId(ICON.panel)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('side-panel-app-hello-panel')).toBeVisible()
    await setActiveProject(page, beta)
    await expect(page.getByTestId(ICON.both)).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId(ICON.files).click()
    await setActiveProject(page, alpha)
  })

  test('collapsed: the strip stays, a panel icon expands into its panel, a tab icon keeps it collapsed', async () => {
    const alpha = fixture.projects.alpha
    await page.getByTestId(ICON.panel).click()
    const frame = await connectedFrame(page.getByTestId(PANEL_FRAME))
    const mark = await markOf(frame)
    const before = await page.getByTestId('panehost').boundingBox()

    await page.getByTestId('side-panel-app-hello-panel').getByTestId('side-panel-collapse').click()
    await expect.poll(() => collapsedState(page)).toBe(true)
    await expect(page.getByTestId('side-panel')).toBeHidden()
    await expect(page.getByTestId('icon-strip').getByRole('button', { name: 'Hello panel' })).toBeVisible()
    await expect(page.getByTestId('filetree-expand')).toBeVisible()
    await expect(page.getByTestId(PANEL_FRAME)).toBeHidden()
    await expect(page.getByTestId('divider-filetree')).toHaveCount(0)
    const strip = await page.getByTestId('icon-strip').boundingBox()
    // Nothing between the icon strip and the main area.
    const main = await page.getByTestId('panehost').boundingBox()
    expect(main!.x).toBeCloseTo(strip!.x + strip!.width, 0)
    expect((await page.getByTestId('panehost').boundingBox())!.width).toBeGreaterThan(before!.width)
    await shot(page, 'strip-collapsed.png')

    // A tab icon opens its tab and leaves the column collapsed.
    await page.getByTestId(ICON.tab).click()
    expect(await collapsedState(page)).toBe(true)
    const tab = (await tabsOf(page, alpha)).find((t) => t.icon === 'tab')!
    expect(await activeTabOf(page, alpha)).toBe(tab.id)

    // A panel icon expands the column into ITS panel; the frame is the same live document.
    await page.getByTestId(ICON.files).click()
    await expect.poll(() => collapsedState(page)).toBe(false)
    await expect(page.getByTestId('side-panel-files')).toBeVisible()
    await page.getByTestId(ICON.panel).click()
    await expect(page.getByTestId(PANEL_FRAME)).toBeVisible()
    expect(await markOf(frame)).toBe(mark)

    // The rail's expand button and Cmd+Shift+B still work.
    await page.getByTestId('side-panel-app-hello-panel').getByTestId('side-panel-collapse').click()
    await page.getByTestId('filetree-expand').click()
    await expect.poll(() => collapsedState(page)).toBe(false)
    await expect(page.getByTestId(PANEL_FRAME)).toBeVisible()
  })

  test('T-244 a one-colour app icon takes the built-in icons\' colour: idle, hover, selected', async () => {
    const files = page.getByTestId(ICON.files)
    const both = page.getByTestId(ICON.both)
    const glyph = files.locator('svg')
    const icon = both.locator('[data-app-icon]')
    await files.click()
    await expect(files).toHaveAttribute('aria-pressed', 'true')
    // Same box as the built-in glyph.
    const g = (await glyph.boundingBox())!
    const i = (await icon.boundingBox())!
    expect([i.width, i.height]).toEqual([g.width, g.height])
    expect(i.x).toBeCloseTo(g.x, 0)

    // Idle: the app icon is drawn in the colour of an idle built-in (Git), not its own blue.
    await page.mouse.move(0, 0)
    const idle = await inkOf(page, page.getByTestId('strip-git').locator('svg'))
    const appIdle = await inkOf(page, icon)
    expect(appIdle.ratio).toBeGreaterThan(0.05)
    expect(appIdle.ratio).toBeLessThan(0.9)
    expect(close(appIdle.ink, idle.ink)).toBe(true)
    await shot(page, 'tint-idle.png')

    // Hover: both darken to the same colour.
    await both.hover()
    await expect.poll(async () => close((await inkOf(page, icon)).ink, textColour)).toBe(true)
    await page.getByTestId('strip-git').hover()
    await expect.poll(async () => close((await inkOf(page, page.getByTestId('strip-git').locator('svg'))).ink, textColour)).toBe(true)
    await both.hover()
    await expect.poll(async () => close((await inkOf(page, icon)).ink, textColour)).toBe(true)
    await page.getByTestId('icon-strip').screenshot({ path: join(ARTIFACTS, 'tint-hover-strip.png') })

    // Selected (the `both` panel shown): the same colour as the selected Files icon had.
    await page.getByTestId(ICON.files).hover()
    const filesSelected = await inkOf(page, glyph)
    await both.click()
    await expect(both).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.move(0, 0)
    await expect.poll(async () => close((await inkOf(page, icon)).ink, filesSelected.ink)).toBe(true)
    await page.getByTestId('icon-strip').screenshot({ path: join(ARTIFACTS, 'tint-selected-strip.png') })
    await files.click()
  })
})

test.describe('E-029 the panel choice survives a restart', () => {
  test('a project reopens on the panel it last showed', async () => {
    const fixture = await createFixtureWorkspace()
    try {
      const first = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
      const page1 = await firstAppWindow(first)
      await page1.getByTestId(`project-${fixture.projects.alpha}`).click()
      await page1.getByTestId(ICON.both).click()
      await expect(page1.getByTestId('side-panel-app-hello-both')).toBeVisible()
      await first.close()

      const second = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
      const page2 = await firstAppWindow(second)
      await page2.getByTestId(`project-${fixture.projects.alpha}`).click()
      await expect(page2.getByTestId(ICON.both)).toHaveAttribute('aria-pressed', 'true')
      const frame = await connectedFrame(page2.getByTestId(BOTH_PANEL_FRAME))
      expect(await welcomeOf(frame)).toEqual({ surface: 'panel', icon: 'both', route: 'needs-you' })
      // The tab the `both` click opened came back as a tab, not as a second panel.
      expect((await tabsOf(page2, fixture.projects.alpha)).filter((t) => t.icon === 'both')).toHaveLength(1)
      await second.close()
    } finally {
      await fixture.cleanup()
    }
  })
})

test.describe('E-029 the strip holds many icons', () => {
  test('a long strip scrolls inside the column; every icon stays reachable', async () => {
    const fixture = await createFixtureWorkspace()
    const manyDir = await tempDir('pomade-many-')
    try {
      await fs.cp(HELLO_DIR, manyDir, { recursive: true })
      const manifest = JSON.parse(await fs.readFile(join(manyDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
      const strip = Array.from({ length: 30 }, (_, i) => ({
        id: `p${i}`,
        title: `Panel ${i}`,
        action: 'panel',
        route: `r${i}`
      }))
      await fs.writeFile(join(manyDir, 'manifest.json'), JSON.stringify({ ...manifest, id: 'many', name: 'Many', strip }))
      const app = await launchApp(fixture, { POMADE_DEV_APPS: `${HELLO_DIR};${manyDir}` })
      try {
        const page = await firstAppWindow(app)
        await page.getByTestId(`project-${fixture.projects.alpha}`).click()
        const buttons = page.getByTestId('icon-strip').getByRole('button')
        await expect(buttons).toHaveCount(3 + 3 + 30)
        // The strip keeps its width; the icon list scrolls instead of overflowing the window.
        const box = await page.getByTestId('icon-strip').boundingBox()
        const shell = await page.getByTestId('app-shell').boundingBox()
        expect(box!.width).toBeLessThan(60)
        expect(box!.y + box!.height).toBeLessThanOrEqual(shell!.y + shell!.height + 1)
        const last = page.getByTestId('strip-app-many-p29')
        await last.scrollIntoViewIfNeeded()
        await last.click()
        const frame = await connectedFrame(page.getByTestId('panel-frame-app-many-p29'))
        expect(await welcomeOf(frame)).toEqual({ surface: 'panel', icon: 'p29', route: 'r29' })
        await expect(page.getByTestId(ICON.files)).toHaveAttribute('aria-pressed', 'false')
        await shot(page, 'strip-many.png')
      } finally {
        await app.close()
      }
    } finally {
      await fixture.cleanup()
      await fs.rm(manyDir, { recursive: true, force: true })
    }
  })
})
