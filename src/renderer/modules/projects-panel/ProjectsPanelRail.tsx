// Pomade — the collapsed Projects panel rail (E-007/E-015). A thin launcher strip: the workspace
// launcher first, then the top-level order (groups + Ungrouped) FLATTENED depth-first — each
// group's subtree is emitted as sub-group markers (tier-sized by depth) each followed by its
// project launchers. Separators appear only between TOP-LEVEL sections. T-074: a group whose
// SUBTREE holds no project contributes nothing at all — no marker and no separator — and every
// glyph is the same size as in the expanded Projects panel (project 16px, group tiers 40/32/24/16, gear
// --control-icon). Read-only: it launches (setActiveProject) and expands (toggleCollapsed) only.

import {
  WORKSPACE_PROJECT_ID,
  type Group,
  type Id,
  type Project,
  type WorkspaceIdentity
} from '@shared/types'
import { summarizeScope } from '@shared/git-state'
import { WORKSPACE_PROJECT } from '../../stores/workspace-store'
import { GitRailDot, gitSummaryLines, useGitSnapshot } from '../git/GitBadge'
import { childGroups, subtreeHasProjects, UNGROUPED_ID } from './reorder'
import { Tooltip } from '../../components/Tooltip'
import {
  AttentionCounter,
  ProjectIcon,
  RailGroupMarker,
  rowColorVars,
  WorkspaceIcon
} from './projects-panel-parts'
import styles from './ProjectsPanel.module.css'

