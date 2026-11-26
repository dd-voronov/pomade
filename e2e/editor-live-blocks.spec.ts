// modules: editor
// Pomade E-024 slice 2 — LIVE view block constructs.
//   • bullet lists render a • widget over the marker (the `-` byte stays in the file);
//     ordered markers stay real, tinted text; tight/loose spacing is source-true by
//     construction (every physical line is one .cm-line — T-126 parity);
//   • task checkboxes are clickable widgets — a click writes the ONE-CHAR diff;
//   • blockquote `> ` markers are hidden, quote lines carry the styled border class;
//     an Obsidian callout renders as a plain styled blockquote (never an error);
//   • fenced code: fence lines dimmed, block monospace; tables: styled MONOSPACE SOURCE,
//     editable as text (byte-diff proven); horizontal rule = atomic widget;
//   • images render as a compact atomic 🖼 chip with the filename; clicking opens the
//     image's own tab; the file keeps the full `![alt](target)` bytes;
//   • frontmatter is hidden and the properties panel appears — identical to Rendered.

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

// Vault-shaped block fixture: frontmatter, lists (tight + nested), tasks, quote + callout,
// fenced code, table, hr, image.
const FM = '---\ntitle: Blocks Note\ntags: [vault]\n---\n\n'
const BLOCKS_BODY = `# Blocks

- alpha
- beta
  - nested
1. first
2. second

- [ ] open task
- [x] done task

> A quoted line.

> [!note] Callout title
> Callout body line.

\`\`\`js
const x = 1
\`\`\`

| Col A | Col B |
| --- | --- |
| a1 | b1 |

---

![screenshot](assets/shot.png)

Tail.
`
const BLOCKS = FM + BLOCKS_BODY

function docTab(id: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId: 'proj-alpha',
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode: 'live',
    dirty: false
  }
}

const read = (name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/blocks.md'), BLOCKS)
  await fs.mkdir(join(root, 'Projects/alpha/assets'), { recursive: true })
  // A tiny real PNG so the chip's click target exists on disk.
  await fs.writeFile(
    join(root, 'Projects/alpha/assets/shot.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  )

  const state = { openTabs: [docTab('doc-blocks', 'blocks.md')], activeTabId: 'doc-blocks' }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('project-proj-alpha').click()
  await page.getByTestId('tab-doc-blocks').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'live')
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('lists: bullets render as • widgets (bytes intact), ordered markers stay editable text', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  // Bullet items show • and no leading dash in the DOM.
  const alpha = content.locator('.cm-line', { hasText: 'alpha' })
  await expect(alpha.locator('.cm-live-bullet')).toHaveText('•')
  expect(await alpha.textContent()).not.toContain('-')
  await expect(content.locator('.cm-line', { hasText: 'nested' }).locator('.cm-live-bullet')).toHaveCount(1)
  // Ordered markers remain literal text, tinted.
  const first = content.locator('.cm-line', { hasText: 'first' })
  await expect(first.locator('.cm-live-list-mark')).toHaveText('1.')
  // File bytes untouched by rendering.
  expect(await read('blocks.md')).toBe(BLOCKS)
})

test('task checkbox click writes the ONE-CHAR diff', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  const openTask = content.locator('.cm-line', { hasText: 'open task' })
  // The bullet + `[ ]` collapsed into one widget; the raw marker text is out of the DOM.
  expect(await openTask.textContent()).not.toContain('[')
  await openTask.locator('[data-testid="live-task-checkbox"]').click()
  await page.keyboard.press(`${MOD}+s`)
  // Exactly one byte changed: the open task's state char.
  await expect
    .poll(() => read('blocks.md'))
    .toBe(BLOCKS.replace('- [ ] open task', '- [x] open task'))
  // Toggle back for the later byte-exact assertions.
  await openTask.locator('[data-testid="live-task-checkbox"]').click()
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read('blocks.md')).toBe(BLOCKS)
})

test('blockquotes + callouts: `> ` hidden, styled border line; callout is a plain quote, never an error', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  const quoted = content.locator('.cm-line.cm-live-quote', { hasText: 'A quoted line.' })
  await expect(quoted).toBeVisible()
  expect(await quoted.textContent()).not.toContain('>')
  // The callout renders as a styled blockquote with its [!note] tag as visible text.
  const callout = content.locator('.cm-line.cm-live-quote', { hasText: 'Callout title' })
  await expect(callout).toBeVisible()
  await expect(callout).toContainText('[!note]')
  expect(await callout.textContent()).not.toContain('>')
})

test('fenced code: fences dimmed, block monospace; the fence bytes stay put', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  await expect(content.locator('.cm-line.cm-live-fence', { hasText: '```js' })).toBeVisible()
  await expect(content.locator('.cm-line.cm-live-codeblock', { hasText: 'const x = 1' })).toBeVisible()
})

test('tables are styled monospace SOURCE, editable as text with a byte-true save', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  const row = content.locator('.cm-line.cm-live-table', { hasText: 'a1' })
  await expect(row).toBeVisible()
  // The pipes are REAL text (styled source, not a widget).
  await expect(row).toContainText('| a1 | b1 |')
  await row.click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.keyboard.press(`${MOD}+s`)
  // Only the typed byte changed — the table is NOT re-padded (no serializer).
  await expect
    .poll(() => read('blocks.md'))
    .toBe(BLOCKS.replace('| a1 | b1 |', '| a1 | b1 |!'))
  // Restore.
  await page.keyboard.press('Backspace')
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read('blocks.md')).toBe(BLOCKS)
})

test('horizontal rule renders as an atomic widget object', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  await expect(content.locator('[data-testid="live-hr"]')).toHaveCount(1)
  // The `---` bytes are gone from the DOM (frontmatter delimiters are hidden too, so
  // assert on the hr's own line).
  const hrLine = content.locator('.cm-line', { has: page.locator('[data-testid="live-hr"]') })
  expect(((await hrLine.textContent()) ?? '').trim()).toBe('')
})

test('image = compact chip with filename; click opens the image tab; bytes stay put', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  const chip = content.locator('[data-testid="live-image-chip"]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('shot.png')
  // The markdown syntax is out of the DOM…
  expect(await content.textContent()).not.toContain('![screenshot]')
  // …and fully in the file.
  expect(await read('blocks.md')).toBe(BLOCKS)

  await chip.click()
  // The image path opened as its own tab (the standing image-tab behavior: the doc pane
  // owns the path; binaries show the refusal panel with Reveal in Finder).
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute(
    'data-doc-path',
    'Projects/alpha/assets/shot.png'
  )
  // Back to the live doc for later tests.
  await page.getByTestId('tab-doc-blocks').click()
})

test('frontmatter is hidden and the properties panel appears, identical to Rendered', async () => {
  const content = vis('[data-testid="live-editor"] .cm-content')
  expect(await content.textContent()).not.toContain('title: Blocks Note')
  // The panel lives in the SAME scroll container as the live body (E-013 architecture).
  const scroll = vis('[data-testid="live-scroll"]')
  await expect(scroll.getByTestId('properties-panel')).toBeVisible()
  await expect(scroll.getByTestId('properties-panel')).toContainText('title')
})
