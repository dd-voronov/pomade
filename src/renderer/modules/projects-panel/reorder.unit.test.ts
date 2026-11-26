// T-176 — pure-logic seed suite for projects-panel/reorder.ts: flat project moves, nested-group tree
// math (reparent / depth cap / cycle safety), top-level ordering incl. the Ungrouped sentinel,
// header drop-zone geometry, and the load-time tree normalizer.

import { describe, expect, it } from 'vitest'
import type { Group, Project } from '@shared/types'
import {
  MAX_GROUP_DEPTH,
  UNGROUPED_ID,
  canNestUnder,
  childGroups,
  descendantIds,
  groupAncestry,
  groupDepth,
  groupHeaderZone,
  headerEdge,
  moveGroup,
  moveGroupInTree,
  moveProject,
  moveProjectIntoGroup,
  moveToTopLevelEnd,
  normalizeGroupTree,
  planGroupDrop,
  reorderTopLevel,
  subtreeAttentionSum,
  subtreeHasProjects,
  topLevelTokens
} from './reorder'

function project(id: string, order: number, groupId?: string): Project {
  return { id, name: id, groupId, rootPath: id, visibleAgents: ['*'], order }
}

function group(id: string, order: number, parentId?: string): Group {
  return { id, name: id, order, parentId }
}

