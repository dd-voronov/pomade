// modules: terminal, editor
// Pomade E-020 e2e — the `path:line` JUMP (T-086 bug-fix round 3).
//
// The Owner reported (real claude-code session): a `:line` terminal link opens the file but never
// lands the caret — the doc sits at line 1, nothing is focused (blind-typing goes nowhere). The
// committed `terminal-links.spec.ts` "puts the caret on that line" test passed anyway because it
// (a) drives activation through the `__pomadeTermLinks` HOOK, so it never contends with xterm for
// focus, and (b) asserts only the active-line GUTTER (a selection artifact, shown even unfocused)
// — never that the editor is focused and a keystroke actually lands on the target line.
//
// This spec closes both gaps for all three paths the user hits:
//   • raw, FRESH open (the file was not open before the click)
//   • raw, ALREADY open on a different line (jump-store re-consumption)
//   • rendered markdown (the user's default open mode) — round-3's new capability
// Every case uses a REAL Cmd+click and then BLIND-TYPES a sentinel, asserting the sentinel lands
// on the target line and the editor holds focus — exactly the gesture the user performed.

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
import { launchApp } from './fixtures/app'
import { writeWhenReady } from './fixtures/stores'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// A 40-line raw text file: line N reads `Line NN — <marker>`. Long enough that lines 20/30 sit
// well below the fold, so a real jump has to SCROLL, not just select.
const RAW_DOC = 'Projects/alpha/jump-raw.txt'
// A separate copy for the already-open test — tests share one app instance, so reusing RAW_DOC
// (left open + dirty on line 20 by the fresh-open test) would break the "starts on line 1" premise.
const RAW_DOC2 = 'Projects/alpha/jump-raw2.txt'
// A realistic markdown note (frontmatter + headings + paragraphs) whose body paragraph at a known
// source line carries a unique marker, so the rendered jump can be checked by where the caret lands.
const MD_DOC = 'Projects/alpha/jump-doc.md'

function rawLines(): string[] {
  const out: string[] = []
  for (let i = 1; i <= 40; i++) {
    out.push(`Line ${String(i).padStart(2, '0')} marker${i} the quick brown fox`)
  }
  return out
}

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  const ws = f.workspaceRoot
  await write(join(ws, RAW_DOC), rawLines().join('\n') + '\n')
  await write(join(ws, RAW_DOC2), rawLines().join('\n') + '\n')
  // MD_DOC: with the frontmatter (4 lines) + blank + headings/paragraphs, the paragraph that
  // contains RENDER_TARGET_PARAGRAPH sits at a source line we compute in the test from the file.
  await write(
    join(ws, MD_DOC),
    [
      '---', // 1
      'title: Jump doc', // 2
      'tags: [jump, e2e]', // 3
      '---', // 4
      '', // 5
      '# Jump doc', // 6
      '', // 7
      'Intro paragraph with **bold** and a [[wikilink]] so the block carries real inline markup.', // 8
      '', // 9
      '## Section one', // 10
      '', // 11
      'First body paragraph. Filler filler filler to push the document past one viewport height.', // 12
      '', // 13
      'Second body paragraph, also filler, so the target below is well under the fold when opened.', // 14
      '', // 15
      '## Section two', // 16
      '', // 17
      'RENDER_TARGET_PARAGRAPH is the unique block the :line link must land the caret inside of.', // 18
      '', // 19
      'Trailing paragraph after the target, more filler to give the scroll container real height.', // 20
      ''
    ].join('\n')
  )
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

/** What the pane actually SHOWS — the xterm rows in the DOM (render can lag the pty buffer). */
function rowsText(termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
    return Array.from(rows)
      .map((r) => r.textContent ?? '')
      .join('\n')
  }, termId)
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

/** The real gesture: hold Cmd, hover the target token so the provider resolves + decorates, click. */
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

/** class list of the currently-focused element (empty when nothing is focused). */
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

