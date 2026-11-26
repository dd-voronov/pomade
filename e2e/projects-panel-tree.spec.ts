// modules: core, projects, filetree, tabs
// Pomade Wave 2a e2e: Projects panel groups/projects + file tree.
// Covers: create 2 groups + 3 projects (one in g1, two in g2, distinct roots) → switch
// project re-roots the tree → create file & folder from the tree → open a doc tab from the
// tree → delete a project (config gone, folder still on disk).

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'

let fixture: Fixture
let app: ElectronApplication
let page: Page

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

async function createGroup(name: string): Promise<void> {
  await page.getByTestId('new-group').click()
  await page.getByTestId('group-name').fill(name)
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-modal')).toHaveCount(0)
}

async function createProject(name: string, groupLabel: string | null, root: string): Promise<void> {
  await page.getByTestId('new-project').click()
  await page.getByTestId('project-name').fill(name)
  if (groupLabel) await page.getByTestId('project-group').selectOption({ label: groupLabel })
  await page.getByTestId('project-root').fill(root)
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
}

test('create two groups', async () => {
  await createGroup('Group One')
  await createGroup('Group Two')
  await expect(page.getByText('Group One', { exact: true })).toBeVisible()
  await expect(page.getByText('Group Two', { exact: true })).toBeVisible()
})

test('create three projects across the two groups with distinct roots', async () => {
  await createProject('Alpha One', 'Group One', 'Projects/alpha')
  await createProject('Beta Two', 'Group Two', 'Projects/beta')
  await createProject('Gamma Three', 'Group Two', 'Apps/gamma')

  await expect(page.getByRole('button', { name: 'Alpha One' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Beta Two' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Gamma Three' })).toBeVisible()
})

test('selecting a project re-roots the file tree', async () => {
  await page.getByRole('button', { name: 'Alpha One' }).click()
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
  await expect(page.getByTestId('tree-node-Projects/alpha/README.md')).toBeVisible()
  // Beta's file should NOT be present under alpha's root.
  await expect(page.getByTestId('tree-node-Projects/beta/README.md')).toHaveCount(0)
})

test('create a file and a folder from the tree', async () => {
  await page.getByTestId('tree-new-file').click()
  await page.getByTestId('name-input').fill('fresh.md')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('tree-node-Projects/alpha/fresh.md')).toBeVisible()

  await page.getByTestId('tree-new-folder').click()
  await page.getByTestId('name-input').fill('freshdir')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('tree-node-Projects/alpha/freshdir')).toBeVisible()

  // The created file really exists on disk.
  await expect
    .poll(async () =>
      fs
        .access(join(fixture.workspaceRoot, 'Projects/alpha/fresh.md'))
        .then(() => true)
        .catch(() => false)
    )
    .toBe(true)
})

test('open a doc tab from the tree', async () => {
  await page.getByTestId('tree-node-Projects/alpha/README.md').click()
  await expect(page.getByTestId('tabstrip').getByText('README.md')).toBeVisible()
})

test('delete a project — config updated, files on disk untouched', async () => {
  const gammaAbs = join(fixture.workspaceRoot, 'Apps/gamma')
  const row = page.locator('li').filter({ has: page.getByRole('button', { name: 'Gamma Three' }) })
  // T-060 — delete now lives behind the row's kebab (⋮) menu. Open it (re-hovering to survive
  // a late reflow under parallel load), then pick the red "Delete" item.
  await hoverClick(row, row.getByRole('button', { name: 'More actions' }))
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByTestId('confirm-dialog')).toBeVisible()
  await page.getByTestId('confirm-ok').click()

  // Gone from the Projects panel (config-driven).
  await expect(page.getByRole('button', { name: 'Gamma Three' })).toHaveCount(0)

  // Removed from persisted workspace.json (after debounce), but its folder still exists.
  await expect
    .poll(async () => {
      const raw = await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8')
      return (JSON.parse(raw) as { projects: { name: string }[] }).projects.some(
        (p) => p.name === 'Gamma Three'
      )
    })
    .toBe(false)

  await expect(fs.access(gammaAbs).then(() => true)).resolves.toBe(true)
})
