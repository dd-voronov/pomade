// Pomade — E-037: All repositories (Workspace project) or a project's repos — one row per repo:
// name, branch, the counts, and the remote line. A row opens the repo view. E-039: a failed
// operation in the repo marks its row (marks-store `row:repo:<root>`) until the repo is opened.
// E-042: the repo's last `pomade-git` run, and — when `pomade-runner` answers (rule 7) — the jobs
// that target it: "Scheduled: Commit & push · 13:00, 20:00 — edit in Runner". T-320: the row an
// app's `git.reveal` names scrolls into view.

import { useEffect, useRef, useState } from 'react'

import { commitDateLabel } from '@shared/git-history'
import { REPO_JOBS_APP_ID, type RepoJob } from 'pomade-kit/protocol'

import { GIT_RUN_TITLE, clockLabel, type GitRunSummary } from '@shared/git-runs'
import type { RepoState } from '@shared/git-state'
import { useAppsStore } from '../../../stores/apps-store'
import { useRepoRowMark } from '../../../stores/marks-store'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { openAppRoute } from '../../apps/open-app'
import { useGitRunsStore } from '../ops/git-runs-store'
import type { RepoRevealRequest } from './git-panel-store'
import { BranchMark } from './BranchMark'
import { RemoteLine, RepoCounts, branchLabel, repoKey } from './RepoStatus'
import styles from './GitPanel.module.css'

export function RepoList({
  title,
  repos,
  onOpen,
  reveal,
  onRevealed
}: {
  title: string
  repos: readonly RepoState[]
  onOpen: (root: string) => void
  /** T-320 — the row to bring into view, while the panel shows. */
  reveal: RepoRevealRequest | null
  onRevealed: (nonce: number) => void
}): React.JSX.Element {
  return (
    <div className={styles.list} data-testid="git-repo-list">
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle} data-testid="git-repo-list-title">
          {title}
        </span>
        <span className={styles.sectionCount}>{repos.length}</span>
      </div>
      {repos.map((repo) => (
        <RepoRow
          key={repo.root}
          repo={repo}
          onOpen={onOpen}
          reveal={reveal?.root === repo.root ? reveal.nonce : null}
          onRevealed={onRevealed}
        />
      ))}
    </div>
  )
}

/** "13:00" today, "Nov 9 13:00" before. */
function runWhen(ms: number, now: number): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString()
  return sameDay ? clockLabel(ms) : `${commitDateLabel(ms, now)} ${clockLabel(ms)}`
}

/** The last `pomade-git` run: "Commit & push done 13:00 · committed a1b2c3d". */
function RunLine({ repo, run }: { repo: RepoState; run: GitRunSummary }): React.JSX.Element {
  const key = repoKey(repo.root)
  const r = run.result
  const what =
    r.status === 'done' ? (r.commit ? `committed ${r.commit.slice(0, 7)}` : (r.steps.find((s) => s.outcome === 'done' && s.step !== 'agents')?.detail ?? '')) : (r.reason ?? '')
  const title = [
    `${GIT_RUN_TITLE[r.op]} by pomade-git${run.job ? ` · job "${run.job}"` : ''} · ${r.status}`,
    ...(r.reason ? [r.reason] : []),
    ...r.steps.map((s) => `${s.step}: ${s.outcome} — ${s.detail}`)
  ].join('\n')
  return (
    <span className={styles.repoLine}>
      <span
        className={`${styles.runLine} ${r.status === 'failed' ? styles.runFailed : ''}`}
        data-testid={`git-run-${key}`}
        data-status={r.status}
        title={title}
      >
        <span className={styles.runLabel}>
          {GIT_RUN_TITLE[r.op]} {r.status} {runWhen(run.at, Date.now())}
        </span>
        {what && <> · {what}</>}
      </span>
    </span>
  )
}

/** Runner's jobs for the repo; null until it answers, or when it is absent (rule 7). Asked when the
 *  row shows, when the window comes back into focus, and when Runner starts or stops serving or
 *  publishes `jobs.changed` or `runs.changed` (one panel-wide subscription, `jobsEpoch`). */
