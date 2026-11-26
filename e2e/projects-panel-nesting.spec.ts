// modules: projects
// Pomade E-015 e2e: nested groups (tree in workspace.json, max depth 4), the center-vs-edge
// drag-and-drop rework, the draggable-but-never-nestable Ungrouped pseudo-group, per-depth
// icon TIER sizing (40/32/24/16px), the flattened collapsed rail, and a flat-drag reliability
// regression (round-4 flakiness must be gone). This spec SEEDS an OLD flat workspace.json (no
// parentId anywhere) to prove migration keeps every group/project and then persists a tree.
// State chains WITHIN this file — append only, never insert mid-file.

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

let fixture: Fixture
let app: ElectronApplication
let page: Page

// Seeded flat (pre-E-015) ids.
/** The Ungrouped pseudo-group's sentinel id in the top-level ordering (see reorder.ts). */
const UNG = '__ungrouped__'
const G_ONE = 'seed-one'
const G_TWO = 'seed-two'
const P_A = 'seed-alpha'
const P_B = 'seed-beta'

interface GroupSnap {
  id: string
  name: string
  parentId?: string
  order: number
}
interface ProjectSnap {
  id: string
  name: string
  groupId?: string
  order: number
}

const groupsOf = (p: Page): Promise<GroupSnap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().groups as GroupSnap[])
const projectsOf = (p: Page): Promise<ProjectSnap[]> =>
  p.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().projects as ProjectSnap[])
const ungroupedOrderOf = (p: Page): Promise<number | undefined> =>
  p.evaluate(
    () => window.__pomadeStores.useWorkspaceStore.getState().ungroupedOrder as number | undefined
  )

/** 1-based depth of a group id in the flat tree (walks parentId). */
function depthOf(groups: GroupSnap[], id: string): number {
  const byId = new Map(groups.map((g) => [g.id, g]))
  let cur = byId.get(id)
  let d = 0
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    d++
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return d || 1
}
const byName = (groups: GroupSnap[], name: string): GroupSnap => groups.find((g) => g.name === name)!

/** The drag handle and the gap test ids of a top-level section (a group or the Ungrouped pseudo-group). */
const headerOf = (id: string): string => (id === UNG ? 'ungrouped-header' : `group-header-${id}`)
const gapOf = (id: string): string => (id === UNG ? 'ungrouped-gap' : `group-gap-${id}`)

// Shared-DataTransfer HTML5 DnD driver (Playwright mouse gestures don't fire native DnD).
// `frac` picks the pointer's vertical position within the target: ~0.05 = top edge (before),
// 0.5 = center (INTO a group), ~0.95 = bottom edge (after). Mirrors the projects-panel-identity driver.
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

async function createGroup(name: string): Promise<void> {
  await page.getByTestId('new-group').click()
  await page.getByTestId('group-name').fill(name)
  await page.getByTestId('group-save').click()
  await expect(page.getByTestId('group-modal')).toHaveCount(0)
}

async function iconWidth(id: string): Promise<number> {
  const box = await page.getByTestId(`group-icon-${id}`).boundingBox()
  if (!box) throw new Error(`no icon box for ${id}`)
  return Math.round(box.width)
}

