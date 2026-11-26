// modules: core, editor
// Pomade E-024 slice 5 — editing-semantics hardening + the byte-fidelity sweep.
//   • P-024 §4 verbatim: deleting the LAST character between a marker pair removes the
//     now-empty pair with it — recursively for nested constructs — so the buffer never
//     holds an orphaned `**`/`****`;
//   • P-024 §5 style-matched insertion: Cmd+B/I write the DOCUMENT's detected convention
//     (`_`-flavored doc → `__…__`/`_…_`); Pomade's `**`/`*` only with no signal; with the
//     caret inside an existing construct the command toggles it OFF (markers deleted);
//   • list insertion follows the document's convention BY CONSTRUCTION — Enter continues a
//     list by copying the current marker (`*` list stays `*`);
//   • byte-fidelity sweep on a vault-shaped fixture (frontmatter, `_em_`, an
//     E-023-CANONICALIZED table, a callout, a tight list, inline `<br>`): one typed edit +
//     save changes ONLY the typed bytes — nothing re-padded, re-flavored or normalized;
//   • toggling views (Live ⇄ Raw ⇄ Rendered via the ⋯ override) without editing never
//     dirties the doc, and an explicit save writes byte-identical content.

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
import { expectQuiet } from './fixtures/timing'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const PAIR = '# P\n\nx**b**y\n'
const NESTED = '# N\n\na **_c_** b\n'
const UNDER =
  '---\ntitle: Under\n---\n\n# U\n\nAlready has __strong__ and _flavor_ in it.\n\nMake the target word bold and vital too.\n'
const PLAIN = '# S\n\nMake the target word bold.\n'
const STARLIST = '# L\n\n* one\n* two\n'
// Vault-shaped sweep fixture: every byte shape the Milkdown serializer would rewrite —
// which is exactly what Live must NEVER touch.
const SWEEP_FM = '---\ntitle: Sweep Note\ntags: [vault, sweep]\n---\n\n'
const SWEEP_BODY = `# Sweep

Prose with _underscore em_, __underscore strong__, a<br>break and a [[wikilink]].

| Column A | B |
| --- | :-- |
| unpadded | cells |

> [!note] Callout title
> - callout list item
> - second item

- tight one
- tight two

Tail paragraph.
`
const SWEEP = SWEEP_FM + SWEEP_BODY

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
  const files: Record<string, string> = {
    'pair.md': PAIR,
    'nested.md': NESTED,
    'under.md': UNDER,
    'under-i.md': UNDER,
    'under-off.md': UNDER,
    'plain.md': PLAIN,
    'starlist.md': STARLIST,
    'sweep.md': SWEEP,
    'toggles.md': SWEEP
  }
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(join(root, 'Projects/alpha', name), body)
  }

  const state = {
    openTabs: Object.keys(files).map((name) => docTab(`doc-${name.replace(/\.md$/, '')}`, name)),
    activeTabId: 'doc-pair'
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

async function openLive(id: string): Promise<void> {
  await page.getByTestId(`tab-${id}`).click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'live')
}

test('deleting the last character between markers removes the now-empty pair with it', async () => {
  await openLive('doc-pair')
  const line = vis('[data-testid="live-editor"] .cm-content').locator('.cm-line', { hasText: 'x' }).last()
  await line.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Backspace') // plain: deletes 'y'
  await page.keyboard.press('Backspace') // tunnels the hidden `**`, deletes 'b' → pair goes too
  await page.keyboard.press(`${MOD}+s`)
  // NOT 'x****' — the empty pair left WITH its last character (P-024 §4 verbatim).
  await expect.poll(() => read('pair.md')).toBe('# P\n\nx\n')
})

test('nested constructs: emptying the innermost removes every emptied pair — no orphans', async () => {
  await openLive('doc-nested')
  const line = vis('[data-testid="live-editor"] .cm-content').locator('.cm-line', { hasText: 'a' }).last()
  await line.click()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft') // over ' '
  await page.keyboard.press('ArrowLeft') // over 'b' → caret right after the hidden `_**`
  await page.keyboard.press('Backspace') // deletes 'c' → `_…_` AND `**…**` go with it
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read('nested.md')).toBe('# N\n\na  b\n')
})

// Deterministic caret placement: a Playwright click on getByText resolves to the whole
// .cm-line ELEMENT (text nodes aren't elements) and clicks its CENTER — which for a short
// line lands past the text. So these tests park the caret with End + ArrowLeft counts
// (the lines carry no hidden markers, so arrows = plain characters) and exercise the
// command's word-at-caret branch.
async function caretInside(lineText: string, backFromEnd: number): Promise<void> {
  const content = vis('[data-testid="live-editor"] .cm-content')
  await content.locator('.cm-line', { hasText: lineText }).click()
  await page.keyboard.press('End')
  for (let i = 0; i < backFromEnd; i++) await page.keyboard.press('ArrowLeft')
}

