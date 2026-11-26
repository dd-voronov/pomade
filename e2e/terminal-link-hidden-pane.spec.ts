// modules: terminal, editor, tabs
// Pomade T-197 e2e — a Cmd+click on ONE terminal opens ONLY that pane's link; the HIDDEN panes of
// other projects must not each open a bogus file from their own buffer.
//
// The bug (regression from T-193's first-click fallback): the click-time fallback in
// `attachLinkProvider` listens on `window`, so a single Cmd+click fires the `mouseup` handler of
// EVERY mounted terminal pane — and PaneHost keeps every project's every tab mounted, hiding the
// inactive ones with `display:none`. A display:none element's getBoundingClientRect is all-zeros, so
// xterm's `getCoords` reads the raw clientX/clientY and clamps them into that hidden pane's grid;
// the fallback then resolves whatever path sits at that mapped cell — against the OTHER project's
// root — and opens it. Result: one click opened the target PLUS one or two "random" files from other
// projects, tracking the click position ("depends on which link I click").
//
// The fix gates the fallback on `container.contains(event.target)` so only the pane that actually
// received the click may act.
//
// A stray open routes to the ACTIVE project, not the pane's own: `routeProbe` opens the resolved
// path in `useWorkspaceStore.activeProjectId` (a Cmd+click never switches projects). So beta's
// hidden pane, resolving a beta path, opens it as an EXTRA tab in the currently-viewed ALPHA — with
// an orange "outside this project" badge. This is exactly what the user sees: the random files
// appear alongside the intended one, in the current view.
//
// Revert-proof: BETA (kept mounted but hidden) is filled with a full-width WALL of a resolvable
// filename, so whatever cell the click maps into beta resolves to that file. A real Cmd+click on
// ALPHA's visible link must leave ALPHA with EXACTLY ONE doc tab (its own target). With the
// containment guard stashed, beta's hidden pane resolves its wall file on the same click and
// routeProbe opens it into ALPHA → Alpha holds two doc tabs → the count assertion fails.

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
import { expectQuiet } from './fixtures/timing'
import { writeWhenReady } from './fixtures/stores'

let fixture: Fixture
let app: ElectronApplication
let page: Page

/** Unique so it resolves unambiguously (no picker) from Alpha's terminal. */
const ALPHA_DOC = 'Projects/alpha/hidden-pane-target.md'

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}

function writePty(termId: string, data: string): Promise<void> {
  return page.evaluate(({ tid, d }) => window.pomade.pty.write(tid, d), { tid: termId, d: data })
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

function rowsText(termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
    return Array.from(rows).map((r) => r.textContent ?? '').join('\n')
  }, termId)
}

/** The live grid width of a VISIBLE terminal: the longest run of a single fill char in any rendered
 *  row after a wrapping line is printed. Sizing the wall filename to exactly this fills each printed
 *  line edge-to-edge (one row, no wrap gap), so any cell the hidden pane maps into hits the token. */
async function measureCols(termId: string): Promise<number> {
  await writePty(termId, `printf '%s\\n' ${'a'.repeat(400)}\r`)
  let cols = 0
  await expect
    .poll(
      async () => {
        cols = await page.evaluate((tid) => {
          const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
          let max = 0
          for (const r of Array.from(rows)) {
            const m = (r.textContent ?? '').match(/a+/)
            if (m) max = Math.max(max, m[0].length)
          }
          return max
        }, termId)
        return cols
      },
      { timeout: 15_000 }
    )
    // A fully wrapped row equals the grid width; anything less is a mid-render read.
    .toBeGreaterThan(40)
  if (cols > 250) throw new Error(`terminal too wide for the wall filename: cols=${cols}`)
  return cols
}

/** Pixel centre of one rendered character, via a DOM Range (prompt-agnostic). */
async function charPoint(termId: string, marker: string, offsetInMarker: number): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ({ tid, mk, off }) => {
      const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
      for (const row of Array.from(rows)) {
        const idx = (row.textContent ?? '').indexOf(mk)
        if (idx < 0) continue
        let remaining = idx + off
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const len = node.textContent?.length ?? 0
          if (remaining < len) {
            const range = document.createRange()
            range.setStart(node, remaining)
            range.setEnd(node, remaining + 1)
            const r = range.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          }
          remaining -= len
          node = walker.nextNode()
        }
      }
      return null
    },
    { tid: termId, mk: marker, off: offsetInMarker }
  )
  if (!point) throw new Error(`no rendered character for marker "${marker}" +${offsetInMarker}`)
  return point
}

/** Hold Cmd, hover the target so the (async) link provider resolves, then click — a reliable open of
 *  the VISIBLE pane's link. The bug under test rides the window-level `mouseup` fallback, which fires
 *  for every mounted pane regardless of hover, so a hovered click exercises the cross-pane leak just
 *  as a cold first-click would while keeping the positive control deterministic. */
