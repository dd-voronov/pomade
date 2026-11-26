// modules: editor
// Pomade T-124 — nested list items no longer gain a blank line when edited in rendered mode.
//
// The Milkdown serializer used to render every nested list item LOOSE (a blank line between the
// item's paragraph and its nested list) because commonmark's list-item schema hands mdast a
// STRINGIFIED `spread` ("false"/"true") — never the strict boolean mdast-util-to-markdown's join
// logic honors — and freshly-created items carry the schema default `spread: true` (boolean junk).
// The emitted blank line re-parses as a genuinely loose list, so the damage COMPOUNDED across
// edits (the Owner's report: nested items come back with an extra blank line, "not always").
//
// The fix is a `join` hook in md-config's shared remark-stringify config: a list item is loose
// ONLY when the parser marked it so (spread === the STRING 'true'); boolean-true junk from new
// items serializes TIGHT. Because the round-trip guard shares that config, tight nested-list files
// now round-trip byte-exact and open RENDERED by default (the T-005 win). These specs pin:
//   1. a tight depth-3 mixed list (bold + wikilinks) opens rendered and toggles to raw byte-exact;
//   2. adding a nested item in rendered mode serializes TIGHT (no blank lines) and saves tight;
//   3. a genuinely LOOSE list stays loose across a rendered edit (the string-'true' branch);
//   4. a nested TASK list keeps its `- [ ]`/`- [x]` checkboxes intact and tight after an edit.
// Fixtures mirror real vault content: inline **bold**, *italic*, `code`, and [[wikilinks]].

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
const PID = 'proj-alpha'

const FM = ['---', 'id: T-124', 'tags: [editor]', '---', ''].join('\n')

// 1 — tight depth-3 list, bullet+ordered mix, items carrying inline markup and a wikilink.
const DEEP = `${FM}
# Nested plan

Intro paragraph with a [[wikilink]].

- **Alpha** parent
  - Child with a [[wiki-link]]
    - Deep leaf in *italic*
  - Second child
- Beta parent
  1. First ordered
  2. Second ordered

Closing line.
`

// 2 — a tight two-level list we add a nested item to, in rendered mode.
const SIMPLE = `${FM}
# Simple list

- Parent with **bold**
  - Child one with a [[wikilink]]
  - Child two
`
const SIMPLE_AFTER = `${FM}
# Simple list

- Parent with **bold**
  - Child one with a [[wikilink]]
  - Child two
  - Child three
`

// 3 — a genuinely LOOSE list (blank lines in source): multi-paragraph first item + blank-separated
// items. The parser marks these items spread 'true', so they must STAY loose through the round-trip.
const LOOSE = `${FM}
# Loose

- First item

  Second paragraph in first item

- Second item
`

