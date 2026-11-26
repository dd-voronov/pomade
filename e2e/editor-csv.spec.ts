// modules: core, editor
// Pomade E-009 e2e — CSV table: the separator/quoting parse fix (T-034) + lossless editable
// cells (T-002). Doc tabs are seeded via .pomade/state (the same restore path the app uses on
// relaunch); CSV tabs are seeded in 'rendered' mode so the table view shows directly.
//
// The LEDGER fixture reproduces the pattern the Owner hit in Knowledge/_meta/sources-ledger.csv
// (the 2026-06-25 row): a trailing free-text `note` column with UNQUOTED commas, mixed with a
// properly-quoted note (embedded + escaped quotes) and semicolons inside another column. Tests
// never touch the vault — the pattern is copied here.

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

// ── Fixtures ──────────────────────────────────────────────────────────────────
// The offending vault row: `note` has two UNQUOTED commas; naive parsing spills it into 8
// columns. Row 2 is a properly-quoted note with an embedded comma + escaped ("") quotes. Row 3
// keeps semicolons inside `wiki_pages` — they must NOT be treated as the delimiter.
const LEDGER =
  'path,sha256,status,wiki_pages,evaluated,note\n' +
  '01-Raw/Journal/AI/Daily-Notes/2026-06-25.md,e087aa71,used,04-Wiki/falk-gottlob.md,2026-07-10,' +
  'daily note - Falk (→ falk-gothlob, done) + page_type schema (a _rules convention)' +
  ' (hash refreshed 2026-07-10 - page_type frontmatter added, no new body)\n' +
  '01-Raw/Documents/Personal/2026-05-06-open-design-questions.md,00fae850,used,04-Wiki/git-base.md,' +
  '2026-06-17,"open design questions for git-base — now in git-base.md ""Open design questions"" section"\n' +
  '01-Raw/Journal/AI/Sessions/2026-06-15-interview.md,fd250434,used,' +
  '04-Wiki/jane-doe.md; 04-Wiki/basketball.md,2026-06-15,verbatim interview transcript — raw source\n'

const SIMPLE = 'name,role,city\nAda,Engineer,London\nGrace,Admiral,New York\n'
const SIMPLE_CRLF = 'name,role,city\r\nAda,Engineer,London\r\nGrace,Admiral,New York\r\n'
const COMMA = 'x,y\n1,2\n'
// Embedded comma + escaped quote, then a multiline (quoted-newline) cell.
const QUOTING = 'a,b,c\n"x,y","p""q",z\n"multi\nline",m,n\n'
// Unterminated quoted field → genuinely unparseable → must fall back to raw with a notice.
const BROKEN = 'a,b\n"oops,c\n'

