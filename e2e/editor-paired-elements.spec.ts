// modules: editor
// Pomade T-077 e2e — paired elements in the RAW editor: auto-close + selection wrapping.
//
// Every assertion goes through SAVED BYTES (Cmd+S → read the file), so what is checked is the
// exact document, not a whitespace-normalized DOM read of `.cm-content`.
//
// Fixtures are vault-shaped on purpose (frontmatter, wikilinks, a real checklist, a ledger-shaped
// CSV) — the repo's lesson is that synthetic minimal docs hide the interactions that actually
// break: frontmatter `---`, `[[wikilink]]` brackets already in the text, list markers next to the
// `[` the checkbox rule wants (T-050). Two further fixture rules, both learned the hard way:
//   • NO fixture ends with a newline — EditorPane's `reconstruct` re-appends the trailing newline
//     a file was loaded with, which would silently shift the first save's expected bytes.
//   • every line stays short — `Home`/`Shift+End`/`Shift+ArrowDown` are VISUAL-line commands and
//     the raw editor wraps long lines.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const PID = 'proj-alpha'

function docTab(id: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId: PID,
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode: 'raw',
    dirty: false
  }
}

async function seed(
  fixture: Fixture,
  files: Record<string, string>,
  tabs: Record<string, unknown>[],
  activeId: string
): Promise<void> {
  const root = fixture.workspaceRoot
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(root, 'Projects/alpha', name), content)
  }
  const state = { openTabs: tabs, activeTabId: activeId }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launchAppPage(fixture)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
  return { app, page }
}

