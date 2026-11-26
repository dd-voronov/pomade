// Pomade — E-041: the repo view's In progress section, above History. One row per worktree and
// per branch main does not have — local rows first, then those only on a remote under a *Remote*
// label — each with its kind, commits ahead of / behind main, uncommitted changes in a worktree,
// a live agent, and its last activity; most recent first. A row opens its branch tab. With the
// agents app installed, a local row also names the agent session working on it (E-043); the link
// focuses the session's live tab or resumes the session in a new tab.

import { useEffect, useMemo } from 'react'

import { glossaryLines } from '@shared/git-glossary'
import { relativeTime } from '@shared/git-history'
import type { BranchSession, InProgressRow } from '@shared/git-branches'
import type { RepoState } from '@shared/git-state'
import type { Id, BranchTab } from '@shared/types'
import { Tooltip } from '../../../components/Tooltip'
import { useToast } from '../../../hooks/useToast'
import { useWorkspaceStore, WORKSPACE_PROJECT } from '../../../stores/workspace-store'
import { resumeAgentSession } from '../../agents/agent-tab-calls'
import { useTabsStore } from '../../../stores/tabs-store'
import { BranchGlyph, Chevron, RemoteGlyph, WorktreeGlyph } from '../icons'
import { openBranchTab } from '../open-git-tabs'
import { openInNewTabItem, useRowMenu } from '../row-menu'
import { useGitPanelStore } from '../panel/git-panel-store'
import styles from '../panel/GitPanel.module.css'
import { backgroundFetch, useAgentsKey, useBranchesStore } from './branches-store'

export function rowName(row: InProgressRow): string {
  return row.branch ?? `${row.path?.slice(row.path.lastIndexOf('/') + 1) ?? 'worktree'} (detached)`
}

/** `3 ahead · 1 behind` against main. */
export function countsLabel(row: InProgressRow, main: string | null): string {
  if (!main) return `${row.ahead} commits`
  const parts = [`${row.ahead} ahead`]
  if (row.behind > 0) parts.push(`${row.behind} behind`)
  return parts.join(' · ')
}

/** The live agents' ids, each once. */
export function agentNames(row: InProgressRow): string {
  return [...new Set(row.agents.map((a) => a.agentId))].join(', ')
}

function sessionLabel(s: BranchSession): string {
  return `${s.agentName} · ${s.name ?? 'unnamed session'}`
}

/** Focus the session's live tab, or resume it in a new tab — in its project; in the Workspace project when
 *  it has none or that project is gone (PLATFORM rule 9). */
async function openSession(session: BranchSession): Promise<string | null> {
  const ws = useWorkspaceStore.getState()
  const project = (session.projectId ? ws.projectById(session.projectId) : undefined) ?? WORKSPACE_PROJECT
  const r = await resumeAgentSession(project, {
    agentId: session.agentId,
    sessionId: session.id,
    cwd: session.cwd
  })
  return r.ok ? null : r.error.message
}

function SessionLink({ session }: { session: BranchSession }): React.JSX.Element {
  const toast = useToast()
  const live = session.live !== 'closed'
  const open = (): void => {
    void openSession(session).then((problem) => {
      if (problem) toast(`Could not open the session: ${problem}`, 'error')
    })
  }
  const stop = (e: React.SyntheticEvent): void => e.stopPropagation()
  return (
    <button
      type="button"
      className={styles.progressSession}
      data-testid="git-progress-session"
      data-live={live || undefined}
      aria-label={`${live ? 'Go to' : 'Resume'} ${sessionLabel(session)}`}
      onClick={(e) => {
        stop(e)
        open()
      }}
      onKeyDown={stop}
    >
      <span className={styles.progressSessionAgent}>{session.agentName}</span>
      <span className={styles.progressSessionSep}>·</span>
      {session.name ? (
        <span className={styles.progressSessionName}>{session.name}</span>
      ) : (
        <span className={`${styles.progressSessionName} ${styles.progressSessionUnnamed}`}>unnamed session</span>
      )}
    </button>
  )
}

function rowTip(row: InProgressRow, main: string | null): string[] {
  const kind =
    row.kind === 'worktree'
      ? `Worktree at ${row.path}`
      : row.kind === 'remote'
        ? `Only on the remote — ${row.branch}`
        : row.current
          ? 'A branch — this checkout is on it'
          : 'A branch on this Mac'
  const lines = [kind, `${row.ahead} ${row.ahead === 1 ? 'commit' : 'commits'} ${main ?? 'main'} doesn’t have${row.behind > 0 ? `; ${row.behind} on ${main ?? 'main'} it doesn’t have` : ''}`]
  if (row.uncommitted > 0) lines.push(`${row.uncommitted} uncommitted ${row.uncommitted === 1 ? 'change' : 'changes'} in the worktree`)
  if (row.agents.length > 0) lines.push(`An agent is working here: ${agentNames(row)}`)
  if (row.session) {
    lines.push(`Agent session: ${sessionLabel(row.session)} — click it to ${row.session.live !== 'closed' ? 'go to its tab' : 'resume it in a new tab'}`)
  }
  if (row.landed) lines.push('Its work is in main — it can be removed')
  return lines
}

