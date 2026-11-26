// Pomade — E-037: one repo — its state at the top, then Changes (uncommitted files with their
// letters) and History (the branch's first-parent line: one row per landed piece of work; a merge
// row expands to the commits it brought in; "Show every commit" switches to the full log). History
// loads in pages as the list scrolls; it reloads when HEAD moves.
// E-039: the operations — Commit & push in Changes (an inline box), Discard on a change row, the
// `⋯` menu in the head (Get their changes then push, Undo last commit, Discard all, Connect
// remote), and the Discarded section. Opening the repo view clears the repo's failure marks.
// E-040: Stage / Unstage on a change row — Changes splits into Staged and Unstaged while anything
// is staged; Fetch after the remote line; the `⋯` operator items; and a bar while a rebase is stopped on a
// conflict (Resolve conflicts… · Abort, back to before).
// E-041: the In progress section above History (worktrees, branches main lacks, remote branches),
// and the bar while a merge into main is stopped on a conflict.
// T-231: Not pushed under Changes — the commits the upstream lacks, shown only while there are any;
// History leaves them out.

import { useEffect, useMemo, useRef, useState } from 'react'

import { glossaryLines } from '@shared/git-glossary'
import { isMerge, relativeTime, type CommitSummary } from '@shared/git-history'
import { jobCommitLabel } from '@shared/git-runs'
import { type GitFileChange, type RepoState } from '@shared/git-state'
import type { Id } from '@shared/types'
import { CheckToggle } from '../../../components/CheckToggle'
import { Tooltip } from '../../../components/Tooltip'
import { GitTerm } from '../GitTerm'
import { useToast } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { useTabsStore } from '../../../stores/tabs-store'
import { FileIcon, FolderIcon } from '../../filetree/icons'
import { Chevron, BackArrow, DiscardGlyph, FetchGlyph, StageGlyph, UnstageGlyph } from '../icons'
import { GIT_LETTER, gitHint, gitTintClass } from '../tree-marks'
import { openCommitTab, openConflictTab } from '../open-git-tabs'
import { openChange } from '../open-change'
import { openInNewTabItem, SHOW_IN_FILE_TREE_LABEL, useRowMenu, VIEW_LAST_VERSION_LABEL } from '../row-menu'
import { BranchMark } from './BranchMark'
import { branchStamp, historyKey, mergeKey, useGitPanelStore } from './git-panel-store'
import { RemoteLine, RepoCounts, branchLabel, repoKey } from './RepoStatus'
import { CommitComposer } from '../ops/CommitComposer'
import { DiscardedSection } from '../ops/DiscardedSection'
import { InProgressSection } from '../branches/InProgressSection'
import { RepoMenu } from '../ops/RepoMenu'
import { clearFailureMarks, runDirect, useGitOpsStore } from '../ops/git-ops-store'
import styles from './GitPanel.module.css'

/** Rows Changes draws before summarizing the rest. */
const CHANGES_SHOWN = 500