function docTab(id: string, name: string, mode: 'raw' | 'rendered'): Record<string, unknown> {
  return {
    id,
    projectId: 'proj-alpha',
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode,
    dirty: false
  }
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  const P = (n: string): string => join(root, 'Projects/alpha', n)
  await fs.writeFile(P('ledger.csv'), LEDGER)
  await fs.writeFile(P('simple.csv'), SIMPLE)
  await fs.writeFile(P('simple-crlf.csv'), SIMPLE_CRLF)
  await fs.writeFile(P('comma.csv'), COMMA)
  await fs.writeFile(P('quoting.csv'), QUOTING)
  await fs.writeFile(P('broken.csv'), BROKEN)

  const state = {
    openTabs: [
      docTab('doc-ledger', 'ledger.csv', 'rendered'),
      docTab('doc-simple', 'simple.csv', 'rendered'),
      docTab('doc-crlf', 'simple-crlf.csv', 'rendered'),
      docTab('doc-comma', 'comma.csv', 'rendered'),
      docTab('doc-quoting', 'quoting.csv', 'rendered'),
      docTab('doc-broken', 'broken.csv', 'rendered')
    ],
    activeTabId: 'doc-ledger'
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

async function openCsv(tabId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click()
  await expect(vis('[data-testid="csv-table"]')).toBeVisible()
}

// ── T-034: the repro pattern renders the correct grid ───────────────────────────
test('T-034: the vault repro row parses as ONE note cell, not spilled columns', async () => {
  await openCsv('doc-ledger')
  const table = vis('[data-testid="csv-table"]')
  // Header defines exactly 6 columns.
  await expect(table.locator('thead th')).toHaveCount(6)
  await expect(table.locator('thead th').first()).toHaveText('path')
  await expect(table.locator('thead th').last()).toHaveText('note')

  // The offending row keeps its unquoted-comma note whole in the LAST cell (6 cells, not 8).
  await expect(table.locator('tbody tr').first().locator('td')).toHaveCount(6)
  const note0 = table.getByTestId('csv-cell-0-5')
  await expect(note0).toContainText('daily note - Falk (→ falk-gothlob, done)')
  // The tail that a naive parser would push into a phantom 8th column stays in this cell.
  await expect(note0).toContainText('no new body)')
  // No phantom cell exists.
  await expect(table.getByTestId('csv-cell-0-6')).toHaveCount(0)
})

test('T-034: quoted field with embedded + escaped quotes decodes correctly', async () => {
  const table = vis('[data-testid="csv-table"]')
  const note1 = table.getByTestId('csv-cell-1-5')
  // "" → a single literal quote; the whole quoted field is one cell.
  await expect(note1).toContainText('open design questions for git-base')
  await expect(note1).toContainText('"Open design questions"')
  await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveCount(6)
})

test('T-034: semicolons inside a comma-delimited column are not split', async () => {
  const table = vis('[data-testid="csv-table"]')
  const wiki2 = table.getByTestId('csv-cell-2-3')
  await expect(wiki2).toContainText('04-Wiki/jane-doe.md; 04-Wiki/basketball.md')
  await expect(table.locator('tbody tr').nth(2).locator('td')).toHaveCount(6)
})

test('T-034: quoted embedded-comma and multiline cells render as single cells', async () => {
  await openCsv('doc-quoting')
  const table = vis('[data-testid="csv-table"]')
  await expect(table.getByTestId('csv-cell-0-0')).toHaveText('x,y')
  await expect(table.getByTestId('csv-cell-0-1')).toHaveText('p"q')
  const multi = table.getByTestId('csv-cell-1-0')
  await expect(multi).toContainText('multi')
  await expect(multi).toContainText('line')
})

// ── T-002: editable cells + lossless save ───────────────────────────────────────
test('T-002: edit a cell → Cmd+S → file differs ONLY in that cell (LF)', async () => {
  await openCsv('doc-simple')
  const table = vis('[data-testid="csv-table"]')
  await table.getByTestId('csv-cell-0-1').click() // "Engineer"
  const input = vis('[data-testid="csv-cell-input"]')
  await expect(input).toBeVisible()
  await input.fill('Scientist')
  await page.keyboard.press('Enter')

  await expect(table.getByTestId('csv-cell-0-1')).toHaveText('Scientist')
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/simple.csv')
  await expect
    .poll(async () => fs.readFile(target, 'utf8'))
    .toBe('name,role,city\nAda,Scientist,London\nGrace,Admiral,New York\n')
  await expect(vis('[data-testid="editor-dirty"]')).toHaveCount(0)
})

test('T-002: CRLF and trailing newline are preserved byte-for-byte on save', async () => {
  await openCsv('doc-crlf')
  const table = vis('[data-testid="csv-table"]')
  await table.getByTestId('csv-cell-1-2').click() // "New York"
  const input = vis('[data-testid="csv-cell-input"]')
  await input.fill('Boston')
  await page.keyboard.press('Enter')
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/simple-crlf.csv')
  await expect
    .poll(async () => fs.readFile(target, 'utf8'))
    .toBe('name,role,city\r\nAda,Engineer,London\r\nGrace,Admiral,Boston\r\n')
})

test('T-002: an edited value containing the delimiter is quoted on save', async () => {
  await openCsv('doc-comma')
  const table = vis('[data-testid="csv-table"]')
  await table.getByTestId('csv-cell-0-1').click()
  const input = vis('[data-testid="csv-cell-input"]')
  await input.fill('he,llo')
  await page.keyboard.press('Enter')
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/comma.csv')
  await expect.poll(async () => fs.readFile(target, 'utf8')).toBe('x,y\n1,"he,llo"\n')
})

test('T-002: editing one cell preserves quoted + multiline neighbours byte-for-byte', async () => {
  await openCsv('doc-quoting')
  const table = vis('[data-testid="csv-table"]')
  await table.getByTestId('csv-cell-0-2').click() // "z"
  const input = vis('[data-testid="csv-cell-input"]')
  await input.fill('Z')
  await page.keyboard.press('Enter')
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/quoting.csv')
  // Only z→Z; the embedded-comma, escaped-quote and multiline cells are untouched.
  await expect
    .poll(async () => fs.readFile(target, 'utf8'))
    .toBe('a,b,c\n"x,y","p""q",Z\n"multi\nline",m,n\n')
})

test('T-002: editing the vault repro note re-quotes only that row', async () => {
  await openCsv('doc-ledger')
  const table = vis('[data-testid="csv-table"]')
  await table.getByTestId('csv-cell-0-5').click()
  const input = vis('[data-testid="csv-cell-input"]')
  await input.fill('rewritten note, still has a comma')
  await page.keyboard.press('Enter')
  await page.keyboard.press(`${MOD}+s`)

  const target = join(fixture.workspaceRoot, 'Projects/alpha/ledger.csv')
  const onDisk = await (async (): Promise<string> => {
    await expect
      .poll(async () => (await fs.readFile(target, 'utf8')).includes('rewritten note'))
      .toBe(true)
    return fs.readFile(target, 'utf8')
  })()
  const orig = LEDGER.split('\n')
  const now = onDisk.split('\n')
  // Exactly one physical line changed.
  const changed = orig.map((l, i) => (l !== now[i] ? i : -1)).filter((i) => i >= 0)
  expect(changed).toEqual([1])
  // The edited note (with a comma) is now quoted; the row's other 5 fields are unchanged.
  expect(now[1]).toBe(
    '01-Raw/Journal/AI/Daily-Notes/2026-06-25.md,e087aa71,used,04-Wiki/falk-gottlob.md,' +
      '2026-07-10,"rewritten note, still has a comma"'
  )
})

test('T-002: Esc cancels an edit, Tab commits and advances', async () => {
  await openCsv('doc-simple')
  const table = vis('[data-testid="csv-table"]')
  // Esc discards.
  await table.getByTestId('csv-cell-0-0').click()
  let input = vis('[data-testid="csv-cell-input"]')
  await input.fill('ZZZ')
  await page.keyboard.press('Escape')
  await expect(vis('[data-testid="csv-cell-input"]')).toHaveCount(0)
  await expect(table.getByTestId('csv-cell-0-0')).toHaveText('Ada')

  // Tab commits and moves to the next cell.
  await table.getByTestId('csv-cell-0-0').click()
  input = vis('[data-testid="csv-cell-input"]')
  await input.fill('Ida')
  await page.keyboard.press('Tab')
  await expect(table.getByTestId('csv-cell-0-0')).toHaveText('Ida')
  // The next cell is now the one being edited.
  await expect(vis('[data-testid="csv-cell-input"]')).toBeVisible()
})

// ── Unparseable → raw with a visible notice ─────────────────────────────────────
test('unparseable CSV falls back to raw with a notice (never garbage, never silent)', async () => {
  await page.getByTestId('tab-doc-broken').click()
  const editor = vis('[data-testid="editor-pane"]')
  // Cannot render as a table → stays raw despite the rendered-mode tab.
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await expect(vis('[data-testid="csv-malformed"]')).toBeVisible()
  await expect(vis('[data-testid="raw-editor"] .cm-content')).toContainText('oops')
})
