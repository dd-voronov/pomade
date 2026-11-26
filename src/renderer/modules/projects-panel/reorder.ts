// Pomade — E-010 (T-003) pure reorder/move helpers for Projects panel drag-and-drop.
// Kept side-effect-free (no store, no React) so the drop math is trivially testable and the
// Projects panel just calls workspace-store.reorder(groups, projects) with the returned arrays.
//
// `order` is only ever compared WITHIN a group (projectsByGroup sorts each group's list by
// order), so these helpers renumber each affected group's projects to a dense 0..n-1 — global
// uniqueness is neither required nor maintained. Group order is a single global sequence.

import type { Group, Project } from '@shared/types'

/** Group projects by groupId ('' = ungrouped), each list sorted by current order. */
function bucketByGroup(projects: Project[]): Map<string, Project[]> {
  const byGroup = new Map<string, Project[]>()
  for (const p of [...projects].sort((a, b) => a.order - b.order)) {
    const key = p.groupId ?? ''
    const list = byGroup.get(key) ?? []
    list.push(p)
    byGroup.set(key, list)
  }
  return byGroup
}

/** Flatten the per-group buckets back to a flat Project[] with dense per-group `order` and a
 *  normalized groupId ('' → undefined). */
function flatten(byGroup: Map<string, Project[]>): Project[] {
  const out: Project[] = []
  for (const [key, list] of byGroup) {
    list.forEach((p, i) => out.push({ ...p, order: i, groupId: key === '' ? undefined : key }))
  }
  return out
}

/**
 * Move `sourceId` into `destGroupId` (undefined = Ungrouped). If `targetId` is given the
 * source lands immediately before (or after, when `after`) that target; otherwise it is
 * appended to the destination group. Handles same-group reorder correctly (source is removed
 * before the insertion index is computed, so there is no off-by-one).
 */
export function moveProject(
  projects: Project[],
  sourceId: string,
  destGroupId: string | undefined,
  targetId: string | null,
  after: boolean
): Project[] {
  const source = projects.find((p) => p.id === sourceId)
  if (!source) return projects
  const byGroup = bucketByGroup(projects)

  // Remove the source from whichever group currently holds it.
  for (const list of byGroup.values()) {
    const i = list.findIndex((p) => p.id === sourceId)
    if (i >= 0) list.splice(i, 1)
  }

  const destKey = destGroupId ?? ''
  const destList = byGroup.get(destKey) ?? []
  let idx = destList.length
  if (targetId) {
    const ti = destList.findIndex((p) => p.id === targetId)
    if (ti >= 0) idx = ti + (after ? 1 : 0)
  }
  destList.splice(idx, 0, { ...source, groupId: destGroupId })
  byGroup.set(destKey, destList)

  return flatten(byGroup)
}

/**
 * T-073 — a project dropped ON a group tier (header) rather than between two rows: it becomes
 * that tier's LAST member (`first: false`, the header's center gesture) or its FIRST member
 * (`first: true`, the gap directly below the header). `destGroupId` undefined = Ungrouped.
 * Pure; delegates the actual splice to `moveProject` so ordering stays dense.
 */
export function moveProjectIntoGroup(
  projects: Project[],
  sourceId: string,
  destGroupId: string | undefined,
  first: boolean
): Project[] {
  if (!projects.some((p) => p.id === sourceId)) return projects
  if (!first) return moveProject(projects, sourceId, destGroupId, null, false)
  const firstMember = projects
    .filter((p) => (p.groupId ?? undefined) === destGroupId && p.id !== sourceId)
    .sort((a, b) => a.order - b.order)[0]
  return moveProject(projects, sourceId, destGroupId, firstMember?.id ?? null, false)
}

/** Reorder `sourceId` before/after `targetId` in the global group sequence. */
export function moveGroup(groups: Group[], sourceId: string, targetId: string, after: boolean): Group[] {
  if (sourceId === targetId) return groups
  const sorted = [...groups].sort((a, b) => a.order - b.order)
  const from = sorted.findIndex((g) => g.id === sourceId)
  if (from < 0) return groups
  const [moved] = sorted.splice(from, 1)
  let to = sorted.findIndex((g) => g.id === targetId)
  if (to < 0) return groups
  if (after) to += 1
  sorted.splice(to, 0, moved)
  return sorted.map((g, i) => ({ ...g, order: i }))
}

