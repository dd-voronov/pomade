// modules: terminal, editor, tabs
// Pomade T-193 e2e — a terminal link opens on the FIRST Cmd+click, with no hover dwell.
//
// The bug: xterm's Linkifier only activates a link that ALREADY resolved by mousedown
// (`_mouseDownLink === _currentLink` at mouseup). Our provider is async (per-row `computeRowLinks`
// → probePath IPC), so the FIRST Cmd+click on a freshly printed path — before hover resolution has
// landed — could never open it; only a SECOND single click did. The fix is a click-time resolution
// fallback in the pane (`attachLinkProvider`) that resolves the clicked cell FRESH, bypassing the
// hover cache, and opens through the same activation path.
//
// Two guarantees, each REVERT-PROVEN against the fallback stashed:
//   1. an immediate Cmd+click (no hover, no dwell) opens the doc — fails on the pre-fallback pane;
//   2. a path that hover-resolved NULL and was negative-cached, then created, still opens on a
//      click — the click bypasses the 30 s negative cache (fails if the bypass is removed).

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

/** Printed and clicked immediately, before any hover — the first-click case. */
const FIRST_DOC = 'Projects/alpha/first-click-target.md'
/** Absent at first (hover negative-caches it), created mid-test — the cache-bypass case. */
const LATE_DOC = 'Projects/alpha/late-created.md'

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

/** Diagnostic hook: does TOKEN resolve to a link right now? Calls `resolveCandidate` WITHOUT the
 *  click bypass, so it reads (and populates) the same hover cache the provider uses. */
function resolveToken(termId: string, token: string): Promise<boolean> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinkResolve[tid](tk),
    { tid: termId, tk: token }
  )
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

/** A ready terminal in the Alpha project (its cwd), opened fresh per test (see terminal-links.spec). */
async function alphaTerminal(): Promise<string> {
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}

function rowsText(termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
    return Array.from(rows).map((r) => r.textContent ?? '').join('\n')
  }, termId)
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

/**
 * The FIRST-CLICK gesture: hold Cmd and click the target character with NO hover and NO dwell —
 * `page.mouse.click` does its own move→down→up, and hover resolution cannot have landed by mouseup,
 * so only the click-time fallback can open the link. This is exactly the case that failed pre-fix.
 */
async function firstCmdClick(termId: string, marker: string, offsetInMarker: number): Promise<void> {
  await page.keyboard.down('Meta')
  const point = await charPoint(termId, marker, offsetInMarker)
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

function hasTab(path: string): Promise<boolean> {
  return tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === path))
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // FIRST_DOC exists from launch (the index is built eagerly on workspace open); LATE_DOC is
  // created mid-test, so it must NOT exist yet.
  await write(join(fixture.workspaceRoot, FIRST_DOC), '# First click target\n\nOpened on the first Cmd+click.\n')
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('terminal first-click link (T-193)', () => {
  test('an immediate Cmd+click (no hover dwell) opens the doc on the FIRST click', async () => {
    const alphaTerm = await alphaTerminal()
    await writePty(alphaTerm, `printf '%s\\n' ${FIRST_DOC}\r`)
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 10_000 }).toContain(FIRST_DOC)
    await expect.poll(() => rowsText(alphaTerm), { timeout: 10_000 }).toContain(FIRST_DOC)

    // No hover, no dwell — resolution cannot have landed by mouseup, so ONLY the click-time
    // fallback can open this. REVERT-PROOF: the pre-fallback pane leaves the click a no-op.
    await firstCmdClick(alphaTerm, 'first-click-target.md', 3)

    await expect.poll(() => hasTab(FIRST_DOC), { timeout: 10_000 }).toBe(true)
    await expect(page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-title"]')).toHaveText(
      'first-click-target.md'
    )
  })

  test('a negative-cached path that is then created opens on click (cache bypassed)', async () => {
    const alphaTerm = await alphaTerminal()
    await writePty(alphaTerm, `printf '%s\\n' ${LATE_DOC}\r`)
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 10_000 }).toContain(LATE_DOC)
    await expect.poll(() => rowsText(alphaTerm), { timeout: 10_000 }).toContain(LATE_DOC)

    // The file does not exist yet: a hover-style resolve returns false AND caches the negative for
    // ~30 s (the same cache the provider fills on hover).
    expect(await resolveToken(alphaTerm, LATE_DOC)).toBe(false)

    // Create the file. The hover cache is untouched, so a hover-style resolve is STILL negative —
    // this is precisely the 30 s window in which the old code left the row unclickable.
    await write(join(fixture.workspaceRoot, LATE_DOC), '# Late created\n\nCreated after the negative cache.\n')
    expect(await resolveToken(alphaTerm, LATE_DOC)).toBe(false)

    // A real Cmd+click bypasses the negative cache, re-resolves fresh, and opens it.
    // REVERT-PROOF: fails with the fallback stashed, or with the click-time cache bypass removed.
    await firstCmdClick(alphaTerm, 'late-created.md', 3)

    await expect.poll(() => hasTab(LATE_DOC), { timeout: 10_000 }).toBe(true)
    await expect(page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-title"]')).toHaveText(
      'late-created.md'
    )
  })
})
