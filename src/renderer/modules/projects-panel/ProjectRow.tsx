// Pomade — one project row in the expanded Projects panel: the selectable/draggable item button (icon +
// name + optional area + live attention counter) and its hover kebab (⋮) menu. Selecting flips
// activeProjectId (the PaneHost invariant). The row is BOTH a reorder-DnD source/target and a
// tab-drop MOVE target (T-104) — both wired through the one `useProjectsPanelDnd` bundle in `ctx.dnd`.

import type { Project } from '@shared/types'
import {
  AttentionCounter,
  colorMenuItem,
  INDENT_STEP,
  KebabButton,
  ProjectIcon,
  rowColorVars,
  TrashGlyph,
  type KebabItem
} from './projects-panel-parts'
import type { ProjectsPanelCtx } from './tree-context'
import { GitBadge } from '../git/GitBadge'
import styles from './ProjectsPanel.module.css'

export function ProjectRow({
  project,
  siblings,
  depth,
  ctx
}: {
  project: Project
  siblings: Project[]
  depth: number
  ctx: ProjectsPanelCtx
}): React.JSX.Element {
  const { activeProjectId, setActiveProject, attentionCounts, dnd, openRowMenu } = ctx
  const active = project.id === activeProjectId
  const flash = project.id === ctx.flashProjectId
  const idx = siblings.findIndex((s) => s.id === project.id)
  // T-190 — the color tone vars live on the <li> so the .item (fill/border) AND the sibling
  // .rowActions (kebab fade slab) both inherit them; `data-color` on the button drives the CSS.
  const colorVars = rowColorVars(project.color, project.highlighted)
  const liStyle =
    depth > 0 || colorVars ? { ...(depth > 0 ? { paddingLeft: depth * INDENT_STEP } : {}), ...colorVars } : undefined
  return (
    <li
      key={project.id}
      className={`${styles.projectRow} ${dnd.rowDropClass(project.id)}`}
      style={liStyle}
    >
      <button
        type="button"
        className={`${styles.item} ${active ? styles.active : ''} ${
          dnd.tabDropTargetId === project.id ? styles.tabDropTarget : ''
        } ${flash ? styles.revealFlash : ''}`}
        data-testid={`project-${project.id}`}
        data-project-row={project.id}
        data-reveal-flash={flash ? 'true' : undefined}
        data-active={active}
        data-color={project.color}
        data-tab-drop-target={dnd.tabDropTargetId === project.id ? 'true' : undefined}
        onClick={() => setActiveProject(project.id)}
        {...dnd.projectRowHandlers(project)}
      >
        <ProjectIcon project={project} />
        <span
          className={`${styles.name} ${project.highlighted ? styles.highlighted : ''}`}
          data-testid={`project-name-${project.id}`}
          data-highlighted={project.highlighted ? 'true' : undefined}
        >
          {project.name}
        </span>
        {project.area && <span className={styles.area}>{project.area}</span>}
        <GitBadge scopeRoot={project.rootPath} testId={`project-git-${project.id}`} counterSlot />
        <AttentionCounter
          count={attentionCounts[project.id] ?? 0}
          testId={`project-attention-${project.id}`}
        />
      </button>
      <span className={styles.rowActions}>
        <KebabButton
          testId={`project-menu-${project.id}`}
          onOpen={(e) =>
            openRowMenu(e, [
              {
                label: 'Move up',
                glyph: '↑',
                disabled: idx <= 0,
                testId: `project-move-up-${project.id}`,
                onClick: () => ctx.moveProjectBtn(project.id, siblings, -1)
              },
              {
                label: 'Move down',
                glyph: '↓',
                disabled: idx >= siblings.length - 1,
                testId: `project-move-down-${project.id}`,
                onClick: () => ctx.moveProjectBtn(project.id, siblings, 1)
              },
              {
                label: 'Edit',
                glyph: '✎',
                testId: `project-edit-${project.id}`,
                onClick: () => ctx.setModal({ kind: 'project', project })
              },
              {
                // T-183 — the label always names the action available from the current state
                // (house rule): a highlighted row offers "Remove highlight", else "Highlight".
                label: project.highlighted ? 'Remove highlight' : 'Highlight',
                glyph: '✦',
                testId: `project-highlight-${project.id}`,
                onClick: () => ctx.updateProject(project.id, { highlighted: !project.highlighted })
              },
              // T-190 — "Change color": the 6 hues + None, persisted like `highlighted`.
              colorMenuItem(
                project.color,
                (color) => ctx.updateProject(project.id, { color }),
                `project-${project.id}`
              ),
              {
                label: 'Delete',
                glyph: <TrashGlyph />,
                danger: true,
                testId: `project-delete-${project.id}`,
                onClick: () => ctx.setModal({ kind: 'confirm-project', project })
              }
            ] satisfies KebabItem[])
          }
        />
      </span>
    </li>
  )
}