async function relaunch(): Promise<void> {
  ;({ app, page } = await relaunchApp(app, fixture))
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // Overwrite the fixture's workspace.json with an OLD FLAT shape: two groups with NO
  // parentId, a grouped project + an ungrouped project, and no fileTree/identity/ungroupedOrder
  // fields at all (exactly what a pre-E-015 config looks like on disk).
  const flat = {
    groups: [
      { id: G_ONE, name: 'One', order: 0 },
      { id: G_TWO, name: 'Two', order: 1 }
    ],
    projects: [
      { id: P_A, name: 'Aay', groupId: G_ONE, rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 },
      { id: P_B, name: 'Bee', rootPath: 'Projects/beta', visibleAgents: ['*'], order: 0 }
    ]
  }
  await fs.writeFile(
    join(fixture.workspaceRoot, '.pomade/workspace.json'),
    JSON.stringify(flat, null, 2),
    'utf8'
  )

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

// ─── Migration: an old flat config loads as a tree, losing nothing ─────────────
test('a flat pre-E-015 workspace.json migrates: every group/project loads as top-level', async () => {
  const groups = await groupsOf(page)
  const projects = await projectsOf(page)
  expect(groups.map((g) => g.id).sort()).toEqual([G_ONE, G_TWO].sort())
  // Both seeded groups load as TOP-LEVEL (depth 1) — no parentId invented, none lost.
  expect(groups.find((g) => g.id === G_ONE)?.parentId).toBeUndefined()
  expect(groups.find((g) => g.id === G_TWO)?.parentId).toBeUndefined()
  // Every project survives with its group membership intact.
  expect(projects.find((p) => p.id === P_A)?.groupId).toBe(G_ONE)
  expect(projects.find((p) => p.id === P_B)?.groupId).toBeUndefined()
  await expect(page.getByTestId(`group-header-${G_ONE}`)).toBeVisible()
  await expect(page.getByTestId(`group-header-${G_TWO}`)).toBeVisible()
})

// ─── Persistence: nesting writes a tree to disk and survives restart ───────────
test('nesting a group (center drop) persists parentId to workspace.json and survives restart', async () => {
  // Drop group Two onto the CENTER of group One's header → Two nests under One.
  await dragOnto(`group-header-${G_TWO}`, `group-header-${G_ONE}`, 0.5)
  await expect.poll(async () => (await groupsOf(page)).find((g) => g.id === G_TWO)?.parentId).toBe(G_ONE)

  // The tree shape reached disk (parentId written via the normal save).
  await expect
    .poll(async () => {
      const raw = await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8')
      return (JSON.parse(raw) as { groups: GroupSnap[] }).groups.find((g) => g.id === G_TWO)?.parentId
    })
    .toBe(G_ONE)

  await relaunch()
  expect((await groupsOf(page)).find((g) => g.id === G_TWO)?.parentId).toBe(G_ONE)
})

// ─── DnD semantics: center = INTO (nest), edge = BETWEEN (sibling) ──────────────
test('dropping on a header CENTER nests; dropping on an EDGE keeps it a sibling', async () => {
  await createGroup('Cee')
  await createGroup('Dee')
  const cee = byName(await groupsOf(page), 'Cee').id
  const dee = byName(await groupsOf(page), 'Dee').id

  // CENTER: Dee → into Cee (nested child).
  await dragOnto(`group-header-${dee}`, `group-header-${cee}`, 0.5)
  await expect.poll(async () => (await groupsOf(page)).find((g) => g.id === dee)?.parentId).toBe(cee)

  // EDGE: a fresh top-level Eff dropped on Cee's TOP edge stays a top-level SIBLING (not nested).
  await createGroup('Eff')
  const eff = byName(await groupsOf(page), 'Eff').id
  await dragOnto(`group-header-${eff}`, `group-header-${cee}`, 0.05)
  const groups = await groupsOf(page)
  expect(groups.find((g) => g.id === eff)?.parentId).toBeUndefined() // still top-level
  // ...and it now sorts BEFORE Cee among the top-level groups.
  expect(groups.find((g) => g.id === eff)!.order).toBeLessThan(groups.find((g) => g.id === cee)!.order)
})

// ─── Depth cap: a 5th level is refused (max depth 4) ───────────────────────────
test('the tree caps at depth 4: a 5th level nest is refused and "New sub-group" hides at depth 4', async () => {
  // Build One(1) > Two(2) > Ell3(3) > Ell4(4) using the existing One>Two chain.
  await createGroup('Ell3')
  await createGroup('Ell4')
  await createGroup('Ell5')
  const g = await groupsOf(page)
  const ell3 = byName(g, 'Ell3').id
  const ell4 = byName(g, 'Ell4').id
  const ell5 = byName(g, 'Ell5').id

  await dragOnto(`group-header-${ell3}`, `group-header-${G_TWO}`, 0.5) // Ell3 under Two → depth 3
  await expect.poll(async () => depthOf(await groupsOf(page), ell3)).toBe(3)
  await dragOnto(`group-header-${ell4}`, `group-header-${ell3}`, 0.5) // Ell4 under Ell3 → depth 4
  await expect.poll(async () => depthOf(await groupsOf(page), ell4)).toBe(4)

  // Attempt to nest Ell5 INTO the depth-4 Ell4 (center). It must be REFUSED — the center gesture
  // degrades to a sibling drop, so Ell5 lands at depth 4 (sibling of Ell4), never depth 5.
  await dragOnto(`group-header-${ell5}`, `group-header-${ell4}`, 0.5)
  const after = await groupsOf(page)
  expect(after.find((x) => x.id === ell5)?.parentId).not.toBe(ell4)
  expect(depthOf(after, ell5)).toBeLessThanOrEqual(4)
  expect(Math.max(...after.map((x) => depthOf(after, x.id)))).toBe(4)

  // The depth-4 group's "+" menu offers only "New project" — "New sub-group" is hidden.
  await hoverClick(page.getByTestId(`group-header-${ell4}`), page.getByTestId(`group-add-${ell4}`))
  await expect(page.getByTestId(`group-new-project-${ell4}`)).toBeVisible()
  await expect(page.getByTestId(`group-new-subgroup-${ell4}`)).toHaveCount(0)
  await page.getByTestId('row-menu-scrim').click()
})

// ─── Ungrouped is a draggable top-level pseudo-group, but never nestable ────────
test('Ungrouped drags in the top-level order but can never be nested into a group', async () => {
  // Drag the Ungrouped header onto One's TOP edge → Ungrouped moves ahead of One in top order.
  await dragOnto('ungrouped-header', `group-header-${G_ONE}`, 0.05)
  await expect.poll(async () => ungroupedOrderOf(page)).not.toBeUndefined()
  const uo = (await ungroupedOrderOf(page))!
  const oneOrder = (await groupsOf(page)).find((x) => x.id === G_ONE)!.order
  expect(uo).toBeLessThan(oneOrder)

  // Drop Ungrouped on a group header CENTER — it must NOT nest (Ungrouped is not a real group,
  // and the pseudo-group can never become a child). No project loses its ungrouped status, and
  // Ungrouped still renders as a top-level section.
  await dragOnto('ungrouped-header', `group-header-${G_ONE}`, 0.5)
  expect((await projectsOf(page)).find((p) => p.id === P_B)?.groupId).toBeUndefined()
  await expect(page.getByTestId('ungrouped-section')).toBeVisible()
  // No group ever adopted the Ungrouped sentinel as a parent.
  expect((await groupsOf(page)).every((x) => x.parentId !== '__ungrouped__')).toBe(true)
})

// ─── Icon tier sizing: 40 / 32 / 24 / 16 px by depth ───────────────────────────
test('group icons scale one tier smaller per nesting level (40/32/24/16)', async () => {
  // Chain One(1) > Two(2) > Ell3(3) > Ell4(4) from earlier tests.
  const ell3 = byName(await groupsOf(page), 'Ell3').id
  const ell4 = byName(await groupsOf(page), 'Ell4').id
  expect(await iconWidth(G_ONE)).toBe(40)
  expect(await iconWidth(G_TWO)).toBe(32)
  expect(await iconWidth(ell3)).toBe(24)
  expect(await iconWidth(ell4)).toBe(16)
})

// ─── Collapsed rail: flattened tree with tier-scaled markers, top-level separators only ──
test('the collapsed rail flattens the tree with tier-scaled markers and top-level-only separators', async () => {
  const ell3 = byName(await groupsOf(page), 'Ell3').id
  const ell4 = byName(await groupsOf(page), 'Ell4').id

  // T-074 — the rail only shows a group whose SUBTREE holds a project, so park the seeded
  // project in the deepest tier: One > Two > Ell3 > Ell4 then all four tiers stay on the rail
  // (One/Two/Ell3 via the descendant, Ell4 directly) and the flattened order is observable.
  await dragOnto(`project-${P_A}`, `group-header-${ell4}`, 0.5)
  await expect.poll(async () => (await projectsOf(page)).find((p) => p.id === P_A)?.groupId).toBe(ell4)

  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId('projects-panel-rail')).toBeVisible()

  // The One > Two > Ell3 > Ell4 subtree appears as a flat, in-order sequence of markers.
  const markers = await page
    .locator('[data-testid^="rail-group-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('rail-group-', '')))
  const idx = (id: string): number => markers.indexOf(id)
  expect(idx(G_ONE)).toBeGreaterThanOrEqual(0)
  expect(idx(G_ONE)).toBeLessThan(idx(G_TWO))
  expect(idx(G_TWO)).toBeLessThan(idx(ell3))
  expect(idx(ell3)).toBeLessThan(idx(ell4))

  // T-074 — marker GLYPHS carry the expanded tier sizes exactly (40 / 32 / 24 / 16): no
  // rail-specific scaling any more. (The buttons around them are hit targets, ≥ --hit-target.)
  expect(await iconWidth(G_ONE)).toBe(40)
  expect(await iconWidth(G_TWO)).toBe(32)
  expect(await iconWidth(ell3)).toBe(24)
  expect(await iconWidth(ell4)).toBe(16)
  for (const id of [G_ONE, G_TWO, ell3, ell4]) {
    const b = (await page.getByTestId(`rail-group-${id}`).boundingBox())!
    expect(b.width).toBeGreaterThanOrEqual(24) // --hit-target
    expect(b.height).toBeGreaterThanOrEqual(24)
  }

  // Separators divide only TOP-LEVEL sections — never between a parent and its sub-groups.
  // There is exactly one rail separator per top-level group (Two/Ell3/Ell4 are nested, so no
  // separator precedes them) plus the Ungrouped separator.
  await expect(page.getByTestId(`rail-separator-${G_ONE}`)).toBeVisible()
  await expect(page.getByTestId(`rail-separator-${G_TWO}`)).toHaveCount(0)
  await expect(page.getByTestId(`rail-separator-${ell3}`)).toHaveCount(0)
  await expect(page.getByTestId(`rail-separator-${ell4}`)).toHaveCount(0)

  await page.getByTestId('projects-panel-expand').click()
  await expect(page.getByTestId('projects-panel-rail')).toHaveCount(0)
})

// ─── T-073: the header BAND map — below-the-header means NEST, never "after" ──────────────
// Round-6 bug (the Owner): the band directly below a group header meant "place after this group",
// yet it sits exactly where the group's children start. It now nests as the FIRST child, for a
// dragged group (→ sub-group) and for a dragged project (→ first member) alike.
test('the band below a header nests as the FIRST child (group) / FIRST member (project)', async () => {
  await createGroup('ZedA')
  await createGroup('ZedB')
  await createGroup('ZedC')
  const zedA = byName(await groupsOf(page), 'ZedA').id
  const zedB = byName(await groupsOf(page), 'ZedB').id
  const zedC = byName(await groupsOf(page), 'ZedC').id

  // CENTER → nested as the LAST child (unchanged E-015 semantics).
  await dragOnto(`group-header-${zedB}`, `group-header-${zedA}`, 0.5)
  await expect.poll(async () => (await groupsOf(page)).find((g) => g.id === zedB)?.parentId).toBe(zedA)

  // BOTTOM band → nested as the FIRST child, ahead of the existing one.
  await dragOnto(`group-header-${zedC}`, `group-header-${zedA}`, 0.95)
  await expect.poll(async () => (await groupsOf(page)).find((g) => g.id === zedC)?.parentId).toBe(zedA)
  const zeds = await groupsOf(page)
  expect(zeds.find((x) => x.id === zedC)!.order).toBeLessThan(zeds.find((x) => x.id === zedB)!.order)

  // A PROJECT on the same bands: center appends, the bottom band makes it the first member.
  const ell4 = byName(zeds, 'Ell4').id // holds Aay (parked there by the rail spec)
  await dragOnto(`project-${P_B}`, `group-header-${ell4}`, 0.5)
  await expect.poll(async () => (await projectsOf(page)).find((p) => p.id === P_B)?.groupId).toBe(ell4)
  const appended = await projectsOf(page)
  expect(appended.find((p) => p.id === P_B)!.order).toBeGreaterThan(
    appended.find((p) => p.id === P_A)!.order
  )
  await dragOnto(`project-${P_B}`, `group-header-${ell4}`, 0.95)
  await expect
    .poll(async () => {
      const ps = await projectsOf(page)
      return ps.find((p) => p.id === P_B)!.order < ps.find((p) => p.id === P_A)!.order
    })
    .toBe(true)
})

// ─── T-074: the Ungrouped section only exists when it holds something ─────────────────────
test('the Ungrouped section hides when empty, and the below-all zone still un-groups a project', async () => {
  // Bee sits inside Ell4 (previous spec) → nothing is ungrouped → no section, no header.
  expect((await projectsOf(page)).some((p) => p.groupId === undefined)).toBe(false)
  await expect(page.getByTestId('ungrouped-section')).toHaveCount(0)
  await expect(page.getByTestId('ungrouped-header')).toHaveCount(0)

  // Moving a project OUT of every group must still be possible with the section hidden: the
  // below-all zone accepts a project drag and un-groups it (the section reappears with the row).
  await dragOnto(`project-${P_B}`, 'projects-panel-below-all')
  await expect
    .poll(async () => (await projectsOf(page)).find((p) => p.id === P_B)?.groupId)
    .toBeUndefined()
  await expect(page.getByTestId('ungrouped-section')).toBeVisible()
  await expect(
    page.getByTestId('ungrouped-section').getByTestId(`project-${P_B}`)
  ).toBeVisible()
})

// ─── T-074: an empty group is absent from the rail and returns when a project lands in it ──
test('an empty group is absent from the collapsed rail and reappears once its subtree has a project', async () => {
  await createGroup('RailEmpty')
  const railEmpty = byName(await groupsOf(page), 'RailEmpty').id

  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId('projects-panel-rail')).toBeVisible()
  await expect(page.getByTestId(`rail-group-${railEmpty}`)).toHaveCount(0)
  await expect(page.getByTestId(`rail-separator-${railEmpty}`)).toHaveCount(0)
  await page.getByTestId('projects-panel-expand').click()

  // Drop the ungrouped project into it → marker (and its separator) appear on the rail.
  await dragOnto(`project-${P_B}`, `group-header-${railEmpty}`, 0.5)
  await expect.poll(async () => (await projectsOf(page)).find((p) => p.id === P_B)?.groupId).toBe(railEmpty)
  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId(`rail-group-${railEmpty}`)).toBeVisible()
  await expect(page.getByTestId(`rail-separator-${railEmpty}`)).toBeVisible()
  await page.getByTestId('projects-panel-expand').click()

  // Put Bee back in Ungrouped (state for the following specs).
  await dragOnto(`project-${P_B}`, 'projects-panel-below-all')
  await expect
    .poll(async () => (await projectsOf(page)).find((p) => p.id === P_B)?.groupId)
    .toBeUndefined()
})

