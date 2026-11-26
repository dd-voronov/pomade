// modules: core, editor
// Pomade E-002 — mode control (T-014) + uniform configurable default open mode (T-015).
//   T-014: the existing single toggle button is kept; only its LABEL changes to show the
//          CURRENT view (Rendered/Table when rich, Raw when raw) instead of the click target.
//          The label must match the pane's data-mode for md AND csv. (the Owner rejected the
//          segmented-control idea — keep the button as-is, just fix the label semantics.)
//   T-015: all .md open in the same default (rendered), configurable app-level; after T-013
//          frontmatter alone does NOT force raw (body decides); flipping the setting flips
//          the default for freshly-opened markdown.

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

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const PLAIN = '# Plain\n\nJust prose.\n'
const FMONLY = '---\ntitle: FM Only\ntags: [a, b]\n---\n\n# Heading\n\nPlain body, no exotic syntax.\n'
// E-023: a body that canonicalizes on save (a heading immediately followed by a paragraph with no
// blank line — commonmark inserts the blank line) now opens RENDERED by default. Under the old
// byte-exact guard this was "guard-lossy" and forced raw; the guard is demoted to parse-only, so a
// parseable-but-canonicalizing note opens rendered and only reformats when actually edited + saved.
const CANON = '---\ntitle: Canon\n---\n\n# Canon\nBody line with no blank after the heading.\n'

function docTab(id: string, name: string, mode = 'rendered'): Record<string, unknown> {
  return {
    id,
    projectId: 'proj-alpha',
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode,
    dirty: false
  }
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/plain.md'), PLAIN)
  await fs.writeFile(join(root, 'Projects/alpha/fmonly.md'), FMONLY)
  await fs.writeFile(join(root, 'Projects/alpha/wiki.md'), CANON)
  await fs.writeFile(
    join(root, 'Projects/alpha/table.csv'),
    'name,role\nAda,Engineer\nGrace,Admiral\n'
  )
  await fs.writeFile(join(root, 'Projects/alpha/fresh.md'), PLAIN)

  const state = {
    openTabs: [
      docTab('doc-plain', 'plain.md'),
      docTab('doc-fmonly', 'fmonly.md'),
      docTab('doc-wiki', 'wiki.md'),
      docTab('doc-csv', 'table.csv', 'raw')
    ],
    activeTabId: 'doc-plain'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('default: plain md and frontmatter-only md both open rendered', async () => {
  await page.getByTestId('tab-doc-plain').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')

  await page.getByTestId('tab-doc-fmonly').click()
  const editor = vis('[data-testid="editor-pane"]')
  // Frontmatter alone must NOT trigger the raw fallback (T-013/T-015 — body decides).
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(vis('[data-testid="rendered-guard"]')).toHaveCount(0)
  // T-039: the informational frontmatter hint was removed — silent for a preserved note.
  await expect(vis('[data-testid="frontmatter-hint"]')).toHaveCount(0)
})

test('E-023: a canonicalizing md opens RENDERED by default; toggling raw and back has no dialog (T-042)', async () => {
  await page.getByTestId('tab-doc-wiki').click()
  const editor = vis('[data-testid="editor-pane"]')
  const toggle = vis('[data-testid="mode-toggle"]')
  // E-023: parseable-but-canonicalizing body opens rendered (guard demoted to parse-only). No banner.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(toggle).toHaveText('Rendered')
  await expect(vis('[data-testid="rendered-guard"]')).toHaveCount(0)

  // T-042: toggling to raw and back switches IMMEDIATELY — no confirm dialog exists anymore.
  await toggle.click()
  await expect(page.locator('[data-testid="render-confirm"]')).toHaveCount(0)
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await expect(toggle).toHaveText('Raw')

  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(toggle).toHaveText('Rendered')
  await expect(page.locator('[data-testid="render-confirm"]')).toHaveCount(0)
})

test('T-014: md toggle label shows the CURRENT view and matches data-mode', async () => {
  await page.getByTestId('tab-doc-plain').click()
  const editor = vis('[data-testid="editor-pane"]')
  const toggle = vis('[data-testid="mode-toggle"]')
  // Rendered now → label reads "Rendered" (current state), not "Raw" (target).
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(toggle).toHaveText('Rendered')
  await expect(toggle).toHaveAttribute('data-mode', 'rendered')

  // Click toggles to raw → label follows the current state.
  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await expect(toggle).toHaveText('Raw')
  await expect(toggle).toHaveAttribute('data-mode', 'raw')

  // And back to rendered — a round-trippable body toggles freely, NO confirm dialog (T-040).
  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(toggle).toHaveText('Rendered')
  await expect(page.locator('[data-testid="render-confirm"]')).toHaveCount(0)
})

test('T-014: csv toggle label shows Table/Raw matching data-mode', async () => {
  await page.getByTestId('tab-doc-csv').click()
  const editor = vis('[data-testid="editor-pane"]')
  const toggle = vis('[data-testid="mode-toggle"]')
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await expect(toggle).toHaveText('Raw')

  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(toggle).toHaveText('Table')
  await expect(vis('[data-testid="csv-table"]')).toBeVisible()
})

test('T-015: flipping the app default flips the mode for a freshly opened md', async () => {
  // Default is rendered; flip it to raw through the (temporary) actions-menu affordance.
  await page.getByTestId('tab-doc-plain').click()
  await vis('[data-testid="doc-actions"]').click()
  const setting = vis('[data-testid="action-default-md-mode"]')
  await expect(setting).toHaveAttribute('data-default-mode', 'rendered')
  await expect(setting).toHaveText('New md opens: Rich') // T-257
  await setting.click() // flips to raw + closes the menu

  // The setting persisted to the app-level store.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__pomadeStores.useAppSettingsStore.getState().markdownDefaultMode
      )
    )
    .toBe('raw')

  // Open a fresh md pane (sanctioned test hook) — it must honor the new 'raw' default.
  await page.evaluate(() => {
    const stores = window.__pomadeStores
    stores.useTabsStore.getState().openTab({
      id: 'doc-fresh',
      projectId: 'proj-alpha',
      kind: 'doc',
      title: 'fresh.md',
      path: 'Projects/alpha/fresh.md',
      mode: 'rendered', // openers hardcode rendered; the app default must override to raw
      dirty: false
    })
  })
  await page.getByTestId('tab-doc-fresh').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-doc-path', 'Projects/alpha/fresh.md')
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
})
