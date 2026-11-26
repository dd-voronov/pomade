// modules: editor
// Pomade E-002 (T-013) — coherent frontmatter messaging + guaranteed YAML preservation.
//   - Frontmatter is ALWAYS preserved verbatim, on BOTH save paths (raw + rendered).
//   - Frontmatter alone never forces raw — the body decides (round-trip guard on body only).
//   - The guard notice speaks only about the BODY and never claims frontmatter is at risk;
//     the frontmatter-hint (rendered) and the guard notice (raw) are mutually exclusive.
//   - EPIC ACCEPTANCE: a frontmatter note edited in BOTH modes survives byte-identical
//     outside the edited range (the frontmatter block).

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

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

// Frontmatter block + the conventional separating blank line = the preserved prefix.
const FM_PREFIX = '---\ntitle: Round Trip\ntags: [x, y]\n---\n\n'
const RT = `${FM_PREFIX}# Doc\n\nOriginal body.\n`
// T-041: `[[wikilink]]` now round-trips byte-exact, so a frontmatter + wikilink note opens
// rendered (the guard no longer trips on gratuitous bracket escaping).
const WIKI = '---\ntitle: Wiki\n---\n\n# Wiki\n\nBody with a [[wikilink]].\n'

function docTab(id: string, name: string): Record<string, unknown> {
  return { id, projectId: 'proj-alpha', kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode: 'rendered', dirty: false }
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/rt.md'), RT)
  await fs.writeFile(join(root, 'Projects/alpha/wiki.md'), WIKI)

  const state = {
    openTabs: [docTab('doc-rt', 'rt.md'), docTab('doc-wiki', 'wiki.md')],
    activeTabId: 'doc-rt'
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

test('frontmatter note with round-trippable body opens rendered (frontmatter alone never forces raw)', async () => {
  await page.getByTestId('tab-doc-rt').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  // T-039: the recurring informational frontmatter hint was removed (preservation is guaranteed +
  // e2e-pinned; silent is correct). Neither notice fires for a clean, round-trippable note.
  await expect(vis('[data-testid="frontmatter-hint"]')).toHaveCount(0)
  await expect(vis('[data-testid="rendered-guard"]')).toHaveCount(0)
})

test('T-041: a frontmatter + [[wikilink]] note opens rendered (guard no longer trips on brackets)', async () => {
  await page.getByTestId('tab-doc-wiki').click()
  const editor = vis('[data-testid="editor-pane"]')
  // T-041: the wikilink round-trips now, so the note opens rendered by default — no banner, no
  // frontmatter hint (both removed in T-039/T-040), and the wikilink shows as literal text.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(vis('[data-testid="mode-toggle"]')).toHaveText('Rendered')
  await expect(vis('[data-testid="rendered-guard"]')).toHaveCount(0)
  await expect(vis('[data-testid="frontmatter-hint"]')).toHaveCount(0)
  await expect(vis('[data-testid="rendered-editor"] .ProseMirror')).toContainText('[[wikilink]]')
})

test('EPIC: a frontmatter note edited in BOTH modes keeps its YAML byte-identical', async () => {
  const target = join(fixture.workspaceRoot, 'Projects/alpha/rt.md')

  // (1) Rendered-mode edit to the body.
  await page.getByTestId('tab-doc-rt').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' RENDER')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  await expect.poll(async () => (await fs.readFile(target, 'utf8')).includes('RENDER')).toBe(true)
  let onDisk = await fs.readFile(target, 'utf8')
  // Frontmatter block (outside the edited range) is byte-identical.
  expect(onDisk.startsWith(FM_PREFIX)).toBe(true)
  expect(onDisk).toContain('Original body. RENDER')

  // (2) Raw-mode edit to the body — frontmatter must STILL be byte-identical.
  await vis('[data-testid="mode-toggle"]').click() // rendered → raw
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
  const cm = vis('[data-testid="raw-editor"] .cm-content')
  await cm.click()
  await page.keyboard.press(`${MOD}+ArrowDown`) // to document end
  await page.keyboard.type('\nRAW_APPEND\n')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  await expect.poll(async () => (await fs.readFile(target, 'utf8')).includes('RAW_APPEND')).toBe(true)
  onDisk = await fs.readFile(target, 'utf8')
  expect(onDisk.startsWith(FM_PREFIX)).toBe(true) // YAML survived the second (raw) edit too
  expect(onDisk).toContain('Original body. RENDER')
})