const read = (fixture: Fixture, name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

// Both doc panes stay MOUNTED (PaneHost hides the inactive one), so every locator is scoped to its
// own `pane-<tabId>` instead of `:visible` — the lesson from editor-checkbox-autocomplete.spec.ts.
const paneSel = (tabId: string): string => `[data-testid="pane-${tabId}"]`
const cmContent = (page: Page, tabId: string): ReturnType<Page['locator']> =>
  page.locator(`${paneSel(tabId)} [data-testid="raw-editor"] .cm-content`)
const cmLine = (page: Page, tabId: string, text: string): ReturnType<Page['locator']> =>
  page.locator(`${paneSel(tabId)} .cm-line`, { hasText: text }).first()

/** Focus a raw pane and put the caret at the very end of the document. */
async function caretAtEnd(page: Page, tabId: string): Promise<void> {
  await expect(page.locator(`${paneSel(tabId)} [data-testid="editor-pane"]`)).toHaveAttribute(
    'data-mode',
    'raw'
  )
  // The LAST line, not the content box: a click in the middle of the box could land on a color
  // swatch widget (E-019) and open the picker instead of moving the caret.
  await page.locator(`${paneSel(tabId)} .cm-line`).last().click()
  await page.keyboard.press(`${MOD}+ArrowDown`)
}

/** Select exactly one (short, unwrapped) line by its text. */
async function selectLine(page: Page, tabId: string, text: string): Promise<void> {
  await cmLine(page, tabId, text).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
}

/** Save, then assert the file's exact bytes. */
async function savedIs(page: Page, fixture: Fixture, name: string, expected: string): Promise<void> {
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read(fixture, name)).toBe(expected)
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
// A wiki-shaped note: frontmatter, an inline `[work, review]` array, a `[[wikilink]]`.
const NOTE =
  '---\n' +
  'title: Weekly review\n' +
  'tags: [work, review]\n' +
  '---\n' +
  '\n' +
  '# Weekly review\n' +
  '\n' +
  'Shipped the paste icon (T-058).\n' +
  '\n' +
  'See [[jane-doe]] for context.'

const PROSE = '# Session log\n\nAlex, on scope creep:'

const WRAP =
  '# Wrap fixtures\n' +
  '\n' +
  'opener target\n' +
  'closer target\n' +
  'emphasis target\n' +
  'first span line\n' +
  'second span line'

const UNDO = '# Undo fixtures\n\nundo wrap target'

const TASKS_DASH =
  '---\n' +
  'title: Round-6 checklist\n' +
  '---\n' +
  '\n' +
  '- [x] paste icon in the go-to field\n' +
  '- [ ] rerun the suite\n' +
  '\n' +
  '- '

const TASKS_STAR = '# Star markers\n\n* [x] nested groups\n\n* '

const CANCEL = '# Round-6 review notes\n\nOpen items:\n\n- '

const TXT = 'alpha notes\n\nreminder: ping the librarian'
const CSS = ':root {\n  --accent: #4f7cff;\n}'
const HTML = '<!doctype html>\n<html lang="en">\n  <body>\n    <h1>Pomade</h1>\n  </body>\n</html>'
// Shaped like Knowledge/_meta/sources-ledger.csv (a free-text trailing column).
const CSV = 'path,status,note\n2026-07-24.md,used,round-5 notes\nopen-questions.md,used,in git-base.md'

test.describe('T-077 — raw-editor paired elements', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('every pair auto-closes, the closer types over it, Backspace removes both; `*`/`_` never auto-close', async () => {
    await seed(fixture, { 'note.md': NOTE }, [docTab('doc-note', 'note.md')], 'doc-note')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-note')

    // Each opener typed alone at the end of the doc: the closer appears, and Backspace between the
    // halves removes BOTH (no orphan closer left behind).
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
      ['<', '>'],
      ['"', '"'],
      ["'", "'"],
      ['`', '`']
    ]) {
      await page.keyboard.type(open)
      await savedIs(page, fixture, 'note.md', `${NOTE}${open}${close}`)
      await page.keyboard.press('Backspace')
      await savedIs(page, fixture, 'note.md', NOTE)
    }

    // Markdown emphasis is wrap-ONLY: typing it never injects a partner.
    await page.keyboard.type('*')
    await savedIs(page, fixture, 'note.md', `${NOTE}*`)
    await page.keyboard.press('Backspace')
    await page.keyboard.type('_')
    await savedIs(page, fixture, 'note.md', `${NOTE}_`)
    await page.keyboard.press('Backspace')

    // Typing the closer where one was auto-inserted moves OVER it (one `)`, not two), leaving the
    // caret outside the pair.
    await page.keyboard.type('(')
    await page.keyboard.type(')')
    await page.keyboard.type('x')
    await savedIs(page, fixture, 'note.md', `${NOTE}()x`)
    await expect(cmContent(page, 'doc-note')).toContainText('()x')

    // `[` twice = the wikilink shape, with no stray closers.
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('[[')
    await savedIs(page, fixture, 'note.md', `${NOTE}[[]]`)
    await app.close()
  })

  test('quotes do not pair right after a word character (apostrophes in prose stay single)', async () => {
    await seed(fixture, { 'prose.md': PROSE }, [docTab('doc-prose', 'prose.md')], 'doc-prose')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-prose')

    // Apostrophe inside a word: no partner, no `don''t`.
    await page.keyboard.type(' we don')
    await page.keyboard.type("'")
    await page.keyboard.type('t need ceremony')
    await savedIs(page, fixture, 'prose.md', `${PROSE} we don't need ceremony`)

    // A double quote right after a word character is equally literal…
    await page.keyboard.type('"')
    await savedIs(page, fixture, 'prose.md', `${PROSE} we don't need ceremony"`)

    // …but after a space it pairs, and the typed text lands inside.
    await page.keyboard.type(' ')
    await page.keyboard.type('"')
    await page.keyboard.type('ship it')
    await savedIs(page, fixture, 'prose.md', `${PROSE} we don't need ceremony" "ship it"`)
    await app.close()
  })

  test('a selection is wrapped by EITHER half, `*`/`_` stack, and a multi-line selection wraps as a whole', async () => {
    await seed(fixture, { 'wrap.md': WRAP }, [docTab('doc-wrap', 'wrap.md')], 'doc-wrap')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-wrap')

    // Opener half.
    await selectLine(page, 'doc-wrap', 'opener target')
    await page.keyboard.type('(')
    await expect(cmContent(page, 'doc-wrap')).toContainText('(opener target)')

    // Closer half — the same wrap, not a replacement of the selected text.
    await selectLine(page, 'doc-wrap', 'closer target')
    await page.keyboard.type('}')
    await expect(cmContent(page, 'doc-wrap')).toContainText('{closer target}')

    // Emphasis stacks: the selection stays on the INNER text, so a second `*` doubles it.
    await selectLine(page, 'doc-wrap', 'emphasis target')
    await page.keyboard.type('*')
    await expect(cmContent(page, 'doc-wrap')).toContainText('*emphasis target*')
    await page.keyboard.type('*')
    await expect(cmContent(page, 'doc-wrap')).toContainText('**emphasis target**')
    // The selection never leaves the INNER text, so a following `_` nests inside the `**` pair.
    await page.keyboard.type('_')
    await expect(cmContent(page, 'doc-wrap')).toContainText('**_emphasis target_**')

    // Multi-line: one opener before the first character, one closer after the last.
    await cmLine(page, 'doc-wrap', 'first span line').click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+End')
    await page.keyboard.type('`')

    await savedIs(
      page,
      fixture,
      'wrap.md',
      '# Wrap fixtures\n' +
        '\n' +
        '(opener target)\n' +
        '{closer target}\n' +
        '**_emphasis target_**\n' +
        '`first span line\n' +
        'second span line`'
    )
    await app.close()
  })

  test('one undo step per auto-close insertion and per wrap', async () => {
    await seed(fixture, { 'undo.md': UNDO }, [docTab('doc-undo', 'undo.md')], 'doc-undo')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-undo')

    // Insertion: a single undo takes the whole pair, never leaving a lone `(`.
    await page.keyboard.type('(')
    await savedIs(page, fixture, 'undo.md', `${UNDO}()`)
    await page.keyboard.press(`${MOD}+z`)
    await savedIs(page, fixture, 'undo.md', UNDO)

    // Wrap: one undo restores the unwrapped text (the wrap is history-isolated, so neither the
    // keystrokes before it nor the ones after can be swept into the same step).
    await selectLine(page, 'doc-undo', 'undo wrap target')
    await page.keyboard.type('"')
    await savedIs(page, fixture, 'undo.md', '# Undo fixtures\n\n"undo wrap target"')
    await page.keyboard.press(`${MOD}+z`)
    await savedIs(page, fixture, 'undo.md', UNDO)
    await app.close()
  })

  test('T-050 wins over auto-close: `- ` / `* ` + `[` still expands to a checkbox', async () => {
    await seed(
      fixture,
      { 'tasks.md': TASKS_DASH, 'stars.md': TASKS_STAR },
      [docTab('doc-tasks', 'tasks.md'), docTab('doc-stars', 'stars.md')],
      'doc-tasks'
    )
    const { app, page } = await launch(fixture)

    await page.getByTestId('tab-doc-tasks').click()
    await caretAtEnd(page, 'doc-tasks')
    await page.keyboard.type('[')
    await page.keyboard.type('rebuild the DnD model')
    await savedIs(page, fixture, 'tasks.md', `${TASKS_DASH}[ ] rebuild the DnD model`)

    await page.getByTestId('tab-doc-stars').click()
    await caretAtEnd(page, 'doc-stars')
    await page.keyboard.type('[')
    await page.keyboard.type('flattened tier rail')
    await savedIs(page, fixture, 'stars.md', `${TASKS_STAR}[ ] flattened tier rail`)

    // With a SELECTION, `[` is a wrap — the checkbox rule must not eat the selected text.
    await selectLine(page, 'doc-stars', 'nested groups')
    await page.keyboard.type('[')
    await savedIs(
      page,
      fixture,
      'stars.md',
      '# Star markers\n\n[* [x] nested groups]\n\n* [ ] flattened tier rail'
    )
    await app.close()
  })

  test('the checkbox completion is cancellable: Backspace or Escape as the very next keystroke reverts it to `- [`', async () => {
    await seed(fixture, { 'cancel.md': CANCEL }, [docTab('doc-cancel', 'cancel.md')], 'doc-cancel')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-cancel')

    // Complete, then take it back with Backspace: the auto-inserted ` ] ` goes, the typed `[` stays.
    await page.keyboard.type('[')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[ ] `)
    await page.keyboard.press('Backspace')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[`)

    // Both halves are single coherent history steps: one undo re-completes, the next removes the
    // whole completion (back to the bare marker, no orphan `[`).
    await page.keyboard.press(`${MOD}+z`)
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[ ] `)
    await page.keyboard.press(`${MOD}+z`)
    await savedIs(page, fixture, 'cancel.md', CANCEL)

    // Escape cancels the same way.
    await page.keyboard.type('[')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[ ] `)
    await page.keyboard.press('Escape')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[`)

    // After a revert the line is `- [`, so the completion context (`- ` right before the caret) is
    // gone: another `[` is an ordinary auto-close, never a second completion — no re-trigger loop.
    await page.keyboard.type('[')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[[]`)
    await page.keyboard.press('Backspace')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[`)
    await page.keyboard.press('Backspace')
    await savedIs(page, fixture, 'cancel.md', CANCEL)

    // Typing COMMITS the completion: Backspace is an ordinary character delete again.
    await page.keyboard.type('[')
    await page.keyboard.type('rerun the suite')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[ ] rerun the suite`)
    await page.keyboard.press('Backspace')
    await savedIs(page, fixture, 'cancel.md', `${CANCEL}[ ] rerun the suit`)
    await app.close()
  })

  test('pairs work in .txt and .css; .html keeps tag completion and gets no `<>` pair', async () => {
    await seed(
      fixture,
      { 'notes.txt': TXT, 'theme.css': CSS, 'page.html': HTML },
      [docTab('doc-txt', 'notes.txt'), docTab('doc-css', 'theme.css'), docTab('doc-html', 'page.html')],
      'doc-txt'
    )
    const { app, page } = await launch(fixture)

    await page.getByTestId('tab-doc-txt').click()
    await caretAtEnd(page, 'doc-txt')
    await page.keyboard.type(' (')
    await page.keyboard.type('plain text pairs')
    await savedIs(page, fixture, 'notes.txt', `${TXT} (plain text pairs)`)

    await page.getByTestId('tab-doc-css').click()
    await caretAtEnd(page, 'doc-css')
    await page.keyboard.type('[')
    await savedIs(page, fixture, 'theme.css', `${CSS}[]`)

    // `.html` is the ONE exception to the `<>` pair: lang-html's tag completion owns angle
    // brackets there, so `<` stays literal and `>` closes the TAG instead.
    await page.getByTestId('tab-doc-html').click()
    await caretAtEnd(page, 'doc-html')
    await page.keyboard.type('<')
    await savedIs(page, fixture, 'page.html', `${HTML}<`)
    await page.keyboard.type('p>')
    await savedIs(page, fixture, 'page.html', `${HTML}<p></p>`)
    // …while every other pair still works in HTML. (At the end of the line — a bracket typed
    // directly in front of the `</p>` correctly does NOT close: closeBrackets only closes in front
    // of whitespace, EOL, or `)]}:;>`.)
    await page.keyboard.press('End')
    await page.keyboard.type('(')
    await savedIs(page, fixture, 'page.html', `${HTML}<p></p>()`)
    await app.close()
  })

  test('.csv gets nothing — the raw fallback types literally and never wraps', async () => {
    await seed(fixture, { 'ledger.csv': CSV }, [docTab('doc-csv', 'ledger.csv')], 'doc-csv')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-csv')

    // No closer inserted for a bracket or a quote (a CSV quote must stay exactly what was typed).
    await page.keyboard.type('(')
    await page.keyboard.type('"')
    await savedIs(page, fixture, 'ledger.csv', `${CSV}("`)

    // No wrapping either: with a selection the mark REPLACES it, like ordinary typing.
    await selectLine(page, 'doc-csv', 'round-5 notes')
    await page.keyboard.type('*')
    await savedIs(
      page,
      fixture,
      'ledger.csv',
      'path,status,note\n*\nopen-questions.md,used,in git-base.md("'
    )
    await app.close()
  })
})
