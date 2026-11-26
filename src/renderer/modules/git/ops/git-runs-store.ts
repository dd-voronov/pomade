// Pomade — E-042: the `pomade-git` runs in the renderer. Each repo's last run (main/git-runs.ts reads
// the run log) for its row in All repositories, and the attention mark of a run that failed unseen:
// on the Git strip icon and the repo's row (marks-store source `git-run:<root>`), until the repo is
// opened — which records it as seen, so the mark does not come back at the next launch. Started
// once, in `App`: a run that failed while Pomade was closed marks the repo right at launch.

import { create } from 'zustand'

import type { GitRunSummary } from '@shared/git-runs'
import { repoRowTarget, stripTarget, useMarksStore } from '../../../stores/marks-store'
import { GIT_PANEL } from '../panel/GitPanel'

interface GitRunsState {
  /** By repo root. */
  runs: Record<string, GitRunSummary>
  /** Counts the times Runner's jobs may have changed (it started or stopped serving, or published
   *  `jobs.changed` or `runs.changed`); a row asks `scheduled` again when it moves. */
  jobsEpoch: number
}

export const useGitRunsStore = create<GitRunsState>(() => ({ runs: {}, jobsEpoch: 0 }))

/** The marks source of a repo's failed `pomade-git` run. */
export function runFailureSource(root: string): string {
  return `git-run:${root}`
}

function publish(runs: Record<string, GitRunSummary>): void {
  const before = useGitRunsStore.getState().runs
  useGitRunsStore.setState({ runs })
  const marks = useMarksStore.getState()
  for (const root of new Set([...Object.keys(before), ...Object.keys(runs)])) {
    const source = runFailureSource(root)
    if (runs[root]?.unseenFailure) {
      marks.setMark(stripTarget(GIT_PANEL), source, { count: 1, urgent: true })
      marks.setMark(repoRowTarget(root), source, { count: 1, urgent: true })
    } else marks.clearSource(source)
  }
}

/** Load the runs and follow the log; returns the unsubscribe. */
export function startGitRuns(): () => void {
  const offRuns = window.pomade.git.onRuns(publish)
  const offJobs = window.pomade.git.onJobs(() => useGitRunsStore.setState((s) => ({ jobsEpoch: s.jobsEpoch + 1 })))
  void window.pomade.git.runs().then(publish, () => {})
  return () => {
    offRuns()
    offJobs()
  }
}

/** The repo was opened: a failed run there is seen — its mark goes, for good. */
export function seeRuns(root: string): void {
  const s = useGitRunsStore.getState().runs[root]
  if (!s?.unseenFailure) return
  publish({ ...useGitRunsStore.getState().runs, [root]: { ...s, unseenFailure: false } })
  void window.pomade.git.runSeen(root).catch(() => {})
}
