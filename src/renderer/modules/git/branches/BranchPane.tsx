// Pomade — E-041: the branch tab. A branch from the repo view's In progress: what it is (a
// worktree, a branch, a branch only on a remote), how far it is from main, its commits main does
// not have (each opens its commit tab) and the total change against where it left main (each file
// opens the comparison tab, that point ↔ the branch). The actions: Merge into main, Rebase onto
// main, Check out to a worktree, Open folder, Open terminal there, Open on GitHub / GitLab, and —
// once it has landed — Remove branch and worktree. Merge, Rebase and Remove wait while an agent is
// live in its checkout, with the reason shown. Read when the pane mounts and whenever the repo's
// git state moves; a branch that is gone renders a notice.

import { useEffect, useState } from 'react'

import { tildePath, type BranchDetails, type InProgressRow } from '@shared/git-branches'
import type { CompareSource } from '@shared/compare'
import { commitTimestamp, relativeTime, type CommitFile, type CommitFileStatus, type CommitSummary } from '@shared/git-history'
import { glossaryLines } from '@shared/git-glossary'
import type { BranchTab, Id, Tab } from '@shared/types'
import { Button } from '../../../components/fields'
import { Tooltip } from '../../../components/Tooltip'
import { useToast } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { useRevealStore } from '../../../stores/reveal-store'
import { useSidePanelStore } from '../../../stores/side-panel-store'
import { useTabsStore } from '../../../stores/tabs-store'
import { useTerminalsStore } from '../../../stores/terminals-store'
import { buildAllProjects, useWorkspaceStore } from '../../../stores/workspace-store'
import { FileIcon } from '../../filetree/icons'
import { FILES_PANEL } from '../../side-panels/strip-model'
import { GitTerm } from '../GitTerm'
import { useGitStateStore, useGitStateSubscription } from '../git-state-store'
import { openCommitTab } from '../open-git-tabs'
import { openComparison } from '../open-compare'
import { OPEN_DELETION_LABEL, openInNewTabItem, useRowMenu } from '../row-menu'
import { repoKeyOf } from '../ops/CommitComposer'
import { useGitOpsStore } from '../ops/git-ops-store'
import commitStyles from '../commit/CommitPane.module.css'
import { agentNames, countsLabel, rowName } from './InProgressSection'
import { useAgentsKey, useBranchesStore } from './branches-store'
import styles from './BranchPane.module.css'

const LETTER: Record<CommitFileStatus, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

function FileRow({ file, onOpen }: { file: CommitFile; onOpen: (preview: boolean) => void }): React.JSX.Element {
  const slash = file.path.lastIndexOf('/')
  const name = slash < 0 ? file.path : file.path.slice(slash + 1)
  const dir = slash < 0 ? '' : file.path.slice(0, slash)
  const rowMenu = useRowMenu(() => [openInNewTabItem(() => onOpen(false), file.status === 'deleted' ? OPEN_DELETION_LABEL : undefined)])
  return (
    <div
      role="button"
      tabIndex={0}
      className={commitStyles.fileRow}
      data-testid={`branch-file-${file.path}`}
      data-status={LETTER[file.status]}
      onClick={() => onOpen(true)}
      onContextMenu={rowMenu.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(false)
      }}
    >
      {rowMenu.menu}
      <span className={`${commitStyles.letter} ${commitStyles[`tint_${file.status}`]}`}>{LETTER[file.status]}</span>
      <span className={commitStyles.fileIcon}>
        <FileIcon name={name} />
      </span>
      <span className={`${commitStyles.fileName} ${commitStyles[`tint_${file.status}`]}`}>{name}</span>
      {dir && <span className={commitStyles.fileDir}>{dir}</span>}
      <span className={commitStyles.stat}>
        {file.added === null ? (
          <span className={commitStyles.binary}>binary</span>
        ) : (
          <>
            <span className={commitStyles.added}>+{file.added}</span>
            <span className={commitStyles.removed}>−{file.removed}</span>
          </>
        )}
      </span>
    </div>
  )
}

function kindWords(row: InProgressRow | undefined): string {
  if (!row) return 'Branch'
  if (row.kind === 'worktree') return 'Worktree'
  if (row.kind === 'remote') return 'Only on the remote'
  return row.current ? 'Branch · this checkout is on it' : 'Branch'
}

