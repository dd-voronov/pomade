// modules: terminal, editor
// Pomade E-020 e2e — HARD-wrapped path joining that breaks INSIDE the filename (T-086 Fix B r2).
//
// Fix B (r1) reconstructed a path split across up to 3 hard-wrapped rows, but required EVERY chain
// fragment to contain a `/` (the `pathCands`-only edge predicates). The Owner's vault names reviewed
// docs with ~50-char UUID stems, so Claude Code's hard wrap routinely breaks INSIDE the basename —
// the continuation fragment (`4867-s01-reviewed.md`, or a bare stem chunk `5136c229`) has no slash,
// broke the chain, and the joined doc never linked. r2 lets slashless fragments be chain
// CONTINUATIONS (middles + tails) while the chain-inclusion rule — a SLASHED head — still keeps a
// pair of slashless prose words from ever being probed.
//
// Fixtures mirror REAL agent-output shapes: a bullet head carrying the slash, then a hanging-indent
// continuation that breaks mid-filename, and a trailing period on the final fragment. Output is
// produced by `cat`-ing a fixture file (real newlines ⇒ genuinely separate, unwrapped logical rows)
// so the echoed command never carries the wrapped path itself. The joined path resolves through the
// normal pipeline (Fix A's file-suffix fallback — the agent prints a folder-relative shorthand).
//
// The join reads NEIGHBOURING buffer lines, so a token-string hook cannot exercise it: the
// `__pomadeTermProvideLinks` hook runs the REAL provider pipeline against the live buffer for the
// physical row containing a given substring, returning each resolved link's target + the absolute
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
// The break is INSIDE the ~50-char UUID basename: the continuation fragment has NO slash.
const F_MID2 = 'Knowledge/02-Graphs/session-docs-reviewed/019f4c7a-3272-75d1-98fc-5136c2294867-s01-reviewed.md'
const F_MID3 = 'Knowledge/deep/session-docs-reviewed/aaaa1111-bbbb-2222cccc-3333dddd4444-s02-reviewed.md'
// The folder-relative shorthand the agent prints (and what the join reconstructs / the hook reports).
const JOINED_MID2 = 'session-docs-reviewed/019f4c7a-3272-75d1-98fc-5136c2294867-s01-reviewed.md'
const JOINED_MID3 = 'session-docs-reviewed/aaaa1111-bbbb-2222cccc-3333dddd4444-s02-reviewed.md'

// ── agent-output sample files (cat-ed to reproduce the hard wrap) ────────────────────────────────
const OUT_MID2 = 'samples/mid2.txt'
const OUT_MID3 = 'samples/mid3.txt'
const OUT_PROSE = 'samples/prose.txt'
const OUT_TWOWORD = 'samples/twoword.txt'

async function writeFile(ws: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(join(ws, rel, '..'), { recursive: true })
  await fs.writeFile(join(ws, rel), content, 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  const ws = f.workspaceRoot
  for (const rel of [F_MID2, F_MID3]) await writeFile(ws, rel, `# ${rel}\n`)

  // 2-fragment wrap breaking mid-basename: slashed head, slashless continuation, trailing period.
  await writeFile(
    ws,
    OUT_MID2,
    '- session-docs-reviewed/019f4c7a-3272-75d1-98fc-5136c229\n  4867-s01-reviewed.md.\n'
  )
  // 3-fragment wrap breaking mid-basename TWICE: slashed head, slashless STEM chunk, slashless tail.
  await writeFile(
    ws,
    OUT_MID3,
    '* session-docs-reviewed/aaaa1111-bbbb-2222\n  cccc-3333dddd4444-s02-rev\n  iewed.md.\n'
  )
  // Prose ending in a failing >=4-char stem word, followed by more prose (perf-gate sanity). Every
  // word here is chosen to match NO seeded file stem, so any link on these rows would be a JOIN.
  await writeFile(
    ws,
    OUT_PROSE,
    'considering the fragments beyond that arbitrary thingamajig\nanother wandering monologue continuing forever afterward\n'
  )
  // Two slashless words on adjacent rows: no slashed head anywhere, must never even be probed.
  await writeFile(ws, OUT_TWOWORD, 'alphaonlyfragment\nbetaonlyfragment\n')
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
/** `cat` a fixture file so its lines land in the buffer as genuinely separate, unwrapped rows,
 *  and wait until the sentinel has been RENDERED (render can lag the pty buffer). */
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

test.describe('terminal hard-wrapped path join — breaks INSIDE the filename (T-086 Fix B r2)', () => {
  test('a 2-fragment mid-basename wrap (slashless continuation) joins — hovering EITHER row', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_MID2, '4867-s01-reviewed.md.')

    // Head fragment's row (carries the slash).
    const head = await provideLinks(term, 'session-docs-reviewed/019f4c7a-3272-75d1-98fc-5136c229')
    expect(head).toHaveLength(1)
    expect(head[0].target).toBe(JOINED_MID2)
    expect(head[0].endY).toBeGreaterThan(head[0].startY) // spans two rows

    // The SLASHLESS continuation row — same link, same span (symmetric). This is the row r1 refused.
    const tail = await provideLinks(term, '4867-s01-reviewed.md.')
    expect(tail).toHaveLength(1)
    expect(tail[0].target).toBe(JOINED_MID2)
    expect(tail[0].startY).toBe(head[0].startY)
    expect(tail[0].endY).toBe(head[0].endY)
  })

  test('a real Cmd+click on the slashed head fragment opens the joined doc', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_MID2, '4867-s01-reviewed.md.')

    await cmdClickChar(term, 'session-docs-reviewed/019f4c7a', 'session-docs-reviewed/'.length + 2)

    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === F_MID2)), {
        timeout: 10_000
      })
      .toBe(true)
  })

  test('a 3-fragment wrap breaking mid-basename TWICE joins — hovering ANY of the three rows', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_MID3, 'iewed.md.')

    for (const rowText of [
      'session-docs-reviewed/aaaa1111-bbbb-2222',
      'cccc-3333dddd4444-s02-rev',
      'iewed.md.'
    ]) {
      const links = await provideLinks(term, rowText)
      expect(links).toHaveLength(1)
      expect(links[0].target).toBe(JOINED_MID3)
      expect(links[0].endY - links[0].startY).toBe(2) // spans three physical rows
    }
  })

  test('a prose row ending in a failing stem word produces NO join link (perf-gate sanity)', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_PROSE, 'continuing forever afterward')

    // The line ends in `thingamajig` (a >=4-char stem that fails), so canDown can fire — but the
    // chain it builds has no SLASHED head, so `headContribution` returns null and NO join is emitted.
    expect(await provideLinks(term, 'arbitrary thingamajig')).toHaveLength(0)
    expect(await provideLinks(term, 'continuing forever afterward')).toHaveLength(0)
  })

  test('two slashless words on adjacent rows never join (no slashed head, never probed)', async () => {
    const term = await alphaTerminal()
    await catSample(term, OUT_TWOWORD, 'betaonlyfragment')

    expect(await provideLinks(term, 'alphaonlyfragment')).toHaveLength(0)
    expect(await provideLinks(term, 'betaonlyfragment')).toHaveLength(0)
  })
})