// ─── E-015 — nested-group TREE helpers ─────────────────────────────────────────
// The group hierarchy is a TREE derived from `Group.parentId` over the flat `groups[]`
// array (undefined parentId = a top-level group). `order` is scoped to a group's SIBLINGS
// (same parent). Depth is 1-based and capped at MAX_GROUP_DEPTH (matches the 40/32/24/16px
// icon tiers). The Ungrouped pseudo-group is not a real Group; it participates in TOP-LEVEL
// ordering via a sentinel id (UNGROUPED_ID) sharing the top-level integer order space with
// top-level groups' `order` (stored as WorkspaceConfig.ungroupedOrder).
//
// Every mutating helper is pure and returns the INPUT UNCHANGED when the move is illegal
// (into itself / its own descendant, or a depth-cap violation) — never a partial mutation —
// and renumbers each affected sibling list to a dense 0..n so repeated drags stay
// deterministic (no order drift or collisions accumulating).

export const MAX_GROUP_DEPTH = 4
/** Sentinel id for the Ungrouped pseudo-group in top-level ordering (never stored on a Group). */
export const UNGROUPED_ID = '__ungrouped__'

const sameParent = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? undefined) === (b ?? undefined)

/** Children of `parentId` (undefined = top-level), sorted by their sibling `order`. */
export function childGroups(groups: Group[], parentId: string | undefined): Group[] {
  return groups.filter((g) => sameParent(g.parentId, parentId)).sort((a, b) => a.order - b.order)
}

/** 1-based depth of a group in the tree (top-level = 1). Cycle-safe (stops if it loops). */
export function groupDepth(groups: Group[], id: string): number {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const seen = new Set<string>()
  let cur = byId.get(id)
  let depth = 0
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    depth++
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return depth || 1
}

/** `id` and its ancestors, innermost first — the groups that must be unfolded for anything inside
 *  `id` to show. Cycle-safe; an unknown id yields []. */
export function groupAncestry(groups: Group[], id: string | undefined): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const out: string[] = []
  let cur = id ? byId.get(id) : undefined
  while (cur && !out.includes(cur.id)) {
    out.push(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return out
}

/** Height of the subtree rooted at `id` (a leaf group = 1). */
function subtreeHeight(groups: Group[], id: string): number {
  const kids = groups.filter((g) => g.parentId === id)
  if (kids.length === 0) return 1
  return 1 + Math.max(...kids.map((k) => subtreeHeight(groups, k.id)))
}

/** `id` plus every descendant id (closure over parentId). */
export function descendantIds(groups: Group[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups) {
      if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id)
        grew = true
      }
    }
  }
  return out
}

/**
 * Whether moving `sourceId`'s subtree under `newParentId` (undefined = top level) is legal:
 * not onto itself, not into its own descendant, and the resulting depth stays within
 * MAX_GROUP_DEPTH. The single source of truth for the depth cap (used by both the drop
 * routing to decide if a center "nest INTO" gesture is offered, and by `moveGroupInTree`).
 */
export function canNestUnder(
  groups: Group[],
  sourceId: string,
  newParentId: string | undefined
): boolean {
  if (sourceId === newParentId) return false
  if (newParentId && descendantIds(groups, sourceId).has(newParentId)) return false
  const parentDepth = newParentId ? groupDepth(groups, newParentId) : 0
  return parentDepth + subtreeHeight(groups, sourceId) <= MAX_GROUP_DEPTH
}

/** Renumber a parent's children to a dense 0..n by current order (used after any mutation). */
function renumber(groups: Group[], parentId: string | undefined): Group[] {
  const orderMap = new Map(childGroups(groups, parentId).map((g, i) => [g.id, i]))
  return groups.map((g) => (orderMap.has(g.id) ? { ...g, order: orderMap.get(g.id)! } : g))
}

/**
 * Reparent `sourceId` under `newParentId` (undefined = top level), positioned relative to a
 * sibling `targetId` (before / after) or appended when `targetId` is null. Returns the input
 * unchanged when the move is illegal: source === newParent, newParent is inside source's own
 * subtree, or the resulting depth would exceed MAX_GROUP_DEPTH. Both the old and the new
 * sibling lists are densely renumbered. NOTE: for TOP-LEVEL positioning that must interleave
 * with the Ungrouped pseudo-group, use `reorderTopLevel` instead — this helper renumbers only
 * real groups.
 */