/** A commit main lacks: a click opens its commit tab through the preview slot. */
function CommitRow({ projectId, repo, commit }: { projectId: Id; repo: string; commit: CommitSummary }): React.JSX.Element {
  const open = (preview: boolean): void => openCommitTab(projectId, repo, commit, { preview })
  const rowMenu = useRowMenu(() => [openInNewTabItem(() => open(false))])
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${commitStyles.fileRow} ${styles.commitRow}`}
      data-testid={`branch-commit-${commit.hash.slice(0, 7)}`}
      onClick={() => open(true)}
      onContextMenu={rowMenu.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(false)
      }}
    >
      {rowMenu.menu}
      <span className={styles.hash}>{commit.hash.slice(0, 7)}</span>
      <span className={commitStyles.fileName}>{commit.subject}</span>
      <Tooltip lines={[commitTimestamp(commit.date)]}>
        <span className={styles.commitMeta}>
          {commit.author} · {relativeTime(commit.date, Date.now())}
        </span>
      </Tooltip>
    </div>
  )
}

export function BranchPane({ tab }: { tab: Tab }): React.JSX.Element | null {
  const t = tab as BranchTab
  useGitStateSubscription()
  const repo = useGitStateStore((s) => s.snapshot.repos.find((r) => r.root === t.repo))
  const repoKey = repo ? repoKeyOf(repo) : ''
  const list = useBranchesStore((s) => s.lists[t.repo])
  const load = useBranchesStore((s) => s.load)
  const openDialog = useGitOpsStore((s) => s.openDialog)
  const running = useGitOpsStore((s) => s.running[t.repo])
  const commitPreview = useTabsStore((s) => s.commitPreview)
  const projects = useWorkspaceStore((s) => s.projects)
  const wsRoot = useWorkspaceStore((s) => s.root)
  const toast = useToast()
  const [details, setDetails] = useState<BranchDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const agentsKey = useAgentsKey()

  useEffect(() => {
    if (repo) load(t.repo)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- an agent starting or ending re-reads the rows
  }, [agentsKey])

  useEffect(() => {
    let cancelled = false
    if (!repo) return
    load(t.repo)
    window.pomade.git.branch(t.repo, t.branch).then(
      (d) => {
        if (cancelled) return
        setDetails(d)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(cleanIpcError(err))
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repoKey covers every change of `repo`
  }, [t.repo, t.branch, repoKey])

  const row = list?.data?.rows.find((r) => r.branch === t.branch)
  const main = list?.data?.main ?? details?.main ?? 'main'
  const name = repo?.name ?? t.repo
  const home = window.pomade.env.home
  const live = (row?.agents.length ?? 0) > 0
  const remote = row?.kind === 'remote'
  const isCurrent = row?.current === true

  const openFolder = (): void => {
    const path = row?.path
    if (!path) return
    // Inside the active project's tree: reveal it in Files; anywhere else: in Finder.
    const projectId = t.projectId
    const project = buildAllProjects(projects).find((p) => p.id === projectId)
    const projectAbs = wsRoot ? (project?.rootPath ? `${wsRoot}/${project.rootPath}` : wsRoot) : null
    if (wsRoot && projectAbs && (path === projectAbs || path.startsWith(`${projectAbs}/`))) {
      useSidePanelStore.getState().select(projectId, FILES_PANEL)
      useRevealStore.getState().reveal(path.slice(wsRoot.length + 1), projectId)
      return
    }
    void window.pomade.app.showItemInFolder(path)
  }

  const openTerminal = (): void => {
    const path = row?.path
    if (!path) return
    void useTerminalsStore
      .getState()
      .newCommandTerminal(t.projectId, { cwd: path })
      .catch((err: unknown) => toast(`Could not open a terminal there: ${cleanIpcError(err)}`, 'error'))
  }

  const openPr = (): void => {
    if (row?.pr?.url) void window.pomade.app.openExternal(row.pr.url)
  }

  const openFile = (f: CommitFile, preview: boolean): void => {
    if (!details?.base) return
    const left: CompareSource =
      f.status === 'added' ? { kind: 'none' } : { kind: 'rev', repo: t.repo, rev: details.base, path: f.from ?? f.path }
    const right: CompareSource = { kind: 'rev', repo: t.repo, rev: details.tip, path: f.path }
    openComparison(t.projectId, left, right, { preview }).catch((err: unknown) =>
      toast(`Could not open the comparison: ${cleanIpcError(err)}`, 'error')
    )
  }

  let body: React.ReactNode
  if (!repo) {
    body = (
      <div className={commitStyles.notice} data-testid="branch-error">
        <div className={commitStyles.noticeTitle}>{t.branch} cannot be shown</div>
        <p>Its repository is no longer in this workspace.</p>
      </div>
    )
  } else if (error) {
    body = (
      <div className={commitStyles.notice} data-testid="branch-error">
        <div className={commitStyles.noticeTitle}>{t.branch} cannot be shown</div>
        <p>{error}</p>
        <p className={commitStyles.noticeHint}>Repository: {name}</p>
      </div>
    )
  } else if (!details) {
    body = (
      <div className={commitStyles.loading} data-testid="branch-loading">
        Loading branch…
      </div>
    )
  } else {
    const added = details.files.reduce((n, f) => n + (f.added ?? 0), 0)
    const removed = details.files.reduce((n, f) => n + (f.removed ?? 0), 0)
    const totalFiles = details.totalFiles ?? details.files.length
    // Why an action is disabled, shown as its tooltip; null when it is available. A running git
    // operation blocks all of them, an agent in the checkout blocks the ones that rewrite it.
    const blockedRunning = running ? 'Another git operation is running in this repository — this waits until it ends.' : null
    const blockedLive = live ? 'An agent is working here — this waits until it ends.' : null
    const blockedMerge = blockedLive ?? blockedRunning ?? (details.commits.length === 0 ? `Nothing to merge — its work is already in ${main}.` : null)
    const blockedRebase = blockedLive ?? blockedRunning ?? ((row?.behind ?? 1) === 0 ? `Already up to date with ${main} — nothing to put it on top of.` : null)
    const blockedRemove = blockedLive ?? blockedRunning
    body = (
      <article className={commitStyles.article}>
        <header className={commitStyles.head}>
          <span className={commitStyles.mergeTag} data-testid="branch-kind">
            {kindWords(row)}
          </span>
          <h1 className={commitStyles.subject} data-testid="branch-name">
            {row ? rowName(row) : t.branch}
          </h1>
          <div className={commitStyles.meta}>
            <span data-testid="branch-counts">{row ? countsLabel(row, main) : `${details.commits.length + details.more} commits`}</span>
            <span className={commitStyles.sep} aria-hidden="true">
              ·
            </span>
            <span>
              against <GitTerm term="branch">{main}</GitTerm>
            </span>
            {row?.path && (
              <>
                <span className={commitStyles.sep} aria-hidden="true">
                  ·
                </span>
                <Tooltip lines={[row.path]}>
                  <span className={styles.path} data-testid="branch-path">
                    {tildePath(row.path, home)}
                  </span>
                </Tooltip>
              </>
            )}
            {row && row.uncommitted > 0 && (
              <>
                <span className={commitStyles.sep} aria-hidden="true">
                  ·
                </span>
                <span data-testid="branch-uncommitted">{row.uncommitted} uncommitted</span>
              </>
            )}
            <span className={commitStyles.sep} aria-hidden="true">
              ·
            </span>
            <span className={commitStyles.repo}>{name}</span>
          </div>
          {live && row && (
            <div className={styles.live} role="status" data-testid="branch-live">
              <span className={styles.liveDot} aria-hidden="true" />
              An agent is working here ({agentNames(row)}) — Merge, Rebase and Remove wait until it
              ends.
            </div>
          )}
          <div className={styles.actions} data-testid="branch-actions">
            {!isCurrent && (
              <Tooltip lines={blockedMerge ? [blockedMerge] : ['Land it on main — as one commit, or with a merge commit', ...glossaryLines('squash')]}>
                <Button
                  variant="primary"
                  data-testid="branch-merge"
                  disabled={live || !!running || details.commits.length === 0}
                  onClick={() => openDialog(t.repo, name, { op: 'merge-branch', branch: t.branch, mode: 'squash' })}
                >
                  Merge into {main}…
                </Button>
              </Tooltip>
            )}
            {!remote && (
              <Tooltip lines={blockedRebase ? [blockedRebase] : [`Put its commits on top of ${main}’s newest`, ...glossaryLines('rebase')]}>
                <Button
                  data-testid="branch-rebase"
                  disabled={live || !!running || (row?.behind ?? 1) === 0}
                  onClick={() =>
                    openDialog(t.repo, name, isCurrent ? { op: 'rebase', onto: 'main' } : { op: 'rebase-branch', branch: t.branch })
                  }
                >
                  Rebase onto {main}…
                </Button>
              </Tooltip>
            )}
            {row?.kind !== 'worktree' && !isCurrent && (
              <Tooltip lines={blockedRunning ? [blockedRunning] : ['Check it out in its own folder, outside the repository — this checkout stays as it is', ...glossaryLines('worktree')]}>
                <Button
                  data-testid="branch-worktree"
                  disabled={!!running}
                  onClick={() => openDialog(t.repo, name, { op: 'worktree-add', branch: t.branch })}
                >
                  Check out to a worktree…
                </Button>
              </Tooltip>
            )}
            {row?.path && (
              <>
                <Tooltip lines={['Show its folder — in Files when it is inside this project, otherwise in Finder']}>
                  <Button data-testid="branch-open-folder" onClick={openFolder}>
                    Open folder
                  </Button>
                </Tooltip>
                <Tooltip lines={['Open a terminal in its folder']}>
                  <Button data-testid="branch-open-terminal" onClick={openTerminal}>
                    Open terminal there
                  </Button>
                </Tooltip>
              </>
            )}
            {row?.pr && (
              <Tooltip
                lines={
                  row.pr.url
                    ? [`Open the page that starts a ${row.pr.host === 'GitHub' ? 'pull' : 'merge'} request for it, in the browser`]
                    : [`It is not on ${row.pr.host} yet — publish it first (switch to it, then ⋯ › Publish branch…)`]
                }
              >
                <Button data-testid="branch-open-pr" disabled={!row.pr.url} onClick={openPr}>
                  Open on {row.pr.host}
                </Button>
              </Tooltip>
            )}
            {row?.landed && (
              <Tooltip lines={blockedRemove ? [blockedRemove] : ['Its work is in main: remove the branch, and its worktree folder']}>
                <Button
                  data-testid="branch-remove"
                  disabled={live || !!running}
                  onClick={() => openDialog(t.repo, name, { op: 'remove-landed', branch: t.branch })}
                >
                  Remove branch{row.path ? ' and worktree' : ''}…
                </Button>
              </Tooltip>
            )}
          </div>
        </header>

        <section className={commitStyles.files} data-testid="branch-commits">
          <div className={commitStyles.filesHead}>
            <span className={commitStyles.filesTitle}>Commits {main} doesn’t have</span>
            <span className={commitStyles.filesCount} data-testid="branch-commits-count">
              {details.commits.length + details.more}
            </span>
          </div>
          {details.commits.length === 0 ? (
            <div className={commitStyles.loading}>None — its work is in {main}.</div>
          ) : (
            details.commits.map((c) => <CommitRow key={c.hash} projectId={t.projectId} repo={t.repo} commit={c} />)
          )}
          {details.more > 0 && <div className={commitStyles.loading}>and {details.more} older.</div>}
        </section>

        <section className={commitStyles.files} data-testid="branch-files">
          <div className={commitStyles.filesHead}>
            <span className={commitStyles.filesTitle}>All its changes</span>
            <span className={commitStyles.filesCount} data-testid="branch-files-count">
              {totalFiles}
            </span>
            <span className={commitStyles.filesStat}>
              <span className={commitStyles.added}>+{added}</span>
              <span className={commitStyles.removed}>−{removed}</span>
            </span>
          </div>
          {details.files.length === 0 ? (
            <div className={commitStyles.loading}>No file changes.</div>
          ) : (
            details.files.map((f) => <FileRow key={f.path} file={f} onOpen={(preview) => openFile(f, preview)} />)
          )}
          {details.totalFiles !== undefined && (
            <div className={commitStyles.loading}>
              Only the first {details.files.length} files of {details.totalFiles} are listed.
            </div>
          )}
          {row && row.uncommitted > 0 && (
            <div className={commitStyles.loading}>
              Its {row.uncommitted} uncommitted {row.uncommitted === 1 ? 'change is' : 'changes are'} not included — only commits.
            </div>
          )}
        </section>
      </article>
    )
  }

  return (
    <div className={commitStyles.pane} data-testid="branch-pane" data-branch={t.branch} onMouseDown={() => commitPreview(t.projectId, t.id)}>
      {body}
    </div>
  )
}
