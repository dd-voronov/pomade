// modules: filetree, projects
// Pomade T-182 e2e — the file-tree FOLDER context menu's "Start new project from here":
// opens the create-project wizard pre-filled with the folder's path, existing-folder mode
// preselected; completing creates the project; disabled (grayed, with a tooltip) on a folder
// under an OUTSIDE-workspace mount; cancel leaves no side effects; the plain "+ new project"
// flow is untouched; and the item is folder-only (absent on a file).
//
// Runs against the FIXTURE workspace with the ACTIVE project switched to alpha. It seeds a real
// subfolder inside alpha (the enabled case) and a throwaway OUTSIDE-workspace dir under HOME
// (mounted for the disabled case — genuinely outside the OS-tmp workspace). Specs chain state
// WITHIN this file — append, never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { tempDir } from './fixtures/temp'

let fixture: Fixture
let app: ElectronApplication
let page: Page
let root: string
let alpha: string
// A folder OUTSIDE the fixture workspace (throwaway tempDir under HOME — never a real user
// folder). Mounted by the disabled-case spec; its node paths are ABSOLUTE, so the menu item is
// grayed there.
let outsideDir: string

async function launch(): Promise<void> {
  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('filetree-root')).toBeVisible()
  // Switch to a REAL project so mounts persist (the Workspace project's are session-only).
  await page.getByTestId(`project-${alpha}`).click()
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
  await expect(page.getByTestId('tree-node-Projects/alpha/module-a')).toBeVisible()
}

/** Mount an outside-workspace folder via the section ⋯ kebab → "Mount new folder…". */
async function mount(path: string): Promise<void> {
  await page.getByTestId('tree-section-kebab').click()
  await page.getByTestId('menu-mount-folder').click()
  await expect(page.getByTestId('tree-mount-dialog')).toBeVisible()
  await page.getByTestId('tree-mount-input').fill(path)
  await page.getByTestId('tree-mount-submit').click()
}

/** Count the real project rows in the Projects panel via their per-row kebab (`project-menu-<id>`) —
 *  one per real project, none on the Workspace row, and absent from the create modal (whose
 *  fields also start with `project-`). */
async function projectRowCount(): Promise<number> {
  return page.locator('[data-testid^="project-menu-"]').count()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  root = fixture.workspaceRoot
  alpha = fixture.projects.alpha

  // A real subfolder INSIDE the alpha project — the enabled ("start project from here") case.
  await fs.mkdir(join(root, 'Projects/alpha/module-a'), { recursive: true })
  await fs.writeFile(join(root, 'Projects/alpha/module-a/index.md'), '# Module A\n')

  // A throwaway OUTSIDE-workspace tree (under HOME), with a nested folder, for the disabled case.
  outsideDir = await tempDir('pomade-t182-', homedir())
  await fs.mkdir(join(outsideDir, 'sub'), { recursive: true })
  await fs.writeFile(join(outsideDir, 'sub', 'deep.md'), '# Deep\n')

  await launch()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
})

test('the item is FOLDER-ONLY — absent on a file', async () => {
  // Right-click a FILE node: the single-node menu opens WITHOUT "Start new project from here".
  await page.getByTestId('tree-node-Projects/alpha/README.md').click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
  await expect(page.getByTestId('menu-new-project-here')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('the plain "+ new project" flow is untouched (no prefill, existing mode default)', async () => {
  await page.getByTestId('new-project').click()
  await expect(page.getByTestId('project-modal')).toBeVisible()
  // Default create shape is existing-folder, and its root field is EMPTY (no folder seeded).
  await expect(page.getByTestId('create-mode-existing')).toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId('project-root')).toHaveValue('')
  // Cancel — no project added.
  const before = await projectRowCount()
  await page.getByTestId('project-modal').getByText('Cancel').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
  expect(await projectRowCount()).toBe(before)
})

test('the item is present + enabled on a workspace folder', async () => {
  await page.getByTestId('tree-node-Projects/alpha/module-a').click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
  const item = page.getByTestId('menu-new-project-here')
  await expect(item).toBeVisible()
  await expect(item).toBeEnabled()
  await expect(item).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
})

test('cancel from the folder menu leaves no side effects', async () => {
  const before = await projectRowCount()
  await page.getByTestId('tree-node-Projects/alpha/module-a').click({ button: 'right' })
  await page.getByTestId('menu-new-project-here').click()
  await expect(page.getByTestId('project-modal')).toBeVisible()
  // Cancel without creating.
  await page.getByTestId('project-modal').getByText('Cancel').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
  expect(await projectRowCount()).toBe(before)
})

test('the item is disabled (grayed, with a tooltip) on a folder under an outside-workspace mount', async () => {
  // Mount the outside dir → its child folder's node path is ABSOLUTE, so the item is disabled.
  await mount(outsideDir)
  await expect(page.locator(`[data-root-path="${outsideDir}"]`)).toBeVisible()
  const subFolder = page.getByTestId(`tree-node-${outsideDir}/sub`)
  await expect(subFolder).toBeVisible()

  await subFolder.click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
  const item = page.getByTestId('menu-new-project-here')
  // Present but disabled (aria-disabled, kept hoverable so the tooltip fires) and grayed.
  await expect(item).toBeVisible()
  await expect(item).toHaveAttribute('aria-disabled', 'true')

  // The design-system tooltip explains why, on hover.
  await item.hover()
  const tooltip = page.locator('[role="tooltip"]').last()
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('outside your workspace')

  // Clicking it does nothing — no modal opens. The click is forced past Playwright's disabled-element
  // actionability guard to prove the handler itself is inert, not just that Playwright refused the click.
  // eslint-disable-next-line playwright/no-force-option -- the test is the forced click on an aria-disabled item: the handler must stay inert
  await item.click({ force: true })
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('clicking the item opens the wizard pre-filled + existing mode, and completing creates the project', async () => {
  const before = await projectRowCount()

  await page.getByTestId('tree-node-Projects/alpha/module-a').click({ button: 'right' })
  await page.getByTestId('menu-new-project-here').click()

  // The wizard opens with existing-folder mode preselected and the folder path pre-filled.
  await expect(page.getByTestId('project-modal')).toBeVisible()
  await expect(page.getByTestId('create-mode-existing')).toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId('project-root')).toHaveValue('Projects/alpha/module-a')

  // Complete: name it and create.
  await page.getByTestId('project-name').fill('ModuleA Project')
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  // It appears in the Projects panel (and the project count rose by one).
  await expect(
    page.getByTestId('projects-panel-scroll').getByText('ModuleA Project', { exact: true })
  ).toBeVisible()
  expect(await projectRowCount()).toBe(before + 1)
})
