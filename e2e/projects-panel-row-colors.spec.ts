// modules: projects, tabs
// Pomade T-190 e2e: colorable project/group/sub-group rows and the automatic interplay with the
// T-183 highlight and the active-project state. A kebab "Change color" submenu (6 hues + None)
// sets `color`; a colored row paints the SOFT tint, auto-flips to MEDIUM when highlighted, and —
// when the active project — keeps its fill and gains a 2px inset border 2 tones darker (soft→medium,
// medium→strong). An active row with NO color gets a near-white fill + a neutral-gray 2px ring
// (the old accent-blue fill is gone). The collapsed rail shows a full-bg chip + an active ring.
// `color` lives on the project/group object in workspace.json (identity-like, rides sync) and
// survives a restart; uncolored rows keep the T-183 bold-only look. State chains WITHIN this file.
//
// Fixture (mirrors projects-panel-highlight): two top-level groups (Work, Personal) + a sub-group (Sub
// under Work); Alpha in Work, Beta in Sub, Gamma ungrouped.

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

// Resolved token colors (tokens.css). soft = the tab tint; medium/strong = the T-190 ladder.
const SOFT_RED = 'rgb(251, 233, 236)' // --row-tint-red-soft (= --tab-tint-red #fbe9ec)
const MED_RED = 'rgb(242, 191, 201)' // --row-tint-red-medium #f2bfc9
const STRONG_RED = '234, 159, 174' // --row-tint-red-strong #ea9fae (box-shadow substring)
const SOFT_TEAL = 'rgb(224, 242, 243)' // --row-tint-teal-soft (= --tab-tint-teal #e0f2f3)
const SOFT_GREEN = 'rgb(228, 244, 234)' // --row-tint-green-soft (= --tab-tint-green #e4f4ea)
const ACCENT_SOFT = 'rgb(234, 246, 250)' // the OLD active fill (#eaf6fa) — must be gone now
const DANGER = 'rgb(209, 73, 91)' // --danger (#d1495b) — the attention badge fill
const TRANSPARENT = 'rgba(0, 0, 0, 0)'
const BOLD = '700'

const wsPath = (): string => join(fixture.workspaceRoot, '.pomade', 'workspace.json')

interface Snap {
  id: string
  color?: string
  highlighted?: boolean
}
const groupsOf = (p: Page): Promise<Snap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().groups as Snap[])
const projectsOf = (p: Page): Promise<Snap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().projects as Snap[])

async function colorOnDisk(kind: 'groups' | 'projects', id: string): Promise<string | undefined> {
  const raw = await fs.readFile(wsPath(), 'utf8')
  const cfg = JSON.parse(raw) as { groups: Snap[]; projects: Snap[] }
  return cfg[kind].find((x) => x.id === id)?.color
}

/** Computed box-shadow string for a testid (used to assert the inset active border/ring). */
function boxShadow(testId: string): Promise<string> {
  return page.getByTestId(testId).evaluate((el) => getComputedStyle(el).boxShadow)
}

async function openProjectMenu(id: string): Promise<void> {
  await hoverClick(page.getByTestId(`project-${id}`), page.getByTestId(`project-menu-${id}`))
  await expect(page.getByTestId('row-menu')).toBeVisible()
}
async function openGroupMenu(id: string): Promise<void> {
  await hoverClick(page.getByTestId(`group-header-${id}`), page.getByTestId(`group-menu-${id}`))
  await expect(page.getByTestId('row-menu')).toBeVisible()
}

