// modules: editor
// Pomade E-024 slice 4 — wiring: the Keep/Adjust formatting setting, the two-state mode
// button, the per-doc rich-view override, and per-tab persistence.
//   • Settings ▸ General gains "Editing markdown: Keep formatting / Adjust formatting"
//     (default Keep) — it selects WHICH rich view a fresh markdown open gets;
//   • Keep (default) → a tree-opened .md lands in LIVE; Adjust → in RENDERED (Milkdown);
//   • changing the setting NEVER re-renders an already-open doc;
//   • the mode button stays two-state, labels the CURRENT view, and the raw leg returns to
//     the SAME rich view it left;
//   • the ⋯ menu's "Rich view: Live/Rendered" switches THIS doc between engines in place;
//   • DocTab.mode 'live' and the richView override persist into .pomade/state (the same
//     record a relaunch restores from — restore itself is proven by every live spec's
//     seeded-state beforeAll).

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
import { expectQuiet } from './fixtures/timing'

const PID = 'proj-alpha'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const NOTE = '---\ntitle: Wiring\n---\n\n# Wiring\n\nBody with **bold** and a [[wikilink]].\n'

const setFormatting = (value: 'keep' | 'adjust'): Promise<void> =>
  page.evaluate(async (v) => {
    await window.__pomadeStores.useAppSettingsStore.getState().setMarkdownFormatting(v)
  }, value)

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/keep-note.md'), NOTE)
  await fs.writeFile(join(root, 'Projects/alpha/adjust-note.md'), NOTE)
  await fs.writeFile(join(root, 'Projects/alpha/stay-note.md'), NOTE)
  await fs.writeFile(join(root, 'Projects/alpha/override-note.md'), NOTE)

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await firstAppWindow(app)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  // Every tree click opens a fresh REAL tab (the wiring tests need fresh opens, not the
  // preview slot chaining docs through one pane).
  await page.evaluate(async () => {
    await window.__pomadeStores.useAppSettingsStore.getState().setPreviewTabMode(false)
  })
  await page.getByTestId(`project-${PID}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('Settings ▸ General offers Keep/Adjust formatting, default Keep', async () => {
  await page.getByTestId('projects-panel-settings').click()
  const select = vis('[data-testid="setting-md-formatting"]')
  await expect(select).toBeVisible()
  await expect(select).toHaveValue('keep')
  // Sits in the same Editor group as "New markdown opens as".
  await expect(vis('[data-testid="setting-md-default-mode"]')).toBeVisible()
  await page.getByTestId('modal-close').click()
})

test('Keep (default): a fresh .md opens LIVE; the button names the current view', async () => {
  await page.getByTestId('tree-node-Projects/alpha/keep-note.md').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/keep-note.md')
  await expect(editor).toHaveAttribute('data-mode', 'live')
  await expect(vis('[data-testid="mode-toggle"]')).toHaveText('Live')
  await expect(vis('[data-testid="live-editor"] .cm-content')).toBeVisible()
})

test('Adjust: a fresh .md opens RENDERED (Milkdown)', async () => {
  await setFormatting('adjust')
  await page.getByTestId('tree-node-Projects/alpha/adjust-note.md').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-doc-path', 'Projects/alpha/adjust-note.md')
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(vis('[data-testid="mode-toggle"]')).toHaveText('Rendered')
  await expect(vis('[data-testid="rendered-editor"] .ProseMirror')).toBeVisible()
  await setFormatting('keep')
})

test('changing the setting NEVER re-renders an already-open doc', async () => {
  await page.getByTestId('tree-node-Projects/alpha/stay-note.md').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'live')
  // Flip the setting under the open doc — the pane must not move, held for the window a
  // re-render would need.
  await setFormatting('adjust')
  await expectQuiet(async () => {
    await expect(editor).toHaveAttribute('data-mode', 'live')
    await expect(vis('[data-testid="live-editor"] .cm-content')).toBeVisible()
  }, 300)
  await setFormatting('keep')
})

test('two-state toggle: Raw ⇄ Live, returning to the SAME rich view it left', async () => {
  await page.getByTestId('tab-strip').isVisible().catch(() => {})
  await page.getByTestId('tree-node-Projects/alpha/keep-note.md').click()
  const editor = vis('[data-testid="editor-pane"]')
  const toggle = vis('[data-testid="mode-toggle"]')
  await expect(editor).toHaveAttribute('data-mode', 'live')

  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'raw')
  await expect(toggle).toHaveText('Raw')

  // Even with the app setting flipped to Adjust meanwhile, THIS doc returns to Live —
  // the per-doc rich view was persisted on the leave leg.
  await setFormatting('adjust')
  await toggle.click()
  await expect(editor).toHaveAttribute('data-mode', 'live')
  await expect(toggle).toHaveText('Live')
  await setFormatting('keep')
})

test('⋯ "Rich view" override switches THIS doc between Live and Rendered in place', async () => {
  await page.getByTestId('tree-node-Projects/alpha/override-note.md').click()
  const editor = vis('[data-testid="editor-pane"]')
  await expect(editor).toHaveAttribute('data-mode', 'live')

  // The menu line names the CURRENT rich view.
  await vis('[data-testid="doc-actions"]').click()
  const item = vis('[data-testid="action-rich-view"]')
  await expect(item).toHaveText('Rich view: Live')
  await item.click()

  // Immediate engine switch, same doc, same tab.
  await expect(editor).toHaveAttribute('data-mode', 'rendered')
  await expect(vis('[data-testid="rendered-editor"] .ProseMirror')).toBeVisible()
  await expect(vis('[data-testid="mode-toggle"]')).toHaveText('Rendered')

  await vis('[data-testid="doc-actions"]').click()
  await expect(vis('[data-testid="action-rich-view"]')).toHaveText('Rich view: Rendered')
  await vis('[data-testid="action-rich-view"]').click()
  await expect(editor).toHaveAttribute('data-mode', 'live')
  await expect(vis('[data-testid="live-editor"] .cm-content')).toBeVisible()
})

test("DocTab.mode 'live' + richView persist into .pomade/state (the relaunch-restore record)", async () => {
  // The docs above live in tabs with mode 'live'; the override doc carries richView too.
  const stateFile = join(fixture.workspaceRoot, '.pomade/state', `${PID}.json`)
  await expect
    .poll(async () => {
      try {
        const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
          openTabs?: { path?: string; mode?: string; richView?: string }[]
        }
        const tabs = raw.openTabs ?? []
        const keep = tabs.find((t) => t.path === 'Projects/alpha/keep-note.md')
        const override = tabs.find((t) => t.path === 'Projects/alpha/override-note.md')
        return { keepMode: keep?.mode, overrideMode: override?.mode, overrideRich: override?.richView }
      } catch {
        return null
      }
    })
    .toEqual({ keepMode: 'live', overrideMode: 'live', overrideRich: 'live' })
})
