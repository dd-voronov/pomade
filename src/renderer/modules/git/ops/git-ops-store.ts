// Pomade — E-039: the renderer side of git operations. Which repo has an operation running (the
// buttons wait), the last failure per repo (shown where the operation was started), the one open
// operation dialog, and the failure marks: a failed operation puts a mark on the Git strip icon and
// the repo's row (marks-store source `git:<root>`) until the repo is opened.

import { create } from 'zustand'

import { GIT_OP_TITLE, opTitle, type GitFailure, type GitOp, type GitOpRequest, type GitOpResult, type GitOpRun } from '@shared/git-ops'
import { useToastStore } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { repoRowTarget, stripTarget, useMarksStore } from '../../../stores/marks-store'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { openConflictTab } from '../open-git-tabs'
import { GIT_PANEL } from '../panel/GitPanel'
import { seeRuns } from './git-runs-store'

/** What an operation is called in buttons, toasts and dialog titles. */
export const OP_TITLE: Record<GitOp, string> = GIT_OP_TITLE

export interface RepoFailure {
  op: GitOp
  failure: GitFailure
}

interface GitOpsState {
  /** Repos with an operation running, by root. */
  running: Record<string, GitOp | undefined>
  /** The last failure per repo, until the next run there or a dismiss. */
  failures: Record<string, RepoFailure | undefined>
  /** The open operation dialog (one at a time). */
  dialog: { repo: string; name: string; req: GitOpRequest; title?: string } | null
  /** Repos whose Commit & push box is open. */
  composer: Record<string, true | undefined>
  /** Bumped after every operation that may have kept discarded drafts. */
  draftsNonce: number
  /** `title` replaces the operation's own (the "Landed — remove…?" offer). */
  openDialog: (repo: string, name: string, req: GitOpRequest, title?: string) => void
  closeDialog: () => void
  setComposer: (repo: string, open: boolean) => void
  dismissFailure: (repo: string) => void
}

export const useGitOpsStore = create<GitOpsState>((set) => ({
  running: {},
  failures: {},
  dialog: null,
  composer: {},
  draftsNonce: 0,
  openDialog: (repo, name, req, title) => set({ dialog: { repo, name, req, ...(title ? { title } : {}) } }),
  closeDialog: () => set({ dialog: null }),
  setComposer: (repo, open) =>
    set((s) => {
      const composer = { ...s.composer }
      if (open) composer[repo] = true
      else delete composer[repo]
      return { composer }
    }),
  dismissFailure: (repo) =>
    set((s) => {
      if (!s.failures[repo]) return s
      const failures = { ...s.failures }
      delete failures[repo]
      return { failures }
    })
}))

/** The marks source of a repo's failures. */
export function failureSource(root: string): string {
  return `git:${root}`
}

/** A failed operation: a mark on the Git icon and the repo's row, until the repo is opened. */
export function markFailure(root: string): void {
  const marks = useMarksStore.getState()
  marks.setMark(stripTarget(GIT_PANEL), failureSource(root), { count: 1, urgent: true })
  marks.setMark(repoRowTarget(root), failureSource(root), { count: 1, urgent: true })
}

/** The repo was opened: its failure marks go — a failed `pomade-git` run's too (seen for good). */
export function clearFailureMarks(root: string): void {
  useMarksStore.getState().clearSource(failureSource(root))
  seeRuns(root)
}

/** Run an operation on `repo` (its ws-relative root; `name` for messages). Success → a toast; a
 *  rebase or merge stopped on a conflict (`paused`) → its conflict tab opens; a branch landed on
 *  main (`landed`) → the dialog offers to remove it and its worktree; failure → a toast, the failure
 *  kept for the repo view, and the marks. Never throws. */
export async function runGitOp(repo: string, name: string, req: GitOpRequest, run: GitOpRun): Promise<GitOpResult> {
  const store = useGitOpsStore
  store.setState((s) => {
    const failures = { ...s.failures }
    delete failures[repo]
    return { running: { ...s.running, [repo]: req.op }, failures }
  })
  let result: GitOpResult
  try {
    result = await window.pomade.git.run(repo, req, run)
  } catch (err) {
    const message = cleanIpcError(err)
    result = { ok: false, failure: { kind: 'other', message, copy: message } }
  }
  store.setState((s) => {
    const running = { ...s.running }
    delete running[repo]
    const failures = result.ok ? s.failures : { ...s.failures, [repo]: { op: req.op, failure: result.failure } }
    return { running, failures, draftsNonce: req.op === 'discard' ? s.draftsNonce + 1 : s.draftsNonce }
  })
  const toast = useToastStore.getState().push
  if (result.ok) {
    toast(result.message)
    if (result.paused) openConflictTab(useWorkspaceStore.getState().activeProjectId, repo, name)
    if (result.landed) {
      store.getState().openDialog(repo, name, { op: 'remove-landed', branch: result.landed.branch }, 'Landed — remove branch and worktree?')
    }
  } else {
    toast(`${opTitle(req)} failed in ${name}: ${failureText(result.failure)}`, 'error')
    // A refusal Pomade made before touching anything (the preview went stale, another operation
    // running) is answered in place; a failure of git itself leaves a mark until the repo is seen.
    if (result.failure.kind !== 'changed' && result.failure.kind !== 'busy' && result.failure.kind !== 'blocked') markFailure(repo)
  }
  return result
}

/** A failure's full sentence: a commit that landed before the failing step says so first. */
export function failureText(f: GitFailure): string {
  return f.committed ? `Committed ${f.committed}, but it was not pushed. ${f.message}` : f.message
}

/** An operation whose hover already said what it does (stage, unstage, fetch): its preview is
 *  taken and run at once — the preview's token still guards the run. A preview that blocks is
 *  answered with its reason. Never throws. */
export async function runDirect(repo: string, name: string, req: GitOpRequest): Promise<GitOpResult> {
  let token: string
  try {
    const p = await window.pomade.git.preview(repo, req)
    if (p.blocked) {
      useToastStore.getState().push(`${opTitle(req)}: ${p.blocked.message}`, 'error')
      return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
    }
    token = p.token
  } catch (err) {
    const message = cleanIpcError(err)
    useToastStore.getState().push(`${opTitle(req)} failed in ${name}: ${message}`, 'error')
    return { ok: false, failure: { kind: 'other', message, copy: message } }
  }
  return runGitOp(repo, name, req, { token })
}
