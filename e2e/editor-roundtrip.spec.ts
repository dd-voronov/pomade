// modules: editor
// Pomade Wave 4 e2e — Milkdown rendered editing + frontmatter preservation, updated for the
// E-023 contract (guard demoted to a parse-only safety net; canonicalization-on-save accepted):
//   - a plain commonmark note opens rendered and saves losslessly (exact bytes, apart from the edit);
//   - a note that canonicalizes on save opens RENDERED by default; editing + saving reformats the
//     body but keeps frontmatter verbatim;
//   - a wikilink note round-trips its brackets byte-exact through a rendered edit (T-041).
// Doc tabs are seeded via .pomade/state (the same restore path the app uses on relaunch).

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

const PLAIN = '# Note\n\nHello world.\n'
// T-041: `[[wikilink]]` now round-trips byte-exact, so a wikilink note opens RENDERED by default.
const WIKI = '---\ntitle: My Note\ntags: [a, b]\n---\n\n# Heading\n\nText with a [[wikilink]].\n'
// A dedicated wikilink note the byte-exact save test edits + saves (so it never disturbs WIKI,
// which the Save-As test still asserts is untouched on disk).
const WIKISAVE = '---\ntitle: Saver\n---\n\n# Saver\n\nText with a [[wikilink]] to keep.\n'
const FM_HEADER = '---\ntitle: Forced Note\ntags: [x, y]\n---\n'
// Canonicalizes on save (heading immediately followed by a paragraph, no blank line — commonmark
// inserts it). E-023: this now opens RENDERED by default (guard demoted to parse-only); editing +
// saving reformats the body but keeps the frontmatter verbatim.
const FMFORCE = `${FM_HEADER}\n# Forced\nBody with a [[link]] and no blank after the heading.\n`
// Whitespace-tolerant guard tier (2026-07-22): the ONLY round-trip diff is a trailing space
// (the parser strips it before the serializer runs) → the file opens RENDERED; the first
// save writes it without the trailing space. Mirrors the real-world AGENTS.md case.
const TRAILING = '# Trail\n\nLine with a trailing space \nmore text.\n\nTail.\n'

