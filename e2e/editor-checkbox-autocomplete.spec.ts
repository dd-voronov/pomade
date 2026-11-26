// modules: editor
// Pomade T-050 — checkbox autocomplete. Typing `- [` expands to a GFM checkbox in BOTH modes:
//   • raw (CodeMirror): the typed `[` becomes `[ ] ` (→ `- [ ] `), caret after; one undo reverts.
//   • rendered (Milkdown): `[` at the start of an empty list item turns it into a real task item
//     (a clickable checkbox) that saves as `- [ ] text`; one undo reverts.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'
import { waitCaretRegistered } from './fixtures/stores'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const PID = 'proj-alpha'

function docTab(id: string, name: string, mode: 'raw' | 'rendered'): Record<string, unknown> {
  return { id, projectId: PID, kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode, dirty: false }
}

async function seed(fixture: Fixture, files: Record<string, string>, tabs: Record<string, unknown>[], activeId: string): Promise<void> {
  const root = fixture.workspaceRoot
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(root, 'Projects/alpha', name), content)
  }
  const state = { openTabs: tabs, activeTabId: activeId }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launchAppPage(fixture)
  await expect
    .poll(() => page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().hydrated))
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
  return { app, page }
}

const read = (fixture: Fixture, name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

test.describe('T-050 — checkbox autocomplete', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('raw: typing `- [` expands to `- [ ] `; one undo reverts', async () => {
    await seed(fixture, { 'raw.md': '' }, [docTab('doc-raw', 'raw.md', 'raw')], 'doc-raw')
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-raw').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    const content = vis(page, '[data-testid="raw-editor"] .cm-content')
    await content.click()
    await page.keyboard.type('- [')
    await expect(content).toContainText('- [ ]')

    // Save and confirm the exact bytes (`- [ ] ` with the trailing space, caret after).
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => read(fixture, 'raw.md')).toBe('- [ ] ')

    // One undo removes the expansion, leaving the bare marker (no `[`).
    await page.keyboard.press(`${MOD}+z`)
    await expect(content).not.toContainText('[')
    await app.close()
  })

  test('rendered: typing `- [` yields a GFM task item saved as `- [ ] text`; one undo reverts', async () => {
    await seed(
      fixture,
      { 'r1.md': 'Tasks\n', 'r2.md': 'Tasks\n' },
      [docTab('doc-r1', 'r1.md', 'rendered'), docTab('doc-r2', 'r2.md', 'rendered')],
      'doc-r1'
    )
    const { app, page } = await launch(fixture)

    // BOTH doc panes stay MOUNTED (PaneHost hides the inactive one with display:none, never
    // unmounts it — see PaneHost.tsx), so r1 keeps its task-checkbox in the DOM after we switch to
    // r2. A `[data-testid="rendered-editor"]:visible …` locator therefore can't uniquely name the
    // pane under test: while the r1→r2 visibility flip is settling under CPU contention, `:visible`
    // transiently matches r1's STALE checkbox and the count assertions desync from r2. Scope every
    // per-pane locator to its own `pane-<tabId>` (the pattern editor-properties.spec.ts already
    // uses) so the checks are immune to that cross-pane flip window.
    const boxes = (tabId: string): ReturnType<Page['locator']> =>
      page.locator(`[data-testid="pane-${tabId}"] input[data-testid="task-checkbox"]`)
    const prose = (tabId: string): ReturnType<Page['locator']> =>
      page.locator(`[data-testid="pane-${tabId}"] [data-testid="rendered-editor"] .ProseMirror`)

    // Create + save a task item.
    await page.getByTestId('tab-doc-r1').click()
    await expect(page.locator('[data-testid="pane-doc-r1"] [data-testid="editor-pane"]')).toHaveAttribute(
      'data-mode',
      'rendered'
    )
    await prose('doc-r1').click()
    await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
    await page.keyboard.press(`${MOD}+ArrowDown`) // to document end
    await page.keyboard.press('Enter')
    await page.keyboard.type('- ')
    await page.keyboard.type('[')
    await page.keyboard.type('todo')
    await expect(boxes('doc-r1')).toHaveCount(1)
    await expect(prose('doc-r1')).toContainText('todo')
    await expect(page.locator('[data-testid="pane-doc-r1"] [data-testid="editor-dirty"]')).toBeVisible()
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => read(fixture, 'r1.md')).toContain('- [ ] todo')

    // Undo reverts the expansion (checkbox gone) in one step.
    await page.getByTestId('tab-doc-r2').click()
    await prose('doc-r2').click()
    await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
    await page.keyboard.press(`${MOD}+ArrowDown`)
    await page.keyboard.press('Enter')
    await page.keyboard.type('- ')
    await page.keyboard.type('[')
    await expect(boxes('doc-r2')).toHaveCount(1)
    await prose('doc-r2').click() // ensure the editor is focused before the undo keystroke
    await page.keyboard.press(`${MOD}+z`)
    await expect(boxes('doc-r2')).toHaveCount(0)
    await app.close()
  })
})