export function moveGroupInTree(
  groups: Group[],
  sourceId: string,
  newParentId: string | undefined,
  targetId: string | null,
  after: boolean
): Group[] {
  const source = groups.find((g) => g.id === sourceId)
  if (!source) return groups
  if (!canNestUnder(groups, sourceId, newParentId)) return groups // self / descendant / depth cap

  const oldParent = source.parentId
  let next = groups.map((g) => (g.id === sourceId ? { ...g, parentId: newParentId } : g))

  const sibIds = childGroups(next, newParentId)
    .filter((g) => g.id !== sourceId)
    .map((g) => g.id)
  let idx = sibIds.length
  if (targetId) {
    const ti = sibIds.indexOf(targetId)
    if (ti >= 0) idx = ti + (after ? 1 : 0)
  }
  sibIds.splice(idx, 0, sourceId)
  const orderMap = new Map(sibIds.map((id, i) => [id, i]))
  next = next.map((g) => (orderMap.has(g.id) ? { ...g, order: orderMap.get(g.id)! } : g))
  // Close the gap the source left in its former sibling list.
  if (!sameParent(oldParent, newParentId)) next = renumber(next, oldParent)
  return next
}

/** The top-level ordering as a token list of group ids + UNGROUPED_ID, in display order. */
export function topLevelTokens(groups: Group[], ungroupedOrder: number | undefined): string[] {
  const items: { id: string; order: number }[] = childGroups(groups, undefined).map((g) => ({
    id: g.id,
    order: g.order
  }))
  items.push({ id: UNGROUPED_ID, order: ungroupedOrder ?? Number.MAX_SAFE_INTEGER })
  items.sort((a, b) => a.order - b.order || (a.id === UNGROUPED_ID ? 1 : -1))
  return items.map((i) => i.id)
}

/**
 * Position `sourceId` (a group id, or UNGROUPED_ID) within the TOP-LEVEL sequence relative to
 * `targetId` (a top-level group id or UNGROUPED_ID). A real group source is promoted to top
 * level (parentId cleared). The combined [top-level groups + Ungrouped] sequence is densely
 * renumbered so top-level groups' `order` and `ungroupedOrder` stay a single coherent
 * sequence. Returns unchanged if source would land relative to a token inside its own subtree.
 */
export function reorderTopLevel(
  groups: Group[],
  ungroupedOrder: number | undefined,
  sourceId: string,
  targetId: string,
  after: boolean
): { groups: Group[]; ungroupedOrder: number | undefined } {
  if (sourceId === targetId) return { groups, ungroupedOrder }
  if (sourceId !== UNGROUPED_ID) {
    const subtree = descendantIds(groups, sourceId)
    if (subtree.has(targetId)) return { groups, ungroupedOrder } // target inside source's subtree
  }
  const oldParent =
    sourceId === UNGROUPED_ID ? undefined : groups.find((g) => g.id === sourceId)?.parentId
  let next =
    sourceId === UNGROUPED_ID
      ? groups
      : groups.map((g) => (g.id === sourceId ? { ...g, parentId: undefined } : g))

  const tokens = topLevelTokens(next, ungroupedOrder).filter((id) => id !== sourceId)
  let idx = tokens.indexOf(targetId)
  idx = idx < 0 ? tokens.length : idx + (after ? 1 : 0)
  tokens.splice(idx, 0, sourceId)

  let uo = ungroupedOrder
  const orderMap = new Map<string, number>()
  tokens.forEach((id, i) => {
    if (id === UNGROUPED_ID) uo = i
    else orderMap.set(id, i)
  })
  next = next.map((g) => (orderMap.has(g.id) ? { ...g, order: orderMap.get(g.id)! } : g))
  // Promoting a nested group to top level leaves a gap in its old sibling list — close it.
  if (sourceId !== UNGROUPED_ID && oldParent !== undefined) next = renumber(next, oldParent)
  return { groups: next, ungroupedOrder: uo }
}

/** Append `sourceId` (group id or UNGROUPED_ID) to the END of the top-level sequence. */
export function moveToTopLevelEnd(
  groups: Group[],
  ungroupedOrder: number | undefined,
  sourceId: string
): { groups: Group[]; ungroupedOrder: number | undefined } {
  const tokens = topLevelTokens(groups, ungroupedOrder).filter((id) => id !== sourceId)
  const last = tokens[tokens.length - 1]
  if (!last) return { groups, ungroupedOrder }
  return reorderTopLevel(groups, ungroupedOrder, sourceId, last, true)
}