// ─── T-074: icon-size PARITY — the rail glyphs equal the expanded glyphs, element by element ──
test('collapsed-rail glyphs are exactly the expanded sizes (project 16px, group tiers, gear)', async () => {
  const ell4 = byName(await groupsOf(page), 'Ell4').id
  const size = async (testId: string): Promise<string> => {
    const b = (await page.getByTestId(testId).boundingBox())!
    return `${Math.round(b.width)}x${Math.round(b.height)}`
  }
  // Expanded reference sizes (Bee is an ungrouped row, One is a depth-1 tier, Ell4 depth-4).
  const expanded = {
    project: await size(`project-icon-${P_B}`),
    tier1: await size(`group-icon-${G_ONE}`),
    tier4: await size(`group-icon-${ell4}`),
    gear: await size('settings-gear')
  }
  expect(expanded.project).toBe('16x16') // --project-icon
  expect(expanded.tier1).toBe('40x40') // --group-icon
  expect(expanded.tier4).toBe('16x16') // --group-icon-4
  expect(expanded.gear).toBe('16x16') // --control-icon

  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId('projects-panel-rail')).toBeVisible()
  expect(await size(`project-icon-${P_B}`)).toBe(expanded.project)
  expect(await size(`group-icon-${G_ONE}`)).toBe(expanded.tier1)
  expect(await size(`group-icon-${ell4}`)).toBe(expanded.tier4)
  expect(await size('settings-gear')).toBe(expanded.gear)
  await page.getByTestId('projects-panel-expand').click()
  await expect(page.getByTestId('projects-panel-rail')).toHaveCount(0)
})

