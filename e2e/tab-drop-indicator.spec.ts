// modules: tabs
// Pomade T-119 e2e — the tab-strip drop indicator must not survive the drag that painted it.
//
// The Owner's user test (screenshot): after dragging a tab onto a Projects panel project row (the T-104
// move gesture) the 2px accent insertion line stayed painted between two tabs of the SOURCE
// strip. The drag ended outside the strip and the successful move UNMOUNTS the source tab, so
// the tab's own onDragEnd never ran — nothing cleared the hover state.
//
// This file asserts the DOM state the indicators actually use — `data-drop="before|after"` on a
// tab (T-048 between-tab line) and `data-drop-end="true"` on the end zone (T-087 "move to END")
// — for every way a drag can end: dropped on a Projects panel row, still in flight but pointing
// elsewhere, ended away from the source tab, and cancelled on the source itself. The last test
// is the positive control: a legitimate in-strip reorder still shows the line and still reorders.
//
// Native HTML5 DnD is not driven by Playwright mouse gestures, so — like tabs.spec.ts (T-048/087)
// and tab-drag-to-projects-panel.spec.ts (T-104) — we share ONE real DataTransfer across
// dragstart(on the tab) → dragover/drop(on the target) → dragend.

import {
  test,
  expect,
  type ElectronApplication,
  type JSHandle,
  type Locator,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

const WORKSPACE_ID = '__workspace__'

function tabIdsOf(page: Page, pid: string): Promise<string[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => t.id as string)
  }, pid)
}

async function resetTabs(page: Page, pids: string[]): Promise<void> {
  for (const pid of pids) {
    await page.evaluate((p) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      for (const t of [...(s.tabsByProject[p] ?? [])]) s.closeTab(p, t.id)
    }, pid)
    await expect.poll(() => tabIdsOf(page, pid).then((t) => t.length)).toBe(0)
  }
}

async function openDoc(page: Page, rel: string, pid: string): Promise<string> {
  const before = new Set(await tabIdsOf(page, pid))
  await page.getByTestId(`tree-node-${rel}`).click()
  await expect.poll(() => tabIdsOf(page, pid).then((t) => t.length)).toBeGreaterThan(before.size)
  const added = (await tabIdsOf(page, pid)).find((id) => !before.has(id))
  if (!added) throw new Error(`doc did not open: ${rel}`)
  // Commit the preview tab so the next open appends instead of replacing it.
  await page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().commitPreview(p),
    pid
  )
  return added
}

/** Every drop-indicator element currently painted in the strip (both kinds). */
function indicators(page: Page): Locator {
  return page
    .getByTestId('tabstrip')
    .locator('[data-drop="before"],[data-drop="after"],[data-drop-end="true"]')
}

/** dragover the LEFT half of a tab — the "insert before" indicator. */
async function hoverTabBefore(
  page: Page,
  tabId: string,
  dt: JSHandle<DataTransfer>
): Promise<void> {
  const tab = page.getByTestId(`tab-${tabId}`)
  const box = await tab.boundingBox()
  if (!box) throw new Error('tab has no box')
  await tab.dispatchEvent('dragover', {
    dataTransfer: dt,
    clientX: Math.round(box.x + 2),
    clientY: Math.round(box.y + box.height / 2)
  })
}

