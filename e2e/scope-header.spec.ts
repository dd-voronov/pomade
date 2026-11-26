// modules: core, editor
// Pomade T-101 (E-021) e2e — the scope triangle + `~`-relative path in the EDITOR HEADER.
//
// In the expanded (path) state, an in-project doc keeps its project-relative path and shows no
// triangle; an out-of-project doc shows a `~`-relative FULL path (home-relative absolute) and the
// scope triangle, which sits to the RIGHT of the name/path but BEFORE the file-type chip.
//
// This spec builds its workspace UNDER the user's home directory (a throwaway dotted folder, never
// the real vault) so the `~` home-relativisation actually fires — the shared fixture lives in the
// OS temp dir, which is not under home.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launchApp } from './fixtures/app'
import { tempDir } from './fixtures/temp'

const PID = 'proj-alpha'
const ALPHA_DOC = 'Projects/alpha/README.md' // in-project (project-relative: README.md)
const BETA_DOC = 'Projects/beta/README.md' // out-of-project for alpha

interface HomeFixture {
  workspaceRoot: string
  userDataDir: string
  cleanup: () => Promise<void>
}

async function buildHomeFixture(): Promise<HomeFixture> {
  // Throwaway folders directly under $HOME so an out-of-project doc's absolute path is `~/…`.
  const workspaceRoot = await tempDir('.pomade-e2e-ws-', homedir())
  const userDataDir = await tempDir('.pomade-e2e-ud-', homedir())

  await fs.mkdir(join(workspaceRoot, 'Projects/alpha'), { recursive: true })
  await fs.mkdir(join(workspaceRoot, 'Projects/beta'), { recursive: true })
  await fs.writeFile(join(workspaceRoot, ALPHA_DOC), '# Alpha\n\nAlpha project.\n')
  await fs.writeFile(join(workspaceRoot, BETA_DOC), '# Beta\n\nBeta project.\n')

  const workspaceConfig = {
    groups: [],
    projects: [{ id: PID, name: 'Alpha', rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 }]
  }
  await fs.mkdir(join(workspaceRoot, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(workspaceRoot, '.pomade/workspace.json'),
    JSON.stringify(workspaceConfig, null, 2)
  )

  const docTab = (id: string, path: string): Record<string, unknown> => ({
    id,
    projectId: PID,
    kind: 'doc',
    title: path.slice(path.lastIndexOf('/') + 1),
    path,
    mode: 'raw',
    dirty: false
  })
  const state = {
    openTabs: [docTab('doc-alpha', ALPHA_DOC), docTab('doc-beta', BETA_DOC)],
    activeTabId: 'doc-alpha'
  }
  await fs.writeFile(join(workspaceRoot, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))

  return {
    workspaceRoot,
    userDataDir,
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  }
}

test.describe('T-101 editor-header scope mark + ~-relative path', () => {
  let fixture: HomeFixture
  let app: ElectronApplication
  let page: Page

  const title = (): ReturnType<Page['locator']> =>
    page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-title"]')
  const scope = (): ReturnType<Page['locator']> =>
    page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-scope"]')

  test.beforeAll(async () => {
    fixture = await buildHomeFixture()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${PID}`).click()
    // Expand the header to path mode (one global, persisted setting) via the in-project doc.
    await page.getByTestId('tab-doc-alpha').click()
    await expect(title()).toHaveText('README.md')
    await title().click()
    await expect(title()).toHaveAttribute('data-expanded', 'true')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('an in-project doc shows the project-relative path and NO triangle', async () => {
    await page.getByTestId('tab-doc-alpha').click()
    await expect(title()).toHaveText('README.md')
    expect(await title().textContent()).not.toContain('Projects/alpha')
    await expect(scope()).toHaveCount(0)
  })

  test('an out-of-project doc shows a ~-relative FULL path and the triangle, right of the name and before the file-type chip', async () => {
    await page.getByTestId('tab-doc-beta').click()

    const expected = `~/${fixture.workspaceRoot.slice(homedir().length + 1)}/${BETA_DOC}`
    await expect(title()).toHaveText(expected)
    await expect(title()).toHaveAttribute('data-expanded', 'true')

    const mark = scope()
    await expect(mark).toBeVisible()
    await expect(mark).toHaveAttribute('data-tone', 'warning')

    // Geometry: the triangle sits to the RIGHT of the name/path and BEFORE the file-type chip.
    const geom = await page.evaluate(() => {
      // Pick the VISIBLE editor pane (hidden panes for other tabs stay mounted).
      const pane = [...document.querySelectorAll('[data-testid="editor-pane"]')].find(
        (el) => (el as HTMLElement).offsetParent !== null
      ) as HTMLElement
      const rect = (sel: string): DOMRect =>
        (pane.querySelector(sel) as HTMLElement).getBoundingClientRect()
      return {
        name: rect('[data-testid="editor-title"]').right,
        markLeft: rect('[data-testid="editor-scope"]').left,
        markRight: rect('[data-testid="editor-scope"]').right,
        chipLeft: rect('[data-testid="editor-lang"]').left
      }
    })
    expect(geom.markLeft).toBeGreaterThanOrEqual(geom.name - 4)
    expect(geom.chipLeft).toBeGreaterThanOrEqual(geom.markRight - 4)

    // Hover carries the same stacking tooltip as the tab.
    await mark.hover()
    await expect(page.getByTestId('editor-scope-tooltip')).toHaveText('Outside this project')
  })
})
