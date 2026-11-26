// modules: editor, filetree
// Pomade E-023 — every markdown opens rendered by default; fidelity fixes. This file covers the
// behaviours the epic pins that the reworked toggle-guard/mode-control specs don't:
//   • policy pin — editing a canonicalizing (GFM table) note in rendered writes the serializer's
//     canonical body while the frontmatter block stays byte-verbatim (accepted policy);
//   • inline `<br>` survives a rendered edit byte-exact (remark-preserve-empty-line removed —
//     revert-prove: with the plugin, `a<br>b` parse-strips to `ab`);
//   • an empty `.md` opens RENDERED (revert-prove: the old byte-exact guard saw
//     serialize(parse('')) === '<br />' ≠ '' → lossy → raw), and an emptied doc saves as empty,
//     never `<br />`;
//   • a `.markdown` file opens rendered by default FROM THE FILE TREE (revert-prove: openers
//     hardcoded `.md`, so `.markdown` opened raw);
//   • the "New markdown opens as: raw" setting still forces a fresh `.md` to raw (survives the demotion).
//
// Parse-error→raw branch: real markdown that makes Milkdown's parser THROW or return null is not
// deterministically constructible (commonmark+gfm parse essentially any UTF-8 text into SOME doc),
// so that branch is not covered by a fixture here. It is the pre-existing try/catch + null-return
// in `parsesCleanly` (structurally identical to the old `rendersLosslessly` guard's), i.e. any
// throw/null → false → raw fallback.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, firstAppWindow } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const PID = 'proj-alpha'

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

// ── Fixtures (real-vault-shaped: YAML frontmatter, inline **bold**, [[wikilinks]]) ──
const FM_TABLE = '---\ntitle: Table Note\n---\n\n'
const TABLE_BODY =
  '# Coverage\n\nIntro paragraph.\n\n| Structure | Round-trips |\n| --- | --- |\n| Table | yes |\n\nClosing paragraph.\n'
const TABLE_FILE = FM_TABLE + TABLE_BODY
// Canonical serializer output (padded delimiter + cells) with the closing paragraph edited; the
// frontmatter block is re-attached byte-verbatim. Computed with the repo's real md-config.
const TABLE_EXPECTED =
  FM_TABLE +
  '# Coverage\n\nIntro paragraph.\n\n| Structure | Round-trips |\n| --------- | ----------- |\n| Table     | yes         |\n\nClosing paragraph. DONE\n'

const FM_BR = '---\ntitle: Break Note\n---\n\n'
const BR_BODY = 'A realistic paragraph with a<br>b inside and a [[wikilink]].\n\nEdit me here.\n'
const BR_FILE = FM_BR + BR_BODY
// The `<br>` paragraph is UNTOUCHED (unrelated edit to the trailing paragraph) and survives byte-exact.
const BR_EXPECTED =
  FM_BR + 'A realistic paragraph with a<br>b inside and a [[wikilink]].\n\nEdit me here. DONE\n'

const MARKDOWN_EXT_FILE = '---\ntitle: Markdown Ext\n---\n\n# Heading\n\nProse with **bold** and a [[wikilink]].\n'
const PLAIN2_FILE = '# Plain Two\n\nJust prose.\n'

let fixture: Fixture
let app: ElectronApplication
let page: Page

function docTab(id: string, name: string): Record<string, unknown> {
  return { id, projectId: PID, kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode: 'rendered', dirty: false }
}

const read = (name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/table-note.md'), TABLE_FILE)
  await fs.writeFile(join(root, 'Projects/alpha/br-note.md'), BR_FILE)
  await fs.writeFile(join(root, 'Projects/alpha/empty.md'), '')
  await fs.writeFile(join(root, 'Projects/alpha/render.markdown'), MARKDOWN_EXT_FILE)
  await fs.writeFile(join(root, 'Projects/alpha/plain2.md'), PLAIN2_FILE)

  const state = {
    openTabs: [docTab('doc-table', 'table-note.md'), docTab('doc-br', 'br-note.md'), docTab('doc-empty', 'empty.md')],
    activeTabId: 'doc-table'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await firstAppWindow(app)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  // Preview mode off so every tree click opens a FRESH real tab (a fresh pane mount — needed for
  // the raw-default coercion to re-run in the setting test).
  await page.evaluate(async () => {
    await window.__pomadeStores.useAppSettingsStore.getState().setPreviewTabMode(false)
  })
  await page.getByTestId(`project-${PID}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('policy pin: editing a GFM-table note in rendered writes canonical body, frontmatter byte-verbatim', async () => {
  await page.getByTestId('tab-doc-table').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/table-note.md')
  // Revert-proof of the demotion: the old byte-exact guard flagged the re-padded table lossy → raw.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()

  // Edit the closing paragraph, then save.
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' DONE')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  // Whole body canonicalized (delimiter row + cells re-padded); frontmatter block byte-verbatim.
  await expect.poll(() => read('table-note.md')).toBe(TABLE_EXPECTED)
})

test('inline <br> survives a rendered edit byte-exact', async () => {
  await page.getByTestId('tab-doc-br').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/br-note.md')
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()

  // Unrelated edit to the trailing paragraph — the `<br>` paragraph is left alone.
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' DONE')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  // The `<br>` is preserved byte-exact (revert-prove: with remark-preserve-empty-line it strips to `ab`).
  await expect.poll(() => read('br-note.md')).toBe(BR_EXPECTED)
})

test('an empty .md opens RENDERED; typing then deleting all saves an empty body (not <br />)', async () => {
  await page.getByTestId('tab-doc-empty').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/empty.md')
  // Revert-proof: the old byte-exact guard saw serialize(parse('')) === '<br />' ≠ '' → raw.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()

  // Type content, then select-all + delete it back to empty, then save.
  await prose.click()
  await page.keyboard.type('Hello world')
  await expect(prose).toContainText('Hello world')
  await page.keyboard.press(`${MOD}+a`)
  await page.keyboard.press('Backspace')
  await page.keyboard.press(`${MOD}+s`)

  // Emptied doc saves as empty — NOT '<br />'.
  await expect.poll(() => read('empty.md')).toBe('')
})

test('a .markdown file opens RICH by default from the file tree (Live under the Keep default — E-024)', async () => {
  const node = page.getByTestId('tree-node-Projects/alpha/render.markdown')
  await expect(node).toBeVisible()
  await node.click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/render.markdown')
  // Revert-proof of the opener unification: openers hardcoded `.md`, so `.markdown` opened raw.
  // E-024: the rich slot follows "Keep/Adjust formatting" — Keep (default) → the LIVE view.
  await expect(editor).toHaveAttribute('data-mode', 'live')
  await expect(vis('[data-testid="live-editor"] .cm-content')).toBeVisible()
})

test('the "New markdown opens as: raw" setting still forces a fresh .md to raw', async () => {
  // Flip the app default to raw (the user's escape hatch survives the guard demotion).
  await page.evaluate(async () => {
    await window.__pomadeStores.useAppSettingsStore.getState().setMarkdownDefaultMode('raw')
  })

  // Open a fresh .md from the tree — the raw-default coercion must flip it to raw.
  const node = page.getByTestId('tree-node-Projects/alpha/plain2.md')
  await expect(node).toBeVisible()
  await node.click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/plain2.md')
  await expect(editor).toHaveAttribute('data-mode', 'raw')
})
