// modules: core, filetree, tabs
// Pomade E-006 / T-027 e2e — Change Workspace.
// Acceptance: switch between two fixture workspaces; each per-workspace .pomade stays intact
// across a round-trip switch. The native folder dialog is stubbed by the POMADE_PICK_ROOT
// main-process env var (set fresh before each switch via electronApp.evaluate), and the
// switch is triggered through the real "Change Workspace…" app-menu item (focus-independent,
// same menu-item → IPC → renderer path as T-036).

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

let wsA: Fixture
let wsB: Fixture
let app: ElectronApplication
let page: Page

// Seed a distinguishing open-doc tab into a workspace's proj-alpha .pomade state.
async function seedAlphaTab(root: string, tabId: string, file: string): Promise<void> {
  const state = {
    openTabs: [
      {
        id: tabId,
        projectId: 'proj-alpha',
        kind: 'doc',
        title: file,
        path: `Projects/alpha/${file}`,
        mode: 'raw',
        dirty: false
      }
    ],
    activeTabId: tabId
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))
}

// Set the stubbed picker return value in the MAIN process, then click Change Workspace….
async function switchTo(target: string): Promise<void> {
  await app.evaluate(({}, t) => {
    process.env.POMADE_PICK_ROOT = t
  }, target)
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-change-workspace')?.click()
  })
}

test.beforeAll(async () => {
  wsA = await createFixtureWorkspace()
  wsB = await createFixtureWorkspace()

  // Distinct marker at each workspace root so the tree unambiguously proves which is loaded.
  await fs.writeFile(join(wsA.workspaceRoot, 'marker-a.md'), '# A\n')
  await fs.writeFile(join(wsB.workspaceRoot, 'marker-b.md'), '# B\n')

  // Distinct pre-seeded proj-alpha tab per workspace (both files exist in each fixture).
  await seedAlphaTab(wsA.workspaceRoot, 'a-doc', 'README.md')
  await seedAlphaTab(wsB.workspaceRoot, 'b-doc', 'notes.txt')

  app = await launchApp(wsA)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await wsA?.cleanup()
  await wsB?.cleanup()
})

test('starts in workspace A (its marker file shows in the tree)', async () => {
  await expect(page.getByTestId('tree-node-marker-a.md')).toBeVisible()
  await expect(page.getByTestId('tree-node-marker-b.md')).toHaveCount(0)

  // A's proj-alpha restores its own tab from A/.pomade.
  await page.getByTestId('project-proj-alpha').click()
  await expect(page.getByTestId('tab-a-doc')).toBeVisible()
})

test('switch A → B: tree re-roots and B loads its own per-workspace .pomade', async () => {
  await switchTo(wsB.workspaceRoot)

  await expect(page.getByTestId('tree-node-marker-b.md')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('tree-node-marker-a.md')).toHaveCount(0)

  // B's proj-alpha restores B's tab — not A's.
  await page.getByTestId('project-proj-alpha').click()
  await expect(page.getByTestId('tab-b-doc')).toBeVisible()
  await expect(page.getByTestId('tab-a-doc')).toHaveCount(0)

  // app.json now points at B.
  await expect
    .poll(async () =>
      JSON.parse(await fs.readFile(join(wsA.userDataDir, 'app.json'), 'utf8')).workspaceRoot
    )
    .toBe(wsB.workspaceRoot)
})

test('switch back B → A: A’s .pomade survived the round-trip intact', async () => {
  await switchTo(wsA.workspaceRoot)

  await expect(page.getByTestId('tree-node-marker-a.md')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('tree-node-marker-b.md')).toHaveCount(0)

  // A's proj-alpha tab is restored exactly as it was, proving A/.pomade was untouched by
  // the excursion into B.
  await page.getByTestId('project-proj-alpha').click()
  await expect(page.getByTestId('tab-a-doc')).toBeVisible()
  await expect(page.getByTestId('tab-b-doc')).toHaveCount(0)
})
