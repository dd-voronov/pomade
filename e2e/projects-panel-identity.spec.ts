// modules: projects
// Pomade E-010 e2e — Projects panel identity & organization: group/project icons (emoji + image,
// T-035) and drag-and-drop reorder / move (T-003). Runs against the FIXTURE workspace
// (projects alpha + beta, initially ungrouped). An EXTERNAL image + POMADE_PICK_PATH drive
// the image-icon path. State is persisted to workspace.json; several tests RELAUNCH the app
// to prove persistence. Specs chain state WITHIN this file — append only.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, relaunchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'
import { tempDir } from './fixtures/temp'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)

let fixture: Fixture
let app: ElectronApplication
let page: Page
let externalDir: string
let externalImage: string

const ALPHA = 'proj-alpha'
const BETA = 'proj-beta'

interface GroupSnap {
  id: string
  name: string
  icon?: string
  image?: string
  order: number
  parentId?: string
}
interface ProjectSnap {
  id: string
  name: string
  groupId?: string
  icon?: string
  image?: string
  order: number
}

const groupsOf = (p: Page): Promise<GroupSnap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().groups as GroupSnap[])
const projectsOf = (p: Page): Promise<ProjectSnap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().projects as ProjectSnap[])

async function relaunch(): Promise<void> {
  ;({ app, page } = await relaunchApp(app, fixture, { POMADE_PICK_PATH: externalImage }))
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

// Shared-DataTransfer HTML5 DnD driver (Playwright mouse gestures don't trigger native DnD).
// `frac` picks the vertical position within the target (0 = top → 'before', 1 = bottom).
async function dragOnto(sourceTestId: string, targetTestId: string, frac = 0.5): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const source = page.getByTestId(sourceTestId)
  const target = page.getByTestId(targetTestId)
  const box = await target.boundingBox()
  if (!box) throw new Error(`target ${targetTestId} has no box`)
  const clientX = Math.round(box.x + box.width / 2)
  const clientY = Math.round(box.y + box.height * frac)
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt, clientX, clientY })
  await target.dispatchEvent('drop', { dataTransfer: dt, clientX, clientY })
  await source.dispatchEvent('dragend', { dataTransfer: dt })
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  externalDir = await tempDir('pomade-ext-')
  externalImage = join(externalDir, 'icon.png')
  await fs.writeFile(externalImage, PNG_1PX)

  app = await launchApp(fixture, { POMADE_PICK_PATH: externalImage })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  await fs.rm(externalDir, { recursive: true, force: true })
})

// ─── T-035: emoji icons ────────────────────────────────────────────────────────
test('a group created with an emoji icon renders it and survives restart', async () => {
  await page.getByTestId('new-group').click()
  await page.getByTestId('group-name').fill('Team')
  await page.getByTestId('group-mode-emoji').click() // E-017 — three-mode window: switch to Emoji
  await page.getByTestId('group-emoji-search').fill('rocket')
  await page.getByTestId('group-emoji-🚀').click()
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-modal')).toHaveCount(0)

  const group = (await groupsOf(page)).find((g) => g.name === 'Team')!
  expect(group.icon).toBe('🚀')
  await expect(page.getByTestId(`group-icon-${group.id}`)).toHaveText('🚀')

  await relaunch()
  const after = (await groupsOf(page)).find((g) => g.name === 'Team')!
  expect(after.icon).toBe('🚀')
  await expect(page.getByTestId(`group-icon-${after.id}`)).toHaveText('🚀')
})

test('a project emoji icon renders at the small size and survives restart', async () => {
  // T-060 — edit now lives behind the row's kebab (⋮) menu.
  await hoverClick(page.getByTestId(`project-${ALPHA}`), page.getByTestId(`project-menu-${ALPHA}`))
  await page.getByTestId(`project-edit-${ALPHA}`).click()
  await page.getByTestId('project-mode-emoji').click() // E-017 — switch to Emoji mode
  await page.getByTestId('project-emoji-search').fill('fire')
  await page.getByTestId('project-emoji-🔥').click()
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  const icon = page.getByTestId(`project-${ALPHA}`).locator('[data-icon="emoji"]')
  await expect(icon).toHaveText('🔥')

  await relaunch()
  await expect(page.getByTestId(`project-${ALPHA}`).locator('[data-icon="emoji"]')).toHaveText('🔥')
})