function Row({
  row,
  main,
  now,
  repo,
  projectId,
  selected
}: {
  row: InProgressRow
  main: string | null
  now: number
  repo: RepoState
  projectId: Id
  selected: boolean
}): React.JSX.Element {
  const name = rowName(row)
  const ref = row.branch
  const open = (preview: boolean): void => {
    if (ref) openBranchTab(projectId, repo.root, ref, { preview })
  }
  const rowMenu = useRowMenu(() => (ref ? [openInNewTabItem(() => open(false))] : []))
  const Icon = row.kind === 'worktree' ? WorktreeGlyph : row.kind === 'remote' ? RemoteGlyph : BranchGlyph
  return (
    <Tooltip lines={rowTip(row, main)}>
      <div
        role="button"
        tabIndex={0}
        className={`${styles.commitRow} ${styles.progressRow} ${selected ? styles.commitSelected : ''}`}
        data-testid={`git-progress-${name}`}
        data-kind={row.kind}
        data-ahead={row.ahead}
        data-behind={row.behind}
        data-live={row.agents.length > 0 || undefined}
        data-session={row.session ? row.session.id : undefined}
        data-landed={row.landed || undefined}
        data-selected={selected || undefined}
        aria-disabled={!ref || undefined}
        onClick={() => open(true)}
        onContextMenu={ref ? rowMenu.onContextMenu : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') open(false)
        }}
      >
        {rowMenu.menu}
        <span className={styles.progressIcon} data-kind={row.kind}>
          <Icon />
        </span>
        <span className={styles.commitText}>
          <span className={styles.progressName}>
            <span className={styles.progressBranch}>{name}</span>
            {row.agents.length > 0 && (
              <span className={styles.progressLive} data-testid={`git-progress-live-${name}`}>
                agent
              </span>
            )}
          </span>
          <span className={styles.commitMeta}>
            {row.kind === 'branch' && row.current ? 'checked out · ' : ''}
            <span data-testid={`git-progress-counts-${name}`}>{countsLabel(row, main)}</span>
            {row.uncommitted > 0 && ` · ${row.uncommitted} uncommitted`}
            {' · '}
            {relativeTime(row.activity, now)}
          </span>
          {row.session && <SessionLink session={row.session} />}
        </span>
      </div>
    </Tooltip>
  )
}

export function InProgressSection({
  repo,
  visible,
  projectId,
  now
}: {
  repo: RepoState
  visible: boolean
  projectId: Id
  now: number
}): React.JSX.Element | null {
  const list = useBranchesStore((s) => s.lists[repo.root])
  const load = useBranchesStore((s) => s.load)
  const collapsed = useGitPanelStore((s) => s.toggles[repo.root]?.progressCollapsed === true)
  const setToggle = useGitPanelStore((s) => s.setToggle)
  const activeBranch = useTabsStore((s) => {
    const id = s.activeTabByProject[projectId]
    const t = id ? s.tabsByProject[projectId]?.find((x) => x.id === id) : undefined
    return t && t.kind === 'branch' && (t as BranchTab).repo === repo.root ? (t as BranchTab).branch : null
  })

  // Reload whenever the repo's state moves (a commit, a branch made in a terminal, a fetch) and
  // whenever an agent starts or ends.
  const agentsKey = useAgentsKey()
  useEffect(() => {
    if (!visible || !repo.hasCommits) return
    const t = setTimeout(() => load(repo.root), 150)
    return () => clearTimeout(t)
  }, [visible, repo, load, agentsKey])

  // Opening the repo view fetches in the background (throttled), so others' branches show.
  useEffect(() => {
    if (visible && repo.remoteUrl !== null) void backgroundFetch(repo.root)
  }, [visible, repo.root, repo.remoteUrl])

  const data = list?.data
  const rows = useMemo(() => data?.rows ?? [], [data])
  const local = useMemo(() => rows.filter((r) => r.kind !== 'remote'), [rows])
  const remote = useMemo(() => rows.filter((r) => r.kind === 'remote'), [rows])
  if (!repo.hasCommits) return null
  const main = list?.data?.main ?? null

  return (
    <section className={styles.section} data-testid="git-progress">
      <div className={styles.sectionHead}>
        <Tooltip lines={glossaryLines('in-progress')}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={!collapsed}
            data-testid="git-progress-toggle"
            onClick={() => setToggle(repo.root, { progressCollapsed: !collapsed })}
          >
            <span className={`${styles.chevron} ${collapsed ? '' : styles.chevronOpen}`}>
              <Chevron />
            </span>
            <span className={styles.sectionTitle}>In progress</span>
            <span className={styles.sectionCount} data-testid="git-progress-count">
              {rows.length}
            </span>
          </button>
        </Tooltip>
      </div>
      {!collapsed &&
        (list?.error && !list.data ? (
          <div className={`${styles.note} ${styles.noteError}`} data-testid="git-progress-error">
            Could not read the branches: {list.error}
          </div>
        ) : !list?.data ? (
          <div className={styles.note}>Loading…</div>
        ) : rows.length === 0 ? (
          <div className={styles.note} data-testid="git-progress-empty">
            Nothing in progress — every branch is in {main ?? 'main'}.
          </div>
        ) : (
          <div className={styles.history} data-testid="git-progress-list">
            {local.map((r) => (
              <Row key={`${r.kind}:${r.path ?? r.branch}`} row={r} main={main} now={now} repo={repo} projectId={projectId} selected={!!r.branch && r.branch === activeBranch} />
            ))}
            {remote.length > 0 && (
              <div className={styles.groupHead} data-testid="git-progress-remote">
                <span>Remote</span>
                <span className={styles.groupCount}>{remote.length}</span>
              </div>
            )}
            {remote.map((r) => (
              <Row key={`remote:${r.branch}`} row={r} main={main} now={now} repo={repo} projectId={projectId} selected={r.branch === activeBranch} />
            ))}
          </div>
        ))}
    </section>
  )
}