// 4 — a nested GFM task list. Checkboxes must survive a rendered edit, tight.
const TASKS = `${FM}
# Tasks

- [ ] Parent task
  - [x] Done subtask
  - [ ] Pending subtask
- [x] Second parent
`
const TASKS_AFTER = TASKS.replace('- [ ] Pending subtask', '- [x] Pending subtask')

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const read = (name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

function docTab(id: string, name: string, mode: 'raw' | 'rendered'): Record<string, unknown> {
  return { id, projectId: PID, kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode, dirty: false }
}

const SEED: { key: string; body: string; mode: 'raw' | 'rendered' }[] = [
  { key: 'deep', body: DEEP, mode: 'rendered' },
  { key: 'simple', body: SIMPLE, mode: 'rendered' },
  { key: 'loose', body: LOOSE, mode: 'rendered' },
  { key: 'tasks', body: TASKS, mode: 'rendered' }
]

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  const tabs: Record<string, unknown>[] = []
  for (const s of SEED) {
    await fs.writeFile(join(root, `Projects/alpha/${s.key}.md`), s.body)
    tabs.push(docTab(`doc-${s.key}`, `${s.key}.md`, s.mode))
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state/proj-alpha.json'),
    JSON.stringify({ openTabs: tabs, activeTabId: 'doc-deep' }, null, 2)
  )

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
  await page.getByTestId(`project-${PID}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('1: a tight depth-3 mixed list opens RENDERED by default and toggles to raw byte-identical', async () => {
  await page.getByTestId('tab-doc-deep').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/deep.md')
  // The guard accepts the tight nested list now → it opens rendered (previously forced to raw).
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(vis('[data-testid="mode-toggle"]')).toHaveText('Rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()
  await expect(prose).toContainText('Deep leaf in')
  await expect(prose).toContainText('Second ordered')

  // Toggle to raw and back — the pane never bounces, and no edit means the file is untouched.
  await vis('[data-testid="mode-toggle"]').click()
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await vis('[data-testid="mode-toggle"]').click()
  await expect(editor).toHaveAttribute('data-mode', 'rendered')

  // Byte-identity: the guard passed BECAUSE serialize(parse(body)) === body, and no edit happened.
  await expect(vis('[data-testid="editor-dirty"]')).toHaveCount(0)
  expect(await read('deep.md')).toBe(DEEP)
})

test('2: adding a nested item in rendered mode serializes TIGHT (no blank lines) and saves tight', async () => {
  await page.getByTestId('tab-doc-simple').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()

  // Put the caret at the end of the last nested item, press Enter (→ a new sibling nested item —
  // which carries the schema-default boolean `spread: true`, the exact junk the fix must ignore),
  // then type the new item's text.
  const childTwo = prose.getByText('Child two', { exact: true })
  await childTwo.click()
  await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Child three')
  await expect(prose).toContainText('Child three')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()

  await page.keyboard.press(`${MOD}+s`)

  // The nested list stays TIGHT: exact bytes, no blank line anywhere around the nested items.
  await expect.poll(() => read('simple.md')).toBe(SIMPLE_AFTER)
  const saved = await read('simple.md')
  expect(saved).not.toMatch(/\n\n\s+-/) // no blank line before an indented (nested) item
  expect(saved).not.toContain('Child two\n\n') // no blank line injected between siblings
})

test('3: a genuinely LOOSE list stays loose across a rendered edit', async () => {
  await page.getByTestId('tab-doc-loose').click()
  const editor = vis('[data-testid="editor-pane"]')
  // It round-trips byte-exact (blank lines preserved) → opens rendered.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  const prose = vis('[data-testid="rendered-editor"] .ProseMirror')
  await expect(prose).toBeVisible()

  // Edit the last item, save — the loose spacing (parser-sourced spread 'true') must survive.
  await prose.getByText('Second item', { exact: true }).click()
  await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
  await page.keyboard.press('End')
  await page.keyboard.type(' EDITED')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  const expected = LOOSE.replace('- Second item', '- Second item EDITED')
  await expect.poll(() => read('loose.md')).toBe(expected)
  const saved = await read('loose.md')
  // Loose markers preserved: blank line between the two items and between the item's paragraphs.
  expect(saved).toContain('Second paragraph in first item\n\n- Second item EDITED')
  expect(saved).toContain('- First item\n\n  Second paragraph in first item')
})

test('4: a nested task list keeps its checkboxes intact and tight after a rendered edit', async () => {
  await page.getByTestId('tab-doc-tasks').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'rendered')

  const boxes = page.locator('[data-testid="rendered-editor"]:visible input[data-testid="task-checkbox"]')
  await expect(boxes).toHaveCount(4)
  await expect(boxes.nth(0)).not.toBeChecked() // Parent task
  await expect(boxes.nth(1)).toBeChecked() // Done subtask
  await expect(boxes.nth(2)).not.toBeChecked() // Pending subtask
  await expect(boxes.nth(3)).toBeChecked() // Second parent

  // Check the pending nested subtask and save. Use the save BUTTON (not Cmd+S): the checkbox
  // preventDefaults its mousedown to keep the doc from losing focus to the input, which leaves the
  // native focus on the checkbox where a Cmd+S keystroke would not reach the editor's save handler.
  await boxes.nth(2).click()
  await expect(boxes.nth(2)).toBeChecked()
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await vis('[data-testid="doc-save"]').click()

  // Only the one marker flips; `- [ ]`/`- [x]` survive, nesting stays tight (no blank lines).
  await expect.poll(() => read('tasks.md')).toBe(TASKS_AFTER)
  const saved = await read('tasks.md')
  expect(saved).toContain('- [ ] Parent task\n  - [x] Done subtask\n  - [x] Pending subtask\n- [x] Second parent')
})