// ─── Reliability regression: EVERY top-level gap is reachable, deterministically, 6× ──────
// Round-4 parked a flaky flat group-drag; E-015 rebuilt the drop on drop-time geometry + pure
// helpers. Round-6 then found the remaining hole (T-073): the space BETWEEN two sections was
// dead — no drop target — so "above the first section" and "between a group and Ungrouped"
// simply never triggered (the Owner's [Group 2, Ungrouped, Work-test] screenshot). Those gaps are
// now real strips. This runs the screenshot gesture — take the LAST top-level section to the
// TOP, then to the MIDDLE, then back to the END — six times in a row: the same landing every
// time, with no order drift or duplicate positions.
test('every top-level gap position is reachable and repeated drags stay deterministic', async () => {
  await createGroup('RegA')
  await createGroup('RegB')

  /** The live top-level sequence: top-level groups + the Ungrouped pseudo-group, in display order. */
  const topSeq = async (): Promise<string[]> => {
    const g = (await groupsOf(page)).filter((x) => x.parentId === undefined)
    const uo = await ungroupedOrderOf(page)
    return [
      ...g.map((x) => ({ id: x.id, order: x.order })),
      { id: UNG, order: uo ?? Number.MAX_SAFE_INTEGER }
    ]
      .sort((a, b) => a.order - b.order || (a.id === UNG ? 1 : -1))
      .map((t) => t.id)
  }
  const posOf = async (id: string): Promise<number> => (await topSeq()).indexOf(id)

  const start = await topSeq()
  expect(start.length).toBeGreaterThanOrEqual(3) // three+ top-level sections, as in the screenshot

  for (let i = 0; i < 6; i++) {
    const seq = await topSeq()
    const mover = seq[seq.length - 1]

    // (a) TOP position — the gap above the first section.
    await dragOnto(headerOf(mover), gapOf(seq[0]))
    await expect.poll(() => posOf(mover)).toBe(0)

    // (b) MIDDLE — the gap before the (now) third section drops it between the first two,
    //     which is exactly the "between Group 2 and Ungrouped" slot from the screenshot.
    const third = (await topSeq())[2]
    await dragOnto(headerOf(mover), gapOf(third))
    await expect.poll(() => posOf(mover)).toBe(1)

    // (c) back to the END via the below-all zone → the cycle restarts from the same shape.
    await dragOnto(headerOf(mover), 'projects-panel-below-all')
    await expect.poll(async () => (await topSeq())[(await topSeq()).length - 1]).toBe(mover)

    // No drift: same membership, no duplicate positions, dense top-level order.
    const after = await topSeq()
    expect(new Set(after).size).toBe(after.length)
    expect([...after].sort()).toEqual([...start].sort())
  }
})

