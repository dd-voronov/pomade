// modules: core, projects
// Pomade T-125 e2e — the expanded Projects panel's footer (Settings + version) is pinned: only the
// project list scrolls (styles.scroll wrapper), the footer never leaves the viewport no matter
// how many projects the workspace has. Seeds a workspace.json with enough projects to force
// real overflow (rows taller than the window), which is exactly the state that scrolled the
// footer away before the fix.

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

const MANY = 40 // project rows — comfortably taller than any test-window height

test.describe('Projects panel footer pinned (T-125)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // Re-seed workspace.json with MANY projects (all sharing alpha's real folder — the
    // Projects panel renders rows from config alone, and none of them is opened here).
    const projects = Array.from({ length: MANY }, (_, i) => ({
      id: `bulk-${i}`,
      name: `Bulk project ${i}`,
      rootPath: 'Projects/alpha',
      visibleAgents: ['*'],
      order: i
    }))
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade/workspace.json'),
      JSON.stringify(
        { groups: [], projects },
        null,
        2
      )
    )
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('project-bulk-0')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('list really overflows and the footer is still fully on-screen', async () => {
    const scroll = page.getByTestId('projects-panel-scroll')
    await expect(scroll).toBeVisible()
    const overflow = await scroll.evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(overflow).toBeGreaterThan(50) // the seeded rows genuinely exceed the window

    const viewport = await page.evaluate(() => window.innerHeight)
    for (const id of ['projects-panel-settings', 'app-version']) {
      const box = await page.getByTestId(id).boundingBox()
      expect(box, `${id} must be on-screen without scrolling`).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport + 1)
    }
  })

  test('scrolling the project list does not move the footer', async () => {
    const before = await page.getByTestId('projects-panel-settings').boundingBox()
    await page.getByTestId('projects-panel-scroll').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const after = await page.getByTestId('projects-panel-settings').boundingBox()
    expect(after!.y).toBeCloseTo(before!.y, 0)
    // And the last seeded row became reachable — the scroller scrolled, not the nav.
    await expect(page.getByTestId(`project-bulk-${MANY - 1}`)).toBeVisible()
  })

  test('the end-drop zone stays inside the scroll area (drop target intact)', async () => {
    // projects-panel-below-all is a reorder drop target (E-015/T-074) — it must live in the
    // scrolling region, after the last row, not under the pinned footer.
    const inScroll = await page.getByTestId('projects-panel-below-all').evaluate((el) =>
      Boolean(el.closest('[data-testid="projects-panel-scroll"]'))
    )
    expect(inScroll).toBe(true)
  })
})
