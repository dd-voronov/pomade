// modules: editor, terminal, agents
// Pomade E-001 e2e — editor context menus (T-010 no-selection, T-011 with-selection) and
// in-document find (T-012). Drives the real Electron app. Doc tabs are seeded via
// .pomade/state (the app's own restore path); a fake agent stands in for a real CLI so the
// "new agent chat" hand-off (file-context instruction + unsubmitted selection) is assertable.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchApp } from './fixtures/app'
import { readBuffer } from './fixtures/stores'
import { FAKE_AGENT_ECHO, seedFakeAgent } from './fixtures/fake-agent'
import { expectQuiet } from './fixtures/timing'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// A stand-in "agent": announces readiness, echoes each SUBMITTED line. Text typed without a
// trailing newline is echoed by the tty but never read as a line — that's how the T-011
// "selection lands unsubmitted" assertion works.

async function seedAlphaState(root: string): Promise<void> {
  const state = {
    openTabs: [
      {
        id: 'doc-md',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'README.md',
        path: 'Projects/alpha/README.md',
        mode: 'rendered',
        dirty: false
      },
      {
        id: 'doc-raw',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'find.txt',
        path: 'Projects/alpha/find.txt',
        mode: 'raw',
        dirty: false
      },
      {
        id: 'doc-search',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'search.txt',
        path: 'Projects/alpha/search.txt',
        mode: 'raw',
        dirty: false
      },
      // T-043 — a markdown file restored in raw mode (stays raw: a restored raw tab is preserved
      // when the app default is rendered) + a CSV shown as a table.
      {
        id: 'doc-mdsel',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'mdsel.md',
        path: 'Projects/alpha/mdsel.md',
        mode: 'raw',
        dirty: false
      },
      {
        id: 'doc-csvsel',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'csvsel.csv',
        path: 'Projects/alpha/csvsel.csv',
        mode: 'rendered',
        dirty: false
      }
    ],
    activeTabId: 'doc-md'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))
}

const vis = (page: Page, sel: string) => page.locator(`${sel}:visible`)

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => window.pomade.app.clipboardRead())
}


async function visibleTermId(page: Page): Promise<string> {
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

function triggerFind(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-editor-find')?.click()
  })
}