/** T-074 — does `groupId`'s subtree (itself + every descendant group) hold ANY project? The
 *  collapsed rail renders a marker only for groups that do (an empty group is rail-invisible). */
export function subtreeHasProjects(
  groups: Group[],
  projects: Project[],
  groupId: string
): boolean {
  const ids = descendantIds(groups, groupId)
  return projects.some((p) => p.groupId !== undefined && ids.has(p.groupId))
}

/** T-186 — the SUM of `counts[project.id]` (the T-151 per-project unread-tab tally) across every
 *  project in `groupId`'s subtree (itself + every descendant group, recursive), mirroring
 *  `subtreeHasProjects`'s traversal. Collapsing a group hides its members' own badges, so this is
 *  what the collapsed group's header shows in their place — a live-derived aggregate, not a
 *  separately tracked count. */
export function subtreeAttentionSum(
  groups: Group[],
  projects: Project[],
  groupId: string,
  counts: Record<string, number>
): number {
  const ids = descendantIds(groups, groupId)
  let sum = 0
  for (const p of projects) {
    if (p.groupId !== undefined && ids.has(p.groupId)) sum += counts[p.id] ?? 0
  }
  return sum
}

// ─── T-073 — drop-zone semantics (the single source of truth for group DnD) ──────
// A group HEADER row carries three vertical bands, read from the drop event's own geometry:
//
//   ┌──────────────────────────┐  ── `before`     : insert ABOVE this group (sibling)
//   │  ▲ edge (≤14px)          │
//   │    center                │  ── `into`       : nest INTO it as the LAST child
//   │  ▼ edge (≤14px)          │  ── `into-first` : nest INTO it as the FIRST child — this band
//   └──────────────────────────┘                    sits where the group's children START, so it
//                                                   reads as "inside", never as "after".
// "Place AFTER the group" is therefore NEVER a header band: it is expressed by the GAP that
// precedes the next section (`before-section`, the strip that used to be dead `.group` margin)
// or, for the last section, by the below-all zone. Every position in the order thus has a real
// element to drop on — the round-6 "some slots never trigger" bug (the visible gap between two
// sections belonged to no drop target at all, leaving only a 14px header edge to hit).
// When nesting is impossible (depth cap / Ungrouped source) the bands collapse to a plain
// before/after midpoint split, which is also the fallback for a refused nest.

const HEADER_EDGE_MIN = 6
const HEADER_EDGE_MAX = 14
const HEADER_EDGE_RATIO = 0.3

export type HeaderZone = 'before' | 'into' | 'into-first' | 'after'

/** Height of a header's top/bottom edge band (clamped 6–14px, ~30% of the row). */
export function headerEdge(height: number): number {
  return Math.max(HEADER_EDGE_MIN, Math.min(HEADER_EDGE_MAX, height * HEADER_EDGE_RATIO))
}

/** The band `offsetY` falls into within a header of `height`. Pure geometry — no DOM. */
export function groupHeaderZone(offsetY: number, height: number, canNest: boolean): HeaderZone {
  if (!canNest) return offsetY < height / 2 ? 'before' : 'after'
  const edge = headerEdge(height)
  if (offsetY <= edge) return 'before'
  if (offsetY >= height - edge) return 'into-first'
  return 'into'
}

/** Where a group / Ungrouped drag would land. Produced by the Projects panel's DOM handlers, consumed
 *  by `planGroupDrop` — so the Projects panel carries no ordering logic of its own. */
export type GroupDropTarget =
  /** A group header band. */
  | { kind: 'header'; groupId: string; zone: HeaderZone }
  /** The gap strip that PRECEDES a group section (= after everything above it, at that level). */
  | { kind: 'before-section'; groupId: string }
  /** The gap strip preceding the Ungrouped section. */
  | { kind: 'ungrouped-before' }
  /** The Ungrouped header (never nestable → before/after only). */
  | { kind: 'ungrouped-header'; zone: HeaderZone }
  /** Below everything → last in the top-level order. */
  | { kind: 'end' }

/**
 * T-073 — the ONE pure reducer for a group / Ungrouped drop. `sourceId` is a group id or
 * UNGROUPED_ID. Returns the input UNCHANGED for every illegal gesture (unknown source/target,
 * onto itself, into its own subtree, Ungrouped asked to nest or to order among non-top-level
 * groups) and degrades a refused nest (depth cap) to sibling placement — never a partial move.
 */