// ─── T-035: image icon (reuses T-033 external copy-in) ─────────────────────────
test('a project image icon is copied in, renders, and survives restart', async () => {
  // T-060 — edit now lives behind the row's kebab (⋮) menu.
  await hoverClick(page.getByTestId(`project-${BETA}`), page.getByTestId(`project-menu-${BETA}`))
  await page.getByTestId(`project-edit-${BETA}`).click()
  await page.getByTestId('project-mode-image').click() // E-017 — switch to Image mode
  // Upload an external image via the icon picker → fs.pickImage copies into .pomade/assets.
  await page.getByTestId('project-image-browse').click()
  await expect(page.getByTestId('project-image')).toHaveValue(/^\.pomade\/assets\/[0-9a-f]+\.png$/)
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  await expect(page.getByTestId(`project-${BETA}`).locator('img[data-icon="image"]')).toBeVisible()
  const beta = (await projectsOf(page)).find((p) => p.id === BETA)!
  expect(beta.image).toMatch(/^\.pomade\/assets\//)

  await relaunch()
  await expect(page.getByTestId(`project-${BETA}`).locator('img[data-icon="image"]')).toBeVisible()
})

// ─── T-003: drag a project into a group; persists across restart ───────────────
test('dragging project alpha into group Team moves it and persists after restart', async () => {
  const team = (await groupsOf(page)).find((g) => g.name === 'Team')!
  await dragOnto(`project-${ALPHA}`, `group-header-${team.id}`)

  await expect
    .poll(async () => (await projectsOf(page)).find((p) => p.id === ALPHA)?.groupId)
    .toBe(team.id)
  // The row now lives inside the group's subtree in the DOM.
  await expect(page.getByTestId(`group-${team.id}`).getByTestId(`project-${ALPHA}`)).toBeVisible()

  await relaunch()
  const team2 = (await groupsOf(page)).find((g) => g.name === 'Team')!
  expect((await projectsOf(page)).find((p) => p.id === ALPHA)?.groupId).toBe(team2.id)
})

// ─── T-003: group reorder persists ─────────────────────────────────────────────
test('dragging a group past another reorders them, persisting after restart', async () => {
  // Add a second group so there is something to reorder against.
  await page.getByTestId('new-group').click()
  await page.getByTestId('group-name').fill('Later')
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-modal')).toHaveCount(0)

  const before = (await groupsOf(page)).sort((a, b) => a.order - b.order).map((g) => g.name)
  expect(before).toEqual(['Team', 'Later'])

  const team = (await groupsOf(page)).find((g) => g.name === 'Team')!
  const later = (await groupsOf(page)).find((g) => g.name === 'Later')!
  // T-073: a header's BOTTOM band now NESTS (see the band map in reorder.ts), so the sibling
  // reorder is expressed on the TOP band — Later dropped above Team → [Later, Team].
  await dragOnto(`group-header-${later.id}`, `group-header-${team.id}`, 0.05)

  await expect
    .poll(async () => (await groupsOf(page)).sort((a, b) => a.order - b.order).map((g) => g.name))
    .toEqual(['Later', 'Team'])

  await relaunch()
  const order = (await groupsOf(page)).sort((a, b) => a.order - b.order).map((g) => g.name)
  expect(order).toEqual(['Later', 'Team'])
})

// ─── T-003: move a project out to Ungrouped ────────────────────────────────────
test('dragging a grouped project onto the Ungrouped tier removes its group', async () => {
  // alpha is currently in Team (from an earlier test).
  expect((await projectsOf(page)).find((p) => p.id === ALPHA)?.groupId).toBeTruthy()
  await dragOnto(`project-${ALPHA}`, 'ungrouped-section')

  await expect
    .poll(async () => (await projectsOf(page)).find((p) => p.id === ALPHA)?.groupId)
    .toBeUndefined()

  await relaunch()
  expect((await projectsOf(page)).find((p) => p.id === ALPHA)?.groupId).toBeUndefined()
})

// ─── T-073: the header's BOTTOM band NESTS; "after the group" is the next section's gap ─────
// Round-3's whole-section group-drop target was superseded by E-015's center-vs-edge model, and
// T-073 fixes that model's misleading half: the band directly BELOW a header is visually where
// the group's children start, so it now nests as the FIRST child instead of meaning "after".
// Sibling placement after a group is expressed by the GAP strip preceding the next section.
// Groups here are [Later, Team]; Ungrouped sits last, so its gap = "after Team".
test('the band below a group header nests as first child; the next section’s gap places after', async () => {
  // Give Team a member (unrelated to the reorder, kept from the round-3 scenario).
  const teamId = (await groupsOf(page)).find((g) => g.name === 'Team')!.id
  await dragOnto(`project-${BETA}`, `group-header-${teamId}`)
  await expect
    .poll(async () => (await projectsOf(page)).find((p) => p.id === BETA)?.groupId)
    .toBe(teamId)

  // Drop Later on Team's header BOTTOM band → Later NESTS into Team (it does not land after it).
  const laterId = (await groupsOf(page)).find((g) => g.name === 'Later')!.id
  await dragOnto(`group-header-${laterId}`, `group-header-${teamId}`, 0.95)
  await expect
    .poll(async () => (await groupsOf(page)).find((g) => g.id === laterId)?.parentId)
    .toBe(teamId)

  // Drag Later out onto the gap preceding the Ungrouped section → back to top level, after Team.
  await dragOnto(`group-header-${laterId}`, 'ungrouped-gap')
  await expect
    .poll(async () => (await groupsOf(page)).find((g) => g.id === laterId)?.parentId)
    .toBeUndefined()
  expect((await groupsOf(page)).sort((a, b) => a.order - b.order).map((g) => g.name)).toEqual([
    'Team',
    'Later'
  ])
})

// ─── E-010 round-3: below-all drop zone (a group dropped beneath everything lands last) ─────
test('dragging a group onto the below-all region moves it to the end, persisting', async () => {
  // Order is [Team, Later]. Drag Team onto the region below the last group → Team lands last.
  const teamId = (await groupsOf(page)).find((g) => g.name === 'Team')!.id
  await dragOnto(`group-header-${teamId}`, 'projects-panel-below-all')

  await expect
    .poll(async () => (await groupsOf(page)).sort((a, b) => a.order - b.order).map((g) => g.name))
    .toEqual(['Later', 'Team'])

  await relaunch()
  const order = (await groupsOf(page)).sort((a, b) => a.order - b.order).map((g) => g.name)
  expect(order).toEqual(['Later', 'Team'])
})

// ─── E-010 round-3: workspace identity icon (row + rail, editable, persists) ─────────────────
const WORKSPACE = '__workspace__'
const identityOf = (p: Page): Promise<{ icon?: string; image?: string } | undefined> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().identity)

