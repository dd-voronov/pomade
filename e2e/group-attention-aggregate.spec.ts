// modules: projects, tabs
// Pomade T-186 e2e — a COLLAPSED Projects panel group's header badge is the SUM of the T-151 per-project
// unread-tab count across every project in its subtree (sub-groups included, recursive). An
// EXPANDED group shows no badge (its members' own badges are visible instead). Terminal-free:
// unread state is created entirely via doc tabs opened directly through the tabs-store (the same
// store-level mechanic the "Mark unread" context action itself uses), so this spec runs in the
// FAST light partition — no zsh/pty involved anywhere.
//
// Fixture: group G (top-level) holds projects A and B directly, plus a sub-group S holding
// project C. Drives the real Electron app through the __pomadeStores hook, the established
// pattern (see e2e/attention-derived-counter.spec.ts).

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

const G = 'grp-g'
const S = 'grp-s'
const PROJ_A = 'proj-a'
const PROJ_B = 'proj-b'
const PROJ_C = 'proj-c'

// One doc tab per file, created directly via the tabs-store (no file-tree click, no terminal) and
// immediately marked unread — the same store-level write the "Mark unread" context action makes.
async function openUnreadDoc(page: Page, pid: string, path: string): Promise<string> {
  return page.evaluate(
    ({ p, rel }) => {
      const stores = window.__pomadeStores
      const id = `${p}-${rel}`.replace(/[/.]/g, '-')
      stores.useTabsStore.getState().openTab({
        id,
        projectId: p,
        kind: 'doc',
        title: rel.split('/').pop(),
        path: rel,
        mode: 'raw',
        dirty: false
      })
      stores.useTabsStore.getState().updateTab(p, id, { attention: true })
      return id
    },
    { p: pid, rel: path }
  )
}

function attentionBadge(page: Page, testId: string): Promise<string | null> {
  return page
    .getByTestId(testId)
    .textContent()
    .catch(() => null)
}

test.describe('T-186 — collapsed group unread-tab aggregate badge', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()

    // A third project folder for C (A/B reuse the fixture's alpha/beta folders — each already
    // ships two real files, enough to mark more than one tab unread).
    await fs.mkdir(join(fixture.workspaceRoot, 'Projects/cee'), { recursive: true })
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/cee/c1.txt'), 'cee one\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/cee/c2.txt'), 'cee two\n')

    // G (top-level) holds A + B directly; S (nested under G) holds C.
    const workspaceConfig = {
      groups: [
        { id: G, name: 'G', order: 0 },
        { id: S, name: 'S', parentId: G, order: 0 }
      ],
      projects: [
        { id: PROJ_A, name: 'A', rootPath: 'Projects/alpha', groupId: G, visibleAgents: ['*'], order: 0 },
        { id: PROJ_B, name: 'B', rootPath: 'Projects/beta', groupId: G, visibleAgents: ['*'], order: 1 },
        { id: PROJ_C, name: 'C', rootPath: 'Projects/cee', groupId: S, visibleAgents: ['*'], order: 0 }
      ]
    }
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade/workspace.json'),
      JSON.stringify(workspaceConfig, null, 2)
    )

    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    // S starts nested-collapsed by default persistence; make the starting shape explicit —
    // both G and S expanded, so the fixture's initial render shows every row.
    await page.evaluate(
      ({ g, s }) => {
        const store = window.__pomadeStores.useWorkspaceUiStore.getState()
        if (store.isCollapsed(g)) store.toggleGroupCollapsed(g)
        if (store.isCollapsed(s)) store.toggleGroupCollapsed(s)
      },
      { g: G, s: S }
    )
    await expect(page.getByTestId(`group-header-${G}`)).toBeVisible()
    await expect(page.getByTestId(`group-header-${S}`)).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('collapsing G with A(1) + B(2) unread shows the Projects panel 3', async () => {
    await openUnreadDoc(page, PROJ_A, 'Projects/alpha/README.md')
    await openUnreadDoc(page, PROJ_B, 'Projects/beta/README.md')
    await openUnreadDoc(page, PROJ_B, 'Projects/beta/data.csv')
    await expect(page.getByTestId(`project-attention-${PROJ_A}`)).toHaveText('1')
    await expect(page.getByTestId(`project-attention-${PROJ_B}`)).toHaveText('2')

    // No aggregate badge while G is expanded.
    await expect(page.getByTestId(`group-attention-${G}`)).toHaveCount(0)

    await page.getByTestId(`group-header-${G}`).click()
    await expect(page.getByTestId(`group-collapse-${G}`)).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByTestId(`group-attention-${G}`)).toHaveText('3')
    // Collapsing hides the per-project rows (and their own badges) entirely.
    await expect(page.getByTestId(`project-${PROJ_A}`)).toHaveCount(0)
  })

  test('a new unread tab in A live-updates the collapsed G badge to 4', async () => {
    await openUnreadDoc(page, PROJ_A, 'Projects/alpha/notes.txt')
    await expect.poll(() => attentionBadge(page, `group-attention-${G}`)).toBe('4')
  })

  test('expanding G removes its badge and shows per-project badges again', async () => {
    await page.getByTestId(`group-header-${G}`).click()
    await expect(page.getByTestId(`group-attention-${G}`)).toHaveCount(0)
    await expect(page.getByTestId(`project-attention-${PROJ_A}`)).toHaveText('2')
    await expect(page.getByTestId(`project-attention-${PROJ_B}`)).toHaveText('2')
  })

  test('nested: collapsed sub-group S shows its own subtree sum while G (expanded) shows none; collapsing G too sums everything under it', async () => {
    await openUnreadDoc(page, PROJ_C, 'Projects/cee/c1.txt')
    await openUnreadDoc(page, PROJ_C, 'Projects/cee/c2.txt')
    await expect(page.getByTestId(`project-attention-${PROJ_C}`)).toHaveText('2')

    // Collapse S alone: S shows its subtree sum (2), G (still expanded) shows none.
    await page.getByTestId(`group-header-${S}`).click()
    await expect(page.getByTestId(`group-attention-${S}`)).toHaveText('2')
    await expect(page.getByTestId(`group-attention-${G}`)).toHaveCount(0)
    await expect(page.getByTestId(`project-${PROJ_C}`)).toHaveCount(0)

    // Collapse G too: G's badge is its direct sum (A=2 + B=2) plus S's subtree sum (2) = 6.
    await page.getByTestId(`group-header-${G}`).click()
    await expect(page.getByTestId(`group-attention-${G}`)).toHaveText('6')
    // S's own badge is gone from view (G's collapse hides the whole subtree, S included).
    await expect(page.getByTestId(`group-attention-${S}`)).toHaveCount(0)
  })
})
