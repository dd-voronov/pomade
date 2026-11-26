// Pomade — Projects panel (Wave 2a; E-010 identity + organization; E-015 nested groups). The
// Workspace project is pinned & undeletable at the very top; then the TOP-LEVEL
// ordering of groups + the draggable Ungrouped pseudo-group; groups form a TREE (max depth 4)
// with tier-scaled icons (40/32/24/16px) and per-depth indentation. Create/edit/delete groups
// & projects via modals; a group's "+" is a menu (New project / New sub-group).
// E-015: drag-and-drop is reworked to the E-012 file-tree center-vs-edge model — a group
// header's vertical CENTER drops INTO it (nest), its top/bottom EDGE reorders before/after
// (sibling). Selecting a project flips activeProjectId (the PaneHost invariant).
//
// This file is the orchestrator: store wiring, the derived view data, and the top-level layout.
// The recursive row/section markup lives in ProjectRow / GroupSection / UngroupedSection (fed the
// shared `ProjectsPanelCtx`), the two interleaved DnD systems in `useProjectsPanelDnd`, and the presentational
// leaves + the collapsed rail's icons in `projects-panel-parts`.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { WORKSPACE_PROJECT_ID, type Group, type Id, type Project } from '@shared/types'
import {
  WORKSPACE_PROJECT,
  useWorkspaceStore
} from '../../stores/workspace-store'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useNewProjectStore } from '../../stores/new-project-store'
import { useProjectRowCounts } from '../../stores/marks-store'
import { useTabsStore } from '../../stores/tabs-store'
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store'
import { UNGROUPED_ID, childGroups, subtreeAttentionSum, topLevelTokens } from './reorder'
import { GroupModal } from './GroupModal'
import { ProjectModal } from './ProjectModal'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { WorkspaceIconModal } from './WorkspaceIconModal'
import { useSettingsStore } from '../settings'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { Tooltip } from '../../components/Tooltip'
import { AttentionCounter, IconBtn, WorkspaceIcon, type KebabItem } from './projects-panel-parts'
import { GitBadge } from '../git/GitBadge'
import { GroupSection } from './GroupSection'
import { UngroupedSection } from './UngroupedSection'
import { ProjectsPanelRail } from './ProjectsPanelRail'
import type { ModalState, ProjectsPanelCtx } from './tree-context'
import { useProjectsPanelDnd } from './useProjectsPanelDnd'
import { pickProject, useRevealActiveProject } from './useRevealActiveProject'
import styles from './ProjectsPanel.module.css'

/** T-060 / T-190 — map a KebabItem onto the shared ContextMenu's MenuItem, recursively for the
 *  "Change color" submenu (radio rows via `checked`). One mapper for every row-menu row. */
function kebabToMenuItem(it: KebabItem): MenuItem {
  return {
    label: it.label,
    glyph: it.glyph,
    testId: it.testId,
    disabled: it.disabled,
    danger: it.danger,
    checked: it.checked,
    onSelect: it.onClick,
    submenu: it.submenu?.map(kebabToMenuItem),
    submenuTestId: it.submenuTestId
  }
}

/** Swap the order values of the item and its neighbour in `siblings`, within `full`. */
function moveWithin<T extends { id: string; order: number }>(
  full: T[],
  siblings: T[],
  id: string,
  dir: -1 | 1
): T[] {
  const idx = siblings.findIndex((s) => s.id === id)
  const j = idx + dir
  if (idx < 0 || j < 0 || j >= siblings.length) return full
  const a = siblings[idx]
  const b = siblings[j]
  return full.map((p) =>
    p.id === a.id ? { ...p, order: b.order } : p.id === b.id ? { ...p, order: a.order } : p
  )
}

