// modules: editor
// Pomade E-024 slice 1 — the LIVE view engine + inline constructs.
//   • a markdown tab with mode 'live' mounts the CodeMirror live view (data-mode 'live',
//     button label 'Live' — the label names the CURRENT view);
//   • inline markers are HIDDEN from the DOM but PRESENT in the file: **bold**, _em_,
//     ~~strike~~, ==highlight==, `code`, and the ATX `#` run; frontmatter is hidden too;
//   • an UNCLOSED marker pair stays visible text (zero special-casing — the parser only
//     folds closed pairs);
//   • typing raw syntax folds on parse-close, and the save writes EXACTLY the typed bytes
//     (byte-diff against the fixture — no serializer exists on this path);
//   • hidden markers are ATOMIC: ArrowLeft from after a folded `**b**` skips the hidden
//     closing run whole, so the next keystroke lands OUTSIDE the pair (byte-proven);
//   • Backspace "through" a hidden closing marker deletes the LETTER inside, never the
//     marker bytes — the rest stays bold (P-024 §4, letters-first half).
//
// Doc tabs are seeded via .pomade/state (the same restore path the app uses on relaunch),
// which also proves DocTab.mode 'live' survives persistence.

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

// Vault-shaped: YAML frontmatter, every v1 inline construct, an unclosed pair.
const FM = '---\ntitle: Live Note\ntags: [vault, test]\n---\n\n'
const INLINE_BODY =
  '# Live Heading\n\nIntro with **bold**, _ital_, ~~gone~~, ==marked== and `code` runs.\n\nSecond paragraph with an unclosed **marker pair.\n\n## Sub heading\n\nTail paragraph.\n'
const INLINE = FM + INLINE_BODY

// A minimal file for the atomicity / backspace byte-proofs.
const ATOMIC = '# A\n\nx**bold**\n'

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
  await fs.writeFile(join(root, 'Projects/alpha/inline.md'), INLINE)
  await fs.writeFile(join(root, 'Projects/alpha/atomic.md'), ATOMIC)
  await fs.writeFile(join(root, 'Projects/alpha/backspace.md'), ATOMIC)
  await fs.writeFile(join(root, 'Projects/alpha/clean.md'), INLINE)

  const state = {
    openTabs: [
      docTab('doc-inline', 'inline.md'),
      docTab('doc-atomic', 'atomic.md'),
      docTab('doc-backspace', 'backspace.md'),
      docTab('doc-clean', 'clean.md')
    ],
    activeTabId: 'doc-inline'
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

test('a live tab mounts the CM live view; markers + frontmatter hidden from the DOM, present in the file', async () => {
  await page.getByTestId('tab-doc-inline').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/inline.md')
  await expect(editor).toHaveAttribute('data-mode', 'live')
  // The mode button names the CURRENT view (T-014 doctrine extended to Live).
  await expect(vis('[data-testid="mode-toggle"]')).toHaveText('Live')
  const content = vis('[data-testid="live-editor"] .cm-content')
  await expect(content).toBeVisible()

  // Every construct's TEXT is visible…
  await expect(content).toContainText('bold')
  await expect(content).toContainText('ital')
  await expect(content).toContainText('gone')
  await expect(content).toContainText('marked')
  await expect(content).toContainText('code')
  await expect(content).toContainText('Live Heading')

  // …but the DOM never shows the markers (zero-reveal): folded pairs and the `#` run are
  // replace-decorated away. The UNCLOSED `**marker pair` stays literal text.
  const text = (await content.textContent()) ?? ''
  expect(text).not.toContain('**bold**')
  expect(text).not.toContain('_ital_')
  expect(text).not.toContain('~~')
  expect(text).not.toContain('==')
  expect(text).not.toContain('`')
  expect(text).not.toContain('# Live Heading')
  expect(text).toContain('unclosed **marker pair')
  // Frontmatter is hidden (the properties panel owns it, as in Rendered).
  expect(text).not.toContain('title: Live Note')

  // Styled spans carry the construct classes; headings style whole lines by level.
  await expect(content.locator('.cm-live-strong', { hasText: 'bold' })).toBeVisible()
  await expect(content.locator('.cm-live-em', { hasText: 'ital' })).toBeVisible()
  await expect(content.locator('.cm-live-strike', { hasText: 'gone' })).toBeVisible()
  await expect(content.locator('.cm-live-highlight', { hasText: 'marked' })).toBeVisible()
  await expect(content.locator('.cm-live-code', { hasText: 'code' })).toBeVisible()
  await expect(content.locator('.cm-line.cm-live-h1', { hasText: 'Live Heading' })).toBeVisible()
  await expect(content.locator('.cm-line.cm-live-h2', { hasText: 'Sub heading' })).toBeVisible()

  // The FILE still holds every marker byte (the view is a decoration, not a rewrite).
  expect(await read('inline.md')).toBe(INLINE)
})

test('typing raw syntax folds on parse-close, and the save changes ONLY the typed bytes', async () => {
  await page.getByTestId('tab-doc-inline').click()
  const content = vis('[data-testid="live-editor"] .cm-content')
  const tail = content.locator('.cm-line', { hasText: 'Tail paragraph.' })
  await tail.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' **hot**')

  // Folds the moment the pair closes: styled span present, markers gone from the DOM.
  await expect(content.locator('.cm-live-strong', { hasText: 'hot' })).toBeVisible()
  await expect(tail).not.toContainText('**')

  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)
  // Byte-diff: the file is the fixture plus EXACTLY the typed bytes — frontmatter verbatim,
  // nothing reformatted anywhere else.
  await expect
    .poll(() => read('inline.md'))
    .toBe(INLINE.replace('Tail paragraph.', 'Tail paragraph. **hot**'))
})