// ─── T-140: Projects panel group / sub-group collapse ─────────────────────────────────
// Independent of the chained tree tests above — this describe seeds its OWN group tree and runs
// its OWN app so the collapse state never entangles the DnD/nesting state. State chains WITHIN
// this describe (append-only): each test restores its baseline (all expanded) except the final
// relaunch test. The collapse toggle is HIDDEN BEHIND the group icon (icon ⇄ chevron on hover);
// the Workspace row has no toggle; collapsed ids persist to the gitignored workspace-ui.json.
test.describe('T-140 — group/sub-group collapse', () => {
  let fx: Fixture
  let capp: ElectronApplication
  let cp: Page

  const G_WORK = 'g-work'
  const G_SUB = 'g-sub'
  const P_ALPHA = 'p-alpha'
  const P_BETA = 'p-beta'

  const uiPath = (): string => join(fx.workspaceRoot, '.pomade', 'state', 'workspace-ui.json')
  const wsPath = (): string => join(fx.workspaceRoot, '.pomade', 'workspace.json')

  const collapsedOnDisk = async (): Promise<string[] | null> => {
    const raw = await fs.readFile(uiPath(), 'utf8').catch(() => '')
    return raw ? (JSON.parse(raw).collapsedGroups as string[]) : null
  }
  const collapsedInStore = (): Promise<string[]> =>
    cp.evaluate(
      () => window.__pomadeStores.useWorkspaceUiStore.getState().collapsedGroups as string[]
    )

  const clapp = (): Promise<ElectronApplication> =>
    launchApp(fx)
  const boot = async (): Promise<void> => {
    capp = await clapp()
    cp = await capp.firstWindow()
    await cp.waitForLoadState('domcontentloaded')
    await expect(cp.getByTestId('app-shell')).toBeVisible()
    await expect(cp.getByTestId(`group-header-${G_WORK}`)).toBeVisible()
  }

  test.beforeAll(async () => {
    fx = await createFixtureWorkspace()
    // A two-tier tree: top-level "Work" holds project Alpha and sub-group "Sub"; "Sub" holds Beta.
    const cfg = {
      groups: [
        { id: G_WORK, name: 'Work', order: 0 },
        { id: G_SUB, name: 'Sub', parentId: G_WORK, order: 0 }
      ],
      projects: [
        { id: P_ALPHA, name: 'Alpha', groupId: G_WORK, rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 },
        { id: P_BETA, name: 'Beta', groupId: G_SUB, rootPath: 'Projects/beta', visibleAgents: ['*'], order: 0 }
      ]
    }
    await fs.writeFile(wsPath(), JSON.stringify(cfg, null, 2), 'utf8')
    await boot()
  })

  test.afterAll(async () => {
    await capp?.close()
    await fx?.cleanup()
  })

  test('the collapse toggle is hidden behind the group icon and revealed only on hover', async () => {
    const chevron = cp.getByTestId(`group-collapse-chevron-${G_WORK}`)
    // Idle: the chevron is invisible (opacity 0) — only the group icon shows, no extra control.
    await expect(chevron).toHaveCSS('opacity', '0')
    // Hovering the icon cross-fades to the chevron (opacity 1).
    await cp.getByTestId(`group-collapse-${G_WORK}`).hover()
    await expect(chevron).toHaveCSS('opacity', '1')
    // Move the pointer away → it hides again.
    await cp.getByTestId('projects-panel-below-all').hover()
    await expect(chevron).toHaveCSS('opacity', '0')
  })

  test('the Workspace row has no collapse toggle and cannot collapse', async () => {
    await expect(cp.getByTestId('group-collapse-__workspace__')).toHaveCount(0)
    await expect(cp.getByTestId('group-collapse-chevron-__workspace__')).toHaveCount(0)
    // Its own icon button (change-icon) is untouched and still present.
    await expect(cp.getByTestId('workspace-icon-button')).toBeVisible()
  })

  test('collapsing a group hides its child projects AND sub-groups; the header row stays', async () => {
    // Baseline: everything under Work is visible.
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toBeVisible()
    await expect(cp.getByTestId(`project-${P_BETA}`)).toBeVisible()

    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    // Children gone from the DOM; the group header itself remains.
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toHaveCount(0)
    await expect(cp.getByTestId(`project-${P_BETA}`)).toHaveCount(0)
    await expect(cp.getByTestId(`group-header-${G_WORK}`)).toBeVisible()

    // Expand again → children return (restore baseline for the next test).
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toBeVisible()
  })

  test('nested sub-groups collapse independently of their parent', async () => {
    // Collapse ONLY the sub-group: Beta hides, but Alpha and the sub-group header stay.
    await cp.getByTestId(`group-collapse-${G_SUB}`).click()
    await expect(cp.getByTestId(`project-${P_BETA}`)).toHaveCount(0)
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toBeVisible()
    expect(await collapsedInStore()).toContain(G_SUB)
    expect(await collapsedInStore()).not.toContain(G_WORK)

    // Collapse the PARENT too → the sub-group header (and everything below Work) disappears.
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toHaveCount(0)
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)

    // Re-expand the parent → the sub-group reappears STILL collapsed (its own state persisted
    // independently), so Beta stays hidden while Alpha and the sub-group header are back.
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toBeVisible()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    await expect(cp.getByTestId(`project-${P_BETA}`)).toHaveCount(0)

    // Restore baseline: expand the sub-group.
    await cp.getByTestId(`group-collapse-${G_SUB}`).click()
    await expect(cp.getByTestId(`project-${P_BETA}`)).toBeVisible()
  })

  test('toggling collapse never touches the git-tracked workspace.json — only the gitignored state', async () => {
    const wsBefore = await fs.readFile(wsPath(), 'utf8')
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    // The gitignored UI state records the collapse…
    await expect.poll(collapsedOnDisk, { timeout: 5_000 }).toContain(G_WORK)
    // …and workspace.json is byte-for-byte unchanged (no git churn on a view toggle).
    expect(await fs.readFile(wsPath(), 'utf8')).toBe(wsBefore)
    // Restore baseline.
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    expect(await fs.readFile(wsPath(), 'utf8')).toBe(wsBefore)
  })

  test('collapsed groups persist across an app relaunch', async () => {
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)
    await expect.poll(collapsedOnDisk, { timeout: 5_000 }).toContain(G_WORK)

    await capp.close()
    await boot()

    // Restored collapsed: children are hidden on first paint and the store carries the id.
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)
    await expect(cp.getByTestId(`group-header-${G_WORK}`)).toBeVisible()
    await expect.poll(collapsedInStore).toContain(G_WORK)
  })
})