function useRepoJobs(root: string): RepoJob[] | null {
  const runnerPresent = useAppsStore((s) => s.apps.some((a) => a.id === REPO_JOBS_APP_ID && !a.unavailable))
  const jobsEpoch = useGitRunsStore((s) => s.jobsEpoch)
  const [jobs, setJobs] = useState<RepoJob[] | null>(null)
  useEffect(() => {
    if (!runnerPresent) {
      setJobs(null)
      return
    }
    let live = true
    const ask = (): void => {
      void window.pomade.git.scheduled(root).then(
        (j) => {
          if (live) setJobs(j)
        },
        () => {
          if (live) setJobs(null)
        }
      )
    }
    ask()
    window.addEventListener('focus', ask)
    return () => {
      live = false
      window.removeEventListener('focus', ask)
    }
  }, [root, runnerPresent, jobsEpoch])
  return jobs
}

function ScheduledLine({ repo, job }: { repo: RepoState; job: RepoJob }): React.JSX.Element {
  const runner = useAppsStore((s) => s.apps.find((a) => a.id === REPO_JOBS_APP_ID && !a.unavailable))
  const now = Date.now()
  const next = job.nextRun ? Date.parse(job.nextRun) : NaN
  const last = job.lastResult ? Date.parse(job.lastResult.at) : NaN
  const title = [
    `Job "${job.name}" in Runner`,
    ...(Number.isFinite(next) ? [`Next run ${runWhen(next, now)}`] : []),
    ...(job.lastResult && Number.isFinite(last) ? [`Last run ${runWhen(last, now)} · ${job.lastResult.status}`] : [])
  ].join('\n')
  return (
    <div className={styles.scheduledLine} data-testid={`git-scheduled-${repoKey(repo.root)}`} data-job={job.id} title={title}>
      <span className={styles.scheduledLabel}>Scheduled:</span> {GIT_RUN_TITLE[job.operation]} · {job.schedule} —{' '}
      <button
        type="button"
        className={styles.inlineLink}
        data-testid={`git-scheduled-edit-${repoKey(repo.root)}`}
        disabled={!runner}
        onClick={() => {
          if (runner) openAppRoute(runner, job.route, useWorkspaceStore.getState().activeProjectId)
        }}
      >
        edit in Runner
      </button>
    </div>
  )
}

function RepoRow({
  repo,
  onOpen,
  reveal,
  onRevealed
}: {
  repo: RepoState
  onOpen: (root: string) => void
  /** The pending reveal's nonce when it names this row. */
  reveal: number | null
  onRevealed: (nonce: number) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (reveal === null) return
    ref.current?.scrollIntoView({ block: 'nearest' })
    onRevealed(reveal)
  }, [reveal, onRevealed])
  const mark = useRepoRowMark(repo.root)
  const run = useGitRunsStore((s) => s.runs[repo.root])
  const jobs = useRepoJobs(repo.root)
  const key = repoKey(repo.root)
  return (
    <div ref={ref} className={styles.repoItem}>
      <button
        type="button"
        className={styles.repoRow}
        data-testid={`git-repo-row-${key}`}
        data-attention={mark ? 'true' : undefined}
        aria-label={mark ? `${repo.name} — the last git operation failed` : undefined}
        onClick={() => onOpen(repo.root)}
      >
        <span className={styles.repoLine}>
          {mark && <span className={styles.rowMark} data-testid={`git-repo-mark-${key}`} aria-hidden="true" />}
          <span className={styles.repoName}>{repo.name}</span>
          <span className={styles.repoBranch}>
            <BranchMark />
            <span className={styles.repoBranchName}>{branchLabel(repo)}</span>
          </span>
          <RepoCounts repo={repo} />
        </span>
        <span className={styles.repoLine}>
          <RemoteLine repo={repo} />
        </span>
        {run && <RunLine repo={repo} run={run} />}
      </button>
      {jobs?.map((job) => <ScheduledLine key={job.id} repo={repo} job={job} />)}
    </div>
  )
}
