// modules: core, projects
// Pomade E-017 e2e — the predefined icon LIBRARY + three-mode change-icon window.
// Runs against the FIXTURE workspace (projects alpha + beta). Covers: the three-mode switcher
// (Icons | Emoji | Image) reveals the right pane; the single search field filters BOTH library
// sections (Use cases + Brands); picking a library icon renders the monochrome SVG in the
// Projects panel (expanded row + collapsed rail) and PERSISTS across an app restart. Specs chain
// state WITHIN this file — append only.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, relaunchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const ALPHA = 'proj-alpha'
const BETA = 'proj-beta'

interface ProjectSnap {
  id: string
  name: string
  icon?: string
  image?: string
}
const projectsOf = (p: Page): Promise<ProjectSnap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().projects as ProjectSnap[])

async function relaunch(): Promise<void> {
  ;({ app, page } = await relaunchApp(app, fixture))
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

async function openProjectEdit(id: string): Promise<void> {
  // T-060 — edit lives behind the row's kebab (⋮) menu.
  await hoverClick(page.getByTestId(`project-${id}`), page.getByTestId(`project-menu-${id}`))
  await page.getByTestId(`project-edit-${id}`).click()
  await expect(page.getByTestId('project-modal')).toBeVisible()
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

// ─── three-mode switcher reveals the matching pane ──────────────────────────────
test('the change-icon window offers three modes and shows only the active pane', async () => {
  await openProjectEdit(ALPHA)

  // Fresh project (no icon) opens on the Icons (library) mode.
  await expect(page.getByTestId('project-lib-pane')).toBeVisible()
  await expect(page.getByTestId('project-emoji-pane')).toHaveCount(0)
  await expect(page.getByTestId('project-image-pane')).toHaveCount(0)
  await expect(page.getByTestId('project-mode-icons')).toHaveAttribute('aria-selected', 'true')

  // Both library sections are present and labeled.
  await expect(page.getByTestId('project-lib-section-usecases')).toContainText('Use cases')
  await expect(page.getByTestId('project-lib-section-brands')).toContainText('Brands')

  // Emoji mode → only the emoji pane.
  await page.getByTestId('project-mode-emoji').click()
  await expect(page.getByTestId('project-emoji-pane')).toBeVisible()
  await expect(page.getByTestId('project-lib-pane')).toHaveCount(0)
  await expect(page.getByTestId('project-image-pane')).toHaveCount(0)

  // Image mode → only the image pane.
  await page.getByTestId('project-mode-image').click()
  await expect(page.getByTestId('project-image-pane')).toBeVisible()
  await expect(page.getByTestId('project-emoji-pane')).toHaveCount(0)
  await expect(page.getByTestId('project-lib-pane')).toHaveCount(0)

  // Cancel without changes.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
})

// ─── one search field filters BOTH sections ─────────────────────────────────────
test('the library search filters both the Use cases and Brands sections', async () => {
  await openProjectEdit(ALPHA)
  await expect(page.getByTestId('project-lib-pane')).toBeVisible()

  // A brand query keeps the matching brand, empties the Use cases section.
  await page.getByTestId('project-lib-search').fill('youtube')
  await expect(page.getByTestId('project-lib-si-youtube')).toBeVisible()
  await expect(page.getByTestId('project-lib-usecase-music')).toHaveCount(0)
  await expect(page.getByTestId('project-lib-section-usecases')).toContainText('match')

  // A use-case query keeps the matching glyph, empties the Brands section.
  await page.getByTestId('project-lib-search').fill('music')
  await expect(page.getByTestId('project-lib-usecase-music')).toBeVisible()
  await expect(page.getByTestId('project-lib-si-youtube')).toHaveCount(0)

  // A shared keyword ("translate") hits BOTH a use-case and a brand.
  await page.getByTestId('project-lib-search').fill('translat')
  await expect(page.getByTestId('project-lib-usecase-translation')).toBeVisible()
  await expect(page.getByTestId('project-lib-si-googletranslate')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
})

// ─── picking a library icon: renders in the Projects panel + persists across restart ───
test('a brand library icon renders in the Projects panel and survives restart', async () => {
  await openProjectEdit(ALPHA)
  await page.getByTestId('project-lib-search').fill('youtube')
  await page.getByTestId('project-lib-si-youtube').click()
  // The live preview reflects the chosen library icon.
  await expect(page.getByTestId('project-icon-preview')).toHaveAttribute('data-kind', 'library')
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  // Stored as the stable `lib:` id in the existing `icon` field.
  expect((await projectsOf(page)).find((p) => p.id === ALPHA)?.icon).toBe('lib:si-youtube')
  // Monochrome SVG rendered at the small tier in the row.
  const rowGlyph = page
    .getByTestId(`project-${ALPHA}`)
    .locator('[data-icon="library"] svg[data-lib-icon="lib:si-youtube"]')
  await expect(rowGlyph).toBeVisible()

  await relaunch()
  expect((await projectsOf(page)).find((p) => p.id === ALPHA)?.icon).toBe('lib:si-youtube')
  await expect(
    page.getByTestId(`project-${ALPHA}`).locator('svg[data-lib-icon="lib:si-youtube"]')
  ).toBeVisible()
})

// ─── use-case icon on a second project + crisp on the collapsed rail ────────────
test('a use-case library icon renders in the row and on the collapsed rail, persisting', async () => {
  await openProjectEdit(BETA)
  await page.getByTestId('project-lib-search').fill('software')
  await page.getByTestId('project-lib-usecase-software').click()
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  expect((await projectsOf(page)).find((p) => p.id === BETA)?.icon).toBe('lib:usecase-software')
  await expect(
    page.getByTestId(`project-${BETA}`).locator('svg[data-lib-icon="lib:usecase-software"]')
  ).toBeVisible()

  // Collapsed rail renders the same library glyph on the launcher.
  await page.getByTestId('projects-panel-collapse').click()
  await expect(
    page.getByTestId(`rail-project-${BETA}`).locator('svg[data-lib-icon="lib:usecase-software"]')
  ).toBeVisible()
  await page.getByTestId('projects-panel-expand').click()

  await relaunch()
  await expect(
    page.getByTestId(`project-${BETA}`).locator('svg[data-lib-icon="lib:usecase-software"]')
  ).toBeVisible()
})

// ─── editing re-opens on the CURRENT icon's mode (Icons), and can switch away ───
test('editing an item with a library icon re-opens on the Icons mode', async () => {
  await openProjectEdit(ALPHA) // alpha holds lib:si-youtube from an earlier test
  await expect(page.getByTestId('project-mode-icons')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('project-lib-pane')).toBeVisible()
  await expect(page.getByTestId('project-lib-si-youtube')).toHaveAttribute('aria-pressed', 'true')

  // Switching to an emoji replaces the library icon (mutually exclusive single field).
  await page.getByTestId('project-mode-emoji').click()
  await page.getByTestId('project-emoji-search').fill('fire')
  await page.getByTestId('project-emoji-🔥').click()
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  expect((await projectsOf(page)).find((p) => p.id === ALPHA)?.icon).toBe('🔥')
  await expect(page.getByTestId(`project-${ALPHA}`).locator('[data-icon="emoji"]')).toHaveText('🔥')
})
