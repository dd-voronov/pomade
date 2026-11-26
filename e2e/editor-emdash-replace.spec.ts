// modules: editor
// Pomade T-152 e2e — app-level `--` + boundary → em-dash (—, U+2014) auto-replacement.
//
// Every assertion goes through SAVED BYTES (Cmd+S → read the file). Fixtures are vault-shaped
// (frontmatter, bold, a link, a `[[wikilink]]`, real code fences) so the interactions that
// actually break — frontmatter `---`, code fences, inline code — are exercised, not hidden by
// minimal synthetic docs. No fixture ends with a newline (EditorPane re-appends the loaded
// trailing newline, which would shift the first save's expected bytes) and every line is short
// (Home/End/ArrowDown are visual-line commands and the editors wrap).
//
// Boundary contract under test (Model C): SPACE and Tab are fully owned (one isolated step,
// backspace restores the literal, Cmd+Z reverts the whole conversion); Enter seeds the
// conversion then lets the editor's native newline run as a separate step. Prose only — never a
// fenced code block, inline code, or (raw) frontmatter; .csv is excluded entirely.

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
const EM = '—' // — em-dash

const PID = 'proj-alpha'

function docTab(id: string, name: string, mode: 'raw' | 'live' | 'rendered'): Record<string, unknown> {
  return { id, projectId: PID, kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode, dirty: false }
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

const paneSel = (tabId: string): string => `[data-testid="pane-${tabId}"]`
const cmLine = (page: Page, tabId: string, kind: 'raw' | 'live', text: string): ReturnType<Page['locator']> =>
  page.locator(`${paneSel(tabId)} [data-testid="${kind}-editor"] .cm-line`, { hasText: text }).first()

/** Focus a CM pane (raw/live) and put the caret at the very end of the document. */
async function caretAtEnd(page: Page, tabId: string, kind: 'raw' | 'live'): Promise<void> {
  await expect(page.locator(`${paneSel(tabId)} [data-testid="editor-pane"]`)).toHaveAttribute(
    'data-mode',
    kind
  )
  await page.locator(`${paneSel(tabId)} [data-testid="${kind}-editor"] .cm-line`).last().click()
  await page.keyboard.press(`${MOD}+ArrowDown`)
}

/** Save, then assert the file's exact bytes. */
async function savedIs(page: Page, fixture: Fixture, name: string, expected: string): Promise<void> {
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read(fixture, name)).toBe(expected)
}

/**
 * Rendered mode: wait for the edit to be IN the editor (its visible text carries the needle, minus
 * the boundary space) BEFORE Cmd+S, then assert the file contains the substring (the serializer may
 * reformat elsewhere / append a trailing NL). Cmd+S flushes the editor's not-yet-reported edits, so
 * the editor's own text is the only thing to wait on — the dirty dot can blip without a typed edit.
 */
async function savedContains(
  page: Page,
  fixture: Fixture,
  name: string,
  tabId: string,
  needle: string
): Promise<void> {
  await expect(page.locator(`${paneSel(tabId)} [data-testid="rendered-editor"] .ProseMirror`)).toContainText(
    needle.trim()
  )
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read(fixture, name)).toContain(needle)
}

// ── Fixtures ────────────────────────────────────────────────────────────────────
// A wiki-shaped note: frontmatter, a bold run, a link, a `[[wikilink]]`, ending on a prose line.
const NOTE =
  '---\n' +
  'title: Weekly review\n' +
  'tags: [work, review]\n' +
  '---\n' +
  '\n' +
  '# Weekly review\n' +
  '\n' +
  'Shipped **the paste icon** and a [link](x).\n' +
  '\n' +
  'See [[jane-doe]] for context.\n' +
  '\n' +
  'Draft:'

// Frontmatter + fenced code + inline code, for the immunity checks.
const IMMUNE =
  '---\n' +
  'title: Config notes\n' +
  '---\n' +
  '\n' +
  '# Config\n' +
  '\n' +
  'Inline `flag` here.\n' +
  '\n' +
  '```sh\n' +
  'echo run\n' +
  '```\n' +
  '\n' +
  'End'

// A live-mode doc (frontmatter + body with inline markup + a code fence).
const LIVE =
  '---\n' +
  'title: Live note\n' +
  '---\n' +
  '\n' +
  '# Live\n' +
  '\n' +
  'A line with **bold** and [[wikilink]].\n' +
  '\n' +
  '```sh\n' +
  'echo live\n' +
  '```\n' +
  '\n' +
  'Body:'

// Rendered-mode doc: a prose paragraph plus a fenced code block to click into.
const REND =
  '# Rendered\n' +
  '\n' +
  'Prose with **bold** and a [link](x).\n' +
  '\n' +
  '```\n' +
  'code line\n' +
  '```\n' +
  '\n' +
  'Tail'

