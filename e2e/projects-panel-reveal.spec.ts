// modules: projects, core
// T-311 e2e — the Projects panel follows the active project (docs/modules/projects/groups-and-projects.md).
// A switch Pomade makes on its own (here: the workspace store's setActiveProject, the call a notice, an
// app or an agent tab call makes) unfolds the collapsed group around the project, scrolls its row into
// view and flashes it; the experimental toast names the switch and its "Back to …" returns without a
// flash. A click on a row never flashes; the setting turns the toast off; the collapsed rail flashes the
// launcher. Screenshots land in T311_SHOTS when set.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.T311_SHOTS
const FILLERS = 'grp-fillers'
const FOLDED = 'grp-folded'
const FAR = 'proj-far'

async function shotOf(el: Locator | Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await el.screenshot({ path: join(SHOTS, name) })
}

interface SwitchSeen {
  /** Every project row that flashed, watched until two frames after the switch landed. */
  flashed: string[]
  /** The switch toasts showing at that moment. */
  toasts: string[]
}

/** Runs `how` towards project `id` in the page and reports what showed: `jump` = a switch Pomade
 *  makes; `click` = the user's click on the row; `back` = a click on the switch toast's Back. */
function flashesDuring(page: Page, how: 'jump' | 'click' | 'back', id: string): Promise<SwitchSeen> {
  return page.evaluate(
    ({ how, id }) =>
      new Promise<SwitchSeen>((resolve) => {
        const seen: string[] = []
        const note = (el: Element): void => {
          const row = el.getAttribute('data-project-row')
          if (row && el.getAttribute('data-reveal-flash') === 'true') seen.push(row)
        }
        const obs = new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === 'attributes') note(r.target as Element)
            for (const n of r.addedNodes) {
              if (n instanceof Element) n.querySelectorAll('[data-reveal-flash]').forEach(note)
            }
          }
        })
        obs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-reveal-flash'] })
        const ws = window.__pomadeStores.useWorkspaceStore
        if (how === 'jump') ws.getState().setActiveProject(id)
        else if (how === 'click') document.querySelector<HTMLElement>(`[data-testid="project-${id}"]`)?.click()
        else document.querySelector<HTMLElement>('[data-testid="project-switch-back"]')?.click()
        const done = (): void => {
          obs.disconnect()
          const toasts = [...document.querySelectorAll('[data-testid="project-switch-toast"]')].map((t) => t.textContent ?? '')
          resolve({ flashed: seen, toasts })
        }
        const settle = (): void => {
          if (ws.getState().activeProjectId !== id) return void requestAnimationFrame(settle)
          requestAnimationFrame(() => requestAnimationFrame(done))
        }
        settle()
      }),
    { how, id }
  )
}

function activeProject(page: Page): Promise<string> {
  return page.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId)
}

test.describe('T-311 the Projects panel reveals the project Pomade switched to', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // Enough filler rows above the folded group that its project sits below the panel's fold.
    const fillers = Array.from({ length: 40 }, (_, i) => ({
      id: `proj-fill-${i}`,
      name: `Filler ${i}`,
      rootPath: 'Projects/beta',
      groupId: FILLERS,
      visibleAgents: ['*'],
      order: i
    }))
    const config = {
      groups: [
        { id: FILLERS, name: 'Fillers', order: 0 },
        { id: FOLDED, name: 'Folded', order: 1 }
      ],
      ungroupedOrder: 2,
      projects: [
        ...fillers,
        { id: FAR, name: 'Far', rootPath: 'Projects/beta', groupId: FOLDED, visibleAgents: ['*'], order: 0 },
        { id: fixture.projects.alpha, name: 'Alpha', rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 }
      ]
    }
    await fs.writeFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), JSON.stringify(config, null, 2))
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  async function foldFarGroup(): Promise<void> {
    await page.evaluate((g) => {
      const ui = window.__pomadeStores.useWorkspaceUiStore.getState()
      if (!ui.isCollapsed(g)) ui.toggleGroupCollapsed(g)
    }, FOLDED)
    await expect(page.getByTestId(`group-collapse-${FOLDED}`)).toHaveAttribute('aria-expanded', 'false')
  }

  async function showFromTop(): Promise<void> {
    await page.getByTestId('projects-panel-scroll').evaluate((el) => (el.scrollTop = 0))
  }

  async function clearToasts(): Promise<void> {
    const toast = page.getByTestId('project-switch-toast')
    while ((await toast.count()) > 0) await toast.first().getByRole('button').first().click()
  }

  test('a switch Pomade makes unfolds the group, scrolls the row into view, flashes it and says so', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect.poll(() => activeProject(page)).toBe(fixture.projects.alpha)
    await foldFarGroup()
    await showFromTop()

    const seen = await flashesDuring(page, 'jump', FAR)
    expect(seen.flashed).toContain(FAR)
    await expect(page.getByTestId(`group-collapse-${FOLDED}`)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId(`project-${FAR}`)).toBeInViewport({ ratio: 1 })
    const toast = page.getByTestId('project-switch-toast')
    await expect(toast).toHaveCount(1)
    await expect(toast).toContainText('Switched to Far')
    await expect(toast.getByTestId('project-switch-back')).toHaveText('Back to Alpha')
    await shotOf(page.getByTestId('projects-panel-scroll'), 'row-flash.png')
    await shotOf(toast, 'switch-toast.png')
    // The flash is a moment, not a state.
    await expect(page.getByTestId(`project-${FAR}`)).not.toHaveAttribute('data-reveal-flash', 'true')

    // Back returns as the user's own pick: no flash, no new toast.
    const back = await flashesDuring(page, 'back', fixture.projects.alpha)
    expect(back).toEqual({ flashed: [], toasts: [] })
    await expect(page.getByTestId(`project-${fixture.projects.alpha}`)).toBeInViewport({ ratio: 1 })
  })

  test('a click on a row switches without a flash or a toast', async () => {
    const seen = await flashesDuring(page, 'click', 'proj-fill-0')
    expect(seen).toEqual({ flashed: [], toasts: [] })
  })

  test('with the experimental setting off, the row still flashes but no toast shows', async () => {
    await page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().setProjectSwitchToast(false))
    try {
      const seen = await flashesDuring(page, 'jump', fixture.projects.alpha)
      expect(seen.flashed).toContain(fixture.projects.alpha)
      expect(seen.toasts).toEqual([])
    } finally {
      await page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().setProjectSwitchToast(true))
    }
  })

  test('the setting sits under Settings ▸ General ▸ Experimental', async () => {
    await page.getByTestId('projects-panel-settings').click()
    const box = page.getByTestId('setting-project-switch-toast')
    await expect(box).toBeChecked()
    await box.uncheck()
    await expect
      .poll(() => page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().projectSwitchToast))
      .toBe(false)
    await shotOf(page.getByTestId('settings-general'), 'setting.png')
    await box.check()
    await page.keyboard.press('Escape')
  })

  test('the collapsed rail flashes the launcher', async () => {
    await clearToasts()
    await page.getByTestId('projects-panel-collapse').click()
    await expect(page.getByTestId('projects-panel-rail')).toBeVisible()
    try {
      const seen = await flashesDuring(page, 'jump', FAR)
      expect(seen.flashed).toContain(FAR)
      await shotOf(page.getByTestId('projects-panel-rail'), 'rail.png')
      await expect(page.getByTestId(`rail-project-${FAR}`)).toBeInViewport({ ratio: 1 })
    } finally {
      await page.getByTestId('projects-panel-expand').click()
    }
  })
})
