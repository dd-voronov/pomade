// modules: projects, tabs
// Pomade T-183 e2e: the Projects panel highlight (focus/emphasis) marker on projects, groups, and
// sub-groups. A kebab item toggles `highlighted`; a highlighted row renders its name BOLD in the
// expanded list; the menu label names the current-state action (Highlight ⇄ Remove highlight);
// the flag lives in the git-tracked workspace.json (identity-like, rides sync) and survives a
// restart; non-highlighted rows are untouched. State chains WITHIN this file — append only.
//
// Fixture is a realistic tree: two top-level groups (Work, Personal) + a sub-group (Sub under
// Work); Alpha sits in Work, Beta in the sub-group, Gamma is ungrouped.

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

let fixture: Fixture
let app: ElectronApplication
let page: Page

const G_WORK = 'g-work'
const G_PERSONAL = 'g-personal'
const G_SUB = 'g-sub'
const P_ALPHA = 'p-alpha'
const P_BETA = 'p-beta'
const P_GAMMA = 'p-gamma'

const wsPath = (): string => join(fixture.workspaceRoot, '.pomade', 'workspace.json')

/** The bold weight a highlighted name renders at (--fw-bold = 700). */
const BOLD = '700'

interface Snap {
  id: string
  highlighted?: boolean
}
const groupsOf = (p: Page): Promise<Snap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().groups as Snap[])
const projectsOf = (p: Page): Promise<Snap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().projects as Snap[])

/** highlighted flag for an id as written to workspace.json on disk. */
async function highlightedOnDisk(kind: 'groups' | 'projects', id: string): Promise<boolean | undefined> {
  const raw = await fs.readFile(wsPath(), 'utf8')
  const cfg = JSON.parse(raw) as { groups: Snap[]; projects: Snap[] }
  return cfg[kind].find((x) => x.id === id)?.highlighted
}

/** Open a project row's kebab menu (hover-revealed) and return once the row menu is up. */
async function openProjectMenu(id: string): Promise<void> {
  await hoverClick(page.getByTestId(`project-${id}`), page.getByTestId(`project-menu-${id}`))
  await expect(page.getByTestId('row-menu')).toBeVisible()
}
/** Open a group/sub-group header's kebab menu. */
async function openGroupMenu(id: string): Promise<void> {
  await hoverClick(page.getByTestId(`group-header-${id}`), page.getByTestId(`group-menu-${id}`))
  await expect(page.getByTestId('row-menu')).toBeVisible()
}

async function boot(): Promise<void> {
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId(`group-header-${G_WORK}`)).toBeVisible()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const cfg = {
    groups: [
      { id: G_WORK, name: 'Work', order: 0 },
      { id: G_PERSONAL, name: 'Personal', order: 1 },
      { id: G_SUB, name: 'Sub', parentId: G_WORK, order: 0 }
    ],
    projects: [
      { id: P_ALPHA, name: 'Alpha', groupId: G_WORK, rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 },
      { id: P_BETA, name: 'Beta', groupId: G_SUB, rootPath: 'Projects/beta', visibleAgents: ['*'], order: 0 },
      { id: P_GAMMA, name: 'Gamma', rootPath: 'Apps/gamma', visibleAgents: ['*'], order: 0 }
    ]
  }
  await fs.writeFile(wsPath(), JSON.stringify(cfg, null, 2), 'utf8')
  await boot()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

// ─── Baseline: nothing highlighted, kebab offers "Highlight" ───────────────────
test('no row starts highlighted, and the kebab offers "Highlight"', async () => {
  await expect(page.getByTestId(`project-name-${P_ALPHA}`)).not.toHaveAttribute('data-highlighted', 'true')
  await expect(page.getByTestId(`group-name-${G_WORK}`)).not.toHaveAttribute('data-highlighted', 'true')

  await openProjectMenu(P_ALPHA)
  const item = page.getByTestId(`project-highlight-${P_ALPHA}`)
  await expect(item).toBeVisible()
  await expect(item).toHaveText(/Highlight/)
  await expect(item).not.toHaveText(/Remove highlight/)
  await page.getByTestId('row-menu-scrim').click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
})

