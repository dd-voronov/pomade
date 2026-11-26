// modules: editor
// Pomade T-083 — the OS-spellchecker content-attributes on the TWO CodeMirror surfaces (raw +
// live), which share one `proseSpellcheckAttrs` object (cm-spellcheck.ts). Prose (markdown/txt)
// carries spellcheck=true (+ autocorrect/autocapitalize off); code files carry none.
//
// This guards the ATTRIBUTE plumbing only. Whether Chromium then paints red squiggles on
// already-LOADED CodeMirror text is a Chromium-44 limitation documented in cm-spellcheck.ts and
// docs/modules/editor/spellcheck.md — it is not assertable under CDP (Chromium suppresses the loaded-text idle
// spell pass whenever a debugger/automation client is attached), so no e2e can pin it; the typed
// path and the full suggestion chain are covered by app-version-spellcheck.spec.ts.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const PID = 'proj-alpha'

async function seedLive(fixture: Fixture): Promise<void> {
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', 'prose.md'), '# Title\n\nSome prose text here.\n')
  const state = {
    openTabs: [
      { id: 'doc-live', projectId: PID, kind: 'doc', title: 'prose.md', path: 'Projects/alpha/prose.md', mode: 'live', richView: 'live', dirty: false }
    ],
    activeTabId: 'doc-live'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

// T-096 — a second-class markdown extension (`.mkd`, also `.mdown`/`.mdx`) seeded in RAW mode:
// the raw prose gate is now `isMarkdownPath`, so it carries the spellcheck attributes like `.md`.
async function seedRawMkd(fixture: Fixture): Promise<void> {
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', 'note.mkd'), '# Heading\n\nSome prose here.\n')
  const state = {
    openTabs: [
      { id: 'doc-mkd', projectId: PID, kind: 'doc', title: 'note.mkd', path: 'Projects/alpha/note.mkd', mode: 'raw', dirty: false }
    ],
    activeTabId: 'doc-mkd'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

test.describe('T-083 — CodeMirror spellcheck content-attributes', () => {
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

  test('live (byte-true CodeMirror) prose carries spellcheck=true', async () => {
    await seedLive(fixture)
    const launched = await launchAppPage(fixture)
    app = launched.app
    const page = launched.page
    await page.getByTestId(`project-${PID}`).click()
    await page.getByTestId('tab-doc-live').click()
    await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'live')
    const content = vis(page, '[data-testid="live-editor"] .cm-content')
    await expect(content).toHaveAttribute('spellcheck', 'true')
    await expect(content).toHaveAttribute('autocorrect', 'off')
    await expect(content).toHaveAttribute('autocapitalize', 'off')
  })

  test('raw .mkd (a formerly second-class markdown ext) carries spellcheck=true (T-096)', async () => {
    await seedRawMkd(fixture)
    const launched = await launchAppPage(fixture)
    app = launched.app
    const page = launched.page
    await page.getByTestId(`project-${PID}`).click()
    await page.getByTestId('tab-doc-mkd').click()
    await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
    const content = vis(page, '[data-testid="raw-editor"] .cm-content')
    await expect(content).toHaveAttribute('spellcheck', 'true')
    await expect(content).toHaveAttribute('autocorrect', 'off')
  })
})
