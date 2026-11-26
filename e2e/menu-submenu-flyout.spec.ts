// modules: tabs, editor
// Pomade — regression guard for the T-158 shared-menu geometry break the Owner hit in npm run dev
// (Electron 44), universal to every bundle:
//
//   BUG A — the .menu shell sets `overflow-y: auto` (a last-resort guard for a menu taller than a
//   short window). Per the CSS spec, a non-`visible` overflow on ONE axis forces `visible` on the
//   other to compute to `auto` too, so `.menu` became a HORIZONTAL scroll container. An absolutely
//   positioned submenu flyout at `left: 100%` was then CLIPPED inside that scroll box (and grew its
//   scrollWidth into a spurious horizontal scrollbar) instead of flying out beside the menu — tab
//   labels read "…others / …to the right" with the panel scrolled right. Fix: the flyout is
//   `position: fixed` to the viewport (useClampedSubmenu), so it escapes every ancestor's overflow.
//
//   BUG B — the editor's ⋯ doc-actions dropdown, sharing the same shell, was widened well past the
//   standard menu by the long "New markdown opens: Rendered" label. Shortened to "New md opens:".
//
// The load-bearing assertion for A is `scrollWidth <= clientWidth` on the base menu WHILE a submenu
// is open (the pre-fix value was ~337 vs 181) — a rendered-box check (boundingBox) can't see it,
// because layout coordinates ignore ancestor clipping. Paired with `position: fixed` on the flyout,
// which is the mechanism that guarantees the escape. Revert either fix and this spec fails on a
// rebuilt bundle.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

let fixture: Fixture
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', 'flyout-doc.md'), '# Flyout\n\nbody\n')
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state/proj-alpha.json'),
    JSON.stringify(
      {
        openTabs: [
          {
            id: 'doc-flyout',
            projectId: 'proj-alpha',
            kind: 'doc',
            title: 'flyout-doc.md',
            path: 'Projects/alpha/flyout-doc.md',
            mode: 'raw',
            dirty: false
          }
        ],
        activeTabId: 'doc-flyout'
      },
      null,
      2
    )
  )
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('project-proj-alpha').click()
  await page.getByTestId('tab-doc-flyout').click()
  await expect(page.locator('[data-testid="editor-pane"]:visible')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

// ── BUG A — the flyout escapes the menu's scroll box (no horizontal clipping/scrollbar) ──
test('a tab submenu flies out beside the menu, not clipped inside it', async () => {
  await page.getByTestId('tab-doc-flyout').click({ button: 'right' })
  const menu = page.getByTestId('tab-context-menu')
  await expect(menu).toBeVisible()

  // Baseline: with no submenu open the menu is not horizontally scrollable.
  const beforeOverflow = await menu.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(beforeOverflow, 'base menu has no horizontal overflow before a submenu opens').toBeLessThanOrEqual(1)

  await page.getByTestId('menu-tab-move').click()
  const sub = page.getByTestId('menu-tab-move-submenu')
  await expect(sub).toBeVisible()

  // The load-bearing regression assertion: the OPEN submenu must not have turned the base menu
  // into a horizontal scroll container. Pre-fix (absolute `left: 100%` flyout inside an
  // `overflow-x: auto` box) this was scrollWidth ~337 vs clientWidth ~181.
  const afterOverflow = await menu.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(afterOverflow, 'base menu must NOT scroll horizontally while a submenu is open').toBeLessThanOrEqual(1)

  // The flyout is fixed to the viewport (the mechanism that lets it escape the overflow box) and
  // its body extends BEYOND the parent menu's right edge — i.e. it flies out beside it.
  const geo = await sub.evaluate((el) => ({
    position: getComputedStyle(el).position,
    right: el.getBoundingClientRect().right,
    left: el.getBoundingClientRect().left
  }))
  expect(geo.position, 'submenu flyout is position:fixed').toBe('fixed')
  const menuRight = await menu.evaluate((el) => el.getBoundingClientRect().right)
  expect(geo.right, 'flyout extends past the parent menu (flies out beside it)').toBeGreaterThan(menuRight)

  // Its items are fully reachable (Beta is a real target in the fixture).
  await expect(page.getByTestId('menu-tab-move-project-proj-beta')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

// ── BUG B — the ⋯ doc-actions dropdown is the standard, compact menu width ──
test('the editor doc-actions dropdown is not oversized', async () => {
  await page.getByTestId('doc-actions').click()
  const menu = page.getByTestId('doc-actions-menu')
  await expect(menu).toBeVisible()

  // The long default-mode label was shortened so it no longer forces an oversized panel; the
  // menu now sits at the standard min-width. Pre-fix ("New markdown opens: Rendered") was ~228px.
  const width = await menu.evaluate((el) => el.getBoundingClientRect().width)
  expect(width, 'doc-actions menu stays at the standard compact width').toBeLessThan(200)

  const label = await page.getByTestId('action-default-md-mode').textContent()
  expect(label?.trim().startsWith('New md opens:'), `label was "${label ?? ''}"`).toBe(true)

  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})