// ─── Toggle on a PROJECT → bold name, label flips, persisted ───────────────────
test('highlighting a project makes its name bold, flips the label, and persists to workspace.json', async () => {
  const name = page.getByTestId(`project-name-${P_ALPHA}`)
  await expect(name).not.toHaveCSS('font-weight', BOLD)

  await openProjectMenu(P_ALPHA)
  await page.getByTestId(`project-highlight-${P_ALPHA}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)

  // Name is now bold + flagged.
  await expect(name).toHaveAttribute('data-highlighted', 'true')
  await expect(name).toHaveCSS('font-weight', BOLD)
  expect((await projectsOf(page)).find((p) => p.id === P_ALPHA)?.highlighted).toBe(true)

  // Reopen the menu: the label now names the opposite action.
  await openProjectMenu(P_ALPHA)
  await expect(page.getByTestId(`project-highlight-${P_ALPHA}`)).toHaveText(/Remove highlight/)
  await page.getByTestId('row-menu-scrim').click()

  // It reached the git-tracked workspace.json.
  await expect.poll(() => highlightedOnDisk('projects', P_ALPHA)).toBe(true)
})

// ─── Toggle on a GROUP and a SUB-GROUP ─────────────────────────────────────────
test('highlighting a group and a sub-group both bold their names (depth-agnostic)', async () => {
  for (const gid of [G_WORK, G_SUB]) {
    const name = page.getByTestId(`group-name-${gid}`)
    await expect(name).not.toHaveCSS('font-weight', BOLD)
    await openGroupMenu(gid)
    await page.getByTestId(`group-highlight-${gid}`).click()
    await expect(page.getByTestId('row-menu')).toHaveCount(0)
    await expect(name).toHaveAttribute('data-highlighted', 'true')
    await expect(name).toHaveCSS('font-weight', BOLD)
  }
  const g = await groupsOf(page)
  expect(g.find((x) => x.id === G_WORK)?.highlighted).toBe(true)
  expect(g.find((x) => x.id === G_SUB)?.highlighted).toBe(true)
  await expect.poll(() => highlightedOnDisk('groups', G_SUB)).toBe(true)
})

// ─── Non-highlighted rows are untouched ────────────────────────────────────────
test('rows that were never highlighted stay normal-weight and unflagged', async () => {
  for (const t of [`project-name-${P_BETA}`, `project-name-${P_GAMMA}`, `group-name-${G_PERSONAL}`]) {
    const el = page.getByTestId(t)
    await expect(el).not.toHaveAttribute('data-highlighted', 'true')
    await expect(el).not.toHaveCSS('font-weight', BOLD)
  }
})

// ─── Toggle OFF restores normal weight ─────────────────────────────────────────
test('removing a highlight restores the normal weight and clears the flag', async () => {
  const name = page.getByTestId(`project-name-${P_ALPHA}`)
  await expect(name).toHaveCSS('font-weight', BOLD) // still on from earlier

  await openProjectMenu(P_ALPHA)
  await expect(page.getByTestId(`project-highlight-${P_ALPHA}`)).toHaveText(/Remove highlight/)
  await page.getByTestId(`project-highlight-${P_ALPHA}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)

  await expect(name).not.toHaveAttribute('data-highlighted', 'true')
  await expect(name).not.toHaveCSS('font-weight', BOLD)
  expect((await projectsOf(page)).find((p) => p.id === P_ALPHA)?.highlighted).toBe(false)
  await expect.poll(() => highlightedOnDisk('projects', P_ALPHA)).toBe(false)

  // Re-highlight Alpha so the restart test below has a highlighted project too.
  await openProjectMenu(P_ALPHA)
  await page.getByTestId(`project-highlight-${P_ALPHA}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
  await expect(name).toHaveCSS('font-weight', BOLD)
  await expect.poll(() => highlightedOnDisk('projects', P_ALPHA)).toBe(true)
})

// ─── Persistence across a restart ──────────────────────────────────────────────
test('highlights survive an app relaunch', async () => {
  // Going into the restart: Alpha (project), Work + Sub (groups) are highlighted; the rest not.
  await app.close()
  await boot()

  await expect(page.getByTestId(`project-name-${P_ALPHA}`)).toHaveCSS('font-weight', BOLD)
  await expect(page.getByTestId(`group-name-${G_WORK}`)).toHaveCSS('font-weight', BOLD)
  await expect(page.getByTestId(`group-name-${G_SUB}`)).toHaveCSS('font-weight', BOLD)

  // Untouched rows are still normal after restart.
  await expect(page.getByTestId(`project-name-${P_BETA}`)).not.toHaveCSS('font-weight', BOLD)
  await expect(page.getByTestId(`group-name-${G_PERSONAL}`)).not.toHaveCSS('font-weight', BOLD)

  // The restored kebab reads "Remove highlight" for a still-highlighted row.
  await openProjectMenu(P_ALPHA)
  await expect(page.getByTestId(`project-highlight-${P_ALPHA}`)).toHaveText(/Remove highlight/)
  await page.getByTestId('row-menu-scrim').click()
})
