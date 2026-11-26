// modules: core, terminal
// Pomade E-007 (T-029/T-030) e2e — resizable columns + collapsible Projects panel.
// Acceptance:
//  • drag a divider → the column resizes and the width persists to the workspace's view state
//    (`.pomade/state/view.json`, gitignored — not settings.json, not workspace.json) → survives
//    an app restart;
//  • extreme drag positions keep the layout intact (columns clamped, working area usable);
//  • Cmd+B collapses/expands the Projects panel (menu-item path, focus-independent); the collapsed
//    state persists across restart and the expand affordance is ALWAYS visible when collapsed;
//  • resizing/collapsing never remounts panes — a live terminal keeps its xterm + PTY.
//
// As with T-036, Playwright's synthesized keystrokes never reach native menu accelerators, so
// Cmd+B is exercised via the real menu item (Menu.getMenuItemById(...).click()).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { LAYOUT_LIMITS } from '../src/shared/types'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'
import { toggleSidePanelKeys } from './fixtures/keys'
import { readViewState, settingsJsonPath } from './fixtures/settings'

interface Launched {
  app: ElectronApplication
  page: Page
}

async function launch(fixture: Fixture): Promise<Launched> {
  const { app, page } = await launchAppPage(fixture)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  // Wait for app-settings hydration so layout reflects persisted values, not defaults.
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  return { app, page }
}

function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`menu item not found: ${itemId}`)
    item.click()
  }, id)
}

interface Layout {
  projectsPanelWidth: number
  fileTreeWidth: number
  projectsPanelCollapsed: boolean
  fileTreeCollapsed: boolean
}

function getLayout(page: Page): Promise<Layout> {
  return page.evaluate(
    () => window.__pomadeStores.useAppSettingsStore.getState().layout as Layout
  )
}

async function storedLayout(fixture: Fixture): Promise<Layout | undefined> {
  return (await readViewState(fixture.workspaceRoot)).layout as Layout | undefined
}

/** Drag a divider so its centre ends at absolute client X = toClientX.
 *  T-076 hardening (flaked twice at full-suite gates, always as "the drag never engaged"):
 *  the target is clamped into the viewport — CDP may drop mouse moves to coordinates outside
 *  the window (the -500 left-drag) — and the whole gesture retries when the divider did not
 *  actually move, because boundingBox can go stale between consecutive drags under load.
 *  A no-move outcome is legitimate when the divider is already at its clamp, so after the
 *  retries we return and let the caller's assertions judge the resulting layout. */
async function dragDividerTo(page: Page, testId: string, toClientX: number): Promise<void> {
  const divider = page.getByTestId(testId)
  const vw: number = await page.evaluate(() => window.innerWidth)
  const targetX = Math.min(Math.max(toClientX, 1), vw - 1)
  for (let attempt = 0; ; attempt++) {
    const box = await divider.boundingBox()
    if (!box) throw new Error(`divider not found: ${testId}`)
    const fromX = box.x + box.width / 2
    const y = box.y + box.height / 2
    await page.mouse.move(fromX, y)
    await page.mouse.down()
    await page.mouse.move(targetX, y, { steps: 12 })
    await page.mouse.up()
    const after = await divider.boundingBox()
    const afterX = after ? after.x + after.width / 2 : fromX
    if (Math.abs(afterX - fromX) > 1 || attempt === 2) return
  }
}

