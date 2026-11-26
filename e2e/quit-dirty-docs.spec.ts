// modules: core, editor, tabs
// Pomade T-187 e2e — quit flow's THIRD confirmation for unsaved (dirty) docs. On quit, when ≥1
// doc tab is dirty in ANY project (hidden panes included — panes are never unmounted), a data-loss
// dialog appears AFTER the existing quit/sessions confirms: Save all docs / Discard all changes /
// Cancel.
//   - Save all → every dirty doc saved through the normal pipeline (T-142 conflict guard, T-095
//     refusal guard), then the app quits. Works across projects (a dirty doc in a NON-active,
//     hidden project is saved too).
//   - A doc that can't be saved unattended (on-disk conflict) → surfaced by name, quit ABORTED.
//   - Discard all → quit continues, files untouched, each discarded buffer kept as a discarded
//     draft in user data (E-035). Cancel → quit aborted, docs stay dirty.
//   - No dirty docs → no third dialog (the quit proceeds straight through).
//
// LIGHT partition: no terminal/agent panes are spawned, so no real zsh. Docs are seeded via
// .pomade/state like the other editor specs; files are real on disk. Quit is triggered from main
// (`app.quit()`) since native menu accelerators can't be synthesized — same as quit-confirm.spec.
// The confirmation is opted IN with POMADE_TEST_QUIT_CONFIRM=1 (bypassed by default in test env).

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

const vis = (page: Page, sel: string) => page.locator(`${sel}:visible`)

/** Cmd+Q / app-menu Quit, from inside main. Returns as soon as the request is in flight — the
 *  gate prevents the exit, so nothing actually quits until `confirmQuit()`. */
function pressQuit(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ app: electronApp }) => {
    electronApp.quit()
  })
}

function docTab(id: string, projectId: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId,
    kind: 'doc',
    title: name,
    path: `${projectId === 'proj-alpha' ? 'Projects/alpha' : 'Projects/beta'}/${name}`,
    mode: 'raw',
    dirty: false
  }
}

async function seedState(
  root: string,
  projectId: string,
  tabs: Record<string, unknown>[]
): Promise<void> {
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, `.pomade/state/${projectId}.json`),
    JSON.stringify({ openTabs: tabs, activeTabId: tabs[0]?.id }, null, 2)
  )
}

/** Make a seeded doc tab dirty: open it and type into the raw editor. */
async function dirtyDoc(page: Page, projectId: string, tabId: string, text: string): Promise<void> {
  await page.getByTestId(`project-${projectId}`).click()
  await page.getByTestId(`tab-${tabId}`).click()
  await vis(page, '[data-testid="raw-editor"] .cm-content').click()
  await page.keyboard.type(text)
  await expect(vis(page, '[data-testid="doc-save"]')).toHaveText('Save')
}

// ── The third confirmation + Save all (cross-project sweep) ───────────────────────────────────
test.describe('T-187 — third confirmation + Save all', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let closed = false
  let aPath: string
  let bPath: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const root = fixture.workspaceRoot
    aPath = join(root, 'Projects/alpha', 'a.txt')
    bPath = join(root, 'Projects/beta', 'b.txt')
    await fs.writeFile(aPath, 'alpha original\n')
    await fs.writeFile(bPath, 'beta original\n')
    await seedState(root, 'proj-alpha', [docTab('doc-a', 'proj-alpha', 'a.txt')])
    await seedState(root, 'proj-beta', [docTab('doc-b', 'proj-beta', 'b.txt')])

    app = await launchApp(fixture, { POMADE_TEST_QUIT_CONFIRM: '1' })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()

    // Dirty a doc in BETA (which then becomes the hidden/non-active project), then one in ALPHA.
    await dirtyDoc(page, 'proj-beta', 'doc-b', ' B-EDIT')
    await dirtyDoc(page, 'proj-alpha', 'doc-a', ' A-EDIT')
  })

  test.afterAll(async () => {
    if (!closed) await app?.close()
    await fixture?.cleanup()
  })

  test('with a dirty doc, quit shows the docs confirm as the third step (no live sessions ⇒ after stage 1)', async () => {
    await pressQuit(app)
    await expect(page.getByTestId('quit-confirm')).toBeVisible()
    // No live sessions ⇒ the sessions stage is skipped; the docs stage comes next.
    await expect(page.getByTestId('quit-confirm-sessions')).toHaveCount(0)
    await page.getByTestId('quit-ok').click()

    await expect(page.getByTestId('quit-confirm-docs')).toBeVisible()
    await expect(page.getByTestId('quit-docs-message')).toContainText('2 documents have unsaved changes.')
  })

  test('Cancel at the docs stage aborts the quit and keeps both docs dirty', async () => {
    await page.getByTestId('quit-docs-cancel').click()
    await expect(page.getByTestId('quit-confirm-docs')).toHaveCount(0)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    // The alpha doc is still dirty (Save button enabled) — nothing was written.
    await expect(vis(page, '[data-testid="doc-save"]')).toHaveText('Save')
    expect(await fs.readFile(aPath, 'utf8')).toBe('alpha original\n')
    expect(await fs.readFile(bPath, 'utf8')).toBe('beta original\n')
  })

  test('Save all docs saves EVERY project (active + hidden), then the app quits', async () => {
    await pressQuit(app)
    await page.getByTestId('quit-ok').click()
    await expect(page.getByTestId('quit-confirm-docs')).toBeVisible()

    const exited = app.waitForEvent('close')
    await page.getByTestId('quit-docs-save-all').click()
    await exited
    closed = true

    // Both files on disk now carry their edits — the hidden beta pane was saved too.
    expect(await fs.readFile(aPath, 'utf8')).toContain('A-EDIT')
    expect(await fs.readFile(bPath, 'utf8')).toContain('B-EDIT')
  })
})