test.describe('E-001 editor context menus + find', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const root = fixture.workspaceRoot
    await fs.writeFile(
      join(root, 'Projects/alpha/find.txt'),
      'find one\nfind two\nfind three\n'
    )
    // A dedicated file for the find test so earlier mutation tests can't affect its counts.
    await fs.writeFile(join(root, 'Projects/alpha/search.txt'), 'alpha alpha alpha\n')
    // T-043 fixtures.
    await fs.writeFile(join(root, 'Projects/alpha/mdsel.md'), '# Note\n\nSelect this markdown line here.\n')
    await fs.writeFile(
      join(root, 'Projects/alpha/csvsel.csv'),
      'name,role\nAda,Engineer\nAlan,Engineer\nGrace,Admiral\n'
    )
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO })
    await seedAlphaState(root)

    app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('project-proj-alpha').click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // Re-activate a known doc tab before each test so tests don't depend on order.
  const activate = async (tabTestId: string): Promise<void> => {
    await page.getByTestId(tabTestId).click()
  }

  // ── T-010: no-selection menu ────────────────────────────────────────────────
  test('rendered: no-selection menu offers file actions', async () => {
    await activate('tab-doc-md')
    const prose = vis(page, '[data-testid="rendered-editor"] .ProseMirror')
    await expect(prose).toBeVisible()
    await prose.click() // caret only, no selection
    await prose.click({ button: 'right' })

    const menu = page.getByTestId('editor-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-variant', 'no-selection')
    await expect(page.getByTestId('menu-duplicate-file')).toBeVisible()
    await expect(page.getByTestId('menu-copy-file-to')).toBeVisible()
    await expect(page.getByTestId('menu-copy-path')).toBeVisible()
    await expect(page.getByTestId('menu-copy-full-path')).toBeVisible()
    // Close via scrim.
    await page.getByTestId('editor-menu-scrim').click()
    await expect(menu).toHaveCount(0)
  })

  test('raw: no-selection menu also works (Copy path writes the relative path)', async () => {
    await activate('tab-doc-raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await expect(cm).toBeVisible()
    await cm.click()
    await cm.click({ button: 'right' })
    await expect(page.getByTestId('editor-context-menu')).toHaveAttribute(
      'data-variant',
      'no-selection'
    )
    await page.getByTestId('menu-copy-path').click()
    expect(await readClipboard(page)).toBe('Projects/alpha/find.txt')
  })

  test('Copy full path writes the absolute path', async () => {
    await activate('tab-doc-raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await cm.click({ button: 'right' })
    await page.getByTestId('menu-copy-full-path').click()
    expect(await readClipboard(page)).toBe(join(fixture.workspaceRoot, 'Projects/alpha/find.txt'))
  })

  test('Duplicate file creates "<name> copy" on disk and opens it', async () => {
    await activate('tab-doc-md')
    const prose = vis(page, '[data-testid="rendered-editor"] .ProseMirror')
    await prose.click()
    await prose.click({ button: 'right' })
    await page.getByTestId('menu-duplicate-file').click()

    const dupPath = join(fixture.workspaceRoot, 'Projects/alpha/README copy.md')
    await expect.poll(() => fs.readFile(dupPath, 'utf8').catch(() => '')).toContain('# Alpha')
    // Opened in a new tab (title = the copy's name).
    await expect(vis(page, '[data-testid="editor-title"]')).toHaveText('README copy.md')
  })

  test('Copy file to… copies into the chosen folder', async () => {
    await activate('tab-doc-raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await cm.click({ button: 'right' })
    await page.getByTestId('menu-copy-file-to').click()

    const modal = page.getByTestId('copyto-modal')
    await expect(modal).toBeVisible()
    // Expand Projects, pick beta.
    await page.getByTestId('copyto-node-Projects').getByRole('button').click()
    await page.getByTestId('copyto-node-Projects/beta').click()
    await page.getByTestId('copyto-confirm').click()

    const dest = join(fixture.workspaceRoot, 'Projects/beta/find.txt')
    await expect.poll(() => fs.readFile(dest, 'utf8').catch(() => '')).toContain('find one')
  })

  // ── T-011: with-selection menu ──────────────────────────────────────────────
  test('raw: selection menu Copy puts the selection on the clipboard', async () => {
    await activate('tab-doc-raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.press('Shift+End') // selects "find one"
    await cm.click({ button: 'right' })

    const menu = page.getByTestId('editor-context-menu')
    await expect(menu).toHaveAttribute('data-variant', 'selection')
    await page.getByTestId('menu-copy').click()
    expect(await readClipboard(page)).toBe('find one')
  })

  test('raw: Cut removes the selection and Paste re-inserts it', async () => {
    await activate('tab-doc-raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.press('Shift+End')
    await cm.click({ button: 'right' })
    await page.getByTestId('menu-cut').click()
    await expect(cm).not.toContainText('find one')
    expect(await readClipboard(page)).toBe('find one')

    // Select-all, then Paste replaces the selection with the cut text (Paste lives in the
    // with-selection menu per T-011).
    await cm.click()
    await page.keyboard.press(`${MOD}+a`)
    await cm.click({ button: 'right' })
    await expect(page.getByTestId('editor-context-menu')).toHaveAttribute('data-variant', 'selection')
    await page.getByTestId('menu-paste').click()
    await expect(cm).toContainText('find one')
    await expect(cm).not.toContainText('find two')
  })

  test('Find & replace from a selection opens find prefilled (raw)', async () => {
    await activate('tab-doc-raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.press('Shift+End')
    await cm.click({ button: 'right' })
    await page.getByTestId('menu-find-replace').click()

    const field = vis(page, '.cm-search input[main-field]')
    await expect(field).toBeVisible()
    await expect(field).toHaveValue('find one')
    await field.press('Escape') // close so it doesn't leak into later find assertions
  })

  test('New agent chat with selection: file context submitted, selection typed unsubmitted', async () => {
    await activate('tab-doc-raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.press('Shift+End') // "find one"
    await cm.click({ button: 'right' })
    await page.getByTestId('menu-new-agent-chat').click()
    await page.getByTestId('menu-agent-claude-test').click()

    const termId = await visibleTermId(page)
    // The file-context instruction is SUBMITTED (read as a line by the fake agent)…
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 15_000 })
      .toContain('AGENT_GOT: Read Projects/alpha/find.txt')
    // …and the selection is typed into the input but NOT submitted (echoed, never read):
    // poll the echo in, then hold the not-submitted state for the window a submit would need.
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('find one')
    await expectQuiet(async () => {
      expect(await readBuffer(page, termId)).not.toContain('AGENT_GOT: find one')
    }, 500)
  })

  // ── T-012: in-document find ─────────────────────────────────────────────────
  test('raw: Cmd+F opens the CodeMirror search panel and highlights matches', async () => {
    await activate('tab-doc-search')
    await vis(page, '[data-testid="raw-editor"] .cm-content').click()
    await triggerFind(app)

    const field = vis(page, '.cm-search input[main-field]')
    await expect(field).toBeVisible()
    // Type (real key events) so CodeMirror commits the query on keyup.
    await field.pressSequentially('alpha')
    await expect(vis(page, '.cm-searchMatch').first()).toBeVisible()
    expect(await vis(page, '.cm-searchMatch').count()).toBeGreaterThan(1)

    // Enter steps to a match (selecting it), Esc closes the panel.
    await field.press('Enter')
    await expect(vis(page, '.cm-searchMatch-selected')).toHaveCount(1)
    await field.press('Escape')
    await expect(vis(page, '.cm-search')).toHaveCount(0)
  })

  test('rendered: Cmd+F opens the find panel with match count and step-through', async () => {
    await activate('tab-doc-md')
    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').click()
    await triggerFind(app)

    const panel = page.getByTestId('find-panel')
    await expect(panel).toBeVisible()
    // T-096 — serving the rendered markdown view, the panel reports data-mode="rendered".
    await expect(panel).toHaveAttribute('data-mode', 'rendered')
    await expect(page.getByTestId('find-replace-note')).toContainText('raw mode')

    await page.getByTestId('find-input').fill('Alpha')
    await expect(page.getByTestId('find-count')).toContainText('of')
    await expect(page.locator('.pomade-find-match').first()).toBeVisible()
    await expect(page.locator('.pomade-find-current')).toHaveCount(1)

    // Step to the next match, then close with Esc.
    await page.getByTestId('find-next').click()
    await expect(page.locator('.pomade-find-current')).toHaveCount(1)
    await page.getByTestId('find-input').press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.pomade-find-match')).toHaveCount(0)
  })

  test('Cmd+F does not fire into a terminal pane (no editor active)', async () => {
    // Open a terminal tab — now the active tab is not a doc.
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()
    const termId = await visibleTermId(page)

    await triggerFind(app)
    // No find UI appears, and the terminal is untouched (still live, no query text leaked) —
    // held for the window the panel would need to mount.
    await expectQuiet(async () => {
      await expect(page.getByTestId('find-panel')).toHaveCount(0)
      await expect(page.locator('.cm-search')).toHaveCount(0)
      await expect(page.locator(`[data-term-id="${termId}"]`)).toHaveAttribute('data-status', 'live')
    }, 300)
  })

  // ── T-043: selection menu + find in raw .md and CSV table view ──────────────────
  // NOTE on the raw-.md "dead selection menu" report: after the T-041/T-042 changes it was NOT
  // reproducible via any Playwright-synthesisable path — a keyboard selection survives a
  // right-click, and a synthetic mouse-drag never populates CodeMirror's *state* selection at
  // all (a Playwright artifact, not app behaviour). The most plausible real mechanism is a
  // right-click collapsing the CM selection before the contextmenu fires; EditorPane now
  // snapshots the selection on secondary mousedown (capture phase) to guard that. This spec
  // pins that the raw-.md selection menu + Cmd+F work (they were never .md-specific).
  test('raw .md: selection menu Copy works and Cmd+F opens the CodeMirror panel', async () => {
    await activate('tab-doc-mdsel')
    await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await expect(cm).toBeVisible()
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown') // caret onto the body line
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End') // select "Select this markdown line here."
    await cm.click({ button: 'right' })
    const menu = page.getByTestId('editor-context-menu')
    await expect(menu).toHaveAttribute('data-variant', 'selection')
    await page.getByTestId('menu-copy').click()
    expect(await readClipboard(page)).toBe('Select this markdown line here.')

    // Cmd+F opens CodeMirror's themed search panel in raw .md.
    await cm.click()
    await triggerFind(app)
    const field = vis(page, '.cm-search input[main-field]')
    await expect(field).toBeVisible()
    await field.pressSequentially('markdown')
    await expect(vis(page, '.cm-searchMatch').first()).toBeVisible()
    await field.press('Escape')
    await expect(vis(page, '.cm-search')).toHaveCount(0)
  })

  test('CSV table: Cmd+F highlights and steps through matching cells (replace stays raw-only)', async () => {
    await activate('tab-doc-csvsel')
    await expect(vis(page, '[data-testid="csv-table"]')).toBeVisible()
    await vis(page, '[data-testid="csv-table"]').click()
    await triggerFind(app)

    const panel = page.getByTestId('find-panel')
    await expect(panel).toBeVisible()
    // T-096 — serving the CSV table, the panel reports data-mode="table" (was hardcoded
    // "rendered" before the fix — this is the revert-proof for the find-panel mode change).
    await expect(panel).toHaveAttribute('data-mode', 'table')
    await expect(page.getByTestId('find-replace-note')).toContainText('raw mode')

    await page.getByTestId('find-input').fill('Engineer')
    await expect(page.getByTestId('find-count')).toContainText('1 of 2')
    await expect(page.locator('[data-find-match]')).toHaveCount(2)
    await expect(page.locator('[data-find-current]')).toHaveCount(1)

    await page.getByTestId('find-next').click()
    await expect(page.getByTestId('find-count')).toContainText('2 of 2')
    await expect(page.locator('[data-find-current]')).toHaveCount(1)

    await page.getByTestId('find-input').press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.locator('[data-find-match]')).toHaveCount(0)
  })

  test('CSV table: Cut/Copy/Paste work while editing a cell', async () => {
    await activate('tab-doc-csvsel')
    const table = vis(page, '[data-testid="csv-table"]')
    const input = (): ReturnType<Page['locator']> => vis(page, '[data-testid="csv-cell-input"]')
    const editCell = async (r: number, c: number): Promise<void> => {
      await table.getByTestId(`csv-cell-${r}-${c}`).click()
      await expect(input()).toBeVisible()
      await input().selectText()
      await input().click({ button: 'right' })
      await expect(page.getByTestId('editor-context-menu')).toHaveAttribute('data-variant', 'selection')
    }

    // Copy from the editing input, then cancel the edit cleanly.
    await editCell(0, 1) // "Engineer"
    await page.getByTestId('menu-copy').click()
    expect(await readClipboard(page)).toBe('Engineer')
    await page.keyboard.press('Escape')
    await expect(input()).toHaveCount(0)

    // Paste over a selection in another cell.
    await editCell(2, 1) // "Admiral"
    await page.getByTestId('menu-paste').click()
    await expect(input()).toHaveValue('Engineer')
    await page.keyboard.press('Enter')
    await expect(table.getByTestId('csv-cell-2-1')).toHaveText('Engineer')

    // Cut empties the editing cell and puts its text on the clipboard.
    await editCell(0, 0) // "Ada"
    await page.getByTestId('menu-cut').click()
    await expect(input()).toHaveValue('')
    expect(await readClipboard(page)).toBe('Ada')
  })

  // ── E-001: primary-button context menu (macOS Ctrl+click) still sees the selection ──
  // Real-usage repro of the dead selection menu: on macOS a Ctrl+click (and some trackpad
  // right-click paths) delivers a PRIMARY-button (button 0) mousedown before contextmenu.
  // CodeMirror collapses its state selection on that mousedown; the pre-fix capture handler only
  // snapshotted when button===2, so onContextMenu saw an empty selection and opened the
  // no-selection menu (Cut/Copy/Paste/Find & replace absent). We drive a real primary mousedown
  // inside the selected line (collapses it) then fire contextmenu — must still be the selection
  // variant. (The earlier keyboard-select + right-button spec stayed green through the bug.)
  test('raw .md: a primary-button (Ctrl+click) context menu still opens the selection variant', async () => {
    await activate('tab-doc-mdsel')
    await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await expect(cm).toBeVisible()
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown') // caret onto the body line
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End') // select "Select this markdown line here."

    // A real primary mousedown on the selected line: onBodyMouseDownCapture (capture phase) must
    // snapshot the selection BEFORE CodeMirror's own handler collapses it.
    const line = present(await cm.locator('.cm-line').nth(2).boundingBox(), 'selected-line box')
    const px = line.x + 6
    const py = line.y + line.height / 2
    await page.mouse.move(px, py)
    await page.mouse.down() // button 0 → capture-phase snapshot; CM then collapses the selection
    await page.mouse.up()
    // The live selection is now collapsed; the menu must fall back to the snapshot.
    await cm.dispatchEvent('contextmenu', { bubbles: true, button: 2, clientX: px, clientY: py })

    const menu = page.getByTestId('editor-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-variant', 'selection')
    await page.getByTestId('editor-menu-scrim').click()
    await expect(menu).toHaveCount(0)
  })

  // ── Round-4 (third strike) — the rendered→raw TOGGLE path. Milkdown's destroy listener is
  // async: on a mode toggle it fired AFTER RawEditor had registered its controller and nulled
  // it, leaving the pane without selection/find access. Every real vault .md opens rendered,
  // so the Owner ALWAYS hit this; every spec fixture opened raw directly, so e2e never did.
  test('raw AFTER toggling from rendered: selection menu and Cmd+F still work', async () => {
    await activate('tab-doc-md')
    await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')
    await vis(page, '[data-testid="mode-toggle"]').click() // rendered → raw
    await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')

    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown') // caret onto "Alpha project."
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await cm.click({ button: 'right' })
    const menu = page.getByTestId('editor-context-menu')
    await expect(menu).toHaveAttribute('data-variant', 'selection')
    await page.getByTestId('menu-copy').click()
    expect(await readClipboard(page)).toBe('Alpha project.')

    // Cmd+F must reach the raw editor's CodeMirror search panel (openFind needs the controller).
    await cm.click()
    await triggerFind(app)
    await expect(vis(page, '.cm-search input[main-field]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(vis(page, '.cm-search')).toHaveCount(0)
  })
})
