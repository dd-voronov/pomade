// modules: editor, tabs, filetree, terminal, agents
// Pomade T-088 e2e — every pointer-positioned menu stays INSIDE the viewport.
//
// All four renderer-built context menus (editor, tab strip, file tree, terminal) open at the
// pointer and grow down-right, so a right-click near the bottom/right edge of the window used to
// push their lower/right items off-screen — unreachable. The clamp now lives in ONE shared hook
// (src/renderer/hooks/use-clamped-position.ts, 8px margin, measured before paint); this file
// pins it for all four, plus the editor's agents submenu, which flips to the LEFT of its parent
// menu when there is no room on the right.
//
// Every menu is opened with a REAL right-click aimed at the bottom-right corner of the surface
// that owns it (the only input the clamp has is the pointer position), and the assertion is
// purely geometric: the menu's box fits within [8, viewport - 8] on both axes.

import {
  test,
  expect,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

// Must match OVERLAY_MARGIN in src/renderer/hooks/use-clamped-position.ts.
const MARGIN = 8
const ALPHA = 'proj-alpha'
// Enough doc tabs to fill the strip end to end, so the rightmost tab sits at the right edge of
// the window and its menu has nowhere to go but left.
const TAB_COUNT = 10

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): Locator => page.locator(`${sel}:visible`)

/** A wide-titled doc tab per file, restored through the app's own state path. */
async function seedTabs(root: string): Promise<void> {
  const openTabs = []
  for (let i = 1; i <= TAB_COUNT; i++) {
    const name = `clamp-document-${String(i).padStart(2, '0')}.md`
    await fs.writeFile(
      join(root, 'Projects/alpha', name),
      `# Clamp ${i}\n\nSome prose in document ${i} to right-click on.\n`
    )
    openTabs.push({
      id: `doc-clamp-${i}`,
      projectId: ALPHA,
      kind: 'doc',
      title: name,
      path: `Projects/alpha/${name}`,
      mode: 'raw',
      dirty: false
    })
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state/proj-alpha.json'),
    JSON.stringify({ openTabs, activeTabId: 'doc-clamp-1' }, null, 2)
  )
}

function viewport(): Promise<{ w: number; h: number }> {
  return page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator).toBeVisible()
  const b = await locator.boundingBox()
  if (!b) throw new Error('no bounding box')
  return b
}

/** The visible tab whose right edge is furthest right within width `w` (the strip scrolls
 *  horizontally, so tabs past the window edge are skipped). */
async function rightmostVisibleTab(tabs: Locator, w: number): Promise<Locator> {
  let target: Locator | null = null
  let best = -Infinity
  for (let i = 0; i < (await tabs.count()); i++) {
    const t = tabs.nth(i)
    const b = await t.boundingBox()
    if (!b || b.width === 0) continue
    const right = b.x + b.width
    if (right <= w && right > best) {
      best = right
      target = t
    }
  }
  if (!target) throw new Error('no visible tab')
  return target
}

/** The clamp contract: fully inside the viewport, never closer than MARGIN to any edge. */
async function expectInsideViewport(locator: Locator, what: string): Promise<void> {
  const { w, h } = await viewport()
  const b = await box(locator)
  expect(b.width, `${what} has width`).toBeGreaterThan(0)
  expect(b.height, `${what} has height`).toBeGreaterThan(0)
  expect(b.x, `${what} left edge`).toBeGreaterThanOrEqual(MARGIN - 1)
  expect(b.y, `${what} top edge`).toBeGreaterThanOrEqual(MARGIN - 1)
  expect(b.x + b.width, `${what} right edge (viewport ${w})`).toBeLessThanOrEqual(w - MARGIN + 1)
  expect(b.y + b.height, `${what} bottom edge (viewport ${h})`).toBeLessThanOrEqual(h - MARGIN + 1)
}

/** Right-click a few px inside the bottom-right corner of `surface`. */
async function rightClickBottomRight(surface: Locator, inset = 6): Promise<void> {
  const b = await box(surface)
  await surface.click({
    button: 'right',
    position: { x: Math.max(1, b.width - inset), y: Math.max(1, b.height - inset) }
  })
}

