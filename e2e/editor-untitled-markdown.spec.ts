// modules: editor
// Pomade T-192 — a new, unsaved "Untitled" doc (no filename → no extension) gets the FULL markdown
// treatment BY POLICY from creation: markdown doc kind (rich view switch present, the header's
// rich-view ⋯ control, prose spellcheck in raw), not the "Plain text" it used to be classified as.
// The first save resolves the real extension: saving as `.md` keeps everything; saving with a
// non-md extension reclassifies the tab to that kind — the one legitimate moment the markdown
// features disappear. Revert-proven: with the policy removed an Untitled doc opens raw with no
// mode-toggle, failing the create-time assertions in BOTH specs.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const PID = 'proj-alpha'
const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

async function newUntitledDoc(page: Page): Promise<void> {
  await page.getByTestId(`project-${PID}`).click()
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-doc').click()
  await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-doc-path', '')
  await expect(vis(page, '[data-testid="editor-title"]')).toHaveText('Untitled')
}

test.describe('T-192 — Untitled doc is markdown by policy', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await app?.close()
    app = undefined
    await fixture?.cleanup()
  })

  test('create → full md treatment → toggle raw (spellcheck) → save as .md keeps it', async () => {
    const launched = await launchAppPage(fixture)
    app = launched.app
    const page = launched.page
    await newUntitledDoc(page)

    const editor = vis(page, '[data-testid="editor-pane"]')
    // Markdown doc kind from creation: opens in the rich view (Live under the Keep default), the
    // language chip reads Markdown, and the raw⇄rich view switch is present.
    await expect(editor).toHaveAttribute('data-mode', 'live')
    await expect(vis(page, '[data-testid="editor-lang"]')).toHaveText('Markdown')
    await expect(vis(page, '[data-testid="mode-toggle"]')).toBeVisible()

    // The ⋯ doc-actions dropdown is complete: the per-doc "Rich view" control (markdown-only) is
    // present. Close the menu afterward.
    await page.getByTestId('doc-actions').click()
    await expect(page.getByTestId('action-rich-view')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('action-rich-view')).toHaveCount(0)

    // Type a body, then toggle to raw — the raw view is prose, so it carries the OS-spellcheck
    // content-attributes (prose gating active for an extensionless buffer).
    await vis(page, '[data-testid="live-editor"] .cm-content').click()
    await page.keyboard.type('untitled body text')
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    const raw = vis(page, '[data-testid="raw-editor"] .cm-content')
    await expect(raw).toHaveAttribute('spellcheck', 'true')
    await expect(raw).toHaveAttribute('autocorrect', 'off')

    // Save as `.md` → nothing about the classification changes: still markdown (mode-toggle stays,
    // language chip stays Markdown, the mode we left it in — raw — persists).
    await page.keyboard.press(`${MOD}+s`)
    await expect(vis(page, '[data-testid="saveas-modal"]')).toBeVisible()
    await vis(page, '[data-testid="saveas-name"]').fill('untitled-note.md')
    await vis(page, '[data-testid="saveas-confirm"]').click()

    const target = join(fixture.workspaceRoot, 'Projects/alpha/untitled-note.md')
    await expect.poll(async () => fs.readFile(target, 'utf8').catch(() => '')).toContain(
      'untitled body text'
    )
    await expect(vis(page, '[data-testid="editor-title"]')).toHaveText('untitled-note.md')
    await expect(vis(page, '[data-testid="editor-lang"]')).toHaveText('Markdown')
    await expect(vis(page, '[data-testid="mode-toggle"]')).toBeVisible()
    await expect(editor).toHaveAttribute('data-mode', 'raw')
  })

  test('create → save as .txt reclassifies the tab away from markdown', async () => {
    const launched = await launchAppPage(fixture)
    app = launched.app
    const page = launched.page
    await newUntitledDoc(page)

    // Markdown treatment is present before the save.
    await expect(vis(page, '[data-testid="editor-lang"]')).toHaveText('Markdown')
    await expect(vis(page, '[data-testid="mode-toggle"]')).toBeVisible()

    await vis(page, '[data-testid="live-editor"] .cm-content').click()
    await page.keyboard.type('plain text body')

    // Save with a non-md extension → the tab reclassifies to that kind: the rich view switch is
    // gone (a .txt has no rich view) and the language chip reads TXT.
    await page.keyboard.press(`${MOD}+s`)
    await expect(vis(page, '[data-testid="saveas-modal"]')).toBeVisible()
    await vis(page, '[data-testid="saveas-name"]').fill('scratch.txt')
    await vis(page, '[data-testid="saveas-confirm"]').click()

    const target = join(fixture.workspaceRoot, 'Projects/alpha/scratch.txt')
    await expect.poll(async () => fs.readFile(target, 'utf8').catch(() => '')).toContain(
      'plain text body'
    )
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/scratch.txt')
    await expect(vis(page, '[data-testid="editor-title"]')).toHaveText('scratch.txt')
    await expect(vis(page, '[data-testid="editor-lang"]')).toHaveText('TXT')
    await expect(vis(page, '[data-testid="mode-toggle"]')).toHaveCount(0)
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // The ⋯ menu no longer offers the markdown-only rich-view control.
    await page.getByTestId('doc-actions').click()
    await expect(page.getByTestId('action-rich-view')).toHaveCount(0)
  })
})
