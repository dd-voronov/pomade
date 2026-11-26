// modules: core, git, editor
// T-217 e2e — every themed tooltip fits its text and stays on screen. Short text stays on one line
// in a box that hugs it; longer text wraps inside the max width; the box never overflows its own
// border and is clamped fully inside the window (8px margin) — shifted off the left/right edges and
// flipped above the anchor near the bottom — measured after wrapping, and re-measured when the
// text changes while the tip is open.
//
// Real cases from the Document history panel / editor header: the History button
// ("Document history (Cmd+Shift+H)") and the "Show all commits" checkbox (a long
// sentence), both at the window's right edge. Generic cases move a real anchor into the bottom
// corners (the tip logic is the real one), and a commit tab's hash button changes its tip text on
// click (long -> "Copied" -> long) to check the re-measure.
// Screenshots go to POMADE_T217_SHOTS when set, else e2e/artifacts/tooltip-fit/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { launchAppPage } from './fixtures/app'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_T217_SHOTS'] || resolve(__dirname, 'artifacts/tooltip-fit')
const ALPHA = 'proj-alpha'
const DOC = 'Projects/alpha/docs/plan.md'
const MARGIN = 8

let fx: Fixture
let app: ElectronApplication
let page: Page
let fullHash: string

interface Geometry {
  tip: { left: number; top: number; right: number; bottom: number; width: number }
  anchor: { left: number; top: number; right: number; bottom: number }
  viewport: { width: number; height: number }
  /** Rendered text lines across the whole tip (distinct line boxes of every text node). */
  lines: number
  /** Nothing spills past the tip's border box: the box and every line are not overflowed. */
  fits: boolean
  /** The widest line's text width (the box hugs it for a one-line tip). */
  textWidth: number
}

/** The shown tip's geometry next to its anchor (the element the pointer is over). */
async function geometry(tip: Locator, anchor: Locator): Promise<Geometry> {
  const a = await anchor.boundingBox()
  if (!a) throw new Error('anchor not visible')
  return tip.evaluate((el, anc) => {
    const box = el.getBoundingClientRect()
    const tops = new Set<number>()
    let textWidth = 0
    let fits = el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight
    for (const line of el.querySelectorAll('span')) {
      if (line.scrollWidth > line.clientWidth) fits = false
      const r = line.getBoundingClientRect()
      if (r.left < box.left || r.right > box.right) fits = false
      const range = document.createRange()
      range.selectNodeContents(line)
      for (const rect of range.getClientRects()) {
        tops.add(Math.round(rect.top))
        textWidth = Math.max(textWidth, rect.width)
      }
    }
    return {
      tip: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width },
      anchor: { left: anc.x, top: anc.y, right: anc.x + anc.width, bottom: anc.y + anc.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      lines: tops.size,
      fits,
      textWidth
    }
  }, a)
}

/** The tip is fully inside the window with the margin (half a pixel of rounding slack). */
function expectOnScreen(g: Geometry): void {
  expect(g.tip.left).toBeGreaterThanOrEqual(MARGIN - 0.5)
  expect(g.tip.top).toBeGreaterThanOrEqual(MARGIN - 0.5)
  expect(g.tip.right).toBeLessThanOrEqual(g.viewport.width - MARGIN + 0.5)
  expect(g.tip.bottom).toBeLessThanOrEqual(g.viewport.height - MARGIN + 0.5)
}