test('setting a workspace identity emoji renders it in the row + rail and survives restart', async () => {
  // Default (unset) shows the 💠 apex glyph.
  await expect(page.getByTestId('workspace-icon')).toHaveText('💠')

  // Right-click the Workspace row → Change icon… → pick 👑.
  await page.getByTestId(`project-${WORKSPACE}`).click({ button: 'right' })
  await page.getByTestId('workspace-change-icon').click()
  await page.getByTestId('workspace-mode-emoji').click() // E-017 — switch to Emoji mode
  await page.getByTestId('workspace-emoji-search').fill('crown')
  await page.getByTestId('workspace-emoji-👑').click()
  await page.getByTestId('workspace-icon-save').click()
  await expect(page.getByTestId('workspace-icon-modal')).toHaveCount(0)

  expect((await identityOf(page))?.icon).toBe('👑')
  await expect(page.getByTestId('workspace-icon')).toHaveText('👑')

  // Collapsed rail renders the same identity on the (larger) workspace launcher.
  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId(`rail-project-${WORKSPACE}`)).toContainText('👑')
  await page.getByTestId('projects-panel-expand').click()

  await relaunch()
  expect((await identityOf(page))?.icon).toBe('👑')
  await expect(page.getByTestId('workspace-icon')).toHaveText('👑')
})