export function planGroupDrop(
  groups: Group[],
  ungroupedOrder: number | undefined,
  sourceId: string,
  target: GroupDropTarget
): { groups: Group[]; ungroupedOrder: number | undefined } {
  const unchanged = { groups, ungroupedOrder }
  const isUngroupedSource = sourceId === UNGROUPED_ID
  if (!isUngroupedSource && !groups.some((g) => g.id === sourceId)) return unchanged

  /** Sibling placement relative to a real group (top level goes through `reorderTopLevel` so the
   *  Ungrouped pseudo-group keeps sharing the top-level integer sequence). */
  const asSibling = (t: Group, after: boolean): { groups: Group[]; ungroupedOrder: number | undefined } => {
    if (t.parentId === undefined)
      return reorderTopLevel(groups, ungroupedOrder, sourceId, t.id, after)
    if (isUngroupedSource) return unchanged // Ungrouped only orders among TOP-LEVEL sections
    return { groups: moveGroupInTree(groups, sourceId, t.parentId, t.id, after), ungroupedOrder }
  }

  switch (target.kind) {
    case 'end':
      return moveToTopLevelEnd(groups, ungroupedOrder, sourceId)

    case 'ungrouped-before':
      return reorderTopLevel(groups, ungroupedOrder, sourceId, UNGROUPED_ID, false)

    case 'ungrouped-header':
      if (isUngroupedSource) return unchanged
      return reorderTopLevel(groups, ungroupedOrder, sourceId, UNGROUPED_ID, target.zone !== 'before')

    case 'before-section': {
      const t = groups.find((g) => g.id === target.groupId)
      if (!t || t.id === sourceId) return unchanged
      return asSibling(t, false)
    }

    case 'header': {
      const t = groups.find((g) => g.id === target.groupId)
      if (!t) return unchanged
      if (isUngroupedSource) {
        if (t.parentId !== undefined) return unchanged
        return reorderTopLevel(groups, ungroupedOrder, UNGROUPED_ID, t.id, target.zone !== 'before')
      }
      if (t.id === sourceId || descendantIds(groups, sourceId).has(t.id)) return unchanged
      const nests = target.zone === 'into' || target.zone === 'into-first'
      if (nests && canNestUnder(groups, sourceId, t.id)) {
        const firstChild = childGroups(groups, t.id).find((k) => k.id !== sourceId)
        const anchor = target.zone === 'into-first' ? (firstChild?.id ?? null) : null
        return { groups: moveGroupInTree(groups, sourceId, t.id, anchor, false), ungroupedOrder }
      }
      // `before` — and the depth-capped fallback for a refused nest — is sibling placement.
      return asSibling(t, target.zone !== 'before')
    }
  }
}

/**
 * Migration / normalization run on load (workspace-store.hydrate). Repairs a group tree so it
 * is always valid before it reaches the UI, and reports whether anything changed so the caller
 * can write the corrected shape back via the normal save. Repairs: (1) a `parentId` pointing at
 * a missing group → detach to top level; (2) a cycle → detach the looping node to top level;
 * (3) a node deeper than MAX_GROUP_DEPTH → detach to top level. A plain pre-E-015 flat config
 * (no parentId anywhere) is already valid → returns it unchanged (changed=false).
 */
export function normalizeGroupTree(groups: Group[]): { groups: Group[]; changed: boolean } {
  const byId = new Map(groups.map((g) => [g.id, g]))
  let changed = false
  const next = groups.map((g) => {
    if (g.parentId === undefined) return g
    // Walk up from g, detecting a missing parent, a cycle, or an over-deep chain.
    const seen = new Set<string>()
    let cur: Group | undefined = g
    let depth = 0
    let bad = false
    while (cur) {
      if (cur.parentId === undefined) break
      if (seen.has(cur.id)) {
        bad = true
        break
      }
      seen.add(cur.id)
      depth++
      const parent = byId.get(cur.parentId)
      if (!parent) {
        bad = true
        break
      }
      if (depth >= MAX_GROUP_DEPTH) {
        bad = true
        break
      }
      cur = parent
    }
    if (bad) {
      changed = true
      const { parentId: _drop, ...rest } = g
      void _drop
      return rest as Group
    }
    return g
  })
  return { groups: next, changed }
}