async function cmdClick(termId: string, marker: string, offsetInMarker: number): Promise<void> {
  const point = await charPoint(termId, marker, offsetInMarker)
  await page.keyboard.down('Meta')
  await page.mouse.move(point.x, point.y)
  // The async provider has resolved the hovered link and decorated it (Cmd held → pointer cursor).
  await expect(page.locator(`[data-term-id="${termId}"] .xterm-screen`)).toHaveClass(/\bxterm-cursor-pointer\b/)
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Meta')
}

interface TabSnapshot {
  id: string
  kind: string
  path?: string
}

function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ id: t.id, kind: t.kind, path: t.path }))
  }, projectId)
}

async function docTabs(projectId: string): Promise<TabSnapshot[]> {
  return (await tabsOf(projectId)).filter((t) => t.kind === 'doc')
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  await write(join(fixture.workspaceRoot, ALPHA_DOC), '# Hidden-pane target\n\nOpened by the click on ALPHA.\n')
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('terminal link — hidden panes never open on another pane\'s click (T-197)', () => {
  test('a Cmd+click on Alpha opens ONLY Alpha\'s link; no hidden pane injects an extra tab', async () => {
    // ── Beta: mount its terminal (visible → fitted), then fill it edge-to-edge with a resolvable
    //    filename so ANY cell a stray click maps into resolves. Beta is then hidden but stays mounted.
    await page.getByTestId(`project-${fixture.projects.beta}`).click()
    const betaTerm = await openTerminal()
    await writeWhenReady(page, betaTerm, "printf 'BETA_TERM_READY\\n'\r")
    await expect.poll(() => readBuffer(betaTerm), { timeout: 10_000 }).toContain('BETA_TERM_READY')

    const cols = await measureCols(betaTerm)
    // A stray click into the hidden pane clamps its X to the LAST column, so every wall row must
    // reach that column. `2*cols` chars wrap into exactly TWO full-width rows (both span col 0..last),
    // leaving no short boundary row for the clamped X to miss. (`2*cols` stays within the 255-byte
    // filename limit for the e2e's fixed 1360px window; cols here is ~114.)
    const wallLen = 2 * cols
    expect(wallLen, `the wall filename fits the 255-byte limit (cols=${cols})`).toBeLessThanOrEqual(250)
    const wallName = 'w'.repeat(wallLen - 3) + '.md'
    await write(join(fixture.workspaceRoot, 'Projects/beta', wallName), '# Beta wall\n\nMust NOT open.\n')
    // A wall far taller than the viewport, so the click maps deep into uniform full-width rows —
    // never the command echo, the trailing prompt, or a wrap boundary.
    await writePty(betaTerm, `yes ${wallName} | head -n 400\r`)
    await expect
      .poll(() => readBuffer(betaTerm).then((b) => b.split(wallName).length - 1), { timeout: 20_000 })
      .toBeGreaterThan(300)

    // ── Alpha: a fresh terminal, its link printed at the TOP of the viewport (clear first) so the
    //    click's clientY is small — the hidden pane maps it onto a wall row, not its bottom prompt.
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const alphaTerm = await openTerminal()
    await writeWhenReady(page, alphaTerm, "printf 'ALPHA_TERM_READY\\n'\r")
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
    // `clear` must finish before the next command is typed: typed ahead, the printf line is echoed
    // first and then wiped by the clear, so a click measured on that echo would land on a blank row.
    await writePty(alphaTerm, 'clear\r')
    await expect.poll(() => rowsText(alphaTerm), { timeout: 10_000 }).not.toContain('ALPHA_TERM_READY')
    await writePty(alphaTerm, `printf '%s\\n' ${ALPHA_DOC}\r`)
    // The OUTPUT row (the path alone), not only the command echo, is on screen.
    await expect
      .poll(() => rowsText(alphaTerm).then((t) => t.split('\n').some((row) => row.trim() === ALPHA_DOC)), {
        timeout: 10_000
      })
      .toBe(true)

    await cmdClick(alphaTerm, 'hidden-pane-target.md', 3)

    // Alpha's target opens (positive control — the fix must not break the real path).
    await expect
      .poll(() => docTabs(fixture.projects.alpha).then((t) => t.some((x) => x.path === ALPHA_DOC)), { timeout: 10_000 })
      .toBe(true)

    // Alpha holds EXACTLY its own target — no wall file injected from beta's hidden pane — and
    // keeps holding it while any stray hidden-pane fallback (same async probe pipeline as Alpha's,
    // just fired) has time to land. The window is empirical (IPC probe round trips under load).
    // REVERT-PROOF: with the containment guard stashed, beta resolves its wall file on this same
    // click and routeProbe opens it into the active project (Alpha), making this length 2.
    await expectQuiet(async () => {
      const alphaDocs = await docTabs(fixture.projects.alpha)
      expect(alphaDocs.map((t) => t.path)).toEqual([ALPHA_DOC])
      // And nothing routes to a hidden project directly.
      expect(await docTabs(fixture.projects.beta)).toHaveLength(0)
    }, 1500)
  })
})
