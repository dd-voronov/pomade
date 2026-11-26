// Pomade — one group section in the expanded Projects panel (E-015 nested groups). Recursive: a group's
// header row is the unified reorder-DnD drop target, followed (when expanded) by its member
// project rows and its child GroupSections. The header's TOP band inserts ABOVE it, its CENTER
// nests a dragged group/project INTO it (last), its BOTTOM band nests as the FIRST child; "after
// this group" is the GAP preceding the next section, never a header band. `depth` (1-based) drives
// the tier icon size and indentation, and gates "New sub-group" at max depth.

import type { Group } from '@shared/types'
import { childGroups, MAX_GROUP_DEPTH, type GroupDropTarget } from './reorder'
import {
  AttentionCounter,
  colorMenuItem,
  GroupIcon,
  IconBtn,
  INDENT_STEP,
  KebabButton,
  rowColorVars,
  TrashGlyph,
  type KebabItem
} from './projects-panel-parts'
import { ChevronIcon } from '../filetree/icons'
import { ProjectRow } from './ProjectRow'
import type { ProjectsPanelCtx } from './tree-context'
import type { ProjectsPanelDnd } from './useProjectsPanelDnd'
import styles from './ProjectsPanel.module.css'

/**
 * T-073 — the GAP strip that precedes a section (a group at any depth, or Ungrouped). It makes the
 * visible space between two sections a REAL drop target meaning "place here, at this section's
 * level" — the round-6 reachability fix (that space used to be plain `.group` margin belonging to
 * no target, so the only route to a between-sections slot was a ≤14px header edge). Inert for
 * project drags. `gapKey` doubles as the live-indicator identity.
 */
export function Gap({
  gapKey,
  testId,
  target,
  depth,
  dnd
}: {
  gapKey: string
  testId: string
  target: GroupDropTarget
  depth: number
  dnd: ProjectsPanelDnd
}): React.JSX.Element {
  return (
    <div
      className={`${styles.gap} ${dnd.isGapActive(gapKey) ? styles.gapActive : ''}`}
      data-testid={testId}
      style={
        depth > 1
          ? { marginLeft: `calc(var(--space-2) + ${(depth - 1) * INDENT_STEP}px)` }
          : undefined
      }
      {...dnd.gapHandlers(target)}
    />
  )
}