// ── Discard all — quit continues, files untouched ─────────────────────────────────────────────
test.describe('T-187 — Discard all', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let docPath: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    docPath = join(fixture.workspaceRoot, 'Projects/alpha', 'd.txt')
    await fs.writeFile(docPath, 'keep me\n')
    await seedState(fixture.workspaceRoot, 'proj-alpha', [docTab('doc-d', 'proj-alpha', 'd.txt')])
    app = await launchApp(fixture, { POMADE_TEST_QUIT_CONFIRM: '1' })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await dirtyDoc(page, 'proj-alpha', 'doc-d', ' DOOMED')
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('Discard all changes quits without writing the dirty buffer', async () => {
    await pressQuit(app)
    await page.getByTestId('quit-ok').click()
    await expect(page.getByTestId('quit-confirm-docs')).toBeVisible()

    const exited = app.waitForEvent('close')
    await page.getByTestId('quit-docs-discard').click()
    await exited

    // The edit was discarded — the file on disk is unchanged.
    expect(await fs.readFile(docPath, 'utf8')).toBe('keep me\n')
    // E-035 — the discarded buffer survives as a draft in user data (never the workspace).
    const draftsDir = join(fixture.userDataDir, 'recovery/drafts')
    const drafts = await Promise.all(
      (await fs.readdir(draftsDir)).map(async (n) => JSON.parse(await fs.readFile(join(draftsDir, n), 'utf8')))
    )
    expect(drafts.map((d: { path: string; reason: string }) => [d.path, d.reason])).toEqual([
      ['Projects/alpha/d.txt', 'quit']
    ])
    expect((drafts[0] as { content: string }).content).toContain('DOOMED')
  })
})

// ── No dirty docs — no third dialog, the quit proceeds ────────────────────────────────────────
test.describe('T-187 — no dirty docs, no third dialog', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha', 'c.txt'), 'clean\n')
    await seedState(fixture.workspaceRoot, 'proj-alpha', [docTab('doc-c', 'proj-alpha', 'c.txt')])
    app = await launchApp(fixture, { POMADE_TEST_QUIT_CONFIRM: '1' })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    // Open the doc but do NOT edit it — it stays clean.
    await page.getByTestId('project-proj-alpha').click()
    await page.getByTestId('tab-doc-c').click()
    await expect(vis(page, '[data-testid="doc-save"]')).toHaveText('Saved')
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('a clean doc lets quit proceed with no docs dialog blocking it', async () => {
    await pressQuit(app)
    await expect(page.getByTestId('quit-confirm')).toBeVisible()
    // Confirming stage 1 with no sessions and no dirty docs quits straight through: if a docs
    // dialog had appeared it would block here and `close` would never fire.
    const exited = app.waitForEvent('close')
    await page.getByTestId('quit-ok').click()
    await exited
  })
})

// ── A doc that can't be saved unattended (on-disk conflict) aborts the quit ────────────────────
test.describe('T-187 — un-savable doc surfaces and aborts', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let docPath: string
  let closed = false

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    docPath = join(fixture.workspaceRoot, 'Projects/alpha', 'conf.txt')
    await fs.writeFile(docPath, 'local original\n')
    await seedState(fixture.workspaceRoot, 'proj-alpha', [docTab('doc-conf', 'proj-alpha', 'conf.txt')])
    app = await launchApp(fixture, { POMADE_TEST_QUIT_CONFIRM: '1' })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await dirtyDoc(page, 'proj-alpha', 'doc-conf', ' MY-EDIT')
  })

  test.afterAll(async () => {
    // The quit is opted IN here, so a plain app.close() would re-raise the dialog and hang the
    // teardown — the test leaves the app cleanly closed instead (closed=true below).
    if (!closed) await app?.close()
    await fixture?.cleanup()
  })

  test('Save all with an on-disk conflict names the doc and aborts (nothing overwritten)', async () => {
    // Diverge the file on disk since the pane loaded it → the T-142 guard blocks a blind overwrite.
    await fs.writeFile(docPath, 'REMOTE rewrite that must survive\n')

    await pressQuit(app)
    await page.getByTestId('quit-ok').click()
    await expect(page.getByTestId('quit-confirm-docs')).toBeVisible()
    await page.getByTestId('quit-docs-save-all').click()

    // The blocked dialog names the offender; the quit is aborted (app still alive).
    await expect(page.getByTestId('quit-confirm-docs-blocked')).toBeVisible()
    await expect(page.getByTestId('quit-docs-blocked-message')).toContainText('conf.txt')
    await page.getByTestId('quit-docs-blocked-ok').click()
    await expect(page.getByTestId('quit-confirm-docs-blocked')).toHaveCount(0)
    await expect(page.getByTestId('app-shell')).toBeVisible()

    // The remote content survived (no silent overwrite) and the doc is still dirty.
    expect(await fs.readFile(docPath, 'utf8')).toBe('REMOTE rewrite that must survive\n')
    await expect(vis(page, '[data-testid="doc-save"]')).toHaveText('Save')

    // Clean teardown: the doc is still dirty, so quit again and Discard to actually close the app
    // (a plain app.close() with the opt-in would hang on the re-raised dialog).
    await pressQuit(app)
    await page.getByTestId('quit-ok').click()
    await expect(page.getByTestId('quit-confirm-docs')).toBeVisible()
    const exited = app.waitForEvent('close')
    await page.getByTestId('quit-docs-discard').click()
    await exited
    closed = true
  })
})