describe('moveProject — flat cross/same-group project moves', () => {
  it('moves a project into a different group, appended by default', () => {
    const projects = [project('p1', 0, 'g1'), project('p2', 0, 'g2')]
    const out = moveProject(projects, 'p1', 'g2', null, false)
    const p1 = out.find((p) => p.id === 'p1')!
    expect(p1.groupId).toBe('g2')
    expect(p1.order).toBe(1) // appended after p2
  })

  it('moves a project to Ungrouped when destGroupId is undefined', () => {
    const projects = [project('p1', 0, 'g1')]
    const out = moveProject(projects, 'p1', undefined, null, false)
    expect(out.find((p) => p.id === 'p1')!.groupId).toBeUndefined()
  })

  it('same-group reorder before a target has no off-by-one (source removed before index computed)', () => {
    const projects = [project('a', 0, 'g1'), project('b', 1, 'g1'), project('c', 2, 'g1')]
    // Move c before a.
    const out = moveProject(projects, 'c', 'g1', 'a', false)
    const ordered = out.filter((p) => p.groupId === 'g1').sort((x, y) => x.order - y.order)
    expect(ordered.map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('an unknown sourceId returns the input unchanged', () => {
    const projects = [project('a', 0)]
    expect(moveProject(projects, 'zzz', undefined, null, false)).toBe(projects)
  })

  // Edge case not previously exercised: dropping "after" an unknown targetId falls back to
  // append (targetId lookup fails silently), never throws or drops the source.
  it('an unknown targetId falls back to append at the end of the destination group', () => {
    const projects = [project('a', 0, 'g1'), project('b', 1, 'g1')]
    const out = moveProject(projects, 'a', 'g1', 'zzz', true)
    const ordered = out.filter((p) => p.groupId === 'g1').sort((x, y) => x.order - y.order)
    expect(ordered.map((p) => p.id)).toEqual(['b', 'a'])
  })
})

describe('moveProjectIntoGroup — T-073 header-center / into-first gestures', () => {
  it('first:false appends as the group tier LAST member', () => {
    const projects = [project('a', 0, 'g1'), project('b', 0, 'g2')]
    const out = moveProjectIntoGroup(projects, 'b', 'g1', false)
    const ordered = out.filter((p) => p.groupId === 'g1').sort((x, y) => x.order - y.order)
    expect(ordered.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('first:true inserts as the group tier FIRST member', () => {
    const projects = [project('a', 0, 'g1'), project('b', 0, 'g2')]
    const out = moveProjectIntoGroup(projects, 'b', 'g1', true)
    const ordered = out.filter((p) => p.groupId === 'g1').sort((x, y) => x.order - y.order)
    expect(ordered.map((p) => p.id)).toEqual(['b', 'a'])
  })

  it('an unknown sourceId returns the input unchanged', () => {
    const projects = [project('a', 0)]
    expect(moveProjectIntoGroup(projects, 'zzz', 'g1', true)).toBe(projects)
  })
})

describe('moveGroup — flat top-level group reorder', () => {
  it('moves a group before a target and renumbers densely', () => {
    const groups = [group('a', 0), group('b', 1), group('c', 2)]
    const out = moveGroup(groups, 'c', 'a', false)
    expect(out.map((g) => g.id)).toEqual(['c', 'a', 'b'])
    expect(out.map((g) => g.order)).toEqual([0, 1, 2])
  })

  it('sourceId === targetId is a no-op', () => {
    const groups = [group('a', 0), group('b', 1)]
    expect(moveGroup(groups, 'a', 'a', false)).toBe(groups)
  })

  it('an unknown targetId returns the input unchanged', () => {
    const groups = [group('a', 0), group('b', 1)]
    expect(moveGroup(groups, 'a', 'zzz', false)).toBe(groups)
  })
})

describe('nested-group tree helpers — depth, descendants, legality', () => {
  // a (depth1) -> b (depth2) -> c (depth3) -> d (depth4)
  const chain: Group[] = [
    group('a', 0),
    group('b', 0, 'a'),
    group('c', 0, 'b'),
    group('d', 0, 'c')
  ]

  it('groupDepth walks parentId to compute 1-based depth', () => {
    expect(groupDepth(chain, 'a')).toBe(1)
    expect(groupDepth(chain, 'd')).toBe(4)
  })

  it('groupDepth is cycle-safe (stops instead of looping forever)', () => {
    const cyclic: Group[] = [group('x', 0, 'y'), group('y', 0, 'x')]
    expect(groupDepth(cyclic, 'x')).toBeLessThanOrEqual(2)
  })

  it('descendantIds returns the id plus every transitive child', () => {
    expect(descendantIds(chain, 'b')).toEqual(new Set(['b', 'c', 'd']))
  })

  it('childGroups sorts children by sibling order', () => {
    const groups = [group('parent', 0), group('c2', 1, 'parent'), group('c1', 0, 'parent')]
    expect(childGroups(groups, 'parent').map((g) => g.id)).toEqual(['c1', 'c2'])
  })

  it('canNestUnder refuses nesting a group under itself', () => {
    expect(canNestUnder(chain, 'a', 'a')).toBe(false)
  })

  it('canNestUnder refuses nesting a group under its own descendant', () => {
    expect(canNestUnder(chain, 'a', 'c')).toBe(false)
  })

  it(`canNestUnder refuses a move that would exceed MAX_GROUP_DEPTH (${MAX_GROUP_DEPTH})`, () => {
    // 'a' is a single leaf (subtreeHeight 1) but nesting the 3-deep chain rooted at 'b' under
    // 'd' (already depth 4) would require depth 4+3=7 > MAX_GROUP_DEPTH.
    expect(canNestUnder(chain, 'b', 'd')).toBe(false)
  })

  it('canNestUnder allows a legal move within the depth cap', () => {
    const groups: Group[] = [group('a', 0), group('b', 0)]
    expect(canNestUnder(groups, 'b', 'a')).toBe(true)
  })

  // Edge case not previously exercised: nesting a SUBTREE (not just a leaf) under a target must
  // account for the whole subtree's height, not just the moved node itself.
  it('canNestUnder accounts for the height of the whole moved subtree, not just the moved node', () => {
    // subtree rooted at 'b' has height 3 (b->c->d). Nesting it under a fresh top-level 'e'
    // (depth 1) would produce depths 2/3/4 — exactly at the cap, so it is legal...
    const groups: Group[] = [group('e', 0), group('b', 0), group('c', 0, 'b'), group('d', 0, 'c')]
    expect(canNestUnder(groups, 'b', 'e')).toBe(true)
    // ...but nesting it one level deeper (under a child of 'e') would exceed the cap.
    const deeper: Group[] = [
      group('e', 0),
      group('f', 0, 'e'),
      group('b', 0),
      group('c', 0, 'b'),
      group('d', 0, 'c')
    ]
    expect(canNestUnder(deeper, 'b', 'f')).toBe(false)
  })
})

describe('moveGroupInTree — reparent + renumber both sibling lists', () => {
  it('reparents a group and appends it as the last child of the new parent', () => {
    const groups = [group('p1', 0), group('p2', 1), group('c', 0, 'p1')]
    const out = moveGroupInTree(groups, 'c', 'p2', null, false)
    const c = out.find((g) => g.id === 'c')!
    expect(c.parentId).toBe('p2')
    expect(c.order).toBe(0)
  })

  it('closes the gap in the OLD sibling list after reparenting', () => {
    const groups = [
      group('p1', 0),
      group('a', 0, 'p1'),
      group('b', 1, 'p1'),
      group('c', 2, 'p1'),
      group('p2', 1)
    ]
    const out = moveGroupInTree(groups, 'b', 'p2', null, false)
    const remaining = out.filter((g) => g.parentId === 'p1').sort((x, y) => x.order - y.order)
    expect(remaining.map((g) => g.id)).toEqual(['a', 'c'])
    expect(remaining.map((g) => g.order)).toEqual([0, 1]) // dense, no gap left at old order=2
  })

  it('an illegal move (into own descendant) returns the input UNCHANGED, not partially applied', () => {
    const groups = [group('a', 0), group('b', 0, 'a')]
    const out = moveGroupInTree(groups, 'a', 'b', null, false)
    expect(out).toBe(groups)
  })

  it('an illegal depth-cap-violating move returns the input unchanged', () => {
    const chain = [group('a', 0), group('b', 0, 'a'), group('c', 0, 'b'), group('d', 0, 'c')]
    expect(moveGroupInTree(chain, 'b', 'd', null, false)).toBe(chain)
  })

  it('an unknown sourceId returns the input unchanged', () => {
    const groups = [group('a', 0)]
    expect(moveGroupInTree(groups, 'zzz', undefined, null, false)).toBe(groups)
  })
})

describe('topLevelTokens / reorderTopLevel / moveToTopLevelEnd — Ungrouped sentinel interleaving', () => {
  it('topLevelTokens interleaves Ungrouped by its stored order', () => {
    const groups = [group('a', 0), group('b', 2)]
    expect(topLevelTokens(groups, 1)).toEqual(['a', UNGROUPED_ID, 'b'])
  })

  it('an undefined ungroupedOrder sorts Ungrouped LAST', () => {
    const groups = [group('a', 0), group('b', 1)]
    expect(topLevelTokens(groups, undefined)).toEqual(['a', 'b', UNGROUPED_ID])
  })

  it('reorderTopLevel can move the Ungrouped sentinel itself among real groups', () => {
    const groups = [group('a', 0), group('b', 1)]
    const { groups: g2, ungroupedOrder } = reorderTopLevel(groups, 2, UNGROUPED_ID, 'a', false)
    expect(topLevelTokens(g2, ungroupedOrder)).toEqual([UNGROUPED_ID, 'a', 'b'])
  })

  it('reorderTopLevel promotes a nested group to top level and closes its old sibling gap', () => {
    const groups = [group('p', 0), group('c1', 0, 'p'), group('c2', 1, 'p'), group('top', 1)]
    const { groups: g2, ungroupedOrder } = reorderTopLevel(groups, undefined, 'c1', 'top', false)
    const c1 = g2.find((g) => g.id === 'c1')!
    expect(c1.parentId).toBeUndefined()
    expect(topLevelTokens(g2, ungroupedOrder).includes('c1')).toBe(true)
    // old sibling list (c2) renumbered densely from 0
    expect(g2.find((g) => g.id === 'c2')!.order).toBe(0)
  })

  it('reorderTopLevel refuses placing a group relative to a target inside its own subtree', () => {
    const groups = [group('a', 0), group('b', 0, 'a')]
    const result = reorderTopLevel(groups, undefined, 'a', 'b', false)
    expect(result.groups).toBe(groups)
  })

  it('sourceId === targetId is a no-op', () => {
    const groups = [group('a', 0)]
    const result = reorderTopLevel(groups, undefined, 'a', 'a', false)
    expect(result.groups).toBe(groups)
  })

  it('moveToTopLevelEnd appends the sentinel/group after everything else', () => {
    const groups = [group('a', 0), group('b', 1)]
    const { groups: g2, ungroupedOrder } = moveToTopLevelEnd(groups, 0, UNGROUPED_ID)
    expect(topLevelTokens(g2, ungroupedOrder)).toEqual(['a', 'b', UNGROUPED_ID])
  })

  it('moveToTopLevelEnd on an already-empty token list (single item) is a no-op', () => {
    const groups: Group[] = []
    const result = moveToTopLevelEnd(groups, undefined, UNGROUPED_ID)
    expect(result.groups).toBe(groups)
  })
})

describe('subtreeHasProjects / subtreeAttentionSum — collapsed-group aggregates', () => {
  const groups = [group('parent', 0), group('child', 0, 'parent')]

  it('subtreeHasProjects is true when a descendant group holds a project', () => {
    const projects = [project('p1', 0, 'child')]
    expect(subtreeHasProjects(groups, projects, 'parent')).toBe(true)
  })

  it('subtreeHasProjects is false for an empty subtree', () => {
    expect(subtreeHasProjects(groups, [], 'parent')).toBe(false)
  })

  it('subtreeAttentionSum sums counts across the whole subtree recursively', () => {
    const projects = [project('p1', 0, 'parent'), project('p2', 0, 'child')]
    const counts = { p1: 2, p2: 3 }
    expect(subtreeAttentionSum(groups, projects, 'parent', counts)).toBe(5)
  })

  it('subtreeAttentionSum treats a missing count as 0, not NaN/undefined', () => {
    const projects = [project('p1', 0, 'parent')]
    expect(subtreeAttentionSum(groups, projects, 'parent', {})).toBe(0)
  })
})

describe('headerEdge / groupHeaderZone — T-073 drop-band geometry', () => {
  it('clamps the edge band between 6 and 14px', () => {
    expect(headerEdge(10)).toBe(6) // 30% of 10 = 3, clamped up to min 6
    expect(headerEdge(1000)).toBe(14) // 30% of 1000 = 300, clamped down to max 14
    expect(headerEdge(40)).toBe(12) // 30% of 40 = 12, within range
  })

  it('when nesting is impossible, the header is a plain before/after midpoint split', () => {
    expect(groupHeaderZone(5, 40, false)).toBe('before')
    expect(groupHeaderZone(21, 40, false)).toBe('after')
  })

  it('when nesting is possible, the header has before/into/into-first bands', () => {
    // height 40 → edge = 12
    expect(groupHeaderZone(5, 40, true)).toBe('before') // <= edge
    expect(groupHeaderZone(20, 40, true)).toBe('into') // middle
    expect(groupHeaderZone(35, 40, true)).toBe('into-first') // >= height-edge
  })

  // Edge case not previously exercised: the exact boundary offsets (offsetY === edge and
  // offsetY === height-edge) must land on the INTO side (both comparisons are <=/>=), not
  // silently fall through to 'into' at one boundary and 'before'/'into-first' at the other.
  it('boundary offsets are inclusive: offsetY===edge is before, offsetY===height-edge is into-first', () => {
    expect(groupHeaderZone(12, 40, true)).toBe('before') // offsetY === edge
    expect(groupHeaderZone(28, 40, true)).toBe('into-first') // offsetY === height-edge
  })
})

describe('planGroupDrop — the single reducer for group/Ungrouped drops', () => {
  it('unknown source (not a real group, not Ungrouped) is a no-op', () => {
    const groups = [group('a', 0)]
    const result = planGroupDrop(groups, undefined, 'zzz', { kind: 'end' })
    expect(result.groups).toBe(groups)
  })

  it('"end" appends the source to the end of the top-level sequence', () => {
    const groups = [group('a', 0), group('b', 1)]
    const result = planGroupDrop(groups, 0, UNGROUPED_ID, { kind: 'end' })
    expect(topLevelTokens(result.groups, result.ungroupedOrder)).toEqual(['a', 'b', UNGROUPED_ID])
  })

  it('a header "into" drop on a nestable target reparents as last child', () => {
    const groups = [group('a', 0), group('b', 1)]
    const result = planGroupDrop(groups, undefined, 'b', { kind: 'header', groupId: 'a', zone: 'into' })
    expect(result.groups.find((g) => g.id === 'b')!.parentId).toBe('a')
  })

  it('a header "into" drop refused by the depth cap degrades to sibling placement, never a partial move', () => {
    const chain = [group('a', 0), group('b', 0, 'a'), group('c', 0, 'b'), group('d', 0, 'c')]
    // 'd' is at depth 4 (the cap). Nesting 'd' further under a fresh top-level leaf would be a
    // no-op reparent anyway; use a scenario where nesting is refused: nest chain-head 'a' under
    // its own depth-4 descendant path is already blocked by descendant-check, so instead test a
    // genuinely depth-refused nest: nesting a 2-deep subtree under 'd'.
    const withExtra = [...chain, group('x', 0), group('y', 0, 'x')]
    const result = planGroupDrop(withExtra, undefined, 'x', {
      kind: 'header',
      groupId: 'd',
      zone: 'into'
    })
    // Refused nest (would exceed MAX_GROUP_DEPTH) falls back to sibling (top-level) placement —
    // 'x' keeps its top-level parentage instead of a half-applied reparent.
    expect(result.groups.find((g) => g.id === 'x')!.parentId).toBeUndefined()
  })

  it('dropping a group onto its own header is a no-op', () => {
    const groups = [group('a', 0)]
    const result = planGroupDrop(groups, undefined, 'a', { kind: 'header', groupId: 'a', zone: 'into' })
    expect(result.groups).toBe(groups)
  })

  it('Ungrouped cannot be nested (nests-into is only for real groups)', () => {
    const groups = [group('a', 0)]
    const result = planGroupDrop(groups, undefined, UNGROUPED_ID, {
      kind: 'header',
      groupId: 'a',
      zone: 'into'
    })
    // Ungrouped header-drop only ever reorders top-level, never nests.
    expect(result.groups.every((g) => g.parentId !== UNGROUPED_ID)).toBe(true)
  })

  it('ungrouped-before places the source immediately before the Ungrouped section', () => {
    const groups = [group('a', 0), group('b', 1)]
    const result = planGroupDrop(groups, 2, 'b', { kind: 'ungrouped-before' })
    const tokens = topLevelTokens(result.groups, result.ungroupedOrder)
    expect(tokens.indexOf('b')).toBe(tokens.indexOf(UNGROUPED_ID) - 1)
  })

  it('before-section on an unknown groupId is a no-op', () => {
    const groups = [group('a', 0)]
    const result = planGroupDrop(groups, undefined, 'a', { kind: 'before-section', groupId: 'zzz' })
    expect(result.groups).toBe(groups)
  })
})

describe('normalizeGroupTree — load-time repair', () => {
  it('a plain pre-E-015 flat config (no parentId anywhere) is unchanged', () => {
    const groups = [group('a', 0), group('b', 1)]
    const result = normalizeGroupTree(groups)
    expect(result.changed).toBe(false)
    expect(result.groups).toEqual(groups)
  })

  it('detaches a group whose parentId points at a missing group', () => {
    const groups = [group('a', 0, 'ghost')]
    const result = normalizeGroupTree(groups)
    expect(result.changed).toBe(true)
    expect(result.groups[0].parentId).toBeUndefined()
  })

  it('detaches a group involved in a parentId cycle', () => {
    const groups = [group('x', 0, 'y'), group('y', 0, 'x')]
    const result = normalizeGroupTree(groups)
    expect(result.changed).toBe(true)
    // At least one side of the cycle must be broken (detached), or an infinite loop would occur.
    expect(result.groups.some((g) => g.parentId === undefined)).toBe(true)
  })

  it('detaches a node deeper than MAX_GROUP_DEPTH', () => {
    // a(1) -> b(2) -> c(3) -> d(4) -> e(5) — e exceeds the cap.
    const groups = [
      group('a', 0),
      group('b', 0, 'a'),
      group('c', 0, 'b'),
      group('d', 0, 'c'),
      group('e', 0, 'd')
    ]
    const result = normalizeGroupTree(groups)
    expect(result.changed).toBe(true)
    expect(result.groups.find((g) => g.id === 'e')!.parentId).toBeUndefined()
  })

  it('a valid depth-4 chain is left untouched', () => {
    const groups = [group('a', 0), group('b', 0, 'a'), group('c', 0, 'b'), group('d', 0, 'c')]
    const result = normalizeGroupTree(groups)
    expect(result.changed).toBe(false)
    expect(result.groups).toEqual(groups)
  })
})

describe('groupAncestry', () => {
  const groups = [group('a', 0), group('b', 0, 'a'), group('c', 0, 'b'), group('x', 1)]
  it('lists the group and its ancestors, innermost first', () => {
    expect(groupAncestry(groups, 'c')).toEqual(['c', 'b', 'a'])
    expect(groupAncestry(groups, 'x')).toEqual(['x'])
  })
  it('yields nothing for no group or an unknown one', () => {
    expect(groupAncestry(groups, undefined)).toEqual([])
    expect(groupAncestry(groups, 'nope')).toEqual([])
  })
  it('stops on a cycle', () => {
    const cyc = [group('p', 0, 'q'), group('q', 0, 'p')]
    expect(groupAncestry(cyc, 'p')).toEqual(['p', 'q'])
  })
})