/** Open a row kebab → the "Change color" submenu → pick a hue (or 'none'). */
async function pickProjectColor(id: string, hue: string): Promise<void> {
  await openProjectMenu(id)
  await page.getByTestId(`project-${id}-color`).click()
  await expect(page.getByTestId(`project-${id}-color-submenu`)).toBeVisible()
  await page.getByTestId(`project-${id}-color-${hue}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
}
async function pickGroupColor(id: string, hue: string): Promise<void> {
  await openGroupMenu(id)
  await page.getByTestId(`group-${id}-color`).click()
  await expect(page.getByTestId(`group-${id}-color-submenu`)).toBeVisible()
  await page.getByTestId(`group-${id}-color-${hue}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
}
async function toggleProjectHighlight(id: string): Promise<void> {
  await openProjectMenu(id)
  await page.getByTestId(`project-highlight-${id}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
}

/** Seed one unread doc tab directly via the tabs-store (mirrors group-attention-aggregate). */
async function openUnreadDoc(pid: string, path: string): Promise<void> {
  await page.evaluate(
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
    },
    { p: pid, rel: path }
  )
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

// ─── Baseline: no color; kebab offers "Change color" with None checked ─────────
test('no row starts colored; the kebab offers "Change color" (None checked)', async () => {
  await expect(page.getByTestId(`project-${P_ALPHA}`)).not.toHaveAttribute('data-color', /.*/)

  await openProjectMenu(P_ALPHA)
  await expect(page.getByTestId(`project-${P_ALPHA}-color`)).toBeVisible()
  await page.getByTestId(`project-${P_ALPHA}-color`).click()
  await expect(page.getByTestId(`project-${P_ALPHA}-color-submenu`)).toBeVisible()
  await expect(page.getByTestId(`project-${P_ALPHA}-color-none`)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId(`project-${P_ALPHA}-color-red`)).toHaveAttribute('aria-checked', 'false')
  await page.getByTestId('row-menu-scrim').click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
})

// ─── Color a project → SOFT fill, persisted ────────────────────────────────────
test('coloring a project red paints the soft tint and persists to workspace.json', async () => {
  await pickProjectColor(P_ALPHA, 'red')

  const item = page.getByTestId(`project-${P_ALPHA}`)
  await expect(item).toHaveAttribute('data-color', 'red')
  await expect(item).toHaveCSS('background-color', SOFT_RED)

  expect((await projectsOf(page)).find((p) => p.id === P_ALPHA)?.color).toBe('red')
  await expect.poll(() => colorOnDisk('projects', P_ALPHA)).toBe('red')
})

// ─── Highlight auto-flips soft ⇄ medium (no re-pick) ────────────────────────────
test('highlighting a colored row flips soft→medium (and bolds); unhighlight restores soft', async () => {
  const item = page.getByTestId(`project-${P_ALPHA}`)
  const name = page.getByTestId(`project-name-${P_ALPHA}`)

  await toggleProjectHighlight(P_ALPHA)
  await expect(item).toHaveCSS('background-color', MED_RED)
  await expect(name).toHaveCSS('font-weight', BOLD)

  await toggleProjectHighlight(P_ALPHA)
  await expect(item).toHaveCSS('background-color', SOFT_RED)
  await expect(name).not.toHaveCSS('font-weight', BOLD)
})

// ─── Active COLORED project → fill stays + 2-tone-darker inset border ───────────
test('activating a colored (soft) project keeps the fill and adds a medium 2px inset border', async () => {
  const item = page.getByTestId(`project-${P_ALPHA}`)
  await item.click()
  await expect(item).toHaveAttribute('data-active', 'true')

  // Fill unchanged (soft), border = the 2-tone-darker (medium) hue as an inset box-shadow.
  await expect(item).toHaveCSS('background-color', SOFT_RED)
  const shadow = await boxShadow(`project-${P_ALPHA}`)
  expect(shadow).toContain('inset')
  expect(shadow).toContain('242, 191, 201') // medium red
})

// ─── Active + highlighted + colored = medium fill + STRONG border + bold ───────
test('active + highlighted + colored = medium fill, strong inset border, bold name', async () => {
  const item = page.getByTestId(`project-${P_ALPHA}`)
  const name = page.getByTestId(`project-name-${P_ALPHA}`)
  await toggleProjectHighlight(P_ALPHA) // Alpha is still the active project

  await expect(item).toHaveCSS('background-color', MED_RED)
  await expect(name).toHaveCSS('font-weight', BOLD)
  const shadow = await boxShadow(`project-${P_ALPHA}`)
  expect(shadow).toContain('inset')
  expect(shadow).toContain(STRONG_RED) // border stepped to strong

  await toggleProjectHighlight(P_ALPHA) // back to soft + active for later tests
  await expect(item).toHaveCSS('background-color', SOFT_RED)
})

// ─── Active UNCOLORED project → near-white fill + neutral ring (no accent blue) ─
test('activating an uncolored project gives a neutral inset ring, not the old accent fill', async () => {
  const gamma = page.getByTestId(`project-${P_GAMMA}`)
  await gamma.click()
  await expect(gamma).toHaveAttribute('data-active', 'true')

  const shadow = await boxShadow(`project-${P_GAMMA}`)
  expect(shadow).toContain('inset') // the new neutral 2px ring
  await expect(gamma).not.toHaveCSS('background-color', ACCENT_SOFT) // accent-blue fill is gone

  // Alpha is now inactive: colored but border-free (the border is active-only).
  await expect(page.getByTestId(`project-${P_ALPHA}`)).toHaveAttribute('data-active', 'false')
  expect(await boxShadow(`project-${P_ALPHA}`)).toBe('none')
})

// ─── Uncolored rows keep the T-183 bold-only look (byte-identical) ──────────────
test('an uncolored row highlights bold-only — no tint, no data-color', async () => {
  const item = page.getByTestId(`project-${P_BETA}`)
  const name = page.getByTestId(`project-name-${P_BETA}`)
  await toggleProjectHighlight(P_BETA)
  await page.mouse.move(0, 0) // park the pointer off every row so :hover doesn't tint the read

  await expect(name).toHaveCSS('font-weight', BOLD)
  await expect(item).not.toHaveAttribute('data-color', /.*/)
  await expect(item).toHaveCSS('background-color', TRANSPARENT) // no fill added by highlight
})

// ─── Groups & sub-groups colorable ─────────────────────────────────────────────
test('coloring a group and a sub-group tints their headers and persists', async () => {
  await pickGroupColor(G_WORK, 'teal')
  await pickGroupColor(G_SUB, 'green')

  const work = page.getByTestId(`group-header-${G_WORK}`)
  const sub = page.getByTestId(`group-header-${G_SUB}`)
  await expect(work).toHaveAttribute('data-color', 'teal')
  await expect(work).toHaveCSS('background-color', SOFT_TEAL)
  await expect(sub).toHaveAttribute('data-color', 'green')
  await expect(sub).toHaveCSS('background-color', SOFT_GREEN)

  const g = await groupsOf(page)
  expect(g.find((x) => x.id === G_WORK)?.color).toBe('teal')
  expect(g.find((x) => x.id === G_SUB)?.color).toBe('green')
  await expect.poll(() => colorOnDisk('groups', G_WORK)).toBe('teal')
  await expect.poll(() => colorOnDisk('groups', G_SUB)).toBe('green')
})

// ─── The attention badge still renders on a colored row (the Owner: badge-INSIDE) ──
test('the red attention badge renders on a colored row and keeps its danger fill', async () => {
  await openUnreadDoc(P_ALPHA, 'README.md')
  const badge = page.getByTestId(`project-attention-${P_ALPHA}`)
  await expect(badge).toBeVisible()
  await expect(badge).toHaveText('1')
  // The badge sits INSIDE the colored (soft-red) row fill and keeps its own --danger background,
  // so the red still pops on the tint (flagged for the Owner's live test).
  await expect(badge).toHaveCSS('background-color', DANGER)
  await expect(page.getByTestId(`project-${P_ALPHA}`)).toHaveCSS('background-color', SOFT_RED)
})

// ─── Collapsed rail: colored chip + active ring ────────────────────────────────
test('the collapsed rail shows a colored chip on a launcher/marker and an active ring', async () => {
  // Make Alpha (colored red, soft) the active project, then collapse to the rail.
  await page.getByTestId(`project-${P_ALPHA}`).click()
  await expect(page.getByTestId(`project-${P_ALPHA}`)).toHaveAttribute('data-active', 'true')
  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId('projects-panel-rail')).toBeVisible()

  const railAlpha = page.getByTestId(`rail-project-${P_ALPHA}`)
  await expect(railAlpha).toHaveAttribute('data-color', 'red')
  await expect(railAlpha).toHaveAttribute('data-active', 'true')
  await expect(railAlpha).toHaveCSS('background-color', SOFT_RED) // full-bg chip
  const railShadow = await boxShadow(`rail-project-${P_ALPHA}`)
  expect(railShadow).toContain('inset') // active ring
  expect(railShadow).toContain('242, 191, 201') // medium red ring (2 tones darker)

  // The colored group marker gets the chip too.
  const railWork = page.getByTestId(`rail-group-${G_WORK}`)
  await expect(railWork).toHaveAttribute('data-color', 'teal')
  await expect(railWork).toHaveCSS('background-color', SOFT_TEAL)

  // Expand back so the restart test boots into the expanded Projects panel.
  await page.getByTestId('projects-panel-expand').click()
  await expect(page.getByTestId(`group-header-${G_WORK}`)).toBeVisible()
})

// ─── Persistence across a restart ──────────────────────────────────────────────
test('row colors survive an app relaunch', async () => {
  // Going in: Alpha=red, Work=teal, Sub=green persisted; Beta/Gamma/Personal uncolored.
  await app.close()
  await boot()

  await expect(page.getByTestId(`project-${P_ALPHA}`)).toHaveAttribute('data-color', 'red')
  await expect(page.getByTestId(`project-${P_ALPHA}`)).toHaveCSS('background-color', SOFT_RED)
  await expect(page.getByTestId(`group-header-${G_WORK}`)).toHaveAttribute('data-color', 'teal')
  await expect(page.getByTestId(`group-header-${G_SUB}`)).toHaveAttribute('data-color', 'green')

  await expect(page.getByTestId(`project-${P_GAMMA}`)).not.toHaveAttribute('data-color', /.*/)
})

// ─── T-196 round-1: hover/active kebab-slab interplay, group highlight color, header seam ──────

// ─── Defect 1: hover must win the kebab/counter fade slab on an active UNCOLORED row ───────────
test('hovering an active uncolored row flips the kebab slab overlay to the hover tone', async () => {
  const gamma = page.getByTestId(`project-${P_GAMMA}`)
  await gamma.click()
  await expect(gamma).toHaveAttribute('data-active', 'true')
  await page.mouse.move(0, 0) // park off every row first

  const rowActions = page.getByTestId(`project-menu-${P_GAMMA}`).locator('..')
  const overlayImage = (): Promise<string> =>
    rowActions.evaluate((el) => getComputedStyle(el).backgroundImage)

  // At rest (active, not hovered): the slab overlay is the near-white active fill.
  await expect.poll(overlayImage).toContain('251, 252, 253') // --row-active-bg #fbfcfd

  await gamma.hover()
  // Hovered: the slab overlay must flip to --hover-bg, not stay stuck on the active near-white
  // (the bug: .projectRow:has(...) out-specified the plain hover rule regardless of source order).
  await expect.poll(overlayImage).toContain('0.04') // --hover-bg rgba(31, 41, 51, 0.04)
  expect(await overlayImage()).not.toContain('251, 252, 253')

  await page.mouse.move(0, 0)
})

// ─── Defect 2: a highlighted GROUP name also turns full text color, not just bold ──────────────
test('highlighting a group turns its name from muted to full text color', async () => {
  const name = page.getByTestId(`group-name-${G_PERSONAL}`) // untouched: uncolored, unhighlighted
  await expect(name).toHaveCSS('color', 'rgb(90, 107, 122)') // --text-muted baseline
  await expect(name).toHaveCSS('font-weight', '600') // --fw-semibold baseline (uncolored, unhighlighted)

  await openGroupMenu(G_PERSONAL)
  await page.getByTestId(`group-highlight-${G_PERSONAL}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)

  await expect(name).toHaveCSS('color', 'rgb(31, 41, 51)') // --text — must go full color, not muted
  await expect(name).toHaveCSS('font-weight', BOLD)

  // Revert so Personal stays untouched for anything else.
  await openGroupMenu(G_PERSONAL)
  await page.getByTestId(`group-highlight-${G_PERSONAL}`).click()
  await expect(page.getByTestId('row-menu')).toHaveCount(0)
  await expect(name).toHaveCSS('color', 'rgb(90, 107, 122)')
})

// ─── Defect 3: a 2px seam sits between a header and its first child ────────────────────────────
test('a group header keeps a 2px seam above its first child, collapsing to 0 when collapsed', async () => {
  const header = page.getByTestId(`group-header-${G_WORK}`)
  await expect(header).toHaveCSS('margin-bottom', '2px') // Work is expanded, lists Alpha first

  await page.getByTestId(`group-collapse-${G_WORK}`).click()
  await expect(page.getByTestId(`group-list-${G_WORK}`)).toHaveCount(0)
  await expect(header).toHaveCSS('margin-bottom', '0px') // no first child left — no seam to add

  await page.getByTestId(`group-collapse-${G_WORK}`).click() // restore expanded
  await expect(page.getByTestId(`group-list-${G_WORK}`)).toBeVisible()
  await expect(header).toHaveCSS('margin-bottom', '2px')

  // The Ungrouped header shares the same rule (Gamma is its one member).
  await expect(page.getByTestId('ungrouped-header')).toHaveCSS('margin-bottom', '2px')
})
