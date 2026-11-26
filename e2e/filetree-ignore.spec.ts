// modules: filetree
// Pomade E-003/T-019 e2e — file tree ignored-items transparency + configurability.
// Covers the acceptance from docs/roadmap/T-019-tree-ignored-folders.md:
//   "toggle reveals node_modules dimmed; settings edit persists."
// Also exercises config-store's defensive default for workspace.json files written before
// `fileTree` existed (the fixture's seeded workspace.json omits it on purpose).

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// T-144 — the show-ignored toggle + the Ignored items… settings entry moved from inline header
// buttons into the file-tree section ⋯ kebab. These helpers open the kebab and click the item.
async function toggleIgnored(): Promise<void> {
  await page.getByTestId('tree-section-kebab').click()
  await page.getByTestId('menu-toggle-ignored').click()
}
async function openIgnoredItems(): Promise<void> {
  await page.getByTestId('tree-section-kebab').click()
  await page.getByTestId('menu-ignored-items').click()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  // Default active project is the Workspace project, so the tree already
  // roots at the workspace and shows the fixture's top-level node_modules.
  await expect(page.getByTestId('filetree-root')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('node_modules is hidden from the tree by default', async () => {
  await expect(page.getByTestId('tree-node-node_modules')).toHaveCount(0)
})

test('the ⋯ menu names ignored items, not hidden ones', async () => {
  await page.getByTestId('tree-section-kebab').click()
  await expect(page.getByTestId('menu-toggle-ignored')).toHaveText('Show ignored items')
  await expect(page.getByTestId('menu-ignored-items')).toHaveText('Ignored items…')
  await page.keyboard.press('Escape')

  await toggleIgnored()
  await page.getByTestId('tree-section-kebab').click()
  await expect(page.getByTestId('menu-toggle-ignored')).toHaveText('Hide ignored items')
  await page.keyboard.press('Escape')
  await toggleIgnored()
})

test('the "show ignored" toggle reveals node_modules, dimmed', async () => {
  await toggleIgnored()
  const row = page.getByTestId('tree-node-node_modules')
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-ignored', 'true')

  // Toggling back off hides it again.
  await toggleIgnored()
  await expect(page.getByTestId('tree-node-node_modules')).toHaveCount(0)

  // Leave it on for the rest of this file's tests.
  await toggleIgnored()
  await expect(page.getByTestId('tree-node-node_modules')).toBeVisible()
})

test('ignore settings: current default list is shown', async () => {
  await openIgnoredItems()
  await expect(page.getByTestId('ignore-settings')).toBeVisible()
  // The hint points at the ⋯ menu's toggle, not at a header eye button.
  await expect(page.getByTestId('ignore-settings')).toContainText('Show ignored items')
  await expect(page.getByTestId('ignore-settings')).not.toContainText('eye')
  await expect(page.getByTestId('ignore-entry-node_modules')).toBeVisible()
  await expect(page.getByTestId('ignore-entry-.git')).toBeVisible()
  await expect(page.getByTestId('ignore-entry-.DS_Store')).toBeVisible()
  await page.getByTestId('modal-close').click()
  await expect(page.getByTestId('ignore-settings')).toHaveCount(0)
})

test('editing the ignored items persists to workspace.json', async () => {
  await openIgnoredItems()
  await page.getByTestId('ignore-add-input').fill('dist')
  await page.getByTestId('ignore-add-submit').click()
  await expect(page.getByTestId('ignore-entry-dist')).toBeVisible()
  await page.getByTestId('modal-close').click()

  await expect
    .poll(async () => {
      const raw = await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8')
      return (JSON.parse(raw) as { fileTree?: { ignore: string[] } }).fileTree?.ignore ?? []
    })
    .toContain('dist')

  // Removing an entry also persists.
  await openIgnoredItems()
  await page.getByTestId('ignore-remove-dist').click()
  await expect(page.getByTestId('ignore-entry-dist')).toHaveCount(0)
  await page.getByTestId('modal-close').click()

  await expect
    .poll(async () => {
      const raw = await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8')
      return (JSON.parse(raw) as { fileTree?: { ignore: string[] } }).fileTree?.ignore ?? []
    })
    .not.toContain('dist')
})
