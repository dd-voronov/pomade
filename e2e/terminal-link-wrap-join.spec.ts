// modules: core, editor, terminal
// Pomade E-020 e2e — HARD-wrapped path joining in the terminal link provider (T-086 Fix B).
//
// Agent CLIs (Claude Code) hard-wrap long output: a path prints as one row ending in a fragment,
// then a NEWLINE, then a hanging-indent row continuing it — two SEPARATE logical lines
// (isWrapped=false), so the logical-line reader never stitches them and neither fragment resolves.
// (xterm SOFT-wraps are already stitched.) The provider now reconstructs the path across up to 3
// physical fragments and, when the joined target resolves (Fix A's file-suffix fallback included),
// emits ONE link whose range spans the rows it covers — hovering ANY fragment's row lights it.
//
// Fixtures mirror REAL agent-output shapes: a bullet, a hanging indent, and trailing punctuation on
// the final fragment. Output is produced by `cat`-ing a fixture file (real newlines ⇒ genuinely
// separate, unwrapped logical lines) so the echoed command never carries the wrapped path itself.
//
// The join reads NEIGHBOURING buffer lines, so a token-string hook cannot exercise it: the
// `__pomadeTermProvideLinks` hook runs the REAL provider pipeline against the live buffer for the
// physical row containing a given substring, and returns each resolved link's target + the absolute
// rows it spans. One real Cmd+click proves the end-to-end open.

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

// ── the real files the wrapped paths point at (deep, resolvable only by suffix — Fix A) ─────────
const F_WRAP2 = 'Knowledge/logs/transcripts/session-docs-reviewed/4f75f0a0-reviewed.md'
const F_WRAP3 = 'Knowledge/logs/deep/alpha-mid/branch-leaf/c0ffee00-final.md'
const F_SINGLE = 'Knowledge/logs/single-line-ok.md'
const JOINED_2 = 'transcripts/session-docs-reviewed/4f75f0a0-reviewed.md'
const JOINED_3 = 'deep/alpha-mid/branch-leaf/c0ffee00-final.md'

// ── agent-output sample files (cat-ed to reproduce the hard wrap) ────────────────────────────────
const OUT_WRAP2 = 'samples/wrap2.txt'
const OUT_WRAP3 = 'samples/wrap3.txt'
const OUT_FALSE = 'samples/wrapfalse.txt'
const OUT_SINGLE = 'samples/single.txt'

async function writeFile(ws: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(join(ws, rel, '..'), { recursive: true })
  await fs.writeFile(join(ws, rel), content, 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  const ws = f.workspaceRoot
  for (const rel of [F_WRAP2, F_WRAP3, F_SINGLE]) await writeFile(ws, rel, `# ${rel}\n`)

  // A 2-fragment wrap: bullet head + hanging-indent tail with a trailing comma.
  await writeFile(ws, OUT_WRAP2, '- transcripts/session-\n  docs-reviewed/4f75f0a0-reviewed.md,\n')
  // A 3-fragment wrap: each fragment carries a slash (a deep path split three ways).
  await writeFile(ws, OUT_WRAP3, '* deep/alpha-\n  mid/branch-\n  leaf/c0ffee00-final.md,\n')
  // A false pair: two path-like fragments whose join names nothing and which each fail alone.
  await writeFile(ws, OUT_FALSE, '- foo/unrelated-alpha.md\n  bar/unrelated-beta.md\n')
  // A complete path on ONE line — the join must never touch it (regression guard).
  await writeFile(ws, OUT_SINGLE, `see ${F_SINGLE} here\n`)
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
async function alphaTerminal(): Promise<string> {
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}
/** `cat` a fixture file so its lines land in the buffer as genuinely separate, unwrapped rows, and
 *  wait until the given sentinel substring has been RENDERED (render can lag the pty buffer). */
async function catSample(termId: string, rel: string, sentinel: string): Promise<void> {
  await writePty(termId, `cat ${join(fixture.workspaceRoot, rel)}\r`)
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain(sentinel)
  await expect
    .poll(
      () =>
        page.evaluate((tid) => {
          const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
          return Array.from(rows)
            .map((r) => r.textContent ?? '')
            .join('\n')
        }, termId),
      { timeout: 10_000 }
    )
    .toContain(sentinel)
}

interface HookLink {
  target: string
  startY: number
  endY: number
}
/** Run the REAL provider pipeline for the physical row whose text contains `rowText`. */
function provideLinks(termId: string, rowText: string): Promise<HookLink[]> {
  return page.evaluate(
    ({ tid, rt }) => window.__pomadeTermProvideLinks[tid](rt),
    { tid: termId, rt: rowText }
  )
}
interface TabSnapshot {
  kind: string
  path?: string
}
function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ kind: t.kind, path: t.path }))
  }, projectId)
}