export function ProjectsPanel(): React.JSX.Element {
  const groups = useWorkspaceStore((s) => s.groups)
  const projects = useWorkspaceStore((s) => s.projects)
  const ungroupedOrder = useWorkspaceStore((s) => s.ungroupedOrder)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const addGroup = useWorkspaceStore((s) => s.addGroup)
  const updateGroup = useWorkspaceStore((s) => s.updateGroup)
  const deleteGroup = useWorkspaceStore((s) => s.deleteGroup)
  const addProject = useWorkspaceStore((s) => s.addProject)
  const updateProject = useWorkspaceStore((s) => s.updateProject)
  const deleteProject = useWorkspaceStore((s) => s.deleteProject)
  const reorder = useWorkspaceStore((s) => s.reorder)
  const identity = useWorkspaceStore((s) => s.identity)
  const setWorkspaceIdentity = useWorkspaceStore((s) => s.setWorkspaceIdentity)

  // T-311 — a switch Pomade makes on its own reveals and flashes the row; the panel's own picks
  // go through `pickProject` so they don't.
  const flashProjectId = useRevealActiveProject(activeProjectId)

  // T-140 — collapsed group/sub-group ids (workspace-scoped, persisted). Every real group can
  // collapse independently of its parent; the Workspace row is excluded (it has no toggle).
  const collapsedGroups = useWorkspaceUiStore((s) => s.collapsedGroups)
  const toggleGroupCollapsed = useWorkspaceUiStore((s) => s.toggleGroupCollapsed)
  const collapsedGroupSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups])

  const openSettings = useSettingsStore((s) => s.openSettings)

  // E-007 (T-030) — collapse to a thin rail. When collapsed the Projects panel renders only the
  // always-visible expand affordance (never a vanished panel).
  const collapsed = useAppSettingsStore((s) => s.layout.projectsPanelCollapsed)
  const toggleCollapsed = useAppSettingsStore((s) => s.toggleProjectsPanelCollapsed)

  // E-011 / T-151 — per-project attention counts, LIVE-DERIVED from the tab set: a project's
  // count = the number of its tabs currently carrying the unread dot (`tab.attention`, all kinds).
  // No gating on the active project (a mark-unread in the open project shows immediately) and no
  // reset on open (the count decrements naturally as unread tabs are activated — setActive clears
  // the dot on the activation edge). E-032 — read through the marks mechanism (marks-store): the
  // tab dots are the rows' derived source, combined with any marks set on project rows. T-181 —
  // the derivation runs inside a shallow-compared selector, so an unrelated tab field change keeps
  // the same counts object and the Projects panel does not re-render for it.
  const attentionCounts = useProjectRowCounts()

  // T-186 — a COLLAPSED group's header shows the SUM of `attentionCounts` across every project
  // in its subtree (sub-groups included, recursive) in place of the now-hidden per-project
  // badges; an expanded group shows none (its members' own badges are visible instead). Purely
  // derived from `attentionCounts` (T-151) and the group tree — no new persisted state.
  const groupAttentionCounts = useMemo(() => {
    const out: Record<Id, number> = {}
    for (const g of groups) out[g.id] = subtreeAttentionSum(groups, projects, g.id, attentionCounts)
    return out
  }, [groups, projects, attentionCounts])

  const [modal, setModal] = useState<ModalState>({ kind: 'none' })
  const close = (): void => setModal({ kind: 'none' })

  // T-182 — the file tree's "Start new project from here" dispatches a request through the
  // new-project store; open the create-project wizard pre-filled at that folder, in existing-
  // folder mode. The `nonce` guard makes each fresh request (incl. the same folder twice) reopen.
  const newProjectRequest = useNewProjectStore((s) => s.request)
  const lastNewProjectNonce = useRef<number | null>(null)
  useEffect(() => {
    if (!newProjectRequest || newProjectRequest.nonce === lastNewProjectNonce.current) return
    lastNewProjectNonce.current = newProjectRequest.nonce
    setModal({
      kind: 'project',
      initialRootPath: newProjectRequest.rootPath,
      initialCreateMode: 'existing'
    })
  }, [newProjectRequest])

  // T-082 — the running app's version, shown next to Settings in the footer (packaged:
  // Info.plist version; dev: package.json). Fetched once; '' until it arrives.
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    let live = true
    void window.pomade.app.version().then((v) => {
      if (live) setAppVersion(v)
    })
    return () => {
      live = false
    }
  }, [])

  // E-010 (round-3) — right-click menu on the Workspace row ("Change icon…").
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number } | null>(null)

  // T-060 — the ONE open kebab / "+" menu. Held at the ProjectsPanel level so the menu keeps
  // rendering after the mouse leaves the row. Positioned from the trigger's bounding box.
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; items: KebabItem[] } | null>(
    null
  )
  const openRowMenu = (e: React.MouseEvent, items: KebabItem[]): void => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    setRowMenu({ x: r.left, y: r.bottom + 2, items })
  }

  // E-010/E-015/T-073 reorder DnD + T-104 tab-drop DnD, both interleaved, in one hook.
  const moveTabToProject = useTabsStore((s) => s.moveTabToProject)
  const dnd = useProjectsPanelDnd({
    groups,
    projects,
    ungroupedOrder,
    activeProjectId,
    reorder,
    moveTabToProject
  })

  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const projectsByGroup = useMemo(() => {
    const map = new Map<string, Project[]>()
    for (const p of [...projects].sort((a, b) => a.order - b.order)) {
      const key = p.groupId ?? ''
      const list = map.get(key) ?? []
      list.push(p)
      map.set(key, list)
    }
    return map
  }, [projects])
  const ungrouped = projectsByGroup.get('') ?? []
  // E-015 — the top-level display order: top-level groups interleaved with the Ungrouped
  // pseudo-group at its stored position (UNGROUPED_ID sentinel).
  const topTokens = useMemo(
    () => topLevelTokens(groups, ungroupedOrder),
    [groups, ungroupedOrder]
  )
  // Groups in tree (pre-order) for the project modal's group <select> — labels stay plain
  // names (e2e matches them exactly), only the ORDER reflects the hierarchy.
  const groupsForModal = useMemo(() => {
    const out: Group[] = []
    const walk = (parentId: string | undefined): void => {
      for (const g of childGroups(groups, parentId)) {
        out.push(g)
        walk(g.id)
      }
    }
    walk(undefined)
    return out
  }, [groups])

  const saveGroup = (g: Group): void => {
    if (groups.some((x) => x.id === g.id)) updateGroup(g.id, g)
    else addGroup(g)
  }
  const saveProject = (p: Project): void => {
    if (projects.some((x) => x.id === p.id)) updateProject(p.id, p)
    else {
      addProject(p)
      pickProject(p.id)
    }
  }

  // Move a group up/down among its SIBLINGS (same parent); keyboard fallback via the kebab.
  const moveGroupBtn = (group: Group, dir: -1 | 1): void =>
    reorder(moveWithin(groups, childGroups(groups, group.parentId), group.id, dir), projects)
  const moveProjectBtn = (id: string, siblings: Project[], dir: -1 | 1): void =>
    reorder(groups, moveWithin(projects, siblings, id, dir))

  // The bundle threaded through the recursive expanded tree (rows + sections).
  const ctx: ProjectsPanelCtx = {
    groups,
    projectsByGroup,
    collapsedGroupSet,
    activeProjectId,
    attentionCounts,
    groupAttentionCounts,
    flashProjectId,
    setActiveProject: pickProject,
    toggleGroupCollapsed,
    updateProject,
    updateGroup,
    setModal,
    moveProjectBtn,
    moveGroupBtn,
    openRowMenu,
    dnd
  }

  // Collapsed: a thin rail (E-007/E-015) — the flattened launcher strip lives in ProjectsPanelRail.
  if (collapsed) {
    return (
      <ProjectsPanelRail
        groups={groups}
        projects={projects}
        projectsByGroup={projectsByGroup}
        groupsById={groupsById}
        collapsedGroupSet={collapsedGroupSet}
        topTokens={topTokens}
        ungrouped={ungrouped}
        activeProjectId={activeProjectId}
        attentionCounts={attentionCounts}
        flashProjectId={flashProjectId}
        identity={identity}
        setActiveProject={pickProject}
        toggleCollapsed={toggleCollapsed}
        openSettings={openSettings}
      />
    )
  }

  return (
    <nav className={styles.projectsPanel} aria-label="Projects">
      <div className={styles.header}>
        <span>Projects</span>
        <span className={styles.headerActions}>
          <IconBtn
            label="Collapse Projects panel"
            glyph="«"
            testId="projects-panel-collapse"
            onClick={() => void toggleCollapsed()}
          />
          <IconBtn
            label="New group"
            glyph="⊞"
            testId="new-group"
            onClick={() => setModal({ kind: 'group' })}
          />
          <IconBtn
            label="New project"
            glyph="+"
            testId="new-project"
            onClick={() => setModal({ kind: 'project' })}
          />
        </span>
      </div>

      {/* T-125 — only the project list scrolls; header above and footer below stay pinned
          (mirrors the rail's railList/railFooter split). */}
      <div className={styles.scroll} data-testid="projects-panel-scroll" data-reveal-scroll>
      {/* Pinned, undeletable Workspace project. T-059: the WHOLE row box opens the
          workspace (click anywhere — text, empty space, corners; keyboard via role/tabindex),
          EXCEPT the icon, which is its own button opening the change-icon modal (it stops
          propagation). Right-click anywhere still opens the "Change icon…" menu. */}
      <ul className={styles.list}>
        <li>
          <div
            className={`${styles.item} ${styles.workspaceItem} ${
              activeProjectId === WORKSPACE_PROJECT_ID ? styles.active : ''
            } ${dnd.tabDropTargetId === WORKSPACE_PROJECT_ID ? styles.tabDropTarget : ''} ${
              flashProjectId === WORKSPACE_PROJECT_ID ? styles.revealFlash : ''
            }`}
            data-testid={`project-${WORKSPACE_PROJECT_ID}`}
            data-project-row={WORKSPACE_PROJECT_ID}
            data-reveal-flash={flashProjectId === WORKSPACE_PROJECT_ID ? 'true' : undefined}
            data-active={activeProjectId === WORKSPACE_PROJECT_ID}
            data-tab-drop-target={dnd.tabDropTargetId === WORKSPACE_PROJECT_ID ? 'true' : undefined}
            role="button"
            tabIndex={0}
            aria-label={`Open ${WORKSPACE_PROJECT.name}`}
            onClick={() => pickProject(WORKSPACE_PROJECT_ID)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                pickProject(WORKSPACE_PROJECT_ID)
              }
            }}
            // T-104 — the Workspace project row is a valid tab MOVE target too (it is one in
            // the menu picker). Only the tab-drag branch is wired; it has no reorder DnD of its own.
            onDragOver={(e) => {
              dnd.tabDragOverRow(e, WORKSPACE_PROJECT_ID)
            }}
            onDrop={(e) => {
              dnd.tabDropOnRow(e, WORKSPACE_PROJECT_ID)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setWsMenu({ x: e.clientX, y: e.clientY })
            }}
          >
            <Tooltip lines={['Change workspace icon']}>
              <button
                type="button"
                className={styles.workspaceIconBtn}
                aria-label="Change workspace icon"
                data-testid="workspace-icon-button"
                onClick={(e) => {
                  e.stopPropagation()
                  setModal({ kind: 'workspace-icon' })
                }}
              >
                <WorkspaceIcon
                  identity={identity}
                  chipClass={styles.workspaceIcon}
                  emojiClass={styles.workspaceIconEmoji}
                  testId="workspace-icon"
                />
              </button>
            </Tooltip>
            <span className={styles.name}>{WORKSPACE_PROJECT.name}</span>
            <GitBadge scopeRoot={null} testId={`project-git-${WORKSPACE_PROJECT_ID}`} />
            <AttentionCounter
              count={attentionCounts[WORKSPACE_PROJECT_ID] ?? 0}
              testId={`project-attention-${WORKSPACE_PROJECT_ID}`}
            />
          </div>
        </li>
      </ul>

      {/* E-015 — top-level order: groups (each a subtree) interleaved with the draggable
          Ungrouped pseudo-group at its stored position. */}
      {topTokens.map((token) => {
        if (token === UNGROUPED_ID)
          return (
            <Fragment key="ungrouped">
              <UngroupedSection ungrouped={ungrouped} ctx={ctx} />
            </Fragment>
          )
        const group = groupsById.get(token)
        return group ? (
          <Fragment key={group.id}>
            <GroupSection group={group} depth={1} ctx={ctx} />
          </Fragment>
        ) : null
      })}

      {/* E-015 — the Projects panel body below everything is a "reorder to the end of the top level"
          drop zone for group / Ungrouped drags. Grows to fill free space. T-074: it also accepts
          a PROJECT — dropping one below everything moves it OUT of its group (→ Ungrouped), which
          keeps "un-group a project" possible while the Ungrouped section is hidden (empty). */}
      <div
        className={`${styles.belowAll} ${dnd.dropInd?.kind === 'end' ? styles.dropEnd : ''}`}
        data-testid="projects-panel-below-all"
        {...dnd.belowAllHandlers()}
      />
      </div>

      {/* Footer: the ONE obvious Settings entry (unified surface). Pinned bottom-left of the
          Projects panel with a text label beside the gear so it can't hide (T-028 discoverability). */}
      <div className={styles.footer}>
        <Tooltip lines={['Settings (Cmd+,)']}>
        <button
          type="button"
          className={styles.settingsBtn}
          aria-label="Settings"
          data-testid="projects-panel-settings"
          onClick={() => openSettings()}
        >
          <span className={styles.settingsGear} data-testid="settings-gear" aria-hidden="true">
            ⚙
          </span>
          <span>Settings</span>
        </button>
        </Tooltip>
        {/* T-082 — current app version, quiet and always in the same corner. */}
        {appVersion && (
          <span className={styles.version} data-testid="app-version">
            v{appVersion}
          </span>
        )}
      </div>

      {/* Modals. */}
      {modal.kind === 'group' && (
        <GroupModal
          group={modal.group}
          parentId={modal.parentId}
          nextOrder={
            childGroups(groups, modal.group?.parentId ?? modal.parentId).reduce(
              (m, g) => Math.max(m, g.order),
              -1
            ) + 1
          }
          onSave={saveGroup}
          onClose={close}
        />
      )}
      {modal.kind === 'project' && (
        <ProjectModal
          project={modal.project}
          groups={groupsForModal}
          projects={projects}
          defaultGroupId={modal.defaultGroupId}
          initialRootPath={modal.initialRootPath}
          initialCreateMode={modal.initialCreateMode}
          onSave={saveProject}
          onClose={close}
        />
      )}
      {modal.kind === 'confirm-project' && (
        <ConfirmDialog
          title="Delete project?"
          message={`“${modal.project.name}” will be removed from this workspace's config. Files on disk are left untouched.`}
          onConfirm={() => deleteProject(modal.project.id)}
          onClose={close}
        />
      )}
      {modal.kind === 'confirm-group' && (
        <ConfirmDialog
          title="Delete group?"
          message={`“${modal.group.name}” will be removed. Its projects move to Ungrouped and any sub-groups move up one level (nothing is deleted). Files on disk are untouched.`}
          onConfirm={() => deleteGroup(modal.group.id)}
          onClose={close}
        />
      )}
      {modal.kind === 'workspace-icon' && (
        <WorkspaceIconModal
          identity={identity}
          onSave={setWorkspaceIdentity}
          onClose={close}
        />
      )}

      {/* E-010 (round-3) — Workspace-row context menu: the ONE minimal action, "Change icon…". */}
      {wsMenu && (
        <ContextMenu
          x={wsMenu.x}
          y={wsMenu.y}
          onClose={() => setWsMenu(null)}
          testId="workspace-context-menu"
          scrimTestId="workspace-menu-scrim"
          items={[
            {
              label: 'Change icon…',
              testId: 'workspace-change-icon',
              onSelect: () => setModal({ kind: 'workspace-icon' })
            }
          ]}
        />
      )}

      {/* T-060 — the shared row kebab / "+" menu. Rendered here, at the ProjectsPanel level, so it
          outlives the hover-only .rowActions that hosts its trigger. */}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          testId="row-menu"
          scrimTestId="row-menu-scrim"
          items={rowMenu.items.map<MenuItem>(kebabToMenuItem)}
        />
      )}
    </nav>
  )
}