test.describe('T-119 drop indicator clears on every drag end', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string
  let beta: string
  let d1: string
  let d2: string
  let d3: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // Three real files in Alpha so the strip holds three tabs (a hovered NON-source tab is what
    // keeps the stale line visible).
    for (const name of ['t119-a.txt', 't119-b.txt', 't119-c.txt']) {
      await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha', name), `${name}\n`)
    }
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.beforeEach(async () => {
    await page.getByTestId(`project-${alpha}`).click()
    await resetTabs(page, [alpha, beta, WORKSPACE_ID])
    d1 = await openDoc(page, 'Projects/alpha/t119-a.txt', alpha)
    d2 = await openDoc(page, 'Projects/alpha/t119-b.txt', alpha)
    d3 = await openDoc(page, 'Projects/alpha/t119-c.txt', alpha)
    expect(await tabIdsOf(page, alpha)).toEqual([d1, d2, d3])
    await expect(indicators(page)).toHaveCount(0)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the between-tab line is gone once the tab is dropped on a Projects panel project row', async () => {
    const dt = await page.evaluateHandle(() => new DataTransfer())
    const source = page.getByTestId(`tab-${d1}`)
    await source.dispatchEvent('dragstart', { dataTransfer: dt })

    // Paint the indicator: hover the LEFT half of a different tab.
    await hoverTabBefore(page, d3, dt)
    await expect(page.getByTestId(`tab-${d3}`)).toHaveAttribute('data-drop', 'before')
    await expect(indicators(page)).toHaveCount(1)

    // Drag on OUT of the strip and over Beta's row: the Projects panel lights up as the move target and
    // the strip's line must already be gone — nothing should hang over mid-drag.
    const betaRow = page.getByTestId(`project-${beta}`)
    await betaRow.dispatchEvent('dragover', { dataTransfer: dt })
    await expect(betaRow).toHaveAttribute('data-tab-drop-target', 'true')
    await expect(indicators(page)).toHaveCount(0)

    // Drop = the T-104 move. The source tab unmounts, so its own dragend never fires — and the
    // strip must still come out clean.
    await betaRow.dispatchEvent('drop', { dataTransfer: dt })
    await expect.poll(() => tabIdsOf(page, alpha)).toEqual([d2, d3])
    await expect.poll(() => tabIdsOf(page, beta)).toEqual([d1])
    await expect(indicators(page)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${d3}`)).not.toHaveAttribute('data-drop', /before|after/)
  })

  test('the T-087 end-zone line is gone once the tab is dropped on a Projects panel project row', async () => {
    const dt = await page.evaluateHandle(() => new DataTransfer())
    await page.getByTestId(`tab-${d1}`).dispatchEvent('dragstart', { dataTransfer: dt })

    // Paint the END indicator (d1 is not last, so the zone is live).
    const endZone = page.getByTestId('tabstrip-end-zone')
    await endZone.dispatchEvent('dragover', { dataTransfer: dt })
    await expect(endZone).toHaveAttribute('data-drop-end', 'true')
    await expect(indicators(page)).toHaveCount(1)

    const betaRow = page.getByTestId(`project-${beta}`)
    await betaRow.dispatchEvent('dragover', { dataTransfer: dt })
    await expect(indicators(page)).toHaveCount(0)

    await betaRow.dispatchEvent('drop', { dataTransfer: dt })
    await expect.poll(() => tabIdsOf(page, alpha)).toEqual([d2, d3])
    await expect(endZone).not.toHaveAttribute('data-drop-end', 'true')
    await expect(indicators(page)).toHaveCount(0)
  })

  test('a drag that ends away from the source tab, and a cancelled drag, both leave no indicator', async () => {
    // (a) The drag ends somewhere else entirely — the real shape of the Projects panel drop, where the
    // source tab is gone by the time dragend is delivered, so no strip handler can see it.
    const dt = await page.evaluateHandle(() => new DataTransfer())
    await page.getByTestId(`tab-${d1}`).dispatchEvent('dragstart', { dataTransfer: dt })
    await hoverTabBefore(page, d3, dt)
    await expect(indicators(page)).toHaveCount(1)
    await page.getByTestId(`project-${beta}`).dispatchEvent('dragend', { dataTransfer: dt })
    await expect(indicators(page)).toHaveCount(0)
    // Nothing moved — a bare dragend is a cancel, not a drop.
    expect(await tabIdsOf(page, alpha)).toEqual([d1, d2, d3])
    expect(await tabIdsOf(page, beta)).toEqual([])

    // (b) Cancelled on the source tab itself (Esc / release over a non-target).
    const dt2 = await page.evaluateHandle(() => new DataTransfer())
    const source = page.getByTestId(`tab-${d1}`)
    await source.dispatchEvent('dragstart', { dataTransfer: dt2 })
    await hoverTabBefore(page, d2, dt2)
    await expect(page.getByTestId(`tab-${d2}`)).toHaveAttribute('data-drop', 'before')
    await source.dispatchEvent('dragend', { dataTransfer: dt2 })
    await expect(indicators(page)).toHaveCount(0)
    expect(await tabIdsOf(page, alpha)).toEqual([d1, d2, d3])
  })

  test('a legitimate in-strip reorder drag still shows the line and still reorders', async () => {
    const dt = await page.evaluateHandle(() => new DataTransfer())
    const source = page.getByTestId(`tab-${d3}`)
    await source.dispatchEvent('dragstart', { dataTransfer: dt })

    // The line follows the hovered tab across the strip, one indicator at a time.
    await hoverTabBefore(page, d2, dt)
    await expect(page.getByTestId(`tab-${d2}`)).toHaveAttribute('data-drop', 'before')
    await expect(indicators(page)).toHaveCount(1)
    await hoverTabBefore(page, d1, dt)
    await expect(page.getByTestId(`tab-${d1}`)).toHaveAttribute('data-drop', 'before')
    await expect(indicators(page)).toHaveCount(1)

    const box = (await page.getByTestId(`tab-${d1}`).boundingBox())!
    await page.getByTestId(`tab-${d1}`).dispatchEvent('drop', {
      dataTransfer: dt,
      clientX: Math.round(box.x + 2),
      clientY: Math.round(box.y + box.height / 2)
    })
    await source.dispatchEvent('dragend', { dataTransfer: dt })

    await expect.poll(() => tabIdsOf(page, alpha)).toEqual([d3, d1, d2])
    await expect(indicators(page)).toHaveCount(0)
  })
})
