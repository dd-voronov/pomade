// modules: core
// Pomade Wave 1 smoke: app launches, layout renders, picker skipped via env, and the
// tab framework opens/closes a placeholder tab and survives an active-project switch
// WITHOUT unmounting the pane (asserted via DOM presence + a stable mount id while hidden).

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

let fixture: Fixture
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('launches straight into the shell (picker skipped via POMADE_WORKSPACE)', async () => {
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('pick-workspace')).toHaveCount(0)
})

test('renders the three-column layout with seeded projects', async () => {
  await expect(page.getByTestId('tabstrip')).toBeVisible()
  await expect(page.getByTestId('panehost')).toBeVisible()
  await expect(page.getByTestId('filetree-root')).toBeVisible()
  // Workspace project + the two seeded projects
  await expect(page.getByTestId('project-__workspace__')).toBeVisible()
  await expect(page.getByTestId(`project-${fixture.projects.alpha}`)).toBeVisible()
  await expect(page.getByTestId(`project-${fixture.projects.beta}`)).toBeVisible()
})

test('tab framework: open a placeholder tab, survive a project switch without unmounting, then close', async () => {
  const { alpha, beta } = fixture.projects

  // Activate Alpha and open a placeholder Terminal tab.
  await page.getByTestId(`project-${alpha}`).click()
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()

  // T-097 — PaneHost renders a FLAT pane list (a pane's project is `data-project-id` on its
  // wrapper, no longer a wrapper div per project), so Alpha's panes are selected by that
  // attribute. The invariant under test is unchanged: hidden, never unmounted.
  const alphaGroup = page.locator('[data-project-id="' + alpha + '"]')
  const alphaPaneBody = alphaGroup.locator('[data-mount-id]')
  await expect(alphaPaneBody).toHaveCount(1)
  await expect(alphaPaneBody).toBeVisible()

  await expect(alphaPaneBody).toHaveAttribute('data-mount-id', /.+/)
  const mountIdBefore = await alphaPaneBody.getAttribute('data-mount-id')

  // The pane wrapper should report itself visible while Alpha is active.
  const alphaWrapper = page.locator('[data-testid^="pane-"][data-project-id="' + alpha + '"]').first()
  await expect(alphaWrapper).toHaveAttribute('data-visible', 'true')

  // Switch to Beta: Alpha's pane must remain in the DOM (hidden), never unmounted.
  await page.getByTestId(`project-${beta}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', beta)
  await expect(alphaPaneBody).toHaveCount(1) // still present in DOM
  await expect(alphaWrapper).toHaveAttribute('data-visible', 'false') // but hidden
  await expect(alphaPaneBody).toHaveAttribute('data-mount-id', mountIdBefore ?? '') // same instance

  // Switch back to Alpha: same pane instance is shown again.
  await page.getByTestId(`project-${alpha}`).click()
  await expect(alphaPaneBody).toBeVisible()
  await expect(alphaPaneBody).toHaveAttribute('data-mount-id', mountIdBefore ?? '')

  // Close the tab: pane is removed and the empty state returns.
  await expect(alphaWrapper).toHaveAttribute('data-tab-id', /.+/)
  const tabId = await alphaWrapper.getAttribute('data-tab-id')
  await page.getByTestId(`close-${tabId}`).click()
  await expect(alphaPaneBody).toHaveCount(0)
  await expect(page.getByTestId('panehost-empty')).toBeVisible()
})