/** "now", ticking once a minute while `live` — relative dates stay true without a timer per row. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [live])
  return now
}

function SectionHead({
  title,
  count,
  collapsed,
  onToggle,
  testId,
  children
}: {
  title: string
  count?: number
  collapsed: boolean
  onToggle: () => void
  testId: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={styles.sectionHead}>
      <button
        type="button"
        className={styles.sectionToggle}
        aria-expanded={!collapsed}
        data-testid={`${testId}-toggle`}
        onClick={onToggle}
      >
        <span className={`${styles.chevron} ${collapsed ? '' : styles.chevronOpen}`}>
          <Chevron />
        </span>
        <span className={styles.sectionTitle}>{title}</span>
        {count !== undefined && (
          <span className={styles.sectionCount} data-testid={`${testId}-count`}>
            {count}
          </span>
        )}
      </button>
      {children}
    </div>
  )
}

function ChangeRow({
  repo,
  change,
  projectId,
  group
}: {
  repo: RepoState
  change: GitFileChange
  projectId: Id
  /** Which list the row is in: `staged` rows offer Unstage, the others Stage. */
  group: 'staged' | 'unstaged' | 'all'
}): React.JSX.Element {
  const inRepo = repo.root && change.path.startsWith(`${repo.root}/`) ? change.path.slice(repo.root.length + 1) : change.path
  const slash = inRepo.lastIndexOf('/')
  const name = slash < 0 ? inRepo : inRepo.slice(slash + 1)
  const dir = slash < 0 ? '' : inRepo.slice(0, slash)
  const letter = GIT_LETTER[change.status]
  const toast = useToast()
  const openDialog = useGitOpsStore((s) => s.openDialog)
  const running = useGitOpsStore((s) => s.running[repo.root])
  const staging = group === 'staged' ? 'unstage' : 'stage'
  const rowId = group === 'staged' ? `git-staged-${change.path}` : `git-change-${change.path}`
  const open = (preview: boolean): void => {
    openChange(projectId, repo, change, { preview }).catch((err: unknown) =>
      toast(`Could not open the comparison: ${cleanIpcError(err)}`, 'error')
    )
  }
  const rowMenu = useRowMenu(() => [
    openInNewTabItem(
      () => open(false),
      change.dir ? SHOW_IN_FILE_TREE_LABEL : change.status === 'deleted' ? VIEW_LAST_VERSION_LABEL : undefined
    )
  ])
  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.fileRow}
      data-testid={rowId}
      data-git-status={letter}
      data-staged={change.staged}
      onClick={() => open(true)}
      onContextMenu={rowMenu.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(false)
      }}
    >
      {rowMenu.menu}
      <span className={styles.fileIcon}>{change.dir ? <FolderIcon open={false} /> : <FileIcon name={name} />}</span>
      <span className={`${styles.fileName} ${gitTintClass(change)}`}>{name}</span>
      {dir && <span className={styles.fileDir}>{dir}</span>}
      <span className={styles.rowTail}>
        {change.status !== 'conflict' && !repo.operation && (
          <Tooltip
            lines={[
              staging === 'stage' ? `Stage ${name} — it goes into the next commit` : `Unstage ${name} — it stays changed, just not in the next commit`,
              ...glossaryLines('stage')
            ]}
            testId={`git-${staging}-tip-${change.path}`}
          >
            <button
              type="button"
              className={styles.rowAction}
              aria-label={`${staging === 'stage' ? 'Stage' : 'Unstage'} ${name}`}
              data-testid={`git-${staging}-${change.path}`}
              disabled={!!running}
              onClick={(e) => {
                e.stopPropagation()
                void runDirect(repo.root, repo.name, { op: staging, paths: [change.path] })
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {staging === 'stage' ? <StageGlyph /> : <UnstageGlyph />}
            </button>
          </Tooltip>
        )}
        {change.status !== 'conflict' && group !== 'staged' && !repo.operation && (
          <Tooltip lines={['Discard changes…', ...glossaryLines('discard')]}>
            <button
              type="button"
              className={styles.rowAction}
              aria-label={`Discard changes to ${name}`}
              data-testid={`git-discard-${change.path}`}
              onClick={(e) => {
                e.stopPropagation()
                openDialog(repo.root, repo.name, { op: 'discard', paths: [change.path] })
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <DiscardGlyph />
            </button>
          </Tooltip>
        )}
        <Tooltip lines={[gitHint(change)]}>
          <span className={`${styles.letter} ${gitTintClass(change)}`} data-testid={`git-change-letter-${change.path}`}>
            {letter}
          </span>
        </Tooltip>
      </span>
    </div>
  )
}

/** One list of change rows (the first CHANGES_SHOWN drawn), under a small title when Changes is
 *  split into Staged and Unstaged. */
function ChangeGroup({
  title,
  testId,
  list,
  repo,
  projectId,
  group
}: {
  title?: string
  testId?: string
  list: GitFileChange[]
  repo: RepoState
  projectId: Id
  group: 'staged' | 'unstaged' | 'all'
}): React.JSX.Element {
  const shown = list.slice(0, CHANGES_SHOWN)
  return (
    <div data-testid={testId}>
      {title && (
        <div className={styles.groupHead}>
          <span>{title}</span>
          <span className={styles.groupCount} data-testid={`${testId}-count`}>
            {list.length}
          </span>
        </div>
      )}
      {title && list.length === 0 && <div className={styles.note}>Nothing here.</div>}
      {shown.map((c) => (
        <ChangeRow key={`${group}:${c.status}:${c.path}`} repo={repo} change={c} projectId={projectId} group={group} />
      ))}
      {list.length > shown.length && <div className={styles.note}>and {list.length - shown.length} more</div>}
    </div>
  )
}

/** The hash of the commit whose details tab is active in `projectId`, for a commit of `repo`. */
function useActiveCommit(projectId: Id, repo: string): string | null {
  return useTabsStore((s) => {
    const id = s.activeTabByProject[projectId]
    const t = id ? s.tabsByProject[projectId]?.find((x) => x.id === id) : undefined
    return t && t.kind === 'commit' && t.repo === repo ? t.hash : null
  })
}

function CommitRow({
  repo,
  commit,
  now,
  projectId,
  nested,
  selected
}: {
  repo: string
  commit: CommitSummary
  now: number
  projectId: Id
  /** A row in a flat list (a merge's inner commits, Not pushed): a merge has no chevron. */
  nested?: boolean
  selected: boolean
}): React.JSX.Element {
  const expanded = useGitPanelStore((s) => s.expanded[mergeKey(repo, commit.hash)] === true)
  const toggleMerge = useGitPanelStore((s) => s.toggleMerge)
  const merge = !nested && isMerge(commit)
  const short = commit.hash.slice(0, 7)
  const open = (preview: boolean): void => openCommitTab(projectId, repo, commit, { preview })
  const rowMenu = useRowMenu(() => [openInNewTabItem(() => open(false))])
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${styles.commitRow} ${selected ? styles.commitSelected : ''}`}
      data-testid={`git-commit-${short}`}
      data-merge={merge || undefined}
      data-selected={selected || undefined}
      onClick={() => open(true)}
      onContextMenu={rowMenu.onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(false)
        if (merge && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          if ((e.key === 'ArrowRight') !== expanded) toggleMerge(repo, commit.hash)
        }
      }}
    >
      {rowMenu.menu}
      <span className={styles.commitGutter}>
        {merge && (
          <button
            type="button"
            className={styles.mergeToggle}
            aria-label={expanded ? 'Hide the commits this merge brought in' : 'Show the commits this merge brought in'}
            aria-expanded={expanded}
            data-testid={`git-merge-toggle-${short}`}
            onClick={(e) => {
              e.stopPropagation()
              toggleMerge(repo, commit.hash)
            }}
          >
            <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}>
              <Chevron />
            </span>
          </button>
        )}
      </span>
      <span className={styles.commitText}>
        <span
          className={styles.commitSubject}
          data-testid={`git-commit-subject-${short}`}
          data-job={commit.job}
          title={commit.job ? commit.subject : undefined}
        >
          {commit.job ? jobCommitLabel(commit.job, commit.date) : commit.subject}
        </span>
        <span className={styles.commitMeta}>
          {relativeTime(commit.date, now)} · {commit.author}
        </span>
      </span>
    </div>
  )
}

function MergeInnerRows({
  repo,
  hash,
  now,
  projectId,
  activeHash
}: {
  repo: string
  hash: string
  now: number
  projectId: Id
  activeHash: string | null
}): React.JSX.Element {
  const inner = useGitPanelStore((s) => s.merges[mergeKey(repo, hash)])
  return (
    <div className={styles.inner} data-testid={`git-merge-inner-${hash.slice(0, 7)}`}>
      {!inner || inner.status === 'loading' ? (
        <div className={styles.note}>Loading…</div>
      ) : inner.status === 'error' ? (
        <div className={`${styles.note} ${styles.noteError}`}>{inner.error}</div>
      ) : (
        <>
          {inner.page.commits.map((c) => (
            <CommitRow
              key={c.hash}
              repo={repo}
              commit={c}
              now={now}
              projectId={projectId}
              nested
              selected={c.hash === activeHash}
            />
          ))}
          {inner.page.more && <div className={styles.note}>Only the newest {inner.page.commits.length} are listed.</div>}
        </>
      )}
    </div>
  )
}

function History({
  repo,
  visible,
  projectId
}: {
  repo: RepoState
  visible: boolean
  projectId: Id
}): React.JSX.Element {
  const all = useGitPanelStore((s) => s.toggles[repo.root]?.all === true)
  const history = useGitPanelStore((s) => s.history[historyKey(repo.root, all)])
  const expanded = useGitPanelStore((s) => s.expanded)
  const ensureHistory = useGitPanelStore((s) => s.ensureHistory)
  const loadMore = useGitPanelStore((s) => s.loadMore)
  const now = useNow(visible)
  const activeHash = useActiveCommit(projectId, repo.root)
  const stamp = branchStamp(repo)

  useEffect(() => {
    if (visible) ensureHistory(repo.root, all, stamp)
  }, [visible, repo.root, stamp, all, ensureHistory])

  // Paging: the next page loads when the end of the list scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const more = history?.more === true
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !visible || !more) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore(repo.root, all)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [visible, more, repo.root, all, loadMore, history?.commits.length])

  if (!repo.hasCommits) return <div className={styles.note}>No commits yet.</div>
  if (!history) return <div className={styles.note}>Loading…</div>
  if (history.commits.length === 0 && !history.loading && !history.error) {
    return (
      <div className={styles.note} data-testid="git-history-empty">
        Nothing pushed yet.
      </div>
    )
  }
  return (
    <div className={styles.history} data-testid="git-history" data-mode={all ? 'all' : 'first-parent'}>
      {history.commits.map((c) => (
        <div key={c.hash}>
          <CommitRow repo={repo.root} commit={c} now={now} projectId={projectId} selected={c.hash === activeHash} />
          {!all && isMerge(c) && expanded[mergeKey(repo.root, c.hash)] && (
            <MergeInnerRows repo={repo.root} hash={c.hash} now={now} projectId={projectId} activeHash={activeHash} />
          )}
        </div>
      ))}
      {history.error ? (
        <div className={`${styles.note} ${styles.noteError}`} data-testid="git-history-error">
          Could not read the history: {history.error}
        </div>
      ) : history.loading ? (
        <div className={styles.note} data-testid="git-history-loading">
          Loading…
        </div>
      ) : (
        more && <div className={styles.note}>&nbsp;</div>
      )}
      <div ref={sentinelRef} className={styles.sentinel} data-testid="git-history-end" data-more={more} />
    </div>
  )
}

/** The commits on the branch its upstream lacks, newest first — shown only while the branch has an
 *  upstream and is ahead of it; the count is the head's ↑n. Merges list flat (their inner commits
 *  are rows of their own). */
function NotPushedSection({
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
  const shown = repo.upstream !== null && repo.ahead > 0
  const collapsed = useGitPanelStore((s) => s.toggles[repo.root]?.unpushedCollapsed === true)
  const setToggle = useGitPanelStore((s) => s.setToggle)
  const list = useGitPanelStore((s) => s.unpushed[repo.root])
  const ensureUnpushed = useGitPanelStore((s) => s.ensureUnpushed)
  const activeHash = useActiveCommit(projectId, repo.root)
  const stamp = branchStamp(repo)

  useEffect(() => {
    if (visible && shown && stamp !== null) ensureUnpushed(repo.root, stamp)
  }, [visible, shown, repo.root, stamp, ensureUnpushed])

  if (!shown) return null
  return (
    <section className={styles.section} data-testid="git-unpushed">
      <SectionHead
        title="Not pushed"
        count={repo.ahead}
        collapsed={collapsed}
        onToggle={() => setToggle(repo.root, { unpushedCollapsed: !collapsed })}
        testId="git-unpushed"
      />
      {!collapsed &&
        (!list || list.status === 'loading' ? (
          <div className={styles.note}>Loading…</div>
        ) : list.status === 'error' ? (
          <div className={`${styles.note} ${styles.noteError}`} data-testid="git-unpushed-error">
            Could not read the commits not pushed: {list.error}
          </div>
        ) : (
          <div className={styles.history} data-testid="git-unpushed-list">
            {list.page.commits.map((c) => (
              <CommitRow key={c.hash} repo={repo.root} commit={c} now={now} projectId={projectId} nested selected={c.hash === activeHash} />
            ))}
            {list.page.more && <div className={styles.note}>Only the newest {list.page.commits.length} are listed.</div>}
          </div>
        ))}
    </section>
  )
}

export function RepoView({
  repo,
  visible,
  projectId,
  onBack,
  backLabel
}: {
  repo: RepoState
  visible: boolean
  projectId: Id
  onBack?: () => void
  backLabel: string
}): React.JSX.Element {
  const toggles = useGitPanelStore((s) => s.toggles[repo.root])
  const setToggle = useGitPanelStore((s) => s.setToggle)
  const all = toggles?.all === true
  const changesCollapsed = toggles?.changesCollapsed === true
  const historyCollapsed = toggles?.historyCollapsed === true
  const sorted = useMemo(() => [...repo.changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), [repo.changes])
  // Staged and Unstaged lists only while something is staged; a file staged and edited again is
  // in both.
  const stagedList = useMemo(() => sorted.filter((c) => c.staged), [sorted])
  const unstagedList = useMemo(() => sorted.filter((c) => !c.staged || c.staged === 'part'), [sorted])
  const split = stagedList.length > 0
  const conflicted = useMemo(() => repo.changes.filter((c) => c.status === 'conflict').length, [repo.changes])
  const key = repoKey(repo.root)
  const composerOpen = useGitOpsStore((s) => s.composer[repo.root] === true)
  const setComposer = useGitOpsStore((s) => s.setComposer)
  const running = useGitOpsStore((s) => s.running[repo.root])
  // Something to commit, or commits to push: ahead of the upstream, or a branch not on its remote yet.
  const unpublished = repo.remoteUrl !== null && repo.upstream === null && repo.hasCommits
  const canCommit = repo.branch !== null && !repo.error && (repo.changes.length > 0 || repo.ahead > 0 || unpublished)
  const commitLabel = repo.changes.length > 0 ? (repo.remoteUrl === null ? 'Commit…' : 'Commit & push…') : 'Push…'
  const openDialog = useGitOpsStore((s) => s.openDialog)
  const now = useNow(visible)

  // Opening the repo (its view shown) is seeing its failures: the marks go.
  useEffect(() => {
    if (visible) clearFailureMarks(repo.root)
  }, [visible, repo.root])

  return (
    <div className={styles.repoView} data-testid="git-repo-view" data-repo={key}>
      <div className={styles.repoHead}>
        {onBack && (
          <Tooltip lines={[`Back to ${backLabel}`]}>
            <button type="button" className={styles.backBtn} aria-label={`Back to ${backLabel}`} data-testid="git-back" onClick={onBack}>
              <BackArrow />
            </button>
          </Tooltip>
        )}
        <div className={styles.repoHeadText}>
          <span className={styles.repoLine}>
            <span className={styles.repoTitle} data-testid="git-repo-title">
              {repo.name}
            </span>
            <Tooltip lines={glossaryLines('branch')}>
              <span className={styles.repoBranch} data-testid="git-repo-branch">
                <BranchMark />
                <span className={styles.repoBranchName}>{branchLabel(repo)}</span>
              </span>
            </Tooltip>
            <RepoCounts repo={repo} />
          </span>
          <span className={styles.repoLine}>
            <RemoteLine repo={repo} />
              {repo.remoteUrl !== null && (
                <Tooltip lines={['Fetch — look at the remote for new commits, without changing your files', ...glossaryLines('fetch')]}>
                  <button
                    type="button"
                    className={styles.fetchBtn}
                    aria-label="Fetch"
                    aria-busy={running === 'fetch' || undefined}
                    data-testid="git-fetch"
                    data-busy={running === 'fetch' || undefined}
                    disabled={!!running}
                    onClick={() => void runDirect(repo.root, repo.name, { op: 'fetch' })}
                  >
                    <FetchGlyph />
                  </button>
                </Tooltip>
              )}
          </span>
        </div>
        <RepoMenu repo={repo} projectId={projectId} />
      </div>

      {repo.operation && (
        <div className={styles.opBar} data-testid="git-op-bar" data-operation={repo.operation} role="status">
          {repo.operation === 'rebase' || repo.operation === 'merge' ? (
            <>
              <span className={styles.opBarText}>
                A <GitTerm term={repo.operation}>{repo.operation}</GitTerm> stopped on a <GitTerm term="conflict">conflict</GitTerm>
                {conflicted === 0
                  ? `. Every file is combined — ${repo.operation === 'merge' ? 'finish' : 'continue'} it in the conflict tab.`
                  : ` in ${conflicted === 1 ? '1 file' : `${conflicted} files`}.`}
              </span>
              <span className={styles.opBarActions}>
                <button
                  type="button"
                  className={styles.opBarBtn}
                  data-variant="primary"
                  data-testid="git-op-bar-resolve"
                  onClick={() => openConflictTab(projectId, repo.root, repo.name)}
                >
                  Resolve conflicts…
                </button>
                <button
                  type="button"
                  className={styles.opBarBtn}
                  data-testid="git-op-bar-abort"
                  onClick={() => openDialog(repo.root, repo.name, { op: repo.operation === 'merge' ? 'merge-abort' : 'rebase-abort' })}
                >
                  Abort, back to before
                </button>
              </span>
            </>
          ) : (
            <span className={styles.opBarText}>
              A {repo.operation} is in progress here. Finish or abort it in a terminal — <code>git status</code> says how.
            </span>
          )}
        </div>
      )}

      {!repo.operation && repo.upstream !== null && repo.ahead > 0 && repo.behind > 0 && (
        <div className={styles.opBar} data-testid="git-diverged-bar" role="status">
          <span className={styles.opBarText}>
            Your <GitTerm term="branch">branch</GitTerm> and <GitTerm term="upstream">{repo.upstream}</GitTerm> went different ways —{' '}
            {repo.ahead === 1 ? '1 commit' : `${repo.ahead} commits`} yours, {repo.behind} theirs.
          </span>
          <span className={styles.opBarActions}>
            <button
              type="button"
              className={styles.opBarBtn}
              data-variant="primary"
              data-testid="git-diverged-sync"
              disabled={!!running}
              onClick={() => openDialog(repo.root, repo.name, { op: 'sync-push' })}
            >
              Get their changes, then push…
            </button>
          </span>
        </div>
      )}

      <section className={styles.section} data-testid="git-changes">
        <SectionHead
          title="Changes"
          count={repo.changes.length}
          collapsed={changesCollapsed}
          onToggle={() => setToggle(repo.root, { changesCollapsed: !changesCollapsed })}
          testId="git-changes"
        >
          {canCommit && !composerOpen && (
            <button
              type="button"
              className={styles.sectionAction}
              data-testid="git-commit-open"
              disabled={!!running}
              onClick={() => {
                setComposer(repo.root, true)
                if (changesCollapsed) setToggle(repo.root, { changesCollapsed: false })
              }}
            >
              {commitLabel}
            </button>
          )}
        </SectionHead>
        {composerOpen && <CommitComposer repo={repo} />}
        {!changesCollapsed &&
          (repo.changes.length === 0 ? (
            <div className={styles.note} data-testid="git-changes-empty">
              Nothing uncommitted.
            </div>
          ) : (
            <>
              {split ? (
                <>
                  <ChangeGroup title="Staged" testId="git-staged" list={stagedList} repo={repo} projectId={projectId} group="staged" />
                  <ChangeGroup title="Unstaged" testId="git-unstaged" list={unstagedList} repo={repo} projectId={projectId} group="unstaged" />
                </>
              ) : (
                <ChangeGroup list={sorted} repo={repo} projectId={projectId} group="all" />
              )}
            </>
          ))}
      </section>

      <NotPushedSection repo={repo} visible={visible} projectId={projectId} now={now} />

      <DiscardedSection repo={repo} projectId={projectId} />

      <InProgressSection repo={repo} visible={visible} projectId={projectId} now={now} />

      <section className={styles.section} data-testid="git-history-section">
        <SectionHead
          title="History"
          collapsed={historyCollapsed}
          onToggle={() => setToggle(repo.root, { historyCollapsed: !historyCollapsed })}
          testId="git-history"
        >
          {!historyCollapsed && (
            <CheckToggle
              checked={all}
              onChange={(v) => setToggle(repo.root, { all: v })}
              label="Every commit"
              tooltip={
                all
                  ? ['Showing every commit, merged branches included']
                  : ['Showing one row per landed piece of work (the branch’s own line)']
              }
              ariaLabel="Show every commit"
              labelClassName={styles.checkLabel}
              testId="git-show-all"
            />
          )}
        </SectionHead>
        {!historyCollapsed && <History repo={repo} visible={visible} projectId={projectId} />}
      </section>
    </div>
  )
}
