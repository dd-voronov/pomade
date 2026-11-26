// modules: core, tabs, editor
// Document editor acceptance: open, edit, save, rendered and raw views.
// Doc tabs are seeded via .pomade/state/<projectId>.json (the same restore path the app
// uses on relaunch) because the file-tree opener is a separate wave. Everything else is
// driven through the real UI.

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

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// Visible-only locators: every project's panes stay mounted, but only the active one is
// display:block, so `:visible` resolves to the pane the user is looking at.
const vis = (sel: string) => page.locator(`${sel}:visible`)

async function seedAlphaState(root: string): Promise<void> {
  const state = {
    openTabs: [
      {
        id: 'doc-md',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'README.md',
        path: 'Projects/alpha/README.md',
        mode: 'rendered',
        dirty: false
      },
      {
        id: 'doc-csv',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'table.csv',
        path: 'Projects/alpha/table.csv',
        mode: 'raw',
        dirty: false
      }
    ],
    activeTabId: 'doc-md'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  // An extra CSV inside alpha for the table-view test.
  await fs.writeFile(
    join(root, 'Projects/alpha/table.csv'),
    'name,role,city\nAda,Engineer,London\nGrace,Admiral,New York\n'
  )
  await seedAlphaState(root)

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Activate Alpha so its seeded doc tabs become visible.
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('opens a .md in rendered mode and the rendered view is editable', async () => {
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'rendered')

  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()
  await expect(prose).toContainText('Alpha')

  // Type into the rendered view → it must appear in the document.
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' RENDEREDIT')
  await expect(prose).toContainText('RENDEREDIT')

  // Editing marks the tab dirty (dot in pane header + tab strip).
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await expect(page.getByTestId('tab-doc-md').locator('[aria-label="unsaved"]')).toBeVisible()
})

test('Cmd+S right after typing in the rendered view saves every keystroke', async () => {
  // Milkdown reports edits through a 200 ms debounce; the save door flushes it first, so a save
  // pressed immediately after the last keystroke never writes a buffer missing that keystroke.
  await page.keyboard.type(' FASTSAVE')
  await page.keyboard.press(`${MOD}+s`)
  const target = join(fixture.workspaceRoot, 'Projects/alpha/README.md')
  await expect.poll(() => fs.readFile(target, 'utf8')).toContain('RENDEREDIT FASTSAVE')
  await expect(vis('[data-testid="editor-dirty"]')).toHaveCount(0)
})

test('toggling to raw shows the markdown source including the edit', async () => {
  await vis('[data-testid="mode-toggle"]').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'raw')

  const cm = vis('[data-testid="raw-editor"] .cm-content')
  await expect(cm).toBeVisible()
  await expect(cm).toContainText('# Alpha')
  await expect(cm).toContainText('RENDEREDIT')
})

test('Cmd+S writes the edited markdown to disk', async () => {
  // Add a marker in raw mode, then save.
  await vis('[data-testid="raw-editor"] .cm-content').click()
  await page.keyboard.type('\nRAWEDIT line\n')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()

  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/README.md')
  await expect
    .poll(async () => (await fs.readFile(target, 'utf8')).includes('RAWEDIT line'))
    .toBe(true)
  const onDisk = await fs.readFile(target, 'utf8')
  expect(onDisk).toContain('RENDEREDIT')
  // Saving clears the dirty state.
  await expect(vis('[data-testid="editor-dirty"]')).toHaveCount(0)
})

test('CSV opens raw and toggles to a table view', async () => {
  await page.getByTestId('tab-doc-csv').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/table.csv')
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await expect(vis('[data-testid="raw-editor"] .cm-content')).toContainText('Ada')

  await vis('[data-testid="mode-toggle"]').click()
  const table = vis('[data-testid="csv-table"]')
  await expect(table).toBeVisible()
  await expect(table.locator('thead th').first()).toHaveText('name')
  await expect(table.locator('tbody')).toContainText('Grace')
  await expect(table.locator('tbody tr')).toHaveCount(2)
})

test('new empty doc: type, Save As, and it lands on disk', async () => {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-doc').click()

  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', '')
  // T-192 — an Untitled doc is markdown by policy, so it opens in the rich view (Live under the
  // Keep default), not raw, from creation.
  await expect(editor).toHaveAttribute('data-mode', 'live')
  await expect(vis('[data-testid="editor-title"]')).toHaveText('Untitled')

  await vis('[data-testid="live-editor"] .cm-content').click()
  await page.keyboard.type('brand new file body')

  await page.keyboard.press(`${MOD}+s`)
  await expect(vis('[data-testid="saveas-modal"]')).toBeVisible()
  await vis('[data-testid="saveas-name"]').fill('created.md')
  await vis('[data-testid="saveas-confirm"]').click()

  const target = join(fixture.workspaceRoot, 'Projects/alpha/created.md')
  await expect.poll(async () => fs.readFile(target, 'utf8').catch(() => '')).toContain(
    'brand new file body'
  )
  await expect(vis('[data-testid="editor-title"]')).toHaveText('created.md')
})

test('close saved docs keeps the dirty one; close guard discards it', async () => {
  // created.md is a .md, so after Save As the pane shows its rich view — LIVE under the
  // Keep default (E-024). Make it dirty again by typing into the live view.
  await vis('[data-testid="live-editor"] .cm-content').click()
  await page.keyboard.type(' more')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()

  // Close saved docs: README + table.csv (clean) close, the dirty created.md stays.
  await vis('[data-testid="doc-actions"]').click()
  await vis('[data-testid="action-close-saved"]').click()

  await expect(page.getByTestId('tab-doc-md')).toHaveCount(0)
  await expect(page.getByTestId('tab-doc-csv')).toHaveCount(0)
  await expect(vis('[data-testid="editor-title"]')).toHaveText('created.md')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()

  // Close-guard on the dirty doc: Cancel keeps it, Discard closes it.
  await vis('[data-testid="doc-close"]').click()
  await expect(vis('[data-testid="close-guard"]')).toBeVisible()
  await vis('[data-testid="guard-cancel"]').click()
  await expect(page.locator('[data-testid="close-guard"]')).toHaveCount(0)
  await expect(vis('[data-testid="editor-title"]')).toHaveText('created.md')

  await vis('[data-testid="doc-close"]').click()
  await vis('[data-testid="guard-discard"]').click()
  await expect(page.getByTestId('panehost-empty')).toBeVisible()
})