test.describe('E-007 — resizable columns + collapsible Projects panel', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('menu wiring + dividers present at defaults', async () => {
    const { app, page } = await launch(fixture)
    const accel = await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('menu-toggle-projects-panel')?.accelerator
    )
    expect(accel).toBe('CmdOrCtrl+B')
    const label = await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('menu-toggle-projects-panel')?.label
    )
    expect(label).toBe('Toggle Projects Panel')
    await expect(page.getByRole('button', { name: 'Collapse Projects panel' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Icon strip' })).toBeVisible()

    await expect(page.getByTestId('divider-projects-panel')).toBeVisible()
    await expect(page.getByTestId('divider-filetree')).toBeVisible()

    expect(await getLayout(page)).toMatchObject({
      projectsPanelWidth: 240,
      fileTreeWidth: 240,
      projectsPanelCollapsed: false
    })
    await app.close()
  })

  test('drag-resize → widths persist to the view state → restored after restart', async () => {
    const first = await launch(fixture)

    // Widen the Projects panel (drag its divider right) and narrow the file tree (drag left).
    await dragDividerTo(first.page, 'divider-projects-panel', 360)
    await expect.poll(() => getLayout(first.page).then((l) => l.projectsPanelWidth)).toBeGreaterThan(320)

    // File-tree divider sits at ~Projects panel+fileTree; drag it well right to WIDEN the tree.
    await dragDividerTo(first.page, 'divider-filetree', 760)
    const set = await getLayout(first.page)
    expect(set.fileTreeWidth).toBeGreaterThan(240)

    // Persisted to the gitignored view state (never settings.json or workspace.json).
    await expect
      .poll(() => storedLayout(fixture).then((l) => l?.projectsPanelWidth))
      .toBe(set.projectsPanelWidth)
    expect((await storedLayout(fixture))?.fileTreeWidth).toBe(set.fileTreeWidth)

    const wsJson = JSON.parse(
      await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8')
    )
    expect(wsJson.layout).toBeUndefined() // not leaked into shared workspace config
    // A drag never writes the git-tracked preferences file.
    await expect(fs.access(settingsJsonPath(fixture.workspaceRoot))).rejects.toThrow()

    await first.app.close()

    // Restart: the persisted widths come back.
    const second = await launch(fixture)
    const restored = await getLayout(second.page)
    expect(restored.projectsPanelWidth).toBe(set.projectsPanelWidth)
    expect(restored.fileTreeWidth).toBe(set.fileTreeWidth)
    await second.app.close()
  })

  test('extreme drags clamp instead of breaking the layout', async () => {
    const { app, page } = await launch(fixture)

    // Drag both dividers far to the RIGHT (past any real position).
    await dragDividerTo(page, 'divider-projects-panel', 6000)
    await dragDividerTo(page, 'divider-filetree', 6000)
    let l = await getLayout(page)
    expect(l.projectsPanelWidth).toBeLessThanOrEqual(LAYOUT_LIMITS.projectsPanelMax)
    expect(l.fileTreeWidth).toBeLessThanOrEqual(LAYOUT_LIMITS.fileTreeMax)

    // The working area must stay usable and the shell must not overflow horizontally.
    const paneBox = await page.getByTestId('panehost').boundingBox()
    expect(paneBox!.width).toBeGreaterThan(250)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    )
    expect(overflow).toBe(true)

    // Drag both dividers far to the LEFT → clamped to their minimums.
    await dragDividerTo(page, 'divider-projects-panel', -500)
    await dragDividerTo(page, 'divider-filetree', -500)
    l = await getLayout(page)
    expect(l.projectsPanelWidth).toBe(LAYOUT_LIMITS.projectsPanelMin)
    expect(l.fileTreeWidth).toBe(LAYOUT_LIMITS.fileTreeMin)
    await app.close()
  })

  test('Cmd+B collapses to a rail (expand always visible) and persists across restart', async () => {
    const first = await launch(fixture)
    await expect(first.page.getByTestId('projects-panel-collapse')).toBeVisible()

    await clickMenuItem(first.app, 'menu-toggle-projects-panel')

    // Full Projects panel gone; the rail + expand affordance are visible.
    await expect(first.page.getByTestId('projects-panel-rail')).toBeVisible()
    await expect(first.page.getByTestId('projects-panel-expand')).toBeVisible()
    await expect(first.page.getByTestId('projects-panel-collapse')).toHaveCount(0)
    // The inter-column divider next to the collapsed Projects panel is hidden (rail is fixed-width).
    await expect(first.page.getByTestId('divider-projects-panel')).toHaveCount(0)

    expect((await getLayout(first.page)).projectsPanelCollapsed).toBe(true)
    await expect.poll(() => storedLayout(fixture).then((l) => l?.projectsPanelCollapsed)).toBe(true)

    await first.app.close()

    // Restart: still collapsed, expand affordance visible.
    const second = await launch(fixture)
    expect((await getLayout(second.page)).projectsPanelCollapsed).toBe(true)
    await expect(second.page.getByTestId('projects-panel-rail')).toBeVisible()
    await expect(second.page.getByTestId('projects-panel-expand')).toBeVisible()

    // Expand via the rail button restores the full Projects panel.
    await expect(second.page.getByTestId('projects-panel-expand')).toHaveAccessibleName('Expand Projects panel')
    await second.page.getByTestId('projects-panel-expand').click()
    await expect(second.page.getByTestId('projects-panel-rail')).toHaveCount(0)
    await expect(second.page.getByTestId('projects-panel-collapse')).toBeVisible()
    expect((await getLayout(second.page)).projectsPanelCollapsed).toBe(false)
    await second.app.close()
  })

  test('a live terminal keeps its xterm + PTY across resize and collapse (no remount)', async () => {
    const { app, page } = await launch(fixture)
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    // Open a terminal.
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()

    const pane = page.locator('[data-term-id][data-status="live"]:visible').first()
    await expect(pane).toBeVisible()
    await expect(pane).toHaveAttribute('data-mount-id', /.+/)
    await expect(pane).toHaveAttribute('data-term-id', /.+/)
    const mountId = await pane.getAttribute('data-mount-id')
    const termId = await pane.getAttribute('data-term-id')

    // Resize the working area (drag the file-tree divider) and collapse/expand the Projects panel.
    await dragDividerTo(page, 'divider-filetree', 420)
    await clickMenuItem(app, 'menu-toggle-projects-panel') // collapse
    await clickMenuItem(app, 'menu-toggle-projects-panel') // expand

    // Same DOM instance (data-mount-id unchanged ⇒ no remount) and still live.
    const paneAfter = page.locator(`[data-term-id="${termId}"]:visible`)
    await expect(paneAfter).toHaveAttribute('data-mount-id', mountId!)
    await expect(paneAfter).toHaveAttribute('data-status', 'live')

    // The PTY was never killed/restarted.
    const alive = await page.evaluate(
      (tid) => window.pomade.pty
        .list()
        .then((l) => l.some((t) => t.termId === tid && t.alive)),
      termId
    )
    expect(alive).toBe(true)
    await app.close()
  })

  // ─── T-049 — collapsible file-tree column (mirrors the Projects panel rail above) ───────

  test('T-049 — Toggle File Tree menu item carries Cmd+Shift+B', async () => {
    const { app } = await launch(fixture)
    const accel = await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('menu-toggle-filetree')?.accelerator
    )
    expect(accel).toBe('CmdOrCtrl+Shift+B')
    await app.close()
  })

  test('T-049 — Cmd+Shift+B collapses the tree (editor widens, expand always visible) and persists across restart', async () => {
    const first = await launch(fixture)
    await expect(first.page.getByTestId('filetree-collapse')).toBeVisible()

    const before = await first.page.getByTestId('panehost').boundingBox()

    await clickMenuItem(first.app, 'menu-toggle-filetree')

    // Full tree gone; the collapsed column (just the icon strip) + expand affordance are visible.
    await expect(first.page.getByTestId('side-panel')).toBeHidden()
    await expect(first.page.getByTestId('filetree-expand')).toBeVisible()
    await expect(first.page.getByTestId('filetree-collapse')).toHaveCount(0)
    // The inter-column divider next to the collapsed column is hidden (the strip is fixed-width).
    await expect(first.page.getByTestId('divider-filetree')).toHaveCount(0)

    // The editor reclaimed the freed width.
    const after = await first.page.getByTestId('panehost').boundingBox()
    expect(after!.width).toBeGreaterThan(before!.width)

    expect((await getLayout(first.page)).fileTreeCollapsed).toBe(true)
    await expect.poll(() => storedLayout(fixture).then((l) => l?.fileTreeCollapsed)).toBe(true)

    await first.app.close()

    // Restart: still collapsed, expand affordance visible.
    const second = await launch(fixture)
    expect((await getLayout(second.page)).fileTreeCollapsed).toBe(true)
    await expect(second.page.getByTestId('side-panel')).toBeHidden()
    await expect(second.page.getByTestId('filetree-expand')).toBeVisible()

    // Expand via the rail button restores the full tree.
    await second.page.getByTestId('filetree-expand').click()
    await expect(second.page.getByTestId('side-panel')).toBeVisible()
    await expect(second.page.getByTestId('filetree-collapse')).toBeVisible()
    expect((await getLayout(second.page)).fileTreeCollapsed).toBe(false)
    await second.app.close()
  })

  test('T-049 — both columns collapsed gives the editor essentially the full window; expanding both restores', async () => {
    const { app, page } = await launch(fixture)
    const full = await page.getByTestId('panehost').boundingBox()

    await clickMenuItem(app, 'menu-toggle-projects-panel')
    await clickMenuItem(app, 'menu-toggle-filetree')

    // Both columns are now thin (Projects panel rail, icon strip); both dividers are hidden.
    await expect(page.getByTestId('projects-panel-rail')).toBeVisible()
    await expect(page.getByTestId('side-panel')).toBeHidden()
    await expect(page.getByTestId('divider-projects-panel')).toHaveCount(0)
    await expect(page.getByTestId('divider-filetree')).toHaveCount(0)

    // The editor now spans nearly the whole window (only the rail and the strip sit beside it).
    const both = await page.getByTestId('panehost').boundingBox()
    const shell = await page.getByTestId('app-shell').boundingBox()
    expect(both!.width).toBeGreaterThan(full!.width)
    expect(both!.width).toBeGreaterThan(shell!.width - 2 * LAYOUT_LIMITS.railWidth - 40)

    // No horizontal overflow at this extreme.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    )
    expect(overflow).toBe(true)

    // Expand both → full Projects panel + tree + both dividers are back.
    await page.getByTestId('projects-panel-expand').click()
    await page.getByTestId('filetree-expand').click()
    await expect(page.getByTestId('projects-panel-rail')).toHaveCount(0)
    await expect(page.getByTestId('side-panel')).toBeVisible()
    await expect(page.getByTestId('divider-projects-panel')).toBeVisible()
    await expect(page.getByTestId('divider-filetree')).toBeVisible()
    await app.close()
  })

  test('T-049 — a live terminal keeps its xterm + PTY across a tree collapse/expand (no remount)', async () => {
    const { app, page } = await launch(fixture)
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    // Open a terminal.
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()

    const pane = page.locator('[data-term-id][data-status="live"]:visible').first()
    await expect(pane).toBeVisible()
    await expect(pane).toHaveAttribute('data-mount-id', /.+/)
    await expect(pane).toHaveAttribute('data-term-id', /.+/)
    const mountId = await pane.getAttribute('data-mount-id')
    const termId = await pane.getAttribute('data-term-id')

    // Collapse and re-expand the tree column.
    await clickMenuItem(app, 'menu-toggle-filetree')
    await clickMenuItem(app, 'menu-toggle-filetree')

    // Same DOM instance (data-mount-id unchanged ⇒ no remount) and still live.
    const paneAfter = page.locator(`[data-term-id="${termId}"]:visible`)
    await expect(paneAfter).toHaveAttribute('data-mount-id', mountId!)
    await expect(paneAfter).toHaveAttribute('data-status', 'live')

    // The PTY was never killed/restarted.
    const alive = await page.evaluate(
      (tid) => window.pomade.pty
        .list()
        .then((l) => l.some((t) => t.termId === tid && t.alive)),
      termId
    )
    expect(alive).toBe(true)
    await app.close()
  })

  test('T-052 — Cmd/Ctrl+Shift+B toggles the tree on the physical key, taken in main before the page', async () => {
    const { app, page } = await launch(fixture)
    // Through Electron's input pipeline (main's before-input-event), which Playwright's keyboard
    // skips; main matches the physical key, so any keyboard layout works.
    await toggleSidePanelKeys(app)
    await expect(page.getByTestId('side-panel')).toBeHidden()
    await toggleSidePanelKeys(app)
    await expect(page.getByTestId('side-panel')).toBeVisible()
    await expect(page.getByTestId('filetree-collapse')).toBeVisible()
    await app.close()
  })
})
