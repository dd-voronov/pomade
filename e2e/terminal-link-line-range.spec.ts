// modules: core, editor, terminal
// Pomade E-020 e2e — `path:N-M` line-RANGE suffixes in the terminal link scanner (T-086, term-links).
//
// SUFFIX_RE accepted only `:line` and `:line:col`, so a token like `TerminalPane.tsx:132-134` (the
// hunk range agents print) matched nothing — the `-134` disqualified the whole token from BARE_FILE
// and STEM, and it was never even a candidate. The Owner hit this on a real link in agent output.
//
// classify() now accepts `path:N-M` (ASCII hyphen): path = the head, line = N (open at the START of
// the range), the `-M` consumed and ignored; the underline still covers the whole token incl.
// `:132-134`. `path:N` / `path:N:C` are unchanged, and a version-ish token with no colon (`1.5-2`)
// must still never become a link (the `-M` alternative fires only AFTER the mandatory `:(\d+)`).
//
// The jump is proven with a REAL Cmd+click that then BLIND-TYPES a sentinel onto the target line
// (the gesture the user performs); the unchanged / non-candidate cases use the deterministic
// `__pomadeTermLinkResolve` hook (does a token resolve to a link at all).

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

// A 140-line source file: line N reads `line NN markerN ...`. Long enough that line 132 sits well
// below the fold, so a real jump must SCROLL, not merely select.
const RANGE_DOC = 'Projects/alpha/rangefile.ts'

function fileLines(): string[] {
  const out: string[] = []
  for (let i = 1; i <= 140; i++) out.push(`line ${String(i).padStart(3, '0')} marker${i} const x = ${i}`)
  return out
}

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  await write(join(f.workspaceRoot, RANGE_DOC), fileLines().join('\n') + '\n')
}

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}
function writePty(termId: string, data: string): Promise<void> {
  return page.evaluate(({ tid, d }) => window.pomade.pty.write(tid, d), { tid: termId, d: data })
}
function ptyCwd(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.cwd(tid), termId)
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
  const alphaAbs = join(fixture.workspaceRoot, 'Projects/alpha')
  await expect.poll(() => ptyCwd(termId), { timeout: 10_000 }).toContain(alphaAbs)
  return termId
}

/** Does TOKEN resolve to a link at all, in this terminal's context? */
function resolveToken(termId: string, token: string): Promise<boolean> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinkResolve[tid](tk),
    { tid: termId, tk: token }
  )
}

/** Pixel centre of one rendered character in the terminal, located via a DOM Range. */
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
function visiblePane(): ReturnType<Page['locator']> {
  return page.locator('[data-testid="editor-pane"]:visible')
}
function activeElementClass(): Promise<string> {
  return page.evaluate(() => document.activeElement?.className ?? '')
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

test.describe('terminal `path:N-M` line-range suffix (T-086)', () => {
  test('a `:132-134` range link resolves and Cmd+click jumps to line 132 (the range START)', async () => {
    const term = await alphaTerminal()
    const token = `${RANGE_DOC}:132-134`
    await writePty(term, `printf '%s\\n' ${token}\r`)
    await expect.poll(() => readBuffer(term), { timeout: 10_000 }).toContain(token)
    // The token must be RENDERED before anything hovers it (render can lag the pty buffer).
    await expect
      .poll(
        () =>
          page.evaluate((tid) => {
            const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
            return Array.from(rows)
              .map((r) => r.textContent ?? '')
              .join('\n')
          }, term),
        { timeout: 10_000 }
      )
      .toContain(token)

    // The whole token (path + `:132-134`) is a link (the `-134` no longer disqualifies it).
    expect(await resolveToken(term, token)).toBe(true)
    // A range on the full ws-relative form resolves too.
    expect(await resolveToken(term, `${RANGE_DOC}:12-30`)).toBe(true)

    await cmdClickChar(term, token, 'Projects/alpha/'.length + 3)

    const pane = visiblePane()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane).toHaveAttribute('data-mode', 'raw')
    // Lands on line 132 (the START of the range), not 134.
    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('132', { timeout: 10_000 })
    const scrollTop = await pane.locator('.cm-scroller').evaluate((el) => el.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
    expect(await activeElementClass()).toContain('cm-content')
    await page.keyboard.type('ZZZ') // caret at the START of line 132
    await expect(pane.locator('.cm-activeLine')).toContainText('ZZZline 132 marker132')
    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('132')
  })

  test('`path:N` and `path:N:C` are unchanged (still resolve)', async () => {
    const term = await alphaTerminal()
    // cwd is the alpha project, so the bare filename resolves cwd-first.
    expect(await resolveToken(term, 'rangefile.ts:12')).toBe(true)
    expect(await resolveToken(term, 'rangefile.ts:12:5')).toBe(true)
  })

  test('a version-ish token `1.5-2` (no colon) is still not a link', async () => {
    const term = await alphaTerminal()
    expect(await resolveToken(term, '1.5-2')).toBe(false)
    expect(await resolveToken(term, 'v2.10-3')).toBe(false)
  })
})
