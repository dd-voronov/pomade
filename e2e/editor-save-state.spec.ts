// modules: core, editor
// Pomade E-026 e2e — Save-button state (T-139) + save-conflict data-loss guard (T-142).
//   T-139: the Save button reflects the two existing signals — "Saved" (disabled, deliberate)
//          iff the buffer is clean AND the file hasn't diverged on disk; "Save" (enabled)
//          otherwise. Refusal keeps its own disabled lock.
//   T-142: on Save, BEFORE writing, the doc re-stats the file through its fs door and — if it
//          diverged since load — shows a single Overwrite / Reload instead / Cancel confirm.
//          No silent overwrite; the happy path shows no dialog.
// Doc tabs are seeded via .pomade/state like the other editor specs; files are real on disk, so
// an "external write" is just fs.writeFile against the same path.

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

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string) => page.locator(`${sel}:visible`)

// NUL byte → binary refusal (read happens, then the content is refused).
const BIN = "PNG " + "\u0000\u0000" + " fake binary payload " + "\u0000" + " end\n"

function docTab(id: string, name: string, mode = 'raw'): Record<string, unknown> {
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

let statePath: string
let stateDocPath: string // the plain doc used for the state tests
let conflictPath: string // a dedicated doc for the conflict guard
let binPath: string

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  stateDocPath = join(root, 'Projects/alpha', 'state-doc.txt')
  conflictPath = join(root, 'Projects/alpha', 'conflict.txt')
  binPath = join(root, 'Projects/alpha', 'blob.bin')
  await fs.writeFile(stateDocPath, 'original state doc body\n')
  await fs.writeFile(conflictPath, 'original conflict body\n')
  await fs.writeFile(binPath, BIN)

  const state = {
    openTabs: [
      docTab('doc-state', 'state-doc.txt'),
      docTab('doc-conflict', 'conflict.txt'),
      docTab('doc-bin', 'blob.bin')
    ],
    activeTabId: 'doc-state'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  statePath = join(root, '.pomade/state/proj-alpha.json')
  await fs.writeFile(statePath, JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('T-139 — Save button reflects state', () => {
  test('an unedited doc shows a disabled "Saved"', async () => {
    await page.getByTestId('tab-doc-state').click()
    const save = vis('[data-testid="doc-save"]')
    await expect(save).toHaveText('Saved')
    await expect(save).toBeDisabled()
    await expect(save).toHaveAttribute('data-saved', 'true')
  })

  test('editing flips it to an enabled "Save"', async () => {
    await vis('[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.type(' EDIT-1')
    const save = vis('[data-testid="doc-save"]')
    await expect(save).toHaveText('Save')
    await expect(save).toBeEnabled()
    await expect(save).toHaveAttribute('data-saved', 'false')
  })

  test('saving clears back to a disabled "Saved"', async () => {
    await vis('[data-testid="doc-save"]').click()
    const save = vis('[data-testid="doc-save"]')
    await expect(save).toHaveText('Saved')
    await expect(save).toBeDisabled()
    // The edit really landed and there is no conflict dialog on the happy path.
    await expect
      .poll(async () => (await fs.readFile(stateDocPath, 'utf8')).includes('EDIT-1'))
      .toBe(true)
    await expect(page.locator('[data-testid="save-conflict-confirm"]')).toHaveCount(0)
  })

  test('a refused (binary) doc keeps the Save button disabled', async () => {
    await page.getByTestId('tab-doc-bin').click()
    await expect(vis('[data-testid="editor-refusal"]')).toBeVisible()
    const save = vis('[data-testid="doc-save"]')
    await expect(save).toBeDisabled()
    // Refusal is NOT the "Saved" lock — it stays labelled "Save".
    await expect(save).toHaveText('Save')
    await expect(save).toHaveAttribute('data-saved', 'false')
  })

  test('a clean buffer whose file diverged on disk shows an enabled "Save"', async () => {
    await page.getByTestId('tab-doc-state').click()
    // Externally modify the file, then force the visibility re-stat (tab away + back) so
    // changedOutside becomes true without depending on watcher timing.
    await fs.writeFile(stateDocPath, 'externally rewritten body\n')
    await page.getByTestId('tab-doc-conflict').click()
    await page.getByTestId('tab-doc-state').click()
    await expect(vis('[data-testid="editor-changed-outside"]')).toBeVisible()
    const save = vis('[data-testid="doc-save"]')
    await expect(save).toHaveText('Save')
    await expect(save).toBeEnabled()
  })
})

test.describe('T-142 — save-conflict guard', () => {
  test('an external write between load and Save triggers the Overwrite/Reload/Cancel confirm', async () => {
    await page.getByTestId('tab-doc-conflict').click()
    const save = vis('[data-testid="doc-save"]')
    await expect(save).toHaveText('Saved') // clean at load

    // Edit the buffer, then have something else rewrite the file on disk.
    await vis('[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.type(' MY-EDIT')
    await fs.writeFile(conflictPath, 'REMOTE rewrite that must not be lost\n')

    // Save → the guard re-stats, sees divergence, and prompts instead of blind-overwriting.
    await save.click()
    await expect(vis('[data-testid="save-conflict-confirm"]')).toBeVisible()
    // Cancel → no write, dialog closes, file on disk still holds the remote content.
    await vis('[data-testid="conflict-cancel"]').click()
    await expect(page.locator('[data-testid="save-conflict-confirm"]')).toHaveCount(0)
    expect(await fs.readFile(conflictPath, 'utf8')).toBe('REMOTE rewrite that must not be lost\n')
  })

  test('Overwrite writes the buffer over the diverged file', async () => {
    // The buffer still holds " MY-EDIT" and is still dirty; the file still diverges.
    const save = vis('[data-testid="doc-save"]')
    await expect(save).toHaveText('Save')
    await save.click()
    await expect(vis('[data-testid="save-conflict-confirm"]')).toBeVisible()
    await vis('[data-testid="conflict-overwrite"]').click()
    await expect(page.locator('[data-testid="save-conflict-confirm"]')).toHaveCount(0)
    await expect
      .poll(async () => (await fs.readFile(conflictPath, 'utf8')).includes('MY-EDIT'))
      .toBe(true)
    // The remote content is gone (the user chose to overwrite it) and the button settles.
    expect(await fs.readFile(conflictPath, 'utf8')).not.toContain('REMOTE rewrite')
    await expect(vis('[data-testid="doc-save"]')).toHaveText('Saved')
  })

  test('Reload instead discards the buffer and loads the disk copy — no write', async () => {
    // Diverge again with a fresh edit + external write.
    await vis('[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.type(' DOOMED-EDIT')
    await fs.writeFile(conflictPath, 'RELOAD-ME disk copy\n')

    const save = vis('[data-testid="doc-save"]')
    await save.click()
    await expect(vis('[data-testid="save-conflict-confirm"]')).toBeVisible()
    await vis('[data-testid="conflict-reload"]').click()
    await expect(page.locator('[data-testid="save-conflict-confirm"]')).toHaveCount(0)

    // Buffer now shows the disk copy; the doomed edit is gone; the file was NOT written.
    await expect(vis('[data-testid="raw-editor"] .cm-content')).toContainText('RELOAD-ME disk copy')
    await expect(vis('[data-testid="raw-editor"] .cm-content')).not.toContainText('DOOMED-EDIT')
    expect(await fs.readFile(conflictPath, 'utf8')).toBe('RELOAD-ME disk copy\n')
    await expect(vis('[data-testid="doc-save"]')).toHaveText('Saved')
  })

  test('happy-path Save (no divergence) writes silently with no dialog', async () => {
    await vis('[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.type(' CLEAN-EDIT')
    await vis('[data-testid="doc-save"]').click()
    // No conflict dialog appears on the undiverged path.
    await expect(page.locator('[data-testid="save-conflict-confirm"]')).toHaveCount(0)
    await expect
      .poll(async () => (await fs.readFile(conflictPath, 'utf8')).includes('CLEAN-EDIT'))
      .toBe(true)
    await expect(vis('[data-testid="doc-save"]')).toHaveText('Saved')
  })
})