/** Pixel centre of one rendered character in the row containing `marker` (a DOM Range walk). */
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
async function cmdClickChar(termId: string, marker: string, offsetInMarker: number): Promise<void> {
  await page.keyboard.down('Meta')
  const point = await charPoint(termId, marker, offsetInMarker)
  await page.mouse.move(point.x, point.y)
  // The async provider has resolved the hovered link and decorated it (Cmd held → pointer cursor).
  await expect(page.locator(`[data-term-id="${termId}"] .xterm-screen`)).toHaveClass(/\bxterm-cursor-pointer\b/)
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Meta')
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

test.describe('terminal hard-wrapped path join (T-086 Fix B)', () => {
  test('a 2-fragment wrap joins into ONE multi-row link — hovering EITHER fragment row', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_WRAP2, 'docs-reviewed/4f75f0a0-reviewed.md,')

    // Hover the HEAD fragment's row.
    const head = await provideLinks(term, 'transcripts/session-')
    expect(head).toHaveLength(1)
    expect(head[0].target).toBe(JOINED_2)
    expect(head[0].endY).toBeGreaterThan(head[0].startY) // spans two rows

    // Hover the CONTINUATION fragment's row — the SAME link, same span.
    const tail = await provideLinks(term, 'docs-reviewed/4f75f0a0-reviewed.md,')
    expect(tail).toHaveLength(1)
    expect(tail[0].target).toBe(JOINED_2)
    expect(tail[0].endY).toBeGreaterThan(tail[0].startY)
    expect(tail[0].startY).toBe(head[0].startY)
    expect(tail[0].endY).toBe(head[0].endY)
  })

  test('a real Cmd+click on a wrapped fragment opens the joined doc', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_WRAP2, 'docs-reviewed/4f75f0a0-reviewed.md,')

    // Click inside the HEAD fragment (`transcripts`), whose row the join link starts on.
    await cmdClickChar(term, '- transcripts/session-', '- '.length + 3)

    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === F_WRAP2)), {
        timeout: 10_000
      })
      .toBe(true)
  })

  test('a 3-fragment wrap joins — hovering ANY of the three rows', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_WRAP3, 'leaf/c0ffee00-final.md,')

    for (const rowText of ['deep/alpha-', 'mid/branch-', 'leaf/c0ffee00-final.md,']) {
      const links = await provideLinks(term, rowText)
      expect(links).toHaveLength(1)
      expect(links[0].target).toBe(JOINED_3)
      // Spans three physical rows: end is two below start.
      expect(links[0].endY - links[0].startY).toBe(2)
    }
  })

  test('a false pair refuses to join (join names nothing) — no dead links', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_FALSE, 'bar/unrelated-beta.md')

    // Each fragment fails alone AND their join resolves to nothing, so NEITHER row yields a link.
    expect(await provideLinks(term, 'foo/unrelated-alpha.md')).toHaveLength(0)
    expect(await provideLinks(term, 'bar/unrelated-beta.md')).toHaveLength(0)
  })

  test('a complete path on ONE line is unaffected (single-row link, no join)', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_SINGLE, 'single-line-ok.md')

    const links = await provideLinks(term, 'single-line-ok.md')
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe(F_SINGLE)
    expect(links[0].startY).toBe(links[0].endY) // one row — the join never fired
  })
})
