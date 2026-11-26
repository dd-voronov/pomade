// modules: core, git, filetree
// Pomade E-006 / T-026 e2e — unified Settings surface.
// Acceptance: one obvious entry (Projects panel footer gear + Cmd+, menu item), every section
// reachable, and values persist to the RIGHT store — the preferences file (.pomade/settings.json)
// for the General editor/startup prefs, the workspace config (.pomade/workspace.json) for the file tree
// ignored items. Also covers the old scattered entry points now deep-linking into this surface.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { readSettingsJson } from './fixtures/settings'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const savedPreferences = (): Promise<Record<string, unknown>> => readSettingsJson(fixture.workspaceRoot)

async function workspaceJson(): Promise<{ fileTree?: { ignore: string[] } }> {
  return JSON.parse(
    await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8')
  )
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('Projects panel footer gear opens the unified Settings surface; every section is reachable', async () => {
  await page.getByTestId('projects-panel-settings').click()
  await expect(page.getByTestId('settings-modal')).toBeVisible()

  // Opens on General by default.
  await expect(page.getByTestId('settings-general')).toBeVisible()

  // Every registered section is navigable.
  await page.getByTestId('settings-nav-filetree').click()
  await expect(page.getByTestId('ignore-settings')).toBeVisible()

  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('settings-general')).toBeVisible()

  await page.getByTestId('modal-close').click()
  await expect(page.getByTestId('settings-modal')).toHaveCount(0)
})

test('Cmd+, app-menu item opens Settings (menu-item path, focus-independent)', async () => {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-settings')?.click()
  })
  await expect(page.getByTestId('settings-modal')).toBeVisible()
  await page.getByTestId('modal-close').click()
  await expect(page.getByTestId('settings-modal')).toHaveCount(0)
})

test('General: markdown default mode persists to the preferences file (settings.json)', async () => {
  await page.getByTestId('projects-panel-settings').click()
  await page.getByTestId('settings-nav-general').click()

  // T-257 — the options read Rich / Raw; the stored value for Rich stays 'rendered'.
  await expect(page.getByTestId('setting-md-default-mode').locator('option')).toHaveText(['Rich', 'Raw'])
  await expect(page.getByTestId('setting-md-default-mode')).toHaveValue('rendered')

  await page.getByTestId('setting-md-default-mode').selectOption('raw')
  await expect
    .poll(async () => (await savedPreferences()).markdownDefaultMode)
    .toBe('raw')

  // Flip back so the setting round-trips and later specs are unaffected.
  await page.getByTestId('setting-md-default-mode').selectOption('rendered')
  await expect
    .poll(async () => (await savedPreferences()).markdownDefaultMode)
    .toBe('rendered')

  await page.getByTestId('modal-close').click()
})

test('General: confirm-workspace-on-startup persists to the preferences file (settings.json)', async () => {
  await page.getByTestId('projects-panel-settings').click()
  await page.getByTestId('settings-nav-general').click()

  await page.getByTestId('setting-confirm-workspace').check()
  await expect
    .poll(async () => (await savedPreferences()).confirmWorkspaceOnStartup)
    .toBe(true)

  await page.getByTestId('setting-confirm-workspace').uncheck()
  await expect
    .poll(async () => (await savedPreferences()).confirmWorkspaceOnStartup)
    .toBe(false)

  await page.getByTestId('modal-close').click()
})

test('File tree: ignored-items edits persist to the WORKSPACE store (workspace.json)', async () => {
  await page.getByTestId('projects-panel-settings').click()
  await page.getByTestId('settings-nav-filetree').click()

  await page.getByTestId('ignore-add-input').fill('coverage')
  await page.getByTestId('ignore-add-submit').click()
  await expect(page.getByTestId('ignore-entry-coverage')).toBeVisible()

  await expect
    .poll(async () => (await workspaceJson()).fileTree?.ignore ?? [])
    .toContain('coverage')

  // Removal persists too.
  await page.getByTestId('ignore-remove-coverage').click()
  await expect
    .poll(async () => (await workspaceJson()).fileTree?.ignore ?? [])
    .not.toContain('coverage')

  await page.getByTestId('modal-close').click()
})

test('the file-tree header gear deep-links straight to the File tree section', async () => {
  // T-144 — the Ignored items settings entry moved into the section ⋯ kebab.
  await page.getByTestId('tree-section-kebab').click()
  await page.getByTestId('menu-ignored-items').click()
  await expect(page.getByTestId('settings-modal')).toBeVisible()
  await expect(page.getByTestId('ignore-settings')).toBeVisible()
  await page.getByTestId('modal-close').click()
})
