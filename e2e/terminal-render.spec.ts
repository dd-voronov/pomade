// modules: terminal
// Pomade T-081 e2e — terminal rendering correctness for agent TUIs.
// Regression: xterm's built-in Unicode 6 width tables size most emoji as 1 cell while
// modern CLIs (Claude Code's status line: 📁 🌿 ⏱️) assume 2 — every cursor-addressed
// rewrite after an emoji landed shifted, garbling status bars and leaking repaint frames
// into scrollback. TerminalPane now loads the Unicode 11 addon; this spec pins the
// rendered-grid semantics, not the raw pty bytes (the ring buffer is width-agnostic).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { writeWhenReady } from './fixtures/stores'
import { expectQuiet } from './fixtures/timing'


async function openTerminal(page: Page): Promise<string> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

/** All rendered xterm row texts of the visible terminal, joined — what the USER sees,
 *  as opposed to the pty ring buffer (raw bytes, escape sequences unrendered). */
function renderedText(page: Page, termId: string): Promise<string> {
  return page
    .locator(`[data-term-id="${termId}"] .xterm-rows > div`)
    .allTextContents()
    .then((rows) => rows.join('\n'))
}

test.describe('terminal rendering (T-081)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('emoji occupy 2 cells: cursor-addressed rewrites land where a TUI expects', async () => {
    const termId = await openTerminal(page)
    // 📁abcdef, CR to column 1, cursor-forward 3, overwrite 2 cells with XY.
    // Unicode 11 (📁 = 2 cells): column 4 is 'b' → 📁aXYdef.
    // Unicode 6 regression (📁 = 1 cell): column 4 is 'c' → 📁abXYef (garbled-status-bar bug).
    await writeWhenReady(page, termId, `printf '\\360\\237\\223\\201abcdef\\r\\033[3CXY\\n'\r`)
    await expect
      .poll(() => renderedText(page, termId), { timeout: 10_000 })
      .toContain('📁aXYdef')
    expect(await renderedText(page, termId)).not.toContain('📁abXYef')
  })

  test('wake broadcast reaches the renderer and leaves the terminal intact', async () => {
    // powerMonitor can't be made to really resume in CI; emitting the event exercises the
    // full chain (main broadcast → preload sub → TerminalPane refit + refresh) end-to-end.
    const termId = await openTerminal(page)
    await writeWhenReady(page, termId, `printf 'WAKE_CANARY\\n'\r`)
    await expect
      .poll(() => renderedText(page, termId), { timeout: 10_000 })
      .toContain('WAKE_CANARY')
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('resume')
      powerMonitor.emit('unlock-screen')
    })
    // Real-world window (rAF + refit/refresh settle, not interval-derived) — the pane must stay
    // live and keep its content THROUGH the refresh, not just after it.
    const el = page.locator(`[data-term-id="${termId}"]`)
    await expectQuiet(async () => {
      await expect(el).toHaveAttribute('data-status', 'live')
      expect(await renderedText(page, termId)).toContain('WAKE_CANARY')
    }, 400)
  })
})