// ─── T-145: a click ANYWHERE on a group/sub-group header toggles collapse ───────
// T-140 folded a group only via the icon-hover chevron; T-145 WIDENS the click target so a plain
// click on the header row (its name, empty space — everything except the kebab / "+" / the icon
// toggle) does the same fold/unfold. The nested controls opt out via stopPropagation and a drag
// never fires a click, so those interactions are preserved. The Workspace row (not a group) and
// project rows are untouched. Its own app + tree, independent of the T-140 chain above.
test.describe('T-145 — click a group header to toggle collapse', () => {
  let fx: Fixture
  let capp: ElectronApplication
  let cp: Page

  const G_WORK = 'g-work'
  const G_MISC = 'g-misc'
  const G_SUB = 'g-sub'
  const P_ALPHA = 'p-alpha'
  const P_BETA = 'p-beta'

  const wsPath = (): string => join(fx.workspaceRoot, '.pomade', 'workspace.json')
  const collapsedInStore = (): Promise<string[]> =>
    cp.evaluate(
      () => window.__pomadeStores.useWorkspaceUiStore.getState().collapsedGroups as string[]
    )
  const activeProjectOf = (): Promise<string> =>
    cp.evaluate(
      () => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId as string
    )
  // A group's NAME cell (never the kebab / "+" / icon-toggle) — the widened click target.
  const headerName = (id: string, name: string) =>
    cp.getByTestId(`group-header-${id}`).getByText(name, { exact: true })

  // Shared-DataTransfer HTML5 DnD driver, bound to this describe's page (`cp`). Mirrors the
  // module-level `dragOnto`; a top edge (frac ~0.05) on a nestable sibling header = 'before'.
  async function dragHeader(sourceId: string, targetId: string, frac: number): Promise<void> {
    const dt = await cp.evaluateHandle(() => new DataTransfer())
    const source = cp.getByTestId(sourceId)
    const target = cp.getByTestId(targetId)
    const box = await target.boundingBox()
    if (!box) throw new Error(`target ${targetId} has no box`)
    const clientX = Math.round(box.x + box.width / 2)
    const clientY = Math.round(box.y + box.height * frac)
    await source.dispatchEvent('dragstart', { dataTransfer: dt })
    await target.dispatchEvent('dragover', { dataTransfer: dt, clientX, clientY })
    await target.dispatchEvent('drop', { dataTransfer: dt, clientX, clientY })
    await source.dispatchEvent('dragend', { dataTransfer: dt })
  }

  const clapp = (): Promise<ElectronApplication> =>
    launchApp(fx)
  const boot = async (): Promise<void> => {
    capp = await clapp()
    cp = await capp.firstWindow()
    await cp.waitForLoadState('domcontentloaded')
    await expect(cp.getByTestId('app-shell')).toBeVisible()
    await expect(cp.getByTestId(`group-header-${G_WORK}`)).toBeVisible()
  }

  test.beforeAll(async () => {
    fx = await createFixtureWorkspace()
    // Two top-level groups (Work, Misc) — for the reorder-still-works check — plus a sub-group
    // under Work; Alpha sits in Work, Beta in the sub-group.
    const cfg = {
      groups: [
        { id: G_WORK, name: 'Work', order: 0 },
        { id: G_MISC, name: 'Misc', order: 1 },
        { id: G_SUB, name: 'Sub', parentId: G_WORK, order: 0 }
      ],
      projects: [
        { id: P_ALPHA, name: 'Alpha', groupId: G_WORK, rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 },
        { id: P_BETA, name: 'Beta', groupId: G_SUB, rootPath: 'Projects/beta', visibleAgents: ['*'], order: 0 }
      ]
    }
    await fs.writeFile(wsPath(), JSON.stringify(cfg, null, 2), 'utf8')
    await boot()
  })

  test.afterAll(async () => {
    await capp?.close()
    await fx?.cleanup()
  })

  test('clicking a group NAME (not its kebab) folds/unfolds it — same as the icon toggle', async () => {
    // Baseline: Work's members are visible.
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toBeVisible()

    // Click the NAME cell → children (project + sub-group) collapse; header row stays.
    await headerName(G_WORK, 'Work').click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toHaveCount(0)
    await expect(cp.getByTestId(`group-header-${G_WORK}`)).toBeVisible()
    expect(await collapsedInStore()).toContain(G_WORK)

    // Click the name again → unfold, restoring the baseline.
    await headerName(G_WORK, 'Work').click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    await expect(cp.getByTestId(`group-header-${G_SUB}`)).toBeVisible()
    expect(await collapsedInStore()).not.toContain(G_WORK)
  })

  test('a sub-group header also toggles on a plain name click', async () => {
    await headerName(G_SUB, 'Sub').click()
    await expect(cp.getByTestId(`project-${P_BETA}`)).toHaveCount(0)
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    expect(await collapsedInStore()).toContain(G_SUB)
    // Restore.
    await headerName(G_SUB, 'Sub').click()
    await expect(cp.getByTestId(`project-${P_BETA}`)).toBeVisible()
    expect(await collapsedInStore()).not.toContain(G_SUB)
  })

  test('clicking the kebab opens its menu and does NOT toggle collapse', async () => {
    // Hover the header so its hover-only kebab is interactable, then open it.
    await cp.getByTestId(`group-header-${G_WORK}`).hover()
    await cp.getByTestId(`group-menu-${G_WORK}`).click()
    // The row menu opened…
    await expect(cp.getByTestId('row-menu')).toBeVisible()
    // …and the group did NOT collapse (stopPropagation kept the header's toggle from firing).
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    expect(await collapsedInStore()).not.toContain(G_WORK)
    // Dismiss the menu.
    await cp.getByTestId('row-menu-scrim').click()
    await expect(cp.getByTestId('row-menu')).toHaveCount(0)
  })

  test('the icon-hover chevron toggle still works alongside the row click', async () => {
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)
    expect(await collapsedInStore()).toContain(G_WORK)
    await cp.getByTestId(`group-collapse-${G_WORK}`).click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toBeVisible()
    expect(await collapsedInStore()).not.toContain(G_WORK)
  })

  test('dragging a group header still reorders (the click target does not hijack the drag)', async () => {
    const topOrder = async (): Promise<string[]> =>
      (await groupsOf(cp))
        .filter((g) => g.parentId === undefined)
        .sort((a, b) => a.order - b.order)
        .map((g) => g.id)
    // Baseline top-level order: Work, then Misc.
    expect(await topOrder()).toEqual([G_WORK, G_MISC])
    // Drag Misc onto Work's TOP edge → Misc reorders BEFORE Work (a sibling reorder, not a nest).
    await dragHeader(`group-header-${G_MISC}`, `group-header-${G_WORK}`, 0.05)
    await expect.poll(topOrder).toEqual([G_MISC, G_WORK])
    // The drag did not collapse anything.
    expect(await collapsedInStore()).toEqual([])
    // Restore the original order for later tests: drag Work onto Misc's TOP edge → Work first
    // again. (A bottom edge would 'nest-as-first-child' on a nestable sibling, not reorder.)
    await dragHeader(`group-header-${G_WORK}`, `group-header-${G_MISC}`, 0.05)
    await expect.poll(topOrder).toEqual([G_WORK, G_MISC])
  })

  test('the Workspace row cannot collapse and a group click never affects it', async () => {
    // The Workspace row is not a group header: it has no collapse toggle at all.
    await expect(cp.getByTestId('group-collapse-__workspace__')).toHaveCount(0)
    // Clicking it activates the Workspace project (unchanged) and records no collapse.
    await cp.getByTestId('project-__workspace__').click()
    expect(await activeProjectOf()).toBe('__workspace__')
    expect(await collapsedInStore()).toEqual([])
  })

  test('a project row still opens the project (a click there does not toggle a group)', async () => {
    await cp.getByTestId(`project-${P_ALPHA}`).click()
    expect(await activeProjectOf()).toBe(P_ALPHA)
    // No group was collapsed by opening the project.
    expect(await collapsedInStore()).toEqual([])
  })

  test('collapse via a header click persists across an app relaunch (T-140 regression)', async () => {
    await headerName(G_WORK, 'Work').click()
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)
    await expect.poll(collapsedInStore).toContain(G_WORK)

    await capp.close()
    await boot()

    // Restored collapsed on first paint.
    await expect(cp.getByTestId(`project-${P_ALPHA}`)).toHaveCount(0)
    await expect(cp.getByTestId(`group-header-${G_WORK}`)).toBeVisible()
    await expect.poll(collapsedInStore).toContain(G_WORK)
  })
})
