// modules: tabs
// Pomade T-062 (edge autoscroll) e2e — a tab drag near either edge of an OVERFLOWING strip must
// pan the strip so the drop target can be off-screen.
//
// This used to be Chromium's own drag autoscroll (no app code): dragging a tab to the scroller's
// edge scrolled it. That native behaviour degraded on the Electron 33→44 Chromium jump — and even
// at its best it only covered the `.tabs` SCROLLER edges, never the strip's visual RIGHT edge,
// which is the TerminalActions cluster (a sibling with margin-left:auto, not part of the scroller).
// So the right edge never panned at all and the left edge panned only barely — the Owner's report.
// TabStrip now drives the pan explicitly off the drag-lifetime window `dragover`, measured against
// the whole strip's width, so both edges pan deterministically regardless of Chromium version.
//
// Native HTML5 DnD is not driven by Playwright mouse gestures, so — like tab-drop-indicator.spec.ts
// — we share ONE real DataTransfer across dragstart → dragover → dragend and assert the scroller's
// scrollLeft. (This is also why the pan is app code and not left to the browser: synthetic drag
// events, and — as it turns out — Chromium 44 itself, do not trigger native autoscroll.)

import {
  test,
  expect,
  type ElectronApplication,
  type JSHandle,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { afterFiveFrames } from './fixtures/hello-app'
import { expectQuiet } from './fixtures/timing'

const WORKSPACE_ID = '__workspace__'
// Enough tabs that the strip overflows its width at the 1360px test window (asserted below).
const DOC_COUNT = 28
const DOCS = Array.from({ length: DOC_COUNT }, (_, i) => `autoscroll-${String(i).padStart(2, '0')}.txt`)

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

/** Seed many real doc tabs directly via the store (openDocByPath) — fast, no per-tab tree clicks. */
async function seedDocs(page: Page, pid: string, rels: string[]): Promise<void> {
  await page.evaluate(
    ({ p, paths }) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      for (const path of paths) s.openDocByPath(p, path)
    },
    { p: pid, paths: rels }
  )
  await expect.poll(() => tabIdsOf(page, pid).then((t) => t.length)).toBe(rels.length)
}

/** The `.tabs` overflow scroller's current scrollLeft. */
function scrollLeft(page: Page): Promise<number> {
  return page.getByTestId('tabstrip-scroll').evaluate((el) => (el as HTMLElement).scrollLeft)
}

/** Its max scrollable extent (scrollWidth - clientWidth) — > 0 iff the strip actually overflows. */
function maxScroll(page: Page): Promise<number> {
  return page
    .getByTestId('tabstrip-scroll')
    .evaluate((el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth)
}

test.describe('T-062 tab drag pans an overflowing strip at both edges', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    for (const name of DOCS) {
      await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha', name), `${name}\n`)
    }
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.beforeEach(async () => {
    await page.getByTestId(`project-${alpha}`).click()
    await resetTabs(page, [alpha, WORKSPACE_ID])
    await seedDocs(page, alpha, DOCS.map((n) => `Projects/alpha/${n}`))
    // Precondition: the strip genuinely overflows, otherwise the pan has nothing to prove.
    expect(await maxScroll(page)).toBeGreaterThan(100)
    // Start from the left edge.
    await page.getByTestId('tabstrip-scroll').evaluate((el) => ((el as HTMLElement).scrollLeft = 0))
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  async function startDrag(): Promise<JSHandle<DataTransfer>> {
    const dt = await page.evaluateHandle(() => new DataTransfer())
    const ids = await tabIdsOf(page, alpha)
    await page.getByTestId(`tab-${ids[0]}`).dispatchEvent('dragstart', { dataTransfer: dt })
    return dt
  }

  async function dragOverAt(dt: JSHandle<DataTransfer>, clientX: number): Promise<void> {
    const strip = (await page.getByTestId('tabstrip').boundingBox())!
    await page.getByTestId('tabstrip').dispatchEvent('dragover', {
      dataTransfer: dt,
      clientX: Math.round(clientX),
      clientY: Math.round(strip.y + strip.height / 2)
    })
  }

  test('dragging to the RIGHT edge pans the strip right (the edge that was dead)', async () => {
    const strip = (await page.getByTestId('tabstrip').boundingBox())!
    expect(await scrollLeft(page)).toBe(0)
    const dt = await startDrag()
    // The far right edge is the actions cluster region — outside the `.tabs` scroller. It must pan.
    // Re-dispatch dragover on each poll: the drag-lifetime window listener attaches on the render
    // after dragstart, so a single event can land before it exists; re-arming direction each poll
    // is race-free (the rAF loop accumulates once the direction is set).
    const rightX = strip.x + strip.width - 4
    await expect
      .poll(async () => {
        await dragOverAt(dt, rightX)
        return scrollLeft(page)
      })
      .toBeGreaterThan(100)
    await page.getByTestId('tabstrip').dispatchEvent('dragend', { dataTransfer: dt })
  })

  test('dragging to the LEFT edge pans the strip back left', async () => {
    const strip = (await page.getByTestId('tabstrip').boundingBox())!
    // Start scrolled to the far right.
    const max = await maxScroll(page)
    await page
      .getByTestId('tabstrip-scroll')
      .evaluate((el, m) => ((el as HTMLElement).scrollLeft = m), max)
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(max - 4)
    const dt = await startDrag()
    const leftX = strip.x + 4
    await expect
      .poll(async () => {
        await dragOverAt(dt, leftX)
        return scrollLeft(page)
      })
      .toBeLessThan(max - 100)
    await page.getByTestId('tabstrip').dispatchEvent('dragend', { dataTransfer: dt })
  })

  test('a drag hovering the strip MIDDLE does not pan (control)', async () => {
    const strip = (await page.getByTestId('tabstrip').boundingBox())!
    const dt = await startDrag()
    // First prove the pan loop is genuinely live for this drag (right edge moves it)...
    const rightX = strip.x + strip.width - 4
    await expect
      .poll(async () => {
        await dragOverAt(dt, rightX)
        return scrollLeft(page)
      })
      .toBeGreaterThan(100)
    // ...then hover the MIDDLE and let the pan direction settle to zero (one final right-edge
    // frame may still land between the poll above and this hover — that is why the baseline is
    // captured AFTER settling, not from a manually set offset). With the pointer parked mid-strip
    // the live loop must leave scrollLeft exactly where it is.
    const midX = strip.x + strip.width / 2
    await dragOverAt(dt, midX)
    // Settled = scrollLeft holds across five animation frames (the pan loop runs per frame).
    await expect
      .poll(async () => {
        const before = await scrollLeft(page)
        await afterFiveFrames(page)
        return (await scrollLeft(page)) === before
      })
      .toBe(true)
    const baseline = await scrollLeft(page)
    // The pointer keeps hovering mid-strip (a dragover every 40 ms); scrollLeft never moves.
    await expectQuiet(
      async () => {
        await dragOverAt(dt, midX)
        expect(await scrollLeft(page)).toBe(baseline)
      },
      240,
      40
    )
    await page.getByTestId('tabstrip').dispatchEvent('dragend', { dataTransfer: dt })
  })
})