test.describe('T-088 — context menus stay inside the viewport', () => {
  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedTabs(fixture.workspaceRoot)
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${ALPHA}`).click()
    // Activate a doc tab so its editor pane is mounted for the editor-menu tests.
    await page.getByTestId('tab-doc-clamp-1').click()
    await expect(vis('[data-testid="editor-pane"]')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // ── the editor menu (was missing the clamp) ──────────────────────────────────
  test('editor menu opened at the bottom-right of the pane stays inside', async () => {
    const pane = vis('[data-testid="editor-pane"]')
    await expect(pane).toBeVisible()
    // The pane's own bottom-right corner: the editor body fills it, so this is a right-click on
    // the document, as low and as far right as the window allows.
    await rightClickBottomRight(pane)

    // T-083 round 2 — this menu mounts ASYNCHRONOUSLY (parked in onContextMenu, mounted on main's
    // EV.spellContext push). Playwright's auto-wait covers the gap.
    const menu = vis('[data-testid="editor-context-menu"]')
    await expect(menu).toBeVisible()
    await expectInsideViewport(menu, 'editor menu')
    // The clamp must have actually moved it (otherwise the assertion above proves nothing).
    const { h } = await viewport()
    const b = await box(menu)
    expect(b.y + b.height).toBeLessThanOrEqual(h - MARGIN + 1)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('editor agents submenu flips to the LEFT near the right edge', async () => {
    const pane = vis('[data-testid="editor-pane"]')
    await rightClickBottomRight(pane)
    const menu = vis('[data-testid="editor-context-menu"]')
    await expect(menu).toBeVisible()

    await vis('[data-testid="menu-new-agent-chat"]').click()
    const submenu = vis('[data-testid="menu-agent-submenu"]')
    await expect(submenu).toBeVisible()
    await expect(submenu).toHaveAttribute('data-flipped', 'true')
    await expectInsideViewport(submenu, 'editor agents submenu')
    // Flipped means it hangs off the parent menu's LEFT side (the flyout's right edge lands on
    // the parent's content box, i.e. within its 4px padding — never over its items).
    const parent = await box(menu)
    const sub = await box(submenu)
    expect(sub.x).toBeLessThan(parent.x)
    expect(sub.x + sub.width).toBeLessThanOrEqual(parent.x + 8)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  // ── the tab menu (was missing the clamp) ─────────────────────────────────────
  test('tab menu opened on the rightmost tab stays inside', async () => {
    const { w } = await viewport()
    const tabs = page.locator('[data-testid="tabstrip-scroll"] [role="tab"]')
    expect(await tabs.count()).toBeGreaterThan(1)
    const target = await rightmostVisibleTab(tabs, w)
    // Right-click at the tab's far-right edge — the pointer as close to the window edge as a tab
    // gesture can get.
    const tb = await box(target)
    await target.click({ button: 'right', position: { x: tb.width - 3, y: tb.height / 2 } })

    const menu = page.getByTestId('tab-context-menu')
    await expect(menu).toBeVisible()
    await expectInsideViewport(menu, 'tab menu')

    // Its color submenu flies out of the row and must stay on-screen too (flipping if needed).
    await page.getByTestId('menu-tab-color').click()
    const submenu = page.getByTestId('menu-tab-color-submenu')
    await expect(submenu).toBeVisible()
    await expectInsideViewport(submenu, 'tab color submenu')

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  // ── the file tree menu (already clamped — regression guard on the migration) ──
  test('file tree menu opened at the bottom of the tree stays inside', async () => {
    const body = page.getByTestId('tree-body')
    // The empty area low in the tree body → the root-scoped menu, anchored at the pointer.
    await rightClickBottomRight(body, 12)
    const menu = page.getByTestId('tree-menu')
    await expect(menu).toBeVisible()
    await expectInsideViewport(menu, 'tree menu')

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  // ── the terminal menu (already clamped — regression guard on the migration) ───
  test('terminal menu opened at the bottom-right of the pane stays inside', async () => {
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()
    const pane = page.locator('[data-term-id]:visible').first()
    await expect(pane).toBeVisible()
    await expect(pane.locator('.xterm-screen')).toBeVisible() // xterm has opened into the pane

    await rightClickBottomRight(pane)
    const menu = page.getByTestId('terminal-menu')
    await expect(menu).toBeVisible()
    await expectInsideViewport(menu, 'terminal menu')

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  // ── T-088 round 2 — vertical overflow FLIPS UP, it doesn't slide (the Owner) ────
  // A click in the lower-middle is the discriminating case: the round-1 clamp slid the menu
  // to bottom = viewport - 8 (extending BELOW the click, pointer left mid-menu); the flip
  // anchors the menu's BOTTOM at the click and opens upward. At the very bottom edge the
  // two converge, so this test clicks ~150px above it.
  test('no room below ⇒ the menu opens UPWARD with its bottom at the click', async () => {
    await page.getByTestId('tab-doc-clamp-1').click()
    const pane = vis('[data-testid="editor-pane"]')
    await expect(pane).toBeVisible()
    const pb = await box(pane)
    const clickX = pb.x + Math.min(300, pb.width / 2)
    const clickY = pb.y + pb.height - 150
    await page.mouse.click(clickX, clickY, { button: 'right' })

    const menu = vis('[data-testid="editor-context-menu"]')
    await expect(menu).toBeVisible()
    await expectInsideViewport(menu, 'editor menu (flip-up)')
    const b = await box(menu)
    // Tall enough that "fits below" can't apply — otherwise this test proves nothing.
    expect(b.height).toBeGreaterThan(150)
    // Bottom anchored at the click (±1 for rounding)…
    expect(Math.abs(b.y + b.height - clickY)).toBeLessThanOrEqual(1)
    // …and the body genuinely above it.
    expect(b.y).toBeLessThan(clickY - 100)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  // ── 2026-07-28 (the Owner report) — the FILE-ROW menu low on the screen, not just the root
  // menu on empty space: the row menu is much taller (Trash/Copy path/… sections), so "stays
  // inside" for the short root menu proved nothing about "Copy path is reachable". Fill the
  // tree past the fold, right-click the lowest visible row, and require the flip contract:
  // bottom anchored at the click, Copy path visible and clickable.
  test('file-ROW menu low in the tree flips up and Copy path is reachable', async () => {
    // Grow the tree well past the viewport via the live watcher (files appear without reopen).
    for (let i = 1; i <= 60; i++) {
      await fs.writeFile(
        join(fixture.workspaceRoot, 'Projects/alpha', `zz-clamp-filler-${String(i).padStart(2, '0')}.md`),
        `filler ${i}\n`
      )
    }
    const lastRow = page.getByTestId('tree-node-Projects/alpha/zz-clamp-filler-60.md')
    await lastRow.scrollIntoViewIfNeeded()
    await expect(lastRow).toBeVisible({ timeout: 10_000 })

    // The discriminating anchor: a row whose menu cannot fit below it.
    const rb = await box(lastRow)
    const { h } = await viewport()
    expect(rb.y, 'row must sit in the lower half for this to prove anything').toBeGreaterThan(h / 2)
    const clickY = rb.y + rb.height / 2
    await lastRow.click({ button: 'right' })

    const menu = page.getByTestId('tree-menu')
    await expect(menu).toBeVisible()
    await expectInsideViewport(menu, 'tree row menu')
    const mb = await box(menu)
    // Too tall to fit below the click — otherwise this test proves nothing about the flip.
    expect(mb.height, 'menu cannot fit below the click').toBeGreaterThan(h - clickY - MARGIN)
    // Flip contract (T-088 r2): bottom anchored at the click, body above it.
    expect(Math.abs(mb.y + mb.height - clickY)).toBeLessThanOrEqual(1)
    const copyPath = page.getByTestId('menu-copy-path')
    await expect(copyPath).toBeVisible()
    const cb = await box(copyPath)
    expect(cb.y + cb.height, 'Copy path fully on-screen').toBeLessThanOrEqual(h - MARGIN + 1)
    await copyPath.click()
    await expect(menu).toHaveCount(0)
  })
})
