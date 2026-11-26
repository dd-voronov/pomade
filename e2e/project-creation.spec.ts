// modules: projects, filetree
// Pomade E-008 e2e — project-creation UX (T-031), tree-header path (T-032), external
// image copy-in (T-033). Runs against the FIXTURE workspace. An EXTERNAL image file is
// created OUTSIDE the workspace and POMADE_PICK_PATH stubs the native image dialog so the
// copy-in path is driven deterministically. Specs chain state WITHIN this file — append only.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'
import { tempDir } from './fixtures/temp'

// A minimal valid 1x1 PNG (transparent) — enough to be copied + rendered as a data: URL.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)

let fixture: Fixture
let app: ElectronApplication
let page: Page
let root: string
let externalImage: string
let externalDir: string

const onDisk = (rel: string): Promise<boolean> =>
  fs
    .access(join(root, rel))
    .then(() => true)
    .catch(() => false)

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  root = fixture.workspaceRoot

  // Seed an external image OUTSIDE the workspace (T-033 copy-in source).
  externalDir = await tempDir('pomade-ext-')
  externalImage = join(externalDir, 'external-image.png')
  await fs.writeFile(externalImage, PNG_1PX)

  app = await launchApp(fixture, { // T-033 — stub the unconstrained image dialog to return the external file.
      POMADE_PICK_PATH: externalImage })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  await fs.rm(externalDir, { recursive: true, force: true })
})

// ─── T-031: explicit mutually-exclusive create options ─────────────────────────
test.describe('T-031 create-project: two explicit options', () => {
  test('default is "existing folder" — only the root field is shown', async () => {
    await page.getByTestId('new-project').click()
    await expect(page.getByTestId('project-modal')).toBeVisible()
    await expect(page.getByTestId('create-mode-existing')).toHaveAttribute('data-active', 'true')
    // Existing-mode reveals ONLY the root field; the template fields are absent from the DOM.
    await expect(page.getByTestId('project-root')).toBeVisible()
    await expect(page.getByTestId('project-template')).toHaveCount(0)
    await expect(page.getByTestId('project-parent')).toHaveCount(0)
  })

  test('switching to template mode swaps the fields (invalid combo impossible)', async () => {
    await page.getByTestId('create-mode-template').click()
    await expect(page.getByTestId('create-mode-template')).toHaveAttribute('data-active', 'true')
    // Template-mode reveals ONLY the template + parent fields; the root field is gone.
    await expect(page.getByTestId('project-template')).toBeVisible()
    await expect(page.getByTestId('project-parent')).toBeVisible()
    await expect(page.getByTestId('project-root')).toHaveCount(0)
  })

  test('creating from a template copies the template folder and roots the project there', async () => {
    // (modal still open, in template mode)
    await page.getByTestId('project-name').fill('Templated')
    await page.getByTestId('project-template').fill('Templates/basic-project')
    await page.getByTestId('project-parent').fill('Projects')
    // E-039 — "Track with git" is on for a template; git-ops-new-project.spec covers it. Here: off.
    await page.getByTestId('project-track-git').uncheck()
    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)

    // The template was copied to Projects/Templated and the project roots there.
    expect(await onDisk('Projects/Templated/README.md')).toBe(true)
    expect(await onDisk('Projects/Templated/.git')).toBe(false)
    // Scope to the Projects panel: since E-026 the tree root header also shows the path leaf
    // ("Templated"), so a bare exact-text match resolves to two elements.
    await expect(
      page.getByTestId('projects-panel-scroll').getByText('Templated', { exact: true })
    ).toBeVisible()
  })

  test('creating from an existing folder roots at the chosen path (no copy)', async () => {
    await page.getByTestId('new-project').click()
    await expect(page.getByTestId('create-mode-existing')).toHaveAttribute('data-active', 'true')
    await page.getByTestId('project-name').fill('Gamma')
    await page.getByTestId('project-root').fill('Apps/gamma')
    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
    await expect(
      page.getByTestId('projects-panel-scroll').getByText('Gamma', { exact: true })
    ).toBeVisible()
  })
})

