// modules: core, projects, tabs
// Pomade T-103 e2e — the cross-project picker lists projects in EXACT Projects panel order (a
// pre-order walk of the group tree, group order shaping project order), with the Workspace
// project first and the current project excluded; and the submenu edge-clamps (T-088).
//
// The order is asserted against a GROUPED fixture whose per-group `Project.order` deliberately
// makes the Projects panel order DIFFER from a flat `order` sort (what T-097's buildAllProjects gave):
//   Group Two (order 0): Bravo, Delta   ·   Group One (order 1): Alpha   ·   Ungrouped: Charlie
//   → Projects panel order  [Bravo, Delta, Alpha, Charlie]
//   → flat-order sort [Bravo, Alpha, Charlie, Delta]  (Delta's order 1 sinks it last)
// so a picker built from the flat sort would show Charlie before Delta — the regression.
//
// State chains WITHIN each describe (one app, one window) — append, never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

const MARGIN = 8 // must match OVERLAY_MARGIN in use-clamped-position.ts

// ─── Projects panel order (grouped fixture) ──────────────────────────────────────────
test.describe('T-103 the picker lists projects in Projects panel order (grouped fixture)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  const G_ONE = 'grp-one'
  const G_TWO = 'grp-two'
  const P_ALPHA = 'p-alpha'
  const P_BRAVO = 'p-bravo'
  const P_CHARLIE = 'p-charlie'
  const P_DELTA = 'p-delta'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // A nested-group config. Group Two sorts before Group One (group order 0 vs 1); each group's
    // members carry per-group `order`. Charlie is ungrouped (sorts last, no ungroupedOrder).
    const config = {
      groups: [
        { id: G_TWO, name: 'Two', order: 0 },
        { id: G_ONE, name: 'One', order: 1 }
      ],
      projects: [
        // Written flat-order-first on purpose so a stable flat sort would mis-order Delta.
        { id: P_BRAVO, name: 'Bravo', groupId: G_TWO, rootPath: 'Projects/beta', visibleAgents: ['*'], order: 0 },
        { id: P_DELTA, name: 'Delta', groupId: G_TWO, rootPath: 'Apps/gamma', visibleAgents: ['*'], order: 1 },
        { id: P_ALPHA, name: 'Alpha', groupId: G_ONE, rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 },
        { id: P_CHARLIE, name: 'Charlie', rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 }
      ]
    }
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade/workspace.json'),
      JSON.stringify(config, null, 2),
      'utf8'
    )
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('submenu order = Projects panel order, the Workspace project first, current excluded', async () => {
    // Open Alpha (in Group One) and a doc there, so the current project is Alpha.
    await page.getByTestId(`project-${P_ALPHA}`).click()
    const before = await page.evaluate(
      (p) => (window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []).length,
      P_ALPHA
    )
    await page.getByTestId('tree-node-Projects/alpha/README.md').click()
    await expect
      .poll(() =>
        page.evaluate(
          (p) => (window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []).length,
          P_ALPHA
        )
      )
      .toBeGreaterThan(before)
    const docTab = await page.evaluate(
      (p) => window.__pomadeStores.useTabsStore.getState().tabsByProject[p].at(-1)!.id,
      P_ALPHA
    )

    await page.getByTestId(`tab-${docTab}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-move').click()
    const submenu = page.getByTestId('menu-tab-move-submenu')
    await expect(submenu).toBeVisible()

    // The Workspace project first, then EXACT Projects panel order; current project (Alpha) absent.
    await expect(submenu.locator('[role="menuitem"]')).toHaveText(['Workspace', 'Bravo', 'Delta', 'Charlie'])
    // The COPY submenu carries the identical order.
    await page.keyboard.press('Escape')
    await page.getByTestId(`tab-${docTab}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-copy-to').click()
    const copySubmenu = page.getByTestId('menu-tab-copy-to-submenu')
    await expect(copySubmenu).toBeVisible()
    await expect(copySubmenu.locator('[role="menuitem"]')).toHaveText(['Workspace', 'Bravo', 'Delta', 'Charlie'])
    await page.keyboard.press('Escape')
  })
})

// ─── Bottom-edge clamp (many projects, short window) ──────────────────────────
test.describe('T-103 the picker submenu clamps at the bottom edge', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  const CURRENT = 'p-000'
  const N = 18

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const projects = Array.from({ length: N }, (_, i) => ({
      id: `p-${String(i).padStart(3, '0')}`,
      name: `Project ${String(i).padStart(2, '0')}`,
      rootPath: 'Projects/alpha',
      visibleAgents: ['*'],
      order: i
    }))
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade/workspace.json'),
      JSON.stringify(
        { groups: [], projects },
        null,
        2
      ),
      'utf8'
    )
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    // Shrink to the minimum window height so the tall submenu genuinely overflows the bottom.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setContentSize(900, 600)
    })
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(660)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a many-project move submenu stays fully inside the viewport', async () => {
    await page.getByTestId(`project-${CURRENT}`).click()
    await page.getByTestId('tree-node-Projects/alpha/README.md').click()
    const docTab = await page.evaluate(
      (p) => window.__pomadeStores.useTabsStore.getState().tabsByProject[p].at(-1)!.id,
      CURRENT
    )

    await page.getByTestId(`tab-${docTab}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-move').click()
    const submenu = page.getByTestId('menu-tab-move-submenu')
    await expect(submenu).toBeVisible()
    // The picker offers every OTHER project + the Workspace project — tall enough to overflow at 600px.
    await expect(submenu.locator('[role="menuitem"]')).toHaveCount(N) // the Workspace project + (N-1) others

    const b = (await submenu.boundingBox())!
    const h = await page.evaluate(() => window.innerHeight)
    const w = await page.evaluate(() => window.innerWidth)
    expect(b, 'submenu has a box').toBeTruthy()
    expect(b.y, 'submenu top inside viewport').toBeGreaterThanOrEqual(MARGIN - 1)
    expect(b.y + b.height, 'submenu bottom inside viewport').toBeLessThanOrEqual(h - MARGIN + 1)
    expect(b.x + b.width, 'submenu right inside viewport').toBeLessThanOrEqual(w - MARGIN + 1)
    await page.keyboard.press('Escape')
  })
})