// ─── E-010 round-4: collapsed rail mirrors expanded group structure + order ───────────────────
// State here (chained): groups [Later (empty), Team (holds beta)], alpha is Ungrouped. So the rail
// exercises a grouped + ungrouped MIX: workspace launcher, group markers in group order, group
// members, then the ungrouped launcher — with thin separators between sections.
test('the collapsed rail mirrors the expanded order and a group marker click expands the Projects panel', async () => {
  const groups = (await groupsOf(page)).sort((a, b) => a.order - b.order)
  const projects = await projectsOf(page)
  const membersOf = (gid: string): string[] =>
    projects.filter((p) => p.groupId === gid).sort((a, b) => a.order - b.order).map((p) => p.id)
  const ungrouped = projects.filter((p) => !p.groupId).sort((a, b) => a.order - b.order).map((p) => p.id)
  // E-015 — Ungrouped now participates in TOP-LEVEL ordering, so it can sit BETWEEN groups.
  // Build the expected launcher order from the real top-level sequence (groups by order,
  // interleaved with the Ungrouped pseudo-group at its stored `ungroupedOrder`).
  const ungroupedOrder = await page.evaluate(
    () => window.__pomadeStores.useWorkspaceStore.getState().ungroupedOrder as number | undefined
  )
  const UNG = '__ungrouped__'
  const topSeq = [
    ...groups.map((g) => ({ id: g.id, order: g.order })),
    { id: UNG, order: ungroupedOrder ?? Number.MAX_SAFE_INTEGER }
  ]
    .sort((a, b) => a.order - b.order || (a.id === UNG ? 1 : -1))
    .map((t) => t.id)
  const expectedLaunchers = [
    WORKSPACE,
    ...topSeq.flatMap((id) => (id === UNG ? ungrouped : membersOf(id)))
  ]
  // Sanity: this fixture really is a grouped + ungrouped mix.
  expect(groups.length).toBeGreaterThan(0)
  expect(ungrouped.length).toBeGreaterThan(0)

  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId('projects-panel-rail')).toBeVisible()

  // Launchers appear in EXACTLY the expanded order (workspace → group members → ungrouped).
  const launchers = await page
    .locator('[data-testid^="rail-project-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('rail-project-', '')))
  expect(launchers).toEqual(expectedLaunchers)

  // Group markers appear in group order — T-074: only for groups that actually hold projects
  // (an EMPTY group contributes nothing to the rail, marker and separator alike).
  const withProjects = groups.filter((g) => membersOf(g.id).length > 0)
  const empty = groups.filter((g) => membersOf(g.id).length === 0)
  expect(withProjects.length).toBeGreaterThan(0)
  expect(empty.length).toBeGreaterThan(0) // this fixture really has an empty group ("Later")
  const markers = await page
    .locator('[data-testid^="rail-group-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('rail-group-', '')))
  expect(markers).toEqual(withProjects.map((g) => g.id))
  for (const g of empty) {
    await expect(page.getByTestId(`rail-group-${g.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`rail-separator-${g.id}`)).toHaveCount(0)
  }

  // Separators divide the sections.
  await expect(page.locator('[data-testid^="rail-separator-"]').first()).toBeVisible()

  // A group marker is a HEADER, not a launcher: clicking it EXPANDS the Projects panel.
  await page.getByTestId(`rail-group-${withProjects[0].id}`).click()
  await expect(page.getByTestId('projects-panel-rail')).toHaveCount(0)
  await expect(page.getByTestId('project-__workspace__')).toBeVisible()
})

// ─── E-010 round-4: workspace icon LEFT-click opens the change-icon modal ──────────────────────
test('left-clicking the workspace icon opens the change-icon modal', async () => {
  await expect(page.getByTestId('workspace-icon-modal')).toHaveCount(0)
  await page.getByTestId('workspace-icon-button').click()
  await expect(page.getByTestId('workspace-icon-modal')).toBeVisible()
  // Close without changes; the identity stays 👑.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('workspace-icon-modal')).toHaveCount(0)
  expect((await identityOf(page))?.icon).toBe('👑')
})