test.describe('terminal `:line` jump (T-086 r3)', () => {
  test('RAW fresh-open: real Cmd+click lands the caret on the line, focused', async () => {
    const term = await alphaTerminal()
    await writePty(term, `printf '%s\\n' ${RAW_DOC}:20\r`)
    await expect.poll(() => readBuffer(term), { timeout: 10_000 }).toContain(`${RAW_DOC}:20`)
    await expect.poll(() => rowsText(term), { timeout: 10_000 }).toContain(`${RAW_DOC}:20`)

    await cmdClickChar(term, `${RAW_DOC}:20`, 'Projects/alpha/'.length + 3)

    const pane = visiblePane()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane).toHaveAttribute('data-mode', 'raw')
    // The caret's line (gutter) — the OLD assertion, kept.
    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('20', { timeout: 10_000 })
    // Scrolled: line 20 sits below the fold, so the scroller must have moved.
    const scrollTop = await pane.locator('.cm-scroller').evaluate((el) => el.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
    // Focused + caret really there: blind-type and prove the keystroke lands on line 20.
    expect(await activeElementClass()).toContain('cm-content')
    await page.keyboard.type('ZZZ') // caret sits at the START of line 20
    await expect(pane.locator('.cm-activeLine')).toContainText('ZZZLine 20 marker20')
    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('20')
  })

  test('RAW already-open on another line: a second `:line` link re-jumps, focused', async () => {
    const term = await alphaTerminal()
    // Open the doc first WITHOUT a line (lands at line 1), from a link.
    await writePty(term, `printf '%s\\n' ${RAW_DOC2}\r`)
    await expect.poll(() => readBuffer(term), { timeout: 10_000 }).toContain(RAW_DOC2)
    await expect.poll(() => rowsText(term), { timeout: 10_000 }).toContain(RAW_DOC2)

    await cmdClickChar(term, RAW_DOC2, 'Projects/alpha/'.length + 3) // the bare path token
    const pane = visiblePane()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('1', { timeout: 10_000 })

    // Back to THIS test's terminal tab (several exist across tests — match by the live pane's
    // own testid, `terminal-<tabId>`), then print + click the `:33` link for the already-open doc.
    const paneTestId = await page
      .locator(`[data-term-id="${term}"]`)
      .getAttribute('data-testid')
    const termTabId = present(paneTestId, 'terminal pane testid').replace(/^terminal-/, '')
    await page.getByTestId(`tab-${termTabId}`).click()
    await expect(page.locator(`[data-term-id="${term}"]`)).toBeVisible()
    await writePty(term, `printf '%s\\n' ${RAW_DOC2}:33\r`)
    await expect.poll(() => readBuffer(term), { timeout: 10_000 }).toContain(`${RAW_DOC2}:33`)
    await expect.poll(() => rowsText(term), { timeout: 10_000 }).toContain(`${RAW_DOC2}:33`)

    await cmdClickChar(term, `${RAW_DOC2}:33`, 'Projects/alpha/'.length + 3)

    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('33', { timeout: 10_000 })
    expect(await activeElementClass()).toContain('cm-content')
    await page.keyboard.type('QQQ') // caret at the START of line 33
    await expect(pane.locator('.cm-activeLine')).toContainText('QQQLine 33 marker33')
  })

  test('RICH markdown (Live under the Keep default): `:line` lands the caret in the matching block, focused', async () => {
    const term = await alphaTerminal()
    await writePty(term, `printf '%s\\n' ${MD_DOC}:18\r`)
    await expect.poll(() => readBuffer(term), { timeout: 10_000 }).toContain(`${MD_DOC}:18`)
    await expect.poll(() => rowsText(term), { timeout: 10_000 }).toContain(`${MD_DOC}:18`)

    await cmdClickChar(term, `${MD_DOC}:18`, 'Projects/alpha/'.length + 3)

    const pane = visiblePane()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    // E-024: a link-opened markdown lands in the rich view the Keep default selects — LIVE.
    await expect(pane).toHaveAttribute('data-mode', 'live')
    const live = pane.locator('[data-testid="live-editor"] .cm-content')
    await expect(live).toBeVisible({ timeout: 10_000 })
    // Focused in the live editor.
    expect(await activeElementClass()).toContain('cm-content')
    // Blind-type: the sentinel must land inside the RENDER_TARGET_PARAGRAPH block.
    await page.keyboard.type('WWW')
    const targetBlock = live.locator('.cm-line', { hasText: 'RENDER_TARGET_PARAGRAPH' })
    await expect(targetBlock).toContainText('WWW', { timeout: 10_000 })
  })
})
