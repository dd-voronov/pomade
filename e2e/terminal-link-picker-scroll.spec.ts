// modules: terminal, editor
// Pomade T-100 e2e — the terminal link-ambiguity picker is HEIGHT-BOUNDED and internally
// scrollable, so its tail rows stay reachable on a small window.
//
// The T-088 clamp positions the picker but never bounds its height. When many bare-name matches
// (up to FIND_BY_NAME_MAX = 20 two-line rows) fill a full screen, a shorter window used to push
// the tail rows off the bottom, unreachable. Since T-158 the picker rides the shared ContextMenu
// primitive, whose `.menu` shell carries `max-height: calc(100vh - 16px)` + `overflow-y: auto`;
// this spec locks that guarantee for the picker specifically.
//
// Reachability is proven by SCROLL + CLICK on the last row (which opens its file), NOT by
// boundingBox: a fixed-position box that overflows the viewport still reports a boundingBox that
// ignores the missing internal scroll, so a geometry-only assertion would pass even when the row
// is unclickable. A supporting geometry check (scrollHeight > clientHeight) proves the clamp
// actually engaged (content overflows the bounded box) rather than the menu simply fitting.

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
import { writeWhenReady } from './fixtures/stores'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// The bare filename shared by every seeded file. It exists in NO probe base (cwd / project /
// workspace root) — only inside per-index subdirs — so resolution falls through to the ambiguous
// fs.findByName leg, exactly the picker's trigger.
const DUP = 'dup-target.md'
// More than FIND_BY_NAME_MAX so the index caps the picker at 20 rows (the ticket's exact scenario:
// docs/ and Skills/ both surfaced 20).
const SEED_COUNT = 24
const CAP = 20

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  for (let i = 0; i < SEED_COUNT; i++) {
    const dir = `Projects/alpha/dup${String(i).padStart(2, '0')}`
    await write(join(f.workspaceRoot, dir, DUP), `# match ${i}\n\nbody ${i}\n`)
  }
}

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}
async function openTerminal(): Promise<string> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}
async function alphaTerminal(): Promise<string> {
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}

/** Activate TOKEN exactly as a Cmd+click would (the provider's own scan+resolve+route). */
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  await seed(fixture)
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('the ambiguity picker is height-bounded and its LAST row is scroll-reachable on a small window', async () => {
  const term = await alphaTerminal()

  // Shrink the window so the 20-row picker (two lines each) cannot fit — the discriminating case.
  // The app pins minHeight 600, so lower the minimum before resizing (mirrors editor-csv-structural).
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width] = w.getContentSize()
    w.setMinimumSize(400, 120)
    w.setContentSize(width, 240)
  })
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(280)

  await activateLink(term, DUP)

  const picker = page.getByTestId('terminal-link-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  // FIND_BY_NAME_MAX caps the matches at 20 regardless of the 24 on disk.
  const candidates = picker.locator('[data-testid^="terminal-link-candidate-"]')
  await expect(candidates).toHaveCount(CAP)

  const vh = await page.evaluate(() => window.innerHeight)

  // Geometry proof the clamp ENGAGED: the bounded box is shorter than the viewport, and its
  // content overflows it (so overflow-y:auto has something to scroll). If the fix were absent the
  // box would grow to its full content height — clientHeight === scrollHeight, and taller than vh.
  const { clientHeight, scrollHeight } = await picker.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight
  }))
  expect(clientHeight, 'picker bounded below the viewport').toBeLessThanOrEqual(vh)
  expect(scrollHeight, 'picker content overflows its bounded box (clamp engaged)').toBeGreaterThan(
    clientHeight
  )

  // Reachability proof: the LAST row must be scrollable into view and CLICKABLE — clicking it
  // opens its file. boundingBox alone would ignore the ancestor overflow clip and read the row as
  // "present" even when it hangs off-screen in a non-scrolling box, so we scroll + click for real.
  const last = picker.getByTestId(`terminal-link-candidate-${CAP - 1}`)
  await expect(last, 'last candidate carries a data-path').toHaveAttribute('data-path', /.+/)
  await last.scrollIntoViewIfNeeded()
  await last.click()

  // The click navigated: the picked doc opened in an editor pane (none existed before the click).
  await expect(picker).toHaveCount(0)
  const pane = page.locator('[data-testid="editor-pane"]:visible')
  await expect(pane).toBeVisible({ timeout: 10_000 })
})