test('hidden markers are ATOMIC: ArrowLeft skips the folded closing run whole (byte-proven)', async () => {
  await page.getByTestId('tab-doc-atomic').click()
  const content = vis('[data-testid="live-editor"] .cm-content')
  const line = content.locator('.cm-line', { hasText: 'x' }).last()
  await line.click()
  await page.keyboard.press('End') // caret after the hidden closing `**`
  await page.keyboard.press('ArrowLeft') // atomic skip → lands INSIDE the text, after 'd'
  await page.keyboard.type('X')
  await page.keyboard.press(`${MOD}+s`)
  // Atomic: the caret skipped the whole `**` and X landed inside the bold text. Were the
  // markers not atomic, ArrowLeft would land between the two `*` and write `x**bold*X*`.
  await expect.poll(() => read('atomic.md')).toBe('# A\n\nx**boldX**\n')
})

test('Backspace through a hidden closing marker deletes the LETTER, the rest stays bold', async () => {
  await page.getByTestId('tab-doc-backspace').click()
  const content = vis('[data-testid="live-editor"] .cm-content')
  const line = content.locator('.cm-line', { hasText: 'x' }).last()
  await line.click()
  await page.keyboard.press('End') // caret after the hidden closing `**`
  await page.keyboard.press('Backspace') // deletes 'd' — NOT the `**` run
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read('backspace.md')).toBe('# A\n\nx**bol**\n')
  // Still folded and styled after the deletion.
  await expect(content.locator('.cm-live-strong', { hasText: 'bol' })).toBeVisible()
})

test('saving an untouched live doc writes byte-identical content (no serializer anywhere)', async () => {
  await page.getByTestId('tab-doc-clean').click()
  await expect(vis('[data-testid="live-editor"] .cm-content')).toBeVisible()
  // T-139 — a clean doc's button reads a disabled "Saved"; drive the explicit save via Cmd+S,
  // which always writes, to prove the untouched round-trip is byte-identical.
  await expect(vis('[data-testid="doc-save"]')).toHaveText('Saved')
  await vis('[data-testid="live-editor"] .cm-content').click()
  await page.keyboard.press(`${MOD}+s`)
  // Not dirty, nothing changed: the write reproduces the exact fixture bytes.
  await expect.poll(() => read('clean.md')).toBe(INLINE)
  await expect(page.locator('[data-testid="editor-dirty"]:visible')).toHaveCount(0)
})
