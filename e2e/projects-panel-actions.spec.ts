// modules: projects
// Pomade round-5 e2e: Projects panel row interactions.
// Covers T-059 (the WHOLE row box is the click target — workspace & project rows — while the
// icon keeps its own action), T-060 (row actions collapsed into ONE kebab (⋮) menu: Move
// up/down disabled at list edges, Edit, Delete styled red; reorder still works), and T-064
// (a create-project path typed with a leading '/' populates the tree like a slash-free path).
//
// State chains within this file (append-only). The fixture seeds two ungrouped projects:
// proj-alpha (Projects/alpha, order 0) and proj-beta (Projects/beta, order 1); no groups.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'

const ALPHA = 'proj-alpha'
const BETA = 'proj-beta'
const WORKSPACE = '__workspace__'

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

/** DOM order of the two seeded ungrouped project rows (reflects the sorted order). */
async function projectOrder(): Promise<(string | null)[]> {
  return page
    .locator('[data-testid^="project-proj-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
}

// ─── T-059: the whole row box is the click target ──────────────────────────────
test('T-059: clicking the Workspace row far-right (empty) area opens the Workspace project', async () => {
  // Make a project active first so the switch to the Workspace project is observable.
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId(`project-${ALPHA}`)).toHaveAttribute('data-active', 'true')

  const box = await page.getByTestId(`project-${WORKSPACE}`).boundingBox()
  expect(box).not.toBeNull()
  // Far right of the row, well past the label — empty space that used to be a dead zone.
  await page.mouse.click(box!.x + box!.width - 6, box!.y + box!.height / 2)

  await expect(page.getByTestId(`project-${WORKSPACE}`)).toHaveAttribute('data-active', 'true')
  await expect(page.getByTestId(`project-${ALPHA}`)).toHaveAttribute('data-active', 'false')
})

test('T-059: clicking the workspace icon opens the change-icon dialog, not the Workspace project', async () => {
  // Start from a project other than the Workspace project.
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId(`project-${ALPHA}`)).toHaveAttribute('data-active', 'true')

  await page.getByTestId('workspace-icon-button').click()
  await expect(page.getByTestId('workspace-icon-modal')).toBeVisible()
  // The icon stops propagation: the row did NOT open.
  await expect(page.getByTestId(`project-${WORKSPACE}`)).toHaveAttribute('data-active', 'false')
  await expect(page.getByTestId(`project-${ALPHA}`)).toHaveAttribute('data-active', 'true')

  await page.getByTestId('modal-close').click()
  await expect(page.getByTestId('workspace-icon-modal')).toHaveCount(0)
})

test('T-059: clicking a project row off the text (empty padding) opens the project', async () => {
  await page.getByTestId(`project-${WORKSPACE}`).click()
  await expect(page.getByTestId(`project-${WORKSPACE}`)).toHaveAttribute('data-active', 'true')

  const box = await page.getByTestId(`project-${BETA}`).boundingBox()
  expect(box).not.toBeNull()
  // Center-x (no kebab there) at the top edge (empty padding above the label) → still opens.
  await page.mouse.click(box!.x + box!.width / 2, box!.y + 3)

  await expect(page.getByTestId(`project-${BETA}`)).toHaveAttribute('data-active', 'true')
})

// ─── T-060: one kebab menu carries all row actions ─────────────────────────────
test('T-060: the project kebab menu carries all actions; Move up disabled at the top edge', async () => {
  // Alpha is first among the ungrouped projects → Move up disabled, Move down enabled.
  await hoverClick(page.getByTestId(`project-${ALPHA}`), page.getByTestId(`project-menu-${ALPHA}`))
  await expect(page.getByTestId('row-menu')).toBeVisible()

  await expect(page.getByTestId(`project-move-up-${ALPHA}`)).toBeDisabled()
  await expect(page.getByTestId(`project-move-down-${ALPHA}`)).toBeEnabled()
  await expect(page.getByTestId(`project-edit-${ALPHA}`)).toBeVisible()
  await expect(page.getByTestId(`project-delete-${ALPHA}`)).toBeVisible()

  // Delete is styled red (token --danger = #d1495b).
  const color = await page
    .getByTestId(`project-delete-${ALPHA}`)
    .evaluate((el) => getComputedStyle(el).color)
  expect(color).toBe('rgb(209, 73, 91)')

  await page.getByTestId('row-menu-scrim').click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
})

test('T-060: reordering a project through the kebab menu (Move down) swaps the row order', async () => {
  await expect.poll(projectOrder).toEqual([`project-${ALPHA}`, `project-${BETA}`])

  await hoverClick(page.getByTestId(`project-${ALPHA}`), page.getByTestId(`project-menu-${ALPHA}`))
  await page.getByTestId(`project-move-down-${ALPHA}`).click()

  await expect.poll(projectOrder).toEqual([`project-${BETA}`, `project-${ALPHA}`])
  // Menu closed itself on action.
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
})

// ─── T-064: leading-slash create path ──────────────────────────────────────────
test('T-064: a create-project path typed with a leading slash populates the tree like no slash', async () => {
  await page.getByTestId('new-project').click()
  await page.getByTestId('project-name').fill('Slash Test')
  await page.getByTestId('project-root').fill('/Projects/alpha')
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  // Newly created project auto-activates → the tree re-roots to Projects/alpha and is populated
  // (the bug produced an EMPTY tree here).
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
  await expect(page.getByTestId('tree-node-Projects/alpha/README.md')).toBeVisible()

  // Stored rootPath is normalized (no leading slash) — identical to a picker-based relative path.
  await expect
    .poll(async () => {
      const raw = await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8')
      return (JSON.parse(raw) as { projects: { name: string; rootPath: string }[] }).projects.find(
        (p) => p.name === 'Slash Test'
      )?.rootPath
    })
    .toBe('Projects/alpha')
})
