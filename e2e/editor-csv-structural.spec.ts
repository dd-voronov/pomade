// modules: editor
// Pomade T-051 — CSV table structural edits (Excel-like insert/delete row & column) via the
// right-click menu on row-number / column headers. Each op round-trips losslessly to disk;
// quoting is preserved on a quoted fixture; undo restores.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchAppPage } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const PID = 'proj-alpha'
const SIMPLE = 'name,role,city\nAda,Engineer,London\nGrace,Admiral,New York\n'
// Quoted: embedded comma + escaped quote — must survive a structural op byte-for-byte.
const QUOTED = 'a,b,c\n"x,y","p""q",z\n1,2,3\n'

function docTab(id: string, name: string): Record<string, unknown> {
  return { id, projectId: PID, kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode: 'rendered', dirty: false }
}

async function seed(fixture: Fixture, name: string, content: string): Promise<void> {
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', name), content)
  const state = { openTabs: [docTab('doc-csv', name)], activeTabId: 'doc-csv' }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launchAppPage(fixture)
  await expect
    .poll(() => page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().hydrated))
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
  await page.getByTestId('tab-doc-csv').click()
  await expect(vis(page, '[data-testid="csv-table"]')).toBeVisible()
  return { app, page }
}

const read = (fixture: Fixture, name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

test.describe('T-051 — CSV structural edits', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('insert column right of the first column → round-trips to disk', async () => {
    await seed(fixture, 'simple.csv', SIMPLE)
    const { app, page } = await launch(fixture)
    await page.getByTestId('csv-col-header-0').click({ button: 'right' })
    await vis(page, '[data-testid="csv-menu-insert-col-right"]').click()
    await page.keyboard.press(`${MOD}+s`)
    await expect
      .poll(() => read(fixture, 'simple.csv'))
      .toBe('name,,role,city\nAda,,Engineer,London\nGrace,,Admiral,New York\n')
    await app.close()
  })

  test('delete a column → round-trips to disk', async () => {
    await seed(fixture, 'simple.csv', SIMPLE)
    const { app, page } = await launch(fixture)
    await page.getByTestId('csv-col-header-2').click({ button: 'right' }) // "city"
    await vis(page, '[data-testid="csv-menu-delete-col"]').click()
    await page.keyboard.press(`${MOD}+s`)
    await expect
      .poll(() => read(fixture, 'simple.csv'))
      .toBe('name,role\nAda,Engineer\nGrace,Admiral\n')
    await app.close()
  })

  test('insert row below the first data row → round-trips to disk', async () => {
    await seed(fixture, 'simple.csv', SIMPLE)
    const { app, page } = await launch(fixture)
    await page.getByTestId('csv-row-header-0').click({ button: 'right' }) // Ada
    await vis(page, '[data-testid="csv-menu-insert-row-below"]').click()
    await page.keyboard.press(`${MOD}+s`)
    await expect
      .poll(() => read(fixture, 'simple.csv'))
      .toBe('name,role,city\nAda,Engineer,London\n,,\nGrace,Admiral,New York\n')
    await app.close()
  })

  test('delete a row → round-trips; undo restores it', async () => {
    await seed(fixture, 'simple.csv', SIMPLE)
    const { app, page } = await launch(fixture)
    const table = vis(page, '[data-testid="csv-table"]')
    await expect(table.locator('tbody tr')).toHaveCount(2)

    await page.getByTestId('csv-row-header-0').click({ button: 'right' }) // Ada
    await vis(page, '[data-testid="csv-menu-delete-row"]').click()
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => read(fixture, 'simple.csv')).toBe('name,role,city\nGrace,Admiral,New York\n')

    // Undo restores the deleted row (table host is focused after a structural op).
    await page.keyboard.press(`${MOD}+z`)
    await expect(table.locator('tbody tr')).toHaveCount(2)
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => read(fixture, 'simple.csv')).toBe(SIMPLE)
    await app.close()
  })

  test('quoting is preserved when inserting a column on a quoted fixture', async () => {
    await seed(fixture, 'quoted.csv', QUOTED)
    const { app, page } = await launch(fixture)
    await page.getByTestId('csv-col-header-0').click({ button: 'right' })
    await vis(page, '[data-testid="csv-menu-insert-col-right"]').click()
    await page.keyboard.press(`${MOD}+s`)
    // The quoted cells ("x,y", "p""q") are byte-identical; only an empty column was added.
    await expect
      .poll(() => read(fixture, 'quoted.csv'))
      .toBe('a,,b,c\n"x,y",,"p""q",z\n1,,2,3\n')
    await app.close()
  })

  test('deleting the last remaining row is refused (1×1 minimum)', async () => {
    await seed(fixture, 'one.csv', 'name,role\nAda,Engineer\n')
    const { app, page } = await launch(fixture)
    const table = vis(page, '[data-testid="csv-table"]')
    await expect(table.locator('tbody tr')).toHaveCount(1)
    await page.getByTestId('csv-row-header-0').click({ button: 'right' })
    await expect(vis(page, '[data-testid="csv-menu-delete-row"]')).toBeDisabled()
    await app.close()
  })

  // T-158 — the CSV header menu never had the shared viewport clamp (raw click coords). A
  // right-click on a row header low in a tall table used to hang the menu off the bottom edge; it
  // now renders through the shared ContextMenu primitive and clamps. Revert-proven: on the
  // pre-migration raw-coords menu the bottom-edge assertion FAILS (menu extends past the viewport).
  test('header menu on a row low in the table clamps inside the viewport', async () => {
    const MARGIN = 8 // must match OVERLAY_MARGIN in use-clamped-position.ts
    const rows = Array.from({ length: 60 }, (_, i) => `r${i},v${i}`).join('\n')
    await seed(fixture, 'tall.csv', `name,role\n${rows}\n`)
    const { app, page } = await launch(fixture)

    // The lowest row header, scrolled to the bottom of the pane, sits near the window's edge — the
    // only input the clamp has is the pointer position.
    const lastHeader = page.getByTestId('csv-row-header-59')
    await lastHeader.scrollIntoViewIfNeeded()
    await expect(lastHeader).toBeVisible()
    const hb = present(await lastHeader.boundingBox(), 'row header box')
    const { h } = await page.evaluate(() => ({ h: window.innerHeight }))
    expect(hb.y, 'row header must sit in the lower half for this to prove anything').toBeGreaterThan(h / 2)

    await lastHeader.click({ button: 'right' })
    const menu = vis(page, '[data-testid="csv-header-menu"]')
    await expect(menu).toBeVisible()
    const mb = present(await menu.boundingBox(), 'menu box')
    expect(mb.height, 'menu has height').toBeGreaterThan(0)
    // The clamp contract: the menu's bottom edge stays inside the viewport (pre-migration it did not).
    expect(mb.y + mb.height, `menu bottom within viewport ${h}`).toBeLessThanOrEqual(h - MARGIN + 1)
    await app.close()
  })

  // T-158 — the tab-strip bulk-actions menu (TerminalActions) also never had the shared clamp: it
  // was a CSS-anchored dropdown (position:absolute) with no viewport guard, so in a short window it
  // hung off the bottom edge. It now opens through the shared ContextMenu primitive and clamps.
  // Revert-proven: on the pre-migration absolute-positioned menu the bottom-edge assertion FAILS.
  // (A tab-strip menu, not a CSV one, but this per-test-launch light spec already renders the
  //  strip; kept here to stay off the heavy real-zsh partition.)
  test('bulk-actions menu clamps inside a short window', async () => {
    const MARGIN = 8
    await seed(fixture, 'simple.csv', SIMPLE)
    const { app, page } = await launch(fixture)

    // Shrink the window so a naive dropdown below the top-strip button would overflow the bottom.
    // The app pins minHeight: 600, so lower the minimum before resizing.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const [width] = w.getContentSize()
      w.setMinimumSize(400, 120)
      w.setContentSize(width, 160)
    })
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(220)

    await page.getByTestId('bulk-actions').click()
    const menu = vis(page, '[data-testid="bulk-menu"]')
    await expect(menu).toBeVisible()
    const mb = present(await menu.boundingBox(), 'menu box')
    const h = await page.evaluate(() => window.innerHeight)
    expect(mb.height, 'menu has height').toBeGreaterThan(0)
    expect(mb.y, 'menu top within viewport').toBeGreaterThanOrEqual(MARGIN - 1)
    expect(mb.y + mb.height, `menu bottom within viewport ${h}`).toBeLessThanOrEqual(h - MARGIN + 1)
    await app.close()
  })
})
