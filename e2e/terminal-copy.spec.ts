// modules: terminal, core
// Pomade E-020 e2e — terminal copy-out (T-084) and Option+click cursor positioning (T-085).
//
// Everything here is asserted through real UI gestures plus the in-memory test clipboard
// (`pomade.app.clipboardWrite/Read`, per-process in test mode), because that is the exact route
// the pane's Copy/Paste use. Selection is made with a REAL mouse drag: auto-copy commits on the
// mouseup that ends a drag, so a programmatic `xterm.select()` would bypass the very behavior
// under test.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'
import { writeWhenReady } from './fixtures/stores'
import { readSettingsJson } from './fixtures/settings'

let fixture: Fixture
let app: ElectronApplication
let page: Page

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

/**
 * A ready terminal in `projectId` with `marker` printed in it, opened fresh per test.
 *
 * Every test provisions its own rather than inheriting one: Playwright DISCARDS the worker
 * process after any failure and starts a new one, so a shared terminal id from an earlier test
 * silently becomes undefined afterwards — turning one real failure into a cascade of noise.
 */
async function terminalWith(projectId: string, marker: string): Promise<string> {
  await page.getByTestId(`project-${projectId}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, `printf '${marker}\\n'\r`)
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain(marker)
  // The row must be RENDERED before anything measures it (render can lag the pty buffer).
  await expect
    .poll(
      () =>
        page
          .locator(`[data-term-id="${termId}"] .xterm-rows > div`)
          .allTextContents()
          .then((rows) => rows.join('\n')),
      { timeout: 10_000 }
    )
    .toContain(marker)
  return termId
}

function clipboard(): Promise<string> {
  return page.evaluate(() => window.pomade.app.clipboardRead())
}

function setClipboard(text: string): Promise<void> {
  return page.evaluate((t) => window.pomade.app.clipboardWrite(t), text)
}

/**
 * Screen position of ONE rendered character, located by the marker text it belongs to.
 *
 * xterm's DOM renderer emits a div per row and spans inside it, so a DOM Range over the row's
 * text nodes gives the exact pixel box of any character — no cell-size arithmetic, and (crucially)
 * no dependence on the developer's own zsh PROMPT, whose width and styling e2e cannot know.
 */
async function charPoint(
  termId: string,
  marker: string,
  offsetInMarker: number
): Promise<{ x: number; y: number; w: number }> {
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
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }
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

/** Drag across `marker` with the real mouse — a selection COMMIT (mouseup ends the drag). */
async function dragSelect(termId: string, marker: string): Promise<void> {
  const from = await charPoint(termId, marker, 0)
  const to = await charPoint(termId, marker, marker.length - 1)
  // Release PAST the last glyph's midpoint: xterm snaps a selection edge to the nearest cell
  // boundary, so stopping at the centre of the final character would leave it out.
  const endX = to.x + to.w * 0.8
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + endX) / 2, to.y, { steps: 4 })
  await page.mouse.move(endX, to.y, { steps: 4 })
  await page.mouse.up()
}

async function savedPreferences(): Promise<Record<string, unknown>> {
  return readSettingsJson(fixture.workspaceRoot)
}

/** The copy confirmation of ONE pane. Scoped by term id because hidden panes stay MOUNTED, so a
 *  hint raised by an earlier test's terminal can still be on-screen during its fade-out. */
const hint = (termId: string): ReturnType<Page['locator']> =>
  page.locator(`[data-term-id="${termId}"] [data-testid^="terminal-copy-hint-"]`)

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('terminal copy-out (T-084)', () => {
  test('right-click opens the pane menu; Copy is disabled with no selection', async () => {
    const termId = await terminalWith(fixture.projects.alpha, 'MENUCHECK')

    const pane = page.locator(`[data-term-id="${termId}"]`)
    await pane.click({ button: 'right', position: { x: 40, y: 40 } })

    const menu = page.getByTestId('terminal-menu')
    await expect(menu).toBeVisible()
    // All four items are present, and Copy is inert while nothing is selected.
    await expect(page.getByTestId('terminal-menu-copy')).toBeDisabled()
    await expect(page.getByTestId('terminal-menu-paste')).toBeEnabled()
    await expect(page.getByTestId('terminal-menu-select-all')).toBeEnabled()
    await expect(page.getByTestId('terminal-menu-clear')).toBeEnabled()

    // Escape closes it (same contract as the tree / editor menus).
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('a right-click never disturbs an existing selection', async () => {
    // xterm defaults `rightClickSelectsWord` to TRUE on macOS — it would replace the user's
    // selection with the word under the cursor, i.e. Copy would copy the wrong thing. The pane
    // turns that off; this pins it.
    const termId = await terminalWith(fixture.projects.alpha, 'KEEPSELECTION-42')
    await dragSelect(termId, 'KEEPSELECTION-42')
    const pane = page.locator(`[data-term-id="${termId}"]`)
    // Right-click on a DIFFERENT word (the prompt area, far from the selection).
    await pane.click({ button: 'right', position: { x: 20, y: 8 } })
    await expect(page.getByTestId('terminal-menu-copy')).toBeEnabled()

    await setClipboard('')
    await page.getByTestId('terminal-menu-copy').click()
    await expect.poll(() => clipboard(), { timeout: 5_000 }).toContain('KEEPSELECTION-42')
  })

  test('Select all + menu Copy put the terminal contents on the clipboard', async () => {
    const termId = await terminalWith(fixture.projects.alpha, 'SELECTALL_MARK')
    await setClipboard('')

    const pane = page.locator(`[data-term-id="${termId}"]`)
    await pane.click({ button: 'right', position: { x: 40, y: 40 } })
    await page.getByTestId('terminal-menu-select-all').click()

    await pane.click({ button: 'right', position: { x: 40, y: 40 } })
    await expect(page.getByTestId('terminal-menu-copy')).toBeEnabled()
    await page.getByTestId('terminal-menu-copy').click()

    await expect.poll(() => clipboard(), { timeout: 5_000 }).toContain('SELECTALL_MARK')
    // Copying always confirms, whatever the auto-copy setting says.
    await expect(hint(termId)).toBeVisible()
  })

  test('menu Paste types the clipboard into the shell', async () => {
    const termId = await terminalWith(fixture.projects.alpha, 'PASTE_HOST')

    await setClipboard("printf 'PASTED_IN\\n'\r")
    const pane = page.locator(`[data-term-id="${termId}"]`)
    await pane.click({ button: 'right', position: { x: 40, y: 40 } })
    await page.getByTestId('terminal-menu-paste').click()

    await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('PASTED_IN')
  })

  test('menu Clear wipes the rendered viewport but not the pty', async () => {
    const termId = await terminalWith(fixture.projects.alpha, 'CLEARME')

    const rendered = (): Promise<string> =>
      page
        .locator(`[data-term-id="${termId}"] .xterm-rows > div`)
        .allTextContents()
        .then((rows) => rows.join('\n'))
    expect(await rendered()).toContain('CLEARME')

    const pane = page.locator(`[data-term-id="${termId}"]`)
    await pane.click({ button: 'right', position: { x: 40, y: 40 } })
    await page.getByTestId('terminal-menu-clear').click()

    await expect.poll(rendered, { timeout: 5_000 }).not.toContain('CLEARME')
    // The pty is untouched — it is a view-level clear, not a session reset.
    await writePty(termId, "printf 'ALIVE_AFTER_CLEAR\\n'\r")
    await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALIVE_AFTER_CLEAR')
  })

  test('a committed mouse selection auto-copies, flashes once, and collapsing does not re-copy', async () => {
    const termId = await terminalWith(fixture.projects.alpha, 'AUTOCOPY-0123456789')
    await setClipboard('')

    await dragSelect(termId, 'AUTOCOPY-0123456789')

    await expect.poll(() => clipboard(), { timeout: 5_000 }).toContain('AUTOCOPY-0123456789')
    await expect(hint(termId)).toBeVisible()
    await expect(hint(termId)).toContainText(/Copied \d+ chars/)
    // …and it fades itself out, without leaving anything to dismiss.
    await expect(hint(termId)).toHaveCount(0, { timeout: 5_000 })

    // A plain click COLLAPSES the selection: a selection change, but not a copy.
    await setClipboard('SENTINEL')
    const point = await charPoint(termId, 'AUTOCOPY-0123456789', 3)
    await page.mouse.click(point.x, point.y)
    // Real-world window (selection-change handling, not interval-derived) — the collapse may not
    // copy and no hint may flash, held throughout.
    await expectQuiet(async () => {
      expect(await clipboard()).toBe('SENTINEL')
      await expect(hint(termId)).toHaveCount(0)
    }, 400)
  })

  test('Cmd+C copies the selection even with auto-copy off, and the setting gates auto-copy', async () => {
    // Turn the setting OFF through the real Settings UI, and check it lands in settings.json.
    await page.getByTestId('projects-panel-settings').click()
    await expect(page.getByTestId('settings-general')).toBeVisible()
    const toggle = page.getByTestId('setting-terminal-auto-copy')
    await expect(toggle).toBeChecked() // default ON (locked decision)
    await toggle.uncheck()
    await page.getByTestId('modal-close').click()
    await expect.poll(() => savedPreferences().then((s) => s.terminalAutoCopy), { timeout: 5_000 }).toBe(false)

    const termId = await terminalWith(fixture.projects.alpha, 'GATED-9876543210')

    // Auto-copy is gated off: the drag selects but never touches the clipboard.
    await setClipboard('UNTOUCHED')
    await dragSelect(termId, 'GATED-9876543210')
    // Real-world window (auto-copy fires right on selection commit, not interval-derived) — the
    // gated drag may never touch the clipboard nor flash the hint, held throughout.
    await expectQuiet(async () => {
      expect(await clipboard()).toBe('UNTOUCHED')
      await expect(hint(termId)).toHaveCount(0)
    }, 500)

    // Cmd+C works regardless of the toggle (locked decision) — the selection is still live.
    await page.keyboard.press('Meta+c')
    await expect.poll(() => clipboard(), { timeout: 5_000 }).toContain('GATED-9876543210')
    await expect(hint(termId)).toBeVisible()

    // Restore the default so later specs in this file see the shipped behavior.
    await page.getByTestId('projects-panel-settings').click()
    await page.getByTestId('setting-terminal-auto-copy').check()
    await page.getByTestId('modal-close').click()
    await expect.poll(() => savedPreferences().then((s) => s.terminalAutoCopy), { timeout: 5_000 }).toBe(true)
  })
})

test.describe('Option+click moves the shell cursor (T-085)', () => {
  test('alt-clicking mid-line inserts at the clicked position', async () => {
    await page.getByTestId(`project-${fixture.projects.beta}`).click()
    const termId = await openTerminal()
    // A command left UNSUBMITTED at the prompt: the zsh line editor is what the cursor moves in.
    await writeWhenReady(page, termId, "printf 'HEAD_TAIL\\n'")
    const pane = page.locator(`[data-term-id="${termId}"]`)
    await expect(pane).toBeVisible()
    // The unsubmitted command's echo must be RENDERED before charPoint measures it.
    await expect
      .poll(() => pane.locator('.xterm-rows > div').allTextContents().then((r) => r.join('\n')), {
        timeout: 10_000
      })
      .toContain('HEAD_TAIL')

    // Focus the pane with a plain click first (never a modified one — that is a link gesture).
    await pane.click({ position: { x: 30, y: 10 } })
    // Option+click on the 'T' of TAIL, i.e. offset 5 of the marker. The modifier is held with the
    // KEYBOARD: `page.mouse.click()` has no `modifiers` option (only `locator.click()` does), so
    // passing one there is silently ignored and the click arrives unmodified.
    const target = await charPoint(termId, 'HEAD_TAIL', 5)
    const echoed = (await readBuffer(termId)).length
    await page.keyboard.down('Alt')
    await page.mouse.click(target.x, target.y)
    await page.keyboard.up('Alt')
    // xterm sent the cursor-move keys and zle echoed the move: the caret now sits on the cell.
    await expect.poll(() => readBuffer(termId).then((b) => b.length), { timeout: 10_000 }).toBeGreaterThan(echoed)

    // Typing now lands at the clicked cell, so the ECHOED text carries the insertion mid-word.
    await writePty(termId, 'X')
    await writePty(termId, '\r')
    await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('HEAD_XTAIL')
  })
})
