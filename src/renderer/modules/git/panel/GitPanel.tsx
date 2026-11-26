// Pomade — E-037: the Git panel (built-in side panel, next to Files). Reading only: which repos
// exist and whether they are safe (uncommitted / unpushed / behind, remote or local only), what is
// uncommitted, and what landed. Scope follows the Projects panel selection:
//   Workspace row        → All repositories (every discovered repo), drill in, back arrow
//   project, one repo    → that repo's view directly
//   project, 2+ repos    → the list limited to the project, drill in, back arrow
// Live: the repo list and Changes are the git-state snapshot (main refreshes it on watcher and
// git-metadata changes); History reloads when the repo's HEAD moves. Detail opens as tabs.
//
// Mounted for the life of the side panel (hidden, never unmounted); it fetches History only while
// it is the shown panel. The operation dialog lives outside it (GitOpDialogHost), so the conflict
// tab can open one while the column is collapsed.
//
// T-320 — an app's `git.reveal` leaves a one-shot request in git-panel-store: once the panel shows
// for that project, the list's row scrolls into view; a repo view already showing the repo (one repo
// in scope, or drilled into it) is the reveal itself.

import { useEffect, useMemo } from 'react'

import { reposInScope, type RepoState } from '@shared/git-state'
import { WORKSPACE_PROJECT_ID } from '@shared/types'
import { Tooltip } from '../../../components/Tooltip'
import { useAppSettingsStore } from '../../../stores/app-settings-store'
import { useSidePanelStore } from '../../../stores/side-panel-store'
import { buildAllProjects, useWorkspaceStore } from '../../../stores/workspace-store'
import { useGitStateStore, useGitStateSubscription } from '../git-state-store'
import { useGitPanelStore } from './git-panel-store'
import { RepoList } from './RepoList'
import { RepoView } from './RepoView'
import styles from './GitPanel.module.css'

/** The Git panel's strip key. */
export const GIT_PANEL = 'git'

export function GitPanel(): React.JSX.Element {
  useGitStateSubscription()
  const snapshot = useGitStateStore((s) => s.snapshot)
  const loaded = useGitStateStore((s) => s.loaded)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const projects = useWorkspaceStore((s) => s.projects)
  const collapsed = useAppSettingsStore((s) => s.layout.fileTreeCollapsed)
  const setCollapsed = useAppSettingsStore((s) => s.setFileTreeCollapsed)
  const selected = useSidePanelStore((s) => s.selectedByProject[activeProjectId])
  const drilled = useGitPanelStore((s) => s.drillByProject[activeProjectId])
  const drill = useGitPanelStore((s) => s.drill)
  const revealRequest = useGitPanelStore((s) => s.revealRequest)
  const consumeReveal = useGitPanelStore((s) => s.consumeReveal)
  const visible = selected === GIT_PANEL && !collapsed
  const pendingReveal = visible && loaded && revealRequest?.projectId === activeProjectId ? revealRequest : null

  const project = useMemo(
    () => buildAllProjects(projects).find((p) => p.id === activeProjectId),
    [projects, activeProjectId]
  )
  const isWorkspace = activeProjectId === WORKSPACE_PROJECT_ID
  const scopeRoot = isWorkspace ? null : (project?.rootPath ?? null)
  const repos = useMemo(() => reposInScope(snapshot, scopeRoot), [snapshot, scopeRoot])

  const single = repos.length === 1 ? repos[0] : null
  const current: RepoState | null = single ?? repos.find((r) => r.root === drilled) ?? null
  const listTitle = isWorkspace ? 'All repositories' : `Repositories in ${project?.name ?? 'this project'}`

  // The list's row performs a reveal it shows; anything else is done (or moot) once the panel shows.
  useEffect(() => {
    if (pendingReveal && (current || !repos.some((r) => r.root === pendingReveal.root))) consumeReveal(pendingReveal.nonce)
  }, [pendingReveal, current, repos, consumeReveal])

  return (
    <aside className={styles.panel} aria-label="Git" data-testid="git-panel" data-scope={scopeRoot ?? ''}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>Git</span>
        <span className={styles.headerActions}>
          <Tooltip lines={['Collapse side panel (Cmd+Shift+B)']}>
            <button
              type="button"
              className={styles.headerBtn}
              aria-label="Collapse side panel"
              data-testid="git-panel-collapse"
              onClick={() => void setCollapsed(true)}
            >
              «
            </button>
          </Tooltip>
        </span>
      </div>
      <div className={styles.body} data-testid="git-panel-body">
        {!loaded ? (
          <div className={styles.empty}>Looking for repositories…</div>
        ) : repos.length === 0 ? (
          <div className={styles.empty} data-testid="git-panel-empty">
            {isWorkspace ? 'No git repositories in this workspace.' : 'This project is not in a git repository.'}
          </div>
        ) : current ? (
          <RepoView
            key={current.root}
            repo={current}
            visible={visible}
            projectId={activeProjectId}
            onBack={single ? undefined : () => drill(activeProjectId, undefined)}
            backLabel={listTitle}
          />
        ) : (
          <RepoList
            title={listTitle}
            repos={repos}
            onOpen={(root) => drill(activeProjectId, root)}
            reveal={pendingReveal}
            onRevealed={consumeReveal}
          />
        )}
      </div>
    </aside>
  )
}