// ─── T-032 / T-144: tree-header reveal + copy full path (now in the root ⋯ kebab) ─────────────
test.describe('T-032 tree header: reveal + copy full path', () => {
  // T-144 — the root's Copy/Reveal moved from inline hover buttons into the ⋯ kebab menu.
  const openHomeKebab = async (): Promise<void> => {
    const rootRow = page.getByTestId('filetree-root')
    await hoverClick(rootRow, page.getByTestId('filetree-root-kebab'))
    await expect(page.getByTestId('tree-menu')).toBeVisible()
  }

  test('copy full path writes the project root absolute path to the clipboard', async () => {
    // Select a real project so the tree re-roots at its folder.
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await openHomeKebab()
    await page.getByTestId('menu-copy-full-path').click()

    await expect
      .poll(() => page.evaluate(() => window.pomade.app.clipboardRead()))
      .toBe(join(root, 'Projects/alpha'))
  })

  test('reveal-in-Finder affordance is wired in the root kebab', async () => {
    await openHomeKebab()
    // Assert the item is present + enabled rather than clicking (a real click launches Finder).
    await expect(page.getByTestId('menu-reveal')).toBeEnabled()
    await page.keyboard.press('Escape')
  })
})

// ─── T-033: external image copied into .pomade/assets and rendered ─────────────
test.describe('T-033 external image copy-in', () => {
  test('picking an out-of-workspace image copies it into .pomade/assets and previews it', async () => {
    await page.getByTestId('new-project').click()
    await page.getByTestId('project-name').fill('Imaged')
    await page.getByTestId('project-root').fill('Projects/alpha')
    await page.getByTestId('project-mode-image').click() // E-017 — three-mode window: Image mode
    // Browse the image → fs.pickImage returns the stubbed EXTERNAL path → copy-in.
    await page.getByTestId('project-image-browse').click()

    // The stored reference is the workspace-relative copy under .pomade/assets.
    const imageInput = page.getByTestId('project-image')
    await expect(imageInput).toHaveValue(/^\.pomade\/assets\/[0-9a-f]+\.png$/)
    const rel = await imageInput.inputValue()
    expect(await onDisk(rel)).toBe(true)

    // The inline preview renders the copied asset.
    await expect(page.locator('img[src^="data:image/png"]').first()).toBeVisible()

    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
  })

  test('an in-workspace image is ALSO copied into .pomade/assets (round-3 fix); re-picking an asset does not duplicate it', async () => {
    // Seed a source image INSIDE the workspace and repoint the dialog stub at it
    // (the handler reads POMADE_PICK_PATH per call, so main-process env can be swapped live).
    const insideImage = join(root, 'Projects/alpha/image-src.png')
    await fs.writeFile(insideImage, PNG_1PX)
    await app.evaluate(({ }, p) => {
      process.env.POMADE_PICK_PATH = p
    }, insideImage)

    await page.getByTestId('new-project').click()
    await page.getByTestId('project-name').fill('InsideImaged')
    await page.getByTestId('project-root').fill('Projects/alpha')
    await page.getByTestId('project-mode-image').click() // E-017 — three-mode window: Image mode
    await page.getByTestId('project-image-browse').click()

    const imageInput = page.getByTestId('project-image')
    await expect(imageInput).toHaveValue(/^\.pomade\/assets\/[0-9a-f]+\.png$/)
    const rel = await imageInput.inputValue()
    expect(await onDisk(rel)).toBe(true)
    // Copy, not move — the original stays where it was.
    expect(await onDisk('Projects/alpha/image-src.png')).toBe(true)

    // Re-picking the copied asset itself must return it as-is, not copy again.
    const assetsBefore = (await fs.readdir(join(root, '.pomade/assets'))).length
    await app.evaluate(({ }, p) => {
      process.env.POMADE_PICK_PATH = p
    }, join(root, rel))
    await page.getByTestId('project-image-browse').click()
    await expect(imageInput).toHaveValue(rel)
    expect(await fs.readdir(join(root, '.pomade/assets'))).toHaveLength(assetsBefore)

    await page.getByTestId('project-modal').getByText('Cancel').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
  })
})