test('Cmd+B in a `_`-flavored doc writes __…__ (style-matched insertion)', async () => {
  await openLive('doc-under')
  // ' word bold and vital too.' = 25 chars after 'target'; +1 puts the caret INSIDE it.
  await caretInside('Make the target', 26)
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.press(`${MOD}+s`)
  await expect
    .poll(() => read('under.md'))
    .toBe(UNDER.replace('the target word', 'the __target__ word'))
})

test('Cmd+I in a `_`-flavored doc writes _…_', async () => {
  await openLive('doc-under-i')
  // ' too.' = 5 chars after 'vital'; +1 puts the caret INSIDE it.
  await caretInside('Make the target', 6)
  await page.keyboard.press(`${MOD}+i`)
  await page.keyboard.press(`${MOD}+s`)
  await expect
    .poll(() => read('under-i.md'))
    .toBe(UNDER.replace('and vital too', 'and _vital_ too'))
})

test('Cmd+B with no document signal writes Pomade’s **…**', async () => {
  await openLive('doc-plain')
  // ' word bold.' = 11 chars after 'target'; +1 puts the caret INSIDE it.
  await caretInside('Make the target', 12)
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.press(`${MOD}+s`)
  await expect
    .poll(() => read('plain.md'))
    .toBe('# S\n\nMake the **target** word bold.\n')
})

test('Cmd+B inside an existing strong construct toggles it OFF (markers deleted, text kept)', async () => {
  await openLive('doc-under-off')
  const content = vis('[data-testid="live-editor"] .cm-content')
  await content.locator('.cm-live-strong', { hasText: 'strong' }).click()
  await page.keyboard.press(`${MOD}+b`)
  await page.keyboard.press(`${MOD}+s`)
  await expect
    .poll(() => read('under-off.md'))
    .toBe(UNDER.replace('__strong__', 'strong'))
})

test('Enter continues a `*` list with `*` — list insertion follows the document convention', async () => {
  await openLive('doc-starlist')
  const content = vis('[data-testid="live-editor"] .cm-content')
  await content.locator('.cm-line', { hasText: 'two' }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('three')
  await page.keyboard.press(`${MOD}+s`)
  // The continuation copied the CURRENT marker — `*`, not Pomade's `-`.
  await expect.poll(() => read('starlist.md')).toBe('# L\n\n* one\n* two\n* three\n')
})

test('byte-fidelity sweep: one typed edit leaves every E-023-canonicalized shape untouched', async () => {
  await openLive('doc-sweep')
  const content = vis('[data-testid="live-editor"] .cm-content')
  const tail = content.locator('.cm-line', { hasText: 'Tail paragraph.' })
  await tail.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDIT')
  await page.keyboard.press(`${MOD}+s`)
  // The WHOLE file, byte for byte: `_em_` not re-flavored to `*em*`, the table not
  // re-padded, the callout + tight list + <br> + frontmatter untouched — only the edit.
  await expect
    .poll(() => read('sweep.md'))
    .toBe(SWEEP.replace('Tail paragraph.', 'Tail paragraph. EDIT'))
})

test('toggling Live ⇄ Raw ⇄ Rendered without editing never dirties; a save is byte-identical', async () => {
  await openLive('doc-toggles')
  const editor = vis('[data-testid="editor-pane"]')
  const toggle = vis('[data-testid="mode-toggle"]')

  // Live → Raw → Live.
  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'live')

  // Live → Rendered (⋯ override) → back to Live.
  await vis('[data-testid="doc-actions"]').click()
  await vis('[data-testid="action-rich-view"]').click()
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await vis('[data-testid="doc-actions"]').click()
  await vis('[data-testid="action-rich-view"]').click()
  await expect(editor).toHaveAttribute('data-mode', 'live')

  // Never dirtied…
  await expect(page.locator('[data-testid="editor-dirty"]:visible')).toHaveCount(0)
  // …and the file was never rewritten; an explicit save reproduces the exact bytes.
  expect(await read('toggles.md')).toBe(SWEEP)
  // T-139 — a clean, undiverged doc shows a disabled "Saved" button, so this explicit save
  // goes through Cmd+S (which always writes); the bytes must still be identical.
  await expect(vis('[data-testid="doc-save"]')).toHaveText('Saved')
  await page.keyboard.press(`${MOD}+s`)
  // The write is fast — hold byte-identity for its whole landing window.
  await expectQuiet(async () => {
    expect(await read('toggles.md')).toBe(SWEEP)
  }, 300)
})
