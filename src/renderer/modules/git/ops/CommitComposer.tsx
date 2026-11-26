// Pomade — E-039: Commit & push, inline under the repo view's Changes header. A plain message box,
// the preview line ("This will commit 5 files and push 1 commit to GitHub (origin/main)."), and
// one button. Commit & push takes every change. A failure stays in the box with its copy button; a
// push the remote turned down because it moved on offers "Get their changes, then push".
// E-040: while something is staged the box also offers **Commit staged** — the staged files only —
// each button with its own preview line.
// T-221: on a repo with a remote, **Push after committing** (on each time the box opens) decides
// whether a commit is pushed — for both buttons; the preview lines and the labels follow it.
// T-309: when the upstream has commits this branch lacks (the last fetch), the preview says the push
// would be turned down; a push alone is blocked and offers "Get their changes, then push".

import { useState } from 'react'

import type { RepoState } from '@shared/git-state'
import { Button } from '../../../components/fields'
import { GitTerm } from '../GitTerm'
import { OpNote, PreviewLine, usePreview } from './OpParts'
import { failureText, runGitOp, useGitOpsStore } from './git-ops-store'
import styles from './GitOps.module.css'

/** A key that changes whenever what a commit would take changes — the preview reloads on it. */
export function repoKeyOf(repo: RepoState): string {
  return [
    repo.head,
    repo.branch,
    repo.upstream,
    repo.ahead,
    repo.behind,
    repo.remoteUrl,
    repo.operation ?? '',
    ...repo.changes.map((c) => `${c.status}:${c.staged ?? ''}:${c.path}`)
  ].join('|')
}

/** "Get their changes, then push…": the box closes and the dialog takes over (a commit that landed
 *  before a turned-down push is what it pushes). */
function SyncAction({ repo }: { repo: RepoState }): React.JSX.Element {
  const setComposer = useGitOpsStore((s) => s.setComposer)
  const openDialog = useGitOpsStore((s) => s.openDialog)
  const dismiss = useGitOpsStore((s) => s.dismissFailure)
  return (
    <button
      type="button"
      className={styles.noteAction}
      data-testid="git-op-sync"
      onClick={() => {
        dismiss(repo.root)
        setComposer(repo.root, false)
        openDialog(repo.root, repo.name, { op: 'sync-push' })
      }}
    >
      Get their changes, then push…
    </button>
  )
}

export function CommitComposer({ repo }: { repo: RepoState }): React.JSX.Element {
  const [message, setMessage] = useState('')
  const running = useGitOpsStore((s) => s.running[repo.root])
  const failure = useGitOpsStore((s) => s.failures[repo.root])
  const setComposer = useGitOpsStore((s) => s.setComposer)
  const key = repoKeyOf(repo)
  const hasStaged = repo.changes.some((c) => c.staged)
  const [pushAfter, setPushAfter] = useState(true)
  const { preview, loading, error } = usePreview(repo.root, { op: 'commit-push', push: pushAfter }, key)
  const staged = usePreview(repo.root, hasStaged ? { op: 'commit-staged', push: pushAfter } : null, key)
  const p = preview?.op === 'commit-push' ? preview : null
  const sp = hasStaged && staged.preview?.op === 'commit-staged' ? staged.preview : null
  const files = p?.files ?? repo.changes.length
  // The choice exists when there is a remote and something to commit (with nothing to commit the
  // box only pushes).
  const offerPush = !!p?.push && files > 0
  const pushing = offerPush && pushAfter
  const label = files > 0 ? (pushing ? 'Commit & push' : 'Commit') : p?.push ? 'Push' : 'Commit'
  const stagedLabel = pushing ? 'Commit staged & push' : 'Commit staged'
  const needsMessage = files > 0
  const hasMessage = message.trim().length > 0
  const canRun = !!p && !p.blocked && !running && !loading && (!needsMessage || hasMessage)
  const canRunStaged = !!sp && !sp.blocked && !running && !staged.loading && hasMessage
  const ownFailure = failure?.op === 'commit-push' || failure?.op === 'commit-staged' ? failure.failure : null

  const submit = async (which: 'all' | 'staged' = 'all'): Promise<void> => {
    const pv = which === 'staged' ? sp : p
    if (!pv || !(which === 'staged' ? canRunStaged : canRun)) return
    const result = await runGitOp(repo.root, repo.name, { op: which === 'staged' ? 'commit-staged' : 'commit-push', push: pushAfter }, { token: pv.token, message })
    if (result.ok) {
      setMessage('')
      setComposer(repo.root, false)
    }
  }

  return (
    <div className={styles.composer} data-testid="git-commit-box">
      {needsMessage && (
        <textarea
          className={styles.message}
          value={message}
          rows={3}
          autoFocus
          placeholder="What changed? e.g. Fix the typo in the login page"
          aria-label="Commit message"
          data-testid="git-commit-message"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void submit(hasStaged ? 'staged' : 'all')
            }
            if (e.key === 'Escape') setComposer(repo.root, false)
          }}
        />
      )}
      {error ? (
        <OpNote tone="failed" message={error} copy={error} testId="git-commit-error" />
      ) : !p || (hasStaged && !sp) ? (
        <div className={styles.previewPending}>Checking what this will do…</div>
      ) : (
        <>
          {sp && (
            <div className={styles.labelled} data-testid="git-commit-staged-line">
              <span className={styles.lineLabel}>{stagedLabel}</span>
              <PreviewLine preview={sp} testId="git-commit-staged-preview" />
              {sp.blocked && <OpNote tone="blocked" message={sp.blocked.message} copy={sp.blocked.copy} testId="git-commit-staged-blocked" />}
            </div>
          )}
          <div className={sp ? styles.labelled : undefined}>
            {sp && <span className={styles.lineLabel}>{label}</span>}
            <PreviewLine preview={p} testId="git-commit-preview" />
            {p.blocked && (
              <OpNote
                tone="blocked"
                message={p.blocked.message}
                copy={p.blocked.copy}
                testId="git-commit-blocked"
                action={p.files === 0 && p.behind > 0 ? <SyncAction repo={repo} /> : undefined}
              />
            )}
          </div>
        </>
      )}
      {offerPush && (
        <label className={styles.pushAfter}>
          <input type="checkbox" checked={pushAfter} data-testid="git-commit-push-after" onChange={(e) => setPushAfter(e.target.checked)} />
          <span>
            <GitTerm term="push">Push</GitTerm> after committing
          </span>
        </label>
      )}
      {ownFailure && (
        <OpNote
          tone="failed"
          message={failureText(ownFailure)}
          copy={ownFailure.copy}
          detail={ownFailure.detail}
          testId="git-commit-failure"
          action={
            ownFailure.kind === 'remote-moved' ? <SyncAction repo={repo} /> : undefined
          }
        />
      )}
      <div className={styles.composerActions}>
        <Button data-testid="git-commit-cancel" onClick={() => setComposer(repo.root, false)}>
          Cancel
        </Button>
        <Button variant={sp ? 'default' : 'primary'} disabled={!canRun} data-testid="git-commit-run" onClick={() => void submit('all')}>
          {running === 'commit-push' ? `${label === 'Push' ? 'Pushing' : 'Committing'}…` : label}
        </Button>
        {sp && (
          <Button variant="primary" disabled={!canRunStaged} data-testid="git-commit-staged-run" onClick={() => void submit('staged')}>
            {running === 'commit-staged' ? 'Committing…' : stagedLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