const CSV = 'path,status,note\n2026-07-24.md,used,round-5 notes\nopen-questions.md,used,in git-base.md'

test.describe('T-152 — em-dash auto-replacement', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('raw: space converts, Backspace restores the literal, Cmd+Z reverts as one step, Tab & Enter boundaries', async () => {
    await seed(fixture, { 'note.md': NOTE }, [docTab('doc-note', 'note.md', 'raw')], 'doc-note')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-note', 'raw')

    // SPACE boundary: `well-- ` → `well— ` (the space is kept).
    await page.keyboard.type(' well-- ')
    await savedIs(page, fixture, 'note.md', `${NOTE} well${EM} `)

    // Backspace as the very next keystroke restores the literal `well-- ` (boundary kept).
    await page.keyboard.press('Backspace')
    await savedIs(page, fixture, 'note.md', `${NOTE} well-- `)

    // A fresh conversion, then Cmd+Z reverts the whole conversion (em-dash AND its space) in one step.
    await page.keyboard.type('x-- ')
    await savedIs(page, fixture, 'note.md', `${NOTE} well-- x${EM} `)
    await page.keyboard.press(`${MOD}+z`)
    await savedIs(page, fixture, 'note.md', `${NOTE} well-- x--`)

    // TAB boundary (fully owned): the caret sits after `x--` again → `x—` + a literal tab.
    await page.keyboard.press('Tab')
    await savedIs(page, fixture, 'note.md', `${NOTE} well-- x${EM}\t`)
    // Tab's conversion is cancellable too.
    await page.keyboard.press('Backspace')
    await savedIs(page, fixture, 'note.md', `${NOTE} well-- x--\t`)

    // ENTER boundary (seed-then-native): `y--` + Enter → `y—` then a real newline.
    await page.keyboard.type('y--')
    await page.keyboard.press('Enter')
    await savedIs(page, fixture, 'note.md', `${NOTE} well-- x--\ty${EM}\n`)
    await app.close()
  })

  test('raw: fenced code, inline code, and frontmatter are immune', async () => {
    await seed(fixture, { 'cfg.md': IMMUNE }, [docTab('doc-cfg', 'cfg.md', 'raw')], 'doc-cfg')
    const { app, page } = await launch(fixture)
    await expect(page.locator(`${paneSel('doc-cfg')} [data-testid="editor-pane"]`)).toHaveAttribute(
      'data-mode',
      'raw'
    )

    // Inside the fenced code block: `-- ` stays literal (`--flag` in a fence must survive).
    await cmLine(page, 'doc-cfg', 'raw', 'echo run').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' --dry ')
    await savedIs(
      page,
      fixture,
      'cfg.md',
      IMMUNE.replace('echo run', 'echo run --dry ')
    )

    // Inside inline code (typed from scratch at the end): still literal. The leading space lets
    // the backtick auto-close (closeBrackets won't pair a backtick right after a word character),
    // so `a-- ` is genuinely closed inline code by the time the space is typed.
    await caretAtEnd(page, 'doc-cfg', 'raw')
    await page.keyboard.type(' `a-- ')
    await savedIs(
      page,
      fixture,
      'cfg.md',
      IMMUNE.replace('echo run', 'echo run --dry ') + ' `a-- `'
    )

    // In the (raw) YAML frontmatter: `--` never converts.
    await cmLine(page, 'doc-cfg', 'raw', 'title: Config notes').click()
    await page.keyboard.press('End')
    await page.keyboard.type('-- ')
    await savedIs(
      page,
      fixture,
      'cfg.md',
      IMMUNE.replace('echo run', 'echo run --dry ').replace('title: Config notes', 'title: Config notes-- ') +
        ' `a-- `'
    )
    await app.close()
  })

  test('live: space & Enter convert on a prose line; a fenced code block is immune', async () => {
    await seed(fixture, { 'live.md': LIVE }, [docTab('doc-live', 'live.md', 'live')], 'doc-live')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-live', 'live')

    // SPACE conversion on the trailing prose line.
    await page.keyboard.type(' note-- ')
    await savedIs(page, fixture, 'live.md', `${LIVE} note${EM} `)

    // ENTER seed-then-native: `more--` + Enter → `more—` then a newline.
    await page.keyboard.type('more--')
    await page.keyboard.press('Enter')
    await savedIs(page, fixture, 'live.md', `${LIVE} note${EM} more${EM}\n`)

    // Inside a fenced code block, `--` stays literal.
    await cmLine(page, 'doc-live', 'live', 'echo live').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' --verbose ')
    await savedIs(
      page,
      fixture,
      'live.md',
      `${LIVE.replace('echo live', 'echo live --verbose ')} note${EM} more${EM}\n`
    )
    await app.close()
  })

  test('rendered: space converts, Backspace restores the literal, Cmd+Z reverts, Tab & Enter boundaries', async () => {
    await seed(fixture, { 'r.md': REND }, [docTab('doc-r', 'r.md', 'rendered')], 'doc-r')
    const { app, page } = await launch(fixture)
    await expect(page.locator(`${paneSel('doc-r')} [data-testid="editor-pane"]`)).toHaveAttribute(
      'data-mode',
      'rendered'
    )
    const prose = page.locator(`${paneSel('doc-r')} [data-testid="rendered-editor"] .ProseMirror`)
    await expect(prose).toBeVisible() // the code-block fixture paints a beat slower than a plain doc
    await prose.click()
    await page.keyboard.press(`${MOD}+ArrowDown`) // document end (the "Tail" paragraph)

    // SPACE conversion.
    await page.keyboard.type(' word-- ')
    await savedContains(page, fixture, 'r.md', 'doc-r', `word${EM} `)

    // Backspace restores the literal `word-- `.
    await page.keyboard.press('Backspace')
    await savedContains(page, fixture, 'r.md', 'doc-r', 'word-- ')

    // Fresh conversion + Cmd+Z reverts it (em-dash gone). Save AFTER the undo before reading.
    await page.keyboard.type('q-- ')
    await savedContains(page, fixture, 'r.md', 'doc-r', `q${EM} `)
    await prose.click()
    await page.keyboard.press(`${MOD}+z`)
    await expect(prose).not.toContainText(`q${EM}`)
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => read(fixture, 'r.md')).not.toContain(`q${EM}`)

    // TAB boundary (fully owned) and ENTER boundary (seed-then-native) both convert.
    await prose.click()
    await page.keyboard.press(`${MOD}+ArrowDown`)
    await page.keyboard.type('tab--')
    await page.keyboard.press('Tab')
    await savedContains(page, fixture, 'r.md', 'doc-r', `tab${EM}`)
    await page.keyboard.type('ret--')
    await page.keyboard.press('Enter')
    await savedContains(page, fixture, 'r.md', 'doc-r', `ret${EM}`)
    await app.close()
  })

  test('rendered: a fenced code block is immune', async () => {
    await seed(fixture, { 'rc.md': REND }, [docTab('doc-rc', 'rc.md', 'rendered')], 'doc-rc')
    const { app, page } = await launch(fixture)
    const prose = page.locator(`${paneSel('doc-rc')} [data-testid="rendered-editor"] .ProseMirror`)
    await expect(prose).toBeVisible()

    // Click the code line, type at its end — `--` inside a code block never converts.
    await prose.locator('pre', { hasText: 'code line' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' --raw ')
    await savedContains(page, fixture, 'rc.md', 'doc-rc', 'code line --raw ')
    await expect.poll(() => read(fixture, 'rc.md')).toContain('code line --raw')
    // The em-dash must not have leaked into the code line.
    await expect.poll(() => read(fixture, 'rc.md')).not.toContain(`code line --raw ${EM}`)
    await app.close()
  })

  test('.csv is excluded — the raw fallback types `--` literally', async () => {
    await seed(fixture, { 'ledger.csv': CSV }, [docTab('doc-csv', 'ledger.csv', 'raw')], 'doc-csv')
    const { app, page } = await launch(fixture)
    await caretAtEnd(page, 'doc-csv', 'raw')

    await page.keyboard.type('-- ')
    await savedIs(page, fixture, 'ledger.csv', `${CSV}-- `)
    await app.close()
  })

  test('toggle OFF disables the replacement in raw and rendered', async () => {
    await seed(
      fixture,
      { 'off.md': NOTE, 'offr.md': REND },
      [docTab('doc-off', 'off.md', 'raw'), docTab('doc-offr', 'offr.md', 'rendered')],
      'doc-off'
    )
    const { app, page } = await launch(fixture)

    // Turn the setting OFF (drives the same store the Settings checkbox writes).
    await page.evaluate(() =>
      window.__pomadeStores.useAppSettingsStore.getState().setEmDashReplace(false)
    )
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__pomadeStores.useAppSettingsStore.getState().emDashReplace
        )
      )
      .toBe(false)

    // Raw: no conversion.
    await page.getByTestId('tab-doc-off').click()
    await caretAtEnd(page, 'doc-off', 'raw')
    await page.keyboard.type(' none-- ')
    await savedIs(page, fixture, 'off.md', `${NOTE} none-- `)

    // Rendered: no conversion.
    await page.getByTestId('tab-doc-offr').click()
    const prose = page.locator(`${paneSel('doc-offr')} [data-testid="rendered-editor"] .ProseMirror`)
    await expect(prose).toBeVisible()
    await prose.click()
    await page.keyboard.press(`${MOD}+ArrowDown`)
    await page.keyboard.type(' none-- ')
    await savedContains(page, fixture, 'offr.md', 'doc-offr', 'none-- ')
    await expect.poll(() => read(fixture, 'offr.md')).not.toContain(`none${EM}`)
    await app.close()
  })
})
