// modules: editor, git
// T-210 e2e — Cmd+Shift+G opens only the quick peek (Saved ↔ Unsaved) in raw, live and rendered;
// Cmd+G opens nothing; Cmd+F still opens find, whose Enter / Shift+Enter and next / previous
// buttons step through the matches. Raw and live bind CodeMirror's search keymap without its
// Cmd+G / Cmd+Shift+G binding (editor/cm-search-keys.ts).

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { docTab } from './fixtures/stores'
import { expectQuiet } from './fixtures/timing'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const TEXT = 'alpha beta alpha gamma alpha\n'
const vis = (page: Page, sel: string): Locator => page.locator(`${sel}:visible`)

/** CodeMirror's search panel (raw, live): query "alpha", then Enter / Shift+Enter and the
 *  next / previous buttons move the selected match; Esc closes. */
async function stepCodeMirror(page: Page, editorSel: string): Promise<void> {
  const field = vis(page, '.cm-search input[main-field]')
  await field.pressSequentially('alpha')
  await expect(vis(page, '.cm-searchMatch')).toHaveCount(3)
  // Which match is selected: its x on the (single) line.
  const head = async () => (await vis(page, `${editorSel} .cm-searchMatch-selected`).boundingBox())?.x ?? -1
  await field.press('Enter')
  await expect(vis(page, '.cm-searchMatch-selected')).toHaveCount(1)
  const first = await head()
  await field.press('Enter')
  await expect.poll(head).not.toBe(first)
  await field.press('Shift+Enter')
  await expect.poll(head).toBe(first)
  await vis(page, '.cm-search button[name="next"]').click()
  await expect.poll(head).not.toBe(first)
  await vis(page, '.cm-search button[name="prev"]').click()
  await expect.poll(head).toBe(first)
  await field.press('Escape')
}

/** Pomade's find panel (rendered): the count follows Enter / Shift+Enter and the ↑/↓ buttons. */
async function stepRendered(page: Page): Promise<void> {
  const input = page.getByTestId('find-input')
  const count = page.getByTestId('find-count')
  await input.fill('alpha')
  await expect(count).toHaveText('1 of 3')
  await input.press('Enter')
  await expect(count).toHaveText('2 of 3')
  await input.press('Shift+Enter')
  await expect(count).toHaveText('1 of 3')
  await page.getByTestId('find-next').click()
  await expect(count).toHaveText('2 of 3')
  await page.getByTestId('find-prev').click()
  await expect(count).toHaveText('1 of 3')
  await page.getByTestId('find-close').click()
}

const RAW = '[data-testid="raw-editor"] .cm-content'
const LIVE = '[data-testid="live-editor"] .cm-content'
const MODES = [
  { mode: 'raw', file: 'keys-raw.md', editor: RAW, step: (page: Page) => stepCodeMirror(page, RAW) },
  { mode: 'live', file: 'keys-live.md', editor: LIVE, step: (page: Page) => stepCodeMirror(page, LIVE) },
  { mode: 'rendered', file: 'keys-rendered.md', editor: '[data-testid="rendered-editor"] .ProseMirror', step: stepRendered }
] as const

test.describe('T-210 editor find keys leave Cmd+G and Cmd+Shift+G alone', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const root = fixture.workspaceRoot
    for (const m of MODES) await fs.writeFile(join(root, 'Projects/alpha', m.file), TEXT)
    await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
    await fs.writeFile(
      join(root, '.pomade/state/proj-alpha.json'),
      JSON.stringify({ openTabs: MODES.map((m) => docTab(`doc-${m.mode}`, m.file, m.mode)), activeTabId: 'doc-raw' }, null, 2)
    )
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId('project-proj-alpha').click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  /** Any find UI: CodeMirror's search panel (raw, live) or Pomade's find panel (rendered). */
  const findUi = (): Locator => page.locator('.cm-search:visible, [data-testid="find-panel"]:visible')
  const triggerFind = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('menu-editor-find')?.click())

  for (const m of MODES) {
    test(`${m.mode}: Cmd+Shift+G opens only the peek; Cmd+G nothing; Cmd+F finds and steps`, async () => {
      await page.getByTestId(`tab-doc-${m.mode}`).click()
      await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', m.mode)
      const editor = vis(page, m.editor)
      await editor.click()
      await page.keyboard.press('Meta+End')
      await page.keyboard.type(' delta')

      // Cmd+Shift+G: the Saved ↔ Unsaved peek, and no search panel under it.
      await page.keyboard.press('Meta+Shift+G')
      await expect(page.getByTestId('diff-overlay')).toBeVisible()
      await expect(page.getByTestId('diff-label-b')).toHaveText('Unsaved (editor)')
      await expect(findUi()).toHaveCount(0)
      await page.getByTestId('diff-close').click()
      await expect(page.getByTestId('diff-overlay')).toHaveCount(0)
      await expect(findUi()).toHaveCount(0)

      // Cmd+G: nothing opens.
      await editor.click()
      await page.keyboard.press('Meta+G')
      await expectQuiet(async () => {
        await expect(findUi()).toHaveCount(0, { timeout: 50 })
        await expect(page.getByTestId('diff-overlay')).toHaveCount(0, { timeout: 50 })
      }, 400)

      // Cmd+F (the menu item): find opens; Enter / Shift+Enter and the buttons step.
      await triggerFind()
      await expect(findUi()).toHaveCount(1)
      await m.step(page)
      await expect(findUi()).toHaveCount(0)
    })
  }
})