export function ProjectsPanelRail({
  groups,
  projects,
  projectsByGroup,
  groupsById,
  collapsedGroupSet,
  topTokens,
  ungrouped,
  activeProjectId,
  attentionCounts,
  flashProjectId,
  identity,
  setActiveProject,
  toggleCollapsed,
  openSettings
}: {
  groups: Group[]
  projects: Project[]
  projectsByGroup: Map<string, Project[]>
  groupsById: Map<string, Group>
  collapsedGroupSet: Set<string>
  topTokens: string[]
  ungrouped: Project[]
  activeProjectId: Id
  attentionCounts: Record<Id, number>
  flashProjectId: Id | null
  identity: WorkspaceIdentity | undefined
  setActiveProject: (id: Id) => void
  toggleCollapsed: () => void | Promise<void>
  openSettings: () => void
}): React.JSX.Element {
  const railTotal = Object.values(attentionCounts).reduce((sum, n) => sum + n, 0)
  // E-036 — the git mark per launcher: a corner dot, with the badge's lines in the tooltip.
  const gitSnapshot = useGitSnapshot()
  const wsGit = summarizeScope(gitSnapshot, null)
  const renderRailProject = (p: Project): React.JSX.Element => {
    const git = summarizeScope(gitSnapshot, p.rootPath)
    return (
      <Tooltip key={p.id} lines={[p.name, ...gitSummaryLines(git)]}>
        <button
          type="button"
          className={`${styles.railProject} ${p.id === activeProjectId ? styles.railProjectActive : ''} ${
            p.id === flashProjectId ? styles.revealFlash : ''
          }`}
          aria-label={p.name}
          data-testid={`rail-project-${p.id}`}
          data-project-row={p.id}
          data-reveal-flash={p.id === flashProjectId ? 'true' : undefined}
          data-active={p.id === activeProjectId}
          // T-190 — colored rail launcher: a full-bg chip (soft; medium when highlighted) + a
          // 2-tone-darker ring when active (neutral-gray ring when uncolored). Driven by these vars.
          data-color={p.color}
          style={rowColorVars(p.color, p.highlighted)}
          onClick={() => setActiveProject(p.id)}
        >
          <ProjectIcon project={p} />
          <AttentionCounter count={attentionCounts[p.id] ?? 0} testId={`rail-attention-${p.id}`} />
          <GitRailDot summary={git} testId={`rail-git-${p.id}`} />
        </button>
      </Tooltip>
    )
  }
  const railSubtree = (group: Group, depth: number): React.JSX.Element[] => {
    // T-074 — an empty subtree is rail-invisible (reappears as soon as a project lands in it).
    if (!subtreeHasProjects(groups, projects, group.id)) return []
    const marker = (
      <RailGroupMarker
        key={`m-${group.id}`}
        group={group}
        depth={depth}
        onExpand={() => void toggleCollapsed()}
      />
    )
    // T-140 — a collapsed group hides its projects + sub-groups here too (shared state); only its
    // marker stays, matching the expanded Projects panel. Clicking the marker expands the Projects panel.
    if (collapsedGroupSet.has(group.id)) return [marker]
    const out: React.JSX.Element[] = [
      marker,
      ...(projectsByGroup.get(group.id) ?? []).map((p) => renderRailProject(p))
    ]
    for (const k of childGroups(groups, group.id)) out.push(...railSubtree(k, depth + 1))
    return out
  }
  // Sections in top-level order; a separator precedes each section that renders anything (the
  // workspace launcher always sits above, so a separator never dangles).
  const railBody: React.JSX.Element[] = []
  for (const token of topTokens) {
    if (token === UNGROUPED_ID) {
      if (ungrouped.length === 0) continue
      railBody.push(
        <div
          key="sep-ungrouped"
          className={styles.railSeparator}
          role="separator"
          data-testid="rail-separator-ungrouped"
        />,
        ...ungrouped.map((p) => renderRailProject(p))
      )
      continue
    }
    const group = groupsById.get(token)
    if (!group) continue
    const items = railSubtree(group, 1)
    if (items.length === 0) continue
    railBody.push(
      <div
        key={`sep-${group.id}`}
        className={styles.railSeparator}
        role="separator"
        data-testid={`rail-separator-${group.id}`}
      />,
      ...items
    )
  }
  return (
    <nav className={styles.rail} aria-label="Projects (collapsed)" data-testid="projects-panel-rail">
      <Tooltip lines={['Expand Projects panel (Cmd+B)']}>
        <button
          type="button"
          className={styles.railBtn}
          aria-label="Expand Projects panel"
          data-testid="projects-panel-expand"
          onClick={() => void toggleCollapsed()}
        >
          »
          <AttentionCounter count={railTotal} testId="projects-panel-rail-attention" />
        </button>
      </Tooltip>
      <div className={styles.railList} data-reveal-scroll>
        <Tooltip lines={[WORKSPACE_PROJECT.name, ...gitSummaryLines(wsGit)]}>
          <button
            type="button"
            className={`${styles.railProject} ${styles.railWorkspace} ${activeProjectId === WORKSPACE_PROJECT_ID ? styles.railProjectActive : ''} ${
              flashProjectId === WORKSPACE_PROJECT_ID ? styles.revealFlash : ''
            }`}
            aria-label={WORKSPACE_PROJECT.name}
            data-testid={`rail-project-${WORKSPACE_PROJECT_ID}`}
            data-project-row={WORKSPACE_PROJECT_ID}
            data-reveal-flash={flashProjectId === WORKSPACE_PROJECT_ID ? 'true' : undefined}
            data-active={activeProjectId === WORKSPACE_PROJECT_ID}
            onClick={() => setActiveProject(WORKSPACE_PROJECT_ID)}
          >
            <WorkspaceIcon
              identity={identity}
              chipClass={styles.railWorkspaceIcon}
              emojiClass={styles.railWorkspaceEmoji}
            />
            <AttentionCounter
              count={attentionCounts[WORKSPACE_PROJECT_ID] ?? 0}
              testId={`rail-attention-${WORKSPACE_PROJECT_ID}`}
            />
            <GitRailDot summary={wsGit} testId={`rail-git-${WORKSPACE_PROJECT_ID}`} />
          </button>
        </Tooltip>
        {railBody}
      </div>
      {/* Settings must stay reachable while collapsed — gear only (no room for a label). */}
      <div className={styles.railFooter}>
        <Tooltip lines={['Settings (Cmd+,)']}>
          <button
            type="button"
            className={styles.railBtn}
            aria-label="Settings"
            data-testid="rail-settings"
            onClick={() => openSettings()}
          >
            {/* T-074 — same test id as the expanded footer gear (only one of the two ever
                mounts) so e2e can assert glyph-size parity across the surfaces. */}
            <span className={styles.settingsGear} data-testid="settings-gear" aria-hidden="true">
              ⚙
            </span>
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}
