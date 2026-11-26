// modules: core, filetree, tabs, projects
// Pomade E-006 / T-028 e2e — control size / hit-target pass (no-regression guard).
// The Owner's review is the subjective gate; this spec just pins the objective floor: chrome
// icon-buttons meet the >=24px hit target and every icon-only button carries a tooltip so nothing
// is a mystery pinpoint control again (the 40-minute gear hunt).
//
// T-143 — the tooltip is now the design-system `Tooltip` (a portalled `[role="tooltip"]` shown on
// hover), NOT a native `title=` (which rendered a grey OS tooltip). `expectTooltip` asserts both: the
// native attribute is gone AND the on-system tooltip appears on hover.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

const MIN = 24

let fixture: Fixture
let app: ElectronApplication
let page: Page

async function expectHitTarget(testId: string): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox()
  expect(box, `${testId} should render`).not.toBeNull()
  // Sub-pixel rounding tolerance.
  expect(box!.width + 0.5, `${testId} width`).toBeGreaterThanOrEqual(MIN)
  expect(box!.height + 0.5, `${testId} height`).toBeGreaterThanOrEqual(MIN)
}

async function expectTooltip(testId: string): Promise<void> {
  const btn = page.getByTestId(testId)
  // Converted OFF the native OS tooltip (no `title=` → no grey box)…
  expect(await btn.evaluate((el) => el.hasAttribute('title')), `${testId} has no native title=`).toBe(
    false
  )
  // …and ONTO the portalled design-system tooltip, which appears on hover with real text.
  await btn.hover()
  const tip = page.locator('[role="tooltip"]').last()
  await expect(tip, `${testId} shows a design-system tooltip on hover`).toBeVisible()
  await expect(tip).toHaveText(/.+/)
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

test('Projects panel footer Settings entry is a large, labeled, discoverable target', async () => {
  const btn = page.getByTestId('projects-panel-settings')
  await expect(btn).toBeVisible()
  await expect(btn).toContainText('Settings')
  await expectTooltip('projects-panel-settings')
  await expectHitTarget('projects-panel-settings')
})

test('file-tree header buttons meet the hit target and have tooltips', async () => {
  // T-144 — show-ignored + ignore-settings moved into the section ⋯ kebab; the inline strip is now
  // New file · New folder · the section kebab (each an icon-button with a title tooltip).
  for (const id of ['tree-new-file', 'tree-new-folder', 'tree-section-kebab']) {
    await expectHitTarget(id)
    await expectTooltip(id)
  }
})

test('tab-strip action cluster meets the hit target and has tooltips', async () => {
  for (const id of ['session-history-open', 'bulk-actions', 'tab-add']) {
    await expectHitTarget(id)
    await expectTooltip(id)
  }
})