export function GroupSection({
  group,
  depth,
  ctx
}: {
  group: Group
  depth: number
  ctx: ProjectsPanelCtx
}): React.JSX.Element {
  const { groups, projectsByGroup, collapsedGroupSet, dnd } = ctx
  const members = projectsByGroup.get(group.id) ?? []
  const kids = childGroups(groups, group.id)
  const collapsed = collapsedGroupSet.has(group.id)
  const siblings = childGroups(groups, group.parentId)
  const gi = siblings.findIndex((s) => s.id === group.id)
  // T-190 — color tone vars + indent on the header (the painted element AND the .rowActions parent,
  // so its kebab fade slab inherits --row-fill). A group is never "active" — fill only, no border.
  const headerIndent = {
    paddingLeft: `calc(var(--space-3) + ${(depth - 1) * INDENT_STEP}px)`,
    ...rowColorVars(group.color, group.highlighted)
  }
  const headerClass = dnd.headerDropClass(
    dnd.dropInd?.kind === 'group' && dnd.dropInd.id === group.id ? dnd.dropInd.zone : undefined
  )
  return (
    <section
      className={styles.group}
      data-testid={`group-${group.id}`}
      data-depth={depth}
    >
      <Gap
        gapKey={`gap-${group.id}`}
        testId={`group-gap-${group.id}`}
        target={{ kind: 'before-section', groupId: group.id }}
        depth={depth}
        dnd={dnd}
      />
      <div
        className={`${styles.groupHeader} ${headerClass}`}
        style={headerIndent}
        data-testid={`group-header-${group.id}`}
        data-color={group.color}
        // T-145 — the WHOLE header row toggles this group's collapse on a plain click, the same
        // fold/unfold as the icon-hover chevron (T-140). The nested controls opt out via
        // stopPropagation on their own handlers (collapse toggle, "+" menu, kebab), and drag
        // never fires a click — so this only ever catches a click on the row's inert areas
        // (name, empty space). The icon-hover affordance stays as an extra hint.
        onClick={() => ctx.toggleGroupCollapsed(group.id)}
        {...dnd.groupHeaderHandlers(group)}
      >
        {/* T-140 — the collapse toggle is HIDDEN BEHIND the group icon and revealed on hover:
            the icon cross-fades to a rotating chevron (▸ collapsed → ▾ open), reusing the file
            tree's chevron vocabulary. Clicking toggles this group's collapse (stopPropagation so
            it never triggers the header's drag/selection). No always-visible extra control. */}
        <button
          type="button"
          className={styles.groupCollapseToggle}
          data-testid={`group-collapse-${group.id}`}
          aria-label={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
          aria-expanded={!collapsed}
          draggable={false}
          onClick={(e) => {
            e.stopPropagation()
            ctx.toggleGroupCollapsed(group.id)
          }}
        >
          <GroupIcon group={group} depth={depth} />
          <span
            className={`${styles.groupCollapseChevron} ${collapsed ? '' : styles.groupCollapseChevronOpen}`}
            data-testid={`group-collapse-chevron-${group.id}`}
            aria-hidden="true"
          >
            <ChevronIcon />
          </span>
        </button>
        <span
          className={`${styles.groupName} ${group.highlighted ? styles.highlighted : ''}`}
          data-testid={`group-name-${group.id}`}
          data-highlighted={group.highlighted ? 'true' : undefined}
          title={group.description}
        >
          {group.name}
        </span>
        {/* T-186 — collapsed only: the subtree's summed unread-tab count stands in for the
            now-hidden per-project badges. Expanded shows none (the members' own badges do). */}
        {collapsed && (
          <AttentionCounter
            count={ctx.groupAttentionCounts[group.id] ?? 0}
            testId={`group-attention-${group.id}`}
          />
        )}
        {/* E-015 — "+" is a menu: New project / New sub-group (sub-group hidden at max depth). */}
        <span className={styles.rowActions}>
          <IconBtn
            label="Add to group"
            glyph="+"
            testId={`group-add-${group.id}`}
            onClick={(e) => {
              const items: KebabItem[] = [
                {
                  label: 'New project',
                  glyph: '📄',
                  testId: `group-new-project-${group.id}`,
                  onClick: () => ctx.setModal({ kind: 'project', defaultGroupId: group.id })
                }
              ]
              if (depth < MAX_GROUP_DEPTH) {
                items.push({
                  label: 'New sub-group',
                  glyph: '📁',
                  testId: `group-new-subgroup-${group.id}`,
                  onClick: () => ctx.setModal({ kind: 'group', parentId: group.id })
                })
              }
              ctx.openRowMenu(e, items)
            }}
          />
          <KebabButton
            testId={`group-menu-${group.id}`}
            onOpen={(e) =>
              ctx.openRowMenu(e, [
                {
                  label: 'Move up',
                  glyph: '↑',
                  disabled: gi <= 0,
                  testId: `group-move-up-${group.id}`,
                  onClick: () => ctx.moveGroupBtn(group, -1)
                },
                {
                  label: 'Move down',
                  glyph: '↓',
                  disabled: gi >= siblings.length - 1,
                  testId: `group-move-down-${group.id}`,
                  onClick: () => ctx.moveGroupBtn(group, 1)
                },
                {
                  label: 'Edit',
                  glyph: '✎',
                  testId: `group-edit-${group.id}`,
                  onClick: () => ctx.setModal({ kind: 'group', group })
                },
                {
                  // T-183 — highlight toggle on groups AND sub-groups; label names the current-
                  // state action (house rule). Works at any depth (same kebab for both tiers).
                  label: group.highlighted ? 'Remove highlight' : 'Highlight',
                  glyph: '✦',
                  testId: `group-highlight-${group.id}`,
                  onClick: () => ctx.updateGroup(group.id, { highlighted: !group.highlighted })
                },
                // T-190 — "Change color" on groups & sub-groups (depth-agnostic, same kebab).
                colorMenuItem(
                  group.color,
                  (color) => ctx.updateGroup(group.id, { color }),
                  `group-${group.id}`
                ),
                {
                  label: 'Delete',
                  glyph: <TrashGlyph />,
                  danger: true,
                  testId: `group-delete-${group.id}`,
                  onClick: () => ctx.setModal({ kind: 'confirm-group', group })
                }
              ] satisfies KebabItem[])
            }
          />
        </span>
      </div>
      {/* T-140 — a collapsed group hides its child projects AND sub-groups; only the header row
          stays. Nested sub-groups keep their own independent collapse state, restored when the
          parent expands again (their ids persist regardless of ancestor collapse). */}
      {!collapsed && (
        <>
          {members.length > 0 ? (
            <ul className={styles.list} data-testid={`group-list-${group.id}`}>
              {members.map((p) => (
                <ProjectRow key={p.id} project={p} siblings={members} depth={depth} ctx={ctx} />
              ))}
            </ul>
          ) : (
            kids.length === 0 && (
              <div
                className={styles.groupEmpty}
                style={{ paddingLeft: `calc(var(--space-6) + ${(depth - 1) * INDENT_STEP}px)` }}
                data-testid={`group-empty-${group.id}`}
                {...dnd.groupEmptyHandlers(group)}
              >
                No projects
              </div>
            )
          )}
          {kids.map((k) => (
            <GroupSection key={k.id} group={k} depth={depth + 1} ctx={ctx} />
          ))}
        </>
      )}
    </section>
  )
}
