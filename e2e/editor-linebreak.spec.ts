// modules: core, editor
// Pomade E-002 (T-038, supersedes T-017) — Obsidian soft-break semantics in rendered mode.
//   - RENDER: a single `\n` inside a paragraph shows as a visible line break (a real <br>), not a
//     merged/space-collapsed line (the bug the Owner hit — their vault is full of `line1\nline2`).
//   - TYPE: Enter inserts that soft break → serializes to exactly one `\n` (never a two-space or
//     backslash hard break); a second Enter on the empty break-line starts a real paragraph.
//   - ROUND-TRIP: `line1\nline2` opens rendered and saves back byte-exact; paragraph breaks
//     (`\n\n`) are untouched. A vault-style mixed note (frontmatter + soft breaks + list +
//     checkbox) round-trips byte-exact through a rendered edit.

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
import { waitCaretRegistered } from './fixtures/stores'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

// Fixtures.
const TYPED = 'start\n' // typed-Enter test writes into this one
const SOFT = 'line1\nline2\n' // an existing Obsidian-style soft break
const VAULT =
  '---\n' +
  'title: Vault Note\n' +
  'tags: [a, b]\n' +
  '---\n\n' +
  '# Notes\n\n' +
  'line one\n' +
  'line two\n\n' +
  '- item one\n' +
  '- item two\n\n' +
  '## Tasks\n\n' +
  '- [ ] todo\n' +
  '- [x] done\n'

function docTab(id: string, name: string): Record<string, unknown> {
  return { id, projectId: 'proj-alpha', kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode: 'rendered', dirty: false }
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/typed.md'), TYPED)
  await fs.writeFile(join(root, 'Projects/alpha/soft.md'), SOFT)
  await fs.writeFile(join(root, 'Projects/alpha/vault.md'), VAULT)
  // T-053 — single-paragraph docs the Enter=paragraph / Shift+Enter=soft-break test types into.
  await fs.writeFile(join(root, 'Projects/alpha/t053-enter.md'), 'A\n')
  await fs.writeFile(join(root, 'Projects/alpha/t053-soft.md'), 'C\n')

  const state = {
    openTabs: [
      docTab('doc-typed', 'typed.md'),
      docTab('doc-soft', 'soft.md'),
      docTab('doc-vault', 'vault.md'),
      docTab('doc-t053-enter', 't053-enter.md'),
      docTab('doc-t053-soft', 't053-soft.md')
    ],
    activeTabId: 'doc-typed'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await firstAppWindow(app)
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('typed Shift+Enter inserts a soft break in the SAME paragraph and saves exactly one `\\n`', async () => {
  // T-053: Shift+Enter is now the soft-break key (Enter makes a new paragraph — see the T-053 test
  // appended at the end). This still pins soft break ↔ exactly one `\n`.
  await page.getByTestId('tab-doc-typed').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')

  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await prose.click()
  await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
  await page.keyboard.press('End')
  await page.keyboard.type(' A')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('B')

  // ONE paragraph (not two), broken internally by a real <br>.
  const paras = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror > p')
  await expect(paras).toHaveCount(1)
  await expect(paras.first().locator('br')).toHaveCount(1)
  await expect(prose).toContainText('start A')
  await expect(prose).toContainText('B')

  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  // A single `\n` between the two lines — no `\n\n`, no `  \n`, no `\\\n`.
  const target = join(fixture.workspaceRoot, 'Projects/alpha/typed.md')
  await expect.poll(async () => fs.readFile(target, 'utf8')).toBe('start A\nB\n')
})

test('an existing `line1\\nline2` renders two visual lines and round-trips byte-exact', async () => {
  await page.getByTestId('tab-doc-soft').click()
  const editor = vis('[data-testid="editor-pane"]')
  // Opening rendered at all means the round-trip guard already proved serialize(parse)==source.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')

  // A single source paragraph, split by a real <br> → two visible lines (was merged before T-038).
  const paras = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror > p')
  await expect(paras).toHaveCount(1)
  await expect(paras.first().locator('br')).toHaveCount(1)
  await expect(paras.first()).toContainText('line1')
  await expect(paras.first()).toContainText('line2')

  // Append at the document end and save — the soft break between line1/line2 survives untouched.
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await prose.click()
  await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
  await page.keyboard.press(`${MOD}+ArrowDown`) // to document end
  await page.keyboard.type(' X')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/soft.md')
  await expect.poll(async () => fs.readFile(target, 'utf8')).toBe('line1\nline2 X\n')
})

test('vault-style note (frontmatter + soft breaks + list + checkbox) round-trips byte-exact', async () => {
  await page.getByTestId('tab-doc-vault').click()
  const editor = vis('[data-testid="editor-pane"]')
  // The whole body round-trips → opens rendered (frontmatter is preserved separately).
  await expect(editor).toHaveAttribute('data-mode', 'rendered')

  // Soft break rendered as <br>; both task checkboxes present with correct state.
  // (A <br> has no box, so it is never ":visible" — scope to the visible editor instead.)
  await expect(
    page.locator('[data-testid="rendered-editor"]:visible .ProseMirror br')
  ).toHaveCount(1)
  const boxes = page.locator('[data-testid="rendered-editor"]:visible input[data-testid="task-checkbox"]')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.nth(0)).not.toBeChecked()
  await expect(boxes.nth(1)).toBeChecked()

  // Toggle the first checkbox and save: EXACTLY one character changes; frontmatter, both soft-break
  // lines, the bullet list and the other checkbox are all byte-identical.
  await boxes.nth(0).click()
  await expect(boxes.nth(0)).toBeChecked()
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await vis('[data-testid="doc-save"]').click()

  const target = join(fixture.workspaceRoot, 'Projects/alpha/vault.md')
  const expected = VAULT.replace('- [ ] todo', '- [x] todo')
  await expect.poll(async () => fs.readFile(target, 'utf8')).toBe(expected)
})

test('T-053: Enter makes a paragraph (`\\n\\n`), Shift+Enter makes a soft break (`\\n`)', async () => {
  // Enter → new paragraph. Cursor at end of the seeded "A".
  await page.getByTestId('tab-doc-t053-enter').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')
  const enterProse = vis('[data-testid="rendered-editor"] .ProseMirror')
  await enterProse.click()
  await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('B')
  // Two separate paragraphs (not one paragraph with a <br>).
  const enterParas = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror > p')
  await expect(enterParas).toHaveCount(2)
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)
  const enterTarget = join(fixture.workspaceRoot, 'Projects/alpha/t053-enter.md')
  await expect.poll(async () => fs.readFile(enterTarget, 'utf8')).toBe('A\n\nB\n')

  // Shift+Enter → soft break inside one paragraph. Cursor at end of the seeded "C".
  await page.getByTestId('tab-doc-t053-soft').click()
  const softProse = vis('[data-testid="rendered-editor"] .ProseMirror')
  await softProse.click()
  await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('D')
  const softParas = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror > p')
  await expect(softParas).toHaveCount(1)
  await expect(softParas.first().locator('br')).toHaveCount(1)
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)
  const softTarget = join(fixture.workspaceRoot, 'Projects/alpha/t053-soft.md')
  await expect.poll(async () => fs.readFile(softTarget, 'utf8')).toBe('C\nD\n')

  // An existing `line1\nline2` note still renders both lines with a visible break.
  await page.getByTestId('tab-doc-soft').click()
  const existing = page.locator('[data-testid="rendered-editor"]:visible .ProseMirror > p')
  await expect(existing).toHaveCount(1)
  await expect(existing.first().locator('br')).toHaveCount(1)
})