function docTab(id: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId: 'proj-alpha',
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode: 'rendered',
    dirty: false
  }
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/plain.md'), PLAIN)
  await fs.writeFile(join(root, 'Projects/alpha/wiki.md'), WIKI)
  await fs.writeFile(join(root, 'Projects/alpha/wikisave.md'), WIKISAVE)
  await fs.writeFile(join(root, 'Projects/alpha/fmforce.md'), FMFORCE)
  await fs.writeFile(join(root, 'Projects/alpha/trailing.md'), TRAILING)

  const state = {
    openTabs: [
      docTab('doc-plain', 'plain.md'),
      docTab('doc-wiki', 'wiki.md'),
      docTab('doc-wikisave', 'wikisave.md'),
      docTab('doc-fmforce', 'fmforce.md'),
      docTab('doc-trailing', 'trailing.md')
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

test('T-041: a frontmatter + [[wikilink]] note now opens RENDERED (guard no longer trips on brackets)', async () => {
  await page.getByTestId('tab-doc-wiki').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/wiki.md')
  // T-041: `[[wikilink]]` round-trips byte-exact now, so the guard passes and the note opens
  // rendered by default (previously it was wrongly forced to raw by gratuitous bracket escaping).
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(vis('[data-testid="mode-toggle"]')).toHaveText('Rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()
  // The wikilink shows as literal text (Milkdown has no wikilink node; T-005 tracks that).
  await expect(prose).toContainText('[[wikilink]]')
})

test('a plain commonmark note opens rendered and saves losslessly', async () => {
  await page.getByTestId('tab-doc-plain').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/plain.md')
  // Round-trips cleanly → rendered editing is allowed.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()
  await expect(prose).toContainText('Hello world.')

  // Append to the paragraph in the rendered view, then save.
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDIT')
  await expect(prose).toContainText('Hello world. EDIT')
  // Dirty dot proves the serialized edit committed to React state before we save.
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/plain.md')
  // Exact bytes: only the edit differs from the original — no reformatting.
  await expect.poll(async () => fs.readFile(target, 'utf8')).toBe('# Note\n\nHello world. EDIT\n')
})

test('E-023: a canonicalizing note opens RENDERED by default and keeps frontmatter verbatim on save', async () => {
  await page.getByTestId('tab-doc-fmforce').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/fmforce.md')
  // E-023: parseable-but-canonicalizing body opens rendered directly (no toggle, no raw fallback).
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  // T-039/T-040: neither the frontmatter hint nor the guard banner exists anymore.
  await expect(vis('[data-testid="frontmatter-hint"]')).toHaveCount(0)
  await expect(vis('[data-testid="rendered-guard"]')).toHaveCount(0)

  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' FORCEDEDIT')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/fmforce.md')
  await expect
    .poll(async () => (await fs.readFile(target, 'utf8')).includes('FORCEDEDIT'))
    .toBe(true)
  const onDisk = await fs.readFile(target, 'utf8')
  // Frontmatter block is preserved byte-for-byte even though the body was reformatted.
  expect(onDisk.startsWith(FM_HEADER)).toBe(true)
})

test('Save As onto an existing file asks before overwriting (finding [2])', async () => {
  // A new untitled doc; Save As with the name of an existing sibling must NOT clobber it.
  // T-192: an Untitled doc is markdown by policy and opens in the rich view (Live under the
  // Keep default) — the Save As collision path under test is surface-independent.
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-doc').click()
  await vis('[data-testid="live-editor"] .cm-content').click()
  await page.keyboard.type('overwrite attempt body')
  await page.keyboard.press(`${MOD}+s`)

  await expect(vis('[data-testid="saveas-modal"]')).toBeVisible()
  await vis('[data-testid="saveas-name"]').fill('wiki.md') // already exists on disk
  await vis('[data-testid="saveas-confirm"]').click()

  // Collision → overwrite confirmation, not a silent clobber.
  await expect(vis('[data-testid="overwrite-confirm"]')).toBeVisible()
  await vis('[data-testid="overwrite-cancel"]').click()
  await expect(page.locator('[data-testid="overwrite-confirm"]')).toHaveCount(0)
  // The existing wiki.md is untouched.
  expect(await fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha/wiki.md'), 'utf8')).toBe(WIKI)

  // Saving under a fresh name succeeds.
  await vis('[data-testid="saveas-name"]').fill('overwrite-fresh.md')
  await vis('[data-testid="saveas-confirm"]').click()
  await expect
    .poll(async () =>
      fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha/overwrite-fresh.md'), 'utf8').catch(() => '')
    )
    .toContain('overwrite attempt body')
})

test('T-041: editing a rendered wikilink note elsewhere saves the brackets byte-identical (no \\[\\[)', async () => {
  await page.getByTestId('tab-doc-wikisave').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/wikisave.md')
  // Round-trips now → opens rendered directly.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()
  await expect(prose).toContainText('[[wikilink]]')

  // Edit the paragraph AWAY from the wikilink, then save.
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDIT')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/wikisave.md')
  // Byte-exact: frontmatter verbatim, the wikilink brackets NOT escaped, only the edit differs.
  await expect
    .poll(async () => fs.readFile(target, 'utf8'))
    .toBe('---\ntitle: Saver\n---\n\n# Saver\n\nText with a [[wikilink]] to keep. EDIT\n')
})

test('whitespace tier: trailing-space-only diff opens RENDERED; save strips the trailing space', async () => {
  await page.getByTestId('tab-doc-trailing').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/trailing.md')
  // The only round-trip diff is the trailing space → whitespace-tolerant tier → rendered.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()

  // Edit at the end, save: the deliberate normalization drops the trailing space.
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDIT')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/trailing.md')
  await expect
    .poll(async () => fs.readFile(target, 'utf8'))
    .toBe('# Trail\n\nLine with a trailing space\nmore text.\n\nTail. EDIT\n')
})

test('T-054: a wikilink is styled in rendered AND raw mode, and still round-trips byte-exact', async () => {
  await page.getByTestId('tab-doc-wiki').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'rendered')

  // Rendered mode: the `[[wikilink]]` run carries the .pm-wikilink decoration (visual only).
  const deco = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror .pm-wikilink')
  await expect(deco).toHaveCount(1)
  await expect(deco.first()).toHaveText('[[wikilink]]')

  // Byte-exact round-trip: edit away from the link and save — the brackets are preserved verbatim
  // (the decoration never touches the document), frontmatter stays intact.
  const para = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror p').last()
  await para.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDIT')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)
  const wikiTarget = join(fixture.workspaceRoot, 'Projects/alpha/wiki.md')
  await expect
    .poll(async () => fs.readFile(wikiTarget, 'utf8'))
    .toBe(WIKI.replace('[[wikilink]].', '[[wikilink]]. EDIT'))

  // Raw mode: the CodeMirror .cm-wikilink decoration is present on the same run.
  await vis('[data-testid="mode-toggle"]').click()
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  const cmDeco = page.locator('[data-testid="raw-editor"]:visible .cm-wikilink')
  await expect(cmDeco).toHaveCount(1)
  await expect(cmDeco.first()).toHaveText('[[wikilink]]')
})