async function shot(name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const vis = (sel: string): Locator => page.locator(`${sel}:visible`)
const tipOf = (text: string): Locator => page.locator('[role="tooltip"]', { hasText: text })

/** Park the pointer away so no tooltip lingers, then hover `target`. */
async function hover(target: Locator): Promise<void> {
  await page.mouse.move(2, 2)
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0)
  await target.hover()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  const alpha = join(fx.workspaceRoot, 'Projects/alpha')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(alpha, 'docs/plan.md'), '# Plan\n\nOne.\n')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'Initial plan')
  await write(join(alpha, 'docs/plan.md'), '# Plan\n\nOne.\n\nTwo.\n')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-11T09:00:00', '-m', 'Add two')
  fullHash = git(alpha, 'rev-parse', 'HEAD').trim()
  ;({ app, page } = await launchAppPage(fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', ALPHA)
  await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: ALPHA, f: DOC }
  )
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(vis('[data-testid="doc-history"]')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('the History button tip, at the right edge, is one line and inside the window', async () => {
  const button = vis('[data-testid="doc-history-toggle"]')
  await hover(button)
  const tip = tipOf('Document history')
  await expect(tip).toBeVisible()
  const g = await geometry(tip, button)
  // Setup guard: the button really is at the window's right edge.
  expect(g.viewport.width - g.anchor.right).toBeLessThan(200)
  expectOnScreen(g)
  expect(g.fits).toBe(true)
  expect(g.lines).toBe(1)
  await shot('history-button-tip')
})

test('the "Show all commits" tip, at the right edge, wraps inside its box and stays on screen', async () => {
  const toggle = vis('[data-testid="history-show-all"]')
  await expect(toggle).toBeVisible()
  await hover(toggle)
  const tip = tipOf('Every commit that touched the file')
  await expect(tip).toBeVisible()
  const g = await geometry(tip, toggle)
  expect(g.viewport.width - g.anchor.right).toBeLessThan(200)
  expectOnScreen(g)
  expect(g.fits).toBe(true)
  expect(g.lines).toBeGreaterThanOrEqual(2)
  expect(g.tip.width).toBeLessThanOrEqual(320 + 0.5)
  await expect(tip).toContainText('not only the branch’s own line')
  await shot('show-all-commits-tip')
})

test('a short tip stays on one line, its box hugging the text', async () => {
  const close = vis('[data-testid="history-close"]')
  await hover(close)
  const tip = tipOf('Close history')
  await expect(tip).toBeVisible()
  const g = await geometry(tip, close)
  expect(g.lines).toBe(1)
  expect(g.fits).toBe(true)
  // Box = text + 9px padding and 1px border per side.
  expect(g.tip.width).toBeLessThanOrEqual(g.textWidth + 2 * (9 + 1) + 1)
  expectOnScreen(g)
})

for (const corner of ['right', 'left'] as const) {
  test(`a long tip anchored at the bottom-${corner} corner flips above and stays on screen`, async () => {
    const toggle = vis('[data-testid="history-show-all"]')
    await toggle.evaluate((el, side) => {
      el.style.position = 'fixed'
      el.style.bottom = '2px'
      el.style[side] = '2px'
      el.style.zIndex = '5'
    }, corner)
    await hover(toggle)
    const tip = tipOf('Every commit that touched the file')
    await expect(tip).toBeVisible()
    const g = await geometry(tip, toggle)
    expectOnScreen(g)
    expect(g.fits).toBe(true)
    expect(g.lines).toBeGreaterThanOrEqual(2)
    // Opens upward: the whole tip is above the anchor.
    expect(g.tip.bottom).toBeLessThanOrEqual(g.anchor.top)
    await shot(`bottom-${corner}-corner`)
    await toggle.evaluate((el) => el.removeAttribute('style'))
  })
}

test('the tip re-measures when its text changes while open', async () => {
  await page.evaluate(
    ({ p, hash }) =>
      window.__pomadeStores.useTabsStore.getState().openTab({
        id: 'commit-t217',
        projectId: p,
        kind: 'commit',
        repo: 'Projects/alpha',
        hash,
        title: 'Add two'
      }),
    { p: ALPHA, hash: fullHash }
  )
  const pane = page.locator(`[data-testid="commit-pane"][data-hash="${fullHash}"]`)
  await expect(pane).toBeVisible()
  const hashBtn = pane.getByTestId('commit-hash-copy')
  await hashBtn.evaluate((el) => {
    el.style.position = 'fixed'
    el.style.right = '2px'
    el.style.top = '40%'
    el.style.zIndex = '5'
  })
  await hover(hashBtn)
  const long = tipOf('Copy the full hash')
  await expect(long).toBeVisible()
  const before = await geometry(long, hashBtn)
  expectOnScreen(before)
  expect(before.fits).toBe(true)

  await hashBtn.click()
  const copied = page.locator('[role="tooltip"]', { hasText: /^Copied$/ })
  await expect(copied).toBeVisible()
  const g = await geometry(copied, hashBtn)
  expectOnScreen(g)
  expect(g.fits).toBe(true)
  expect(g.lines).toBe(1)
  expect(g.tip.width).toBeLessThan(before.tip.width)
  // Re-clamped for its NEW width: flush against the right margin like the anchor it hangs under
  // (a stale position from the long text would leave it short of the margin).
  const centre = (g.anchor.left + g.anchor.right) / 2
  const expectedLeft = Math.max(MARGIN, Math.min(centre - g.tip.width / 2, g.viewport.width - g.tip.width - MARGIN))
  expect(Math.abs(g.tip.left - expectedLeft)).toBeLessThanOrEqual(1)
  await shot('retext-copied')

  // And back to the long text when the label reverts.
  await expect(tipOf('Copy the full hash')).toBeVisible({ timeout: 5000 })
  const back = await geometry(tipOf('Copy the full hash'), hashBtn)
  expectOnScreen(back)
  expect(back.fits).toBe(true)
})
