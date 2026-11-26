// Pomade — E-039: the dialog of every operation that is not Commit & push — Get their changes then
// push, Undo last commit, Discard changes, Connect remote, and E-040's Pull, Publish branch, New
// branch (a name box), Switch branch (a branch list), Rebase, Continue and Abort. It opens on the
// preview: what will happen, in plain words with the git terms explained, or why it cannot happen
// now. The button runs exactly that; a failure stays in the dialog with its copy button. A switch
// blocked by uncommitted files offers the two ways out: commit them, or discard them.
// E-041: Check out to a worktree, Merge into main (squash or merge commit, a message box prefilled
// with the branch's name and commit subjects), Finish / Abort the merge, Remove branch and worktree
// (offered right after a landing as "Landed — remove branch and worktree?"), Rebase a branch.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { relativeTime } from '@shared/git-history'
import { squashMessage } from '@shared/git-branches'
import { discardLine, skipLine, type GitOpRequest } from '@shared/git-ops'
import type { RepoState } from '@shared/git-state'
import { Modal } from '../../../components/Modal'
import { Button, TextInput } from '../../../components/fields'
import { GitTerm } from '../GitTerm'
import { useGitStateStore, useGitStateSubscription } from '../git-state-store'
import { repoKeyOf } from './CommitComposer'
import { OpNote, PreviewLine, usePreview } from './OpParts'
import { OP_TITLE, failureText, runGitOp, useGitOpsStore } from './git-ops-store'
import styles from './GitOps.module.css'

function confirmLabel(req: GitOpRequest, mode: 'undo' | 'revert' | null, n: number): string {
  switch (req.op) {
    case 'sync-push':
      return 'Get their changes, then push'
    case 'undo-commit':
      return mode === 'revert' ? 'Add cancelling commit & push' : 'Undo commit'
    case 'discard':
      return n === 1 ? 'Discard 1 file' : `Discard ${n} files`
    case 'connect-remote':
      return 'Connect'
    case 'commit-push':
      return 'Commit & push'
    case 'pull':
      return 'Pull'
    case 'publish':
      return 'Publish'
    case 'create-branch':
      return 'Create branch'
    case 'switch-branch':
      return 'Switch'
    case 'rebase':
      return 'Rebase'
    case 'rebase-continue':
      return 'Continue'
    case 'rebase-abort':
    case 'merge-abort':
      return 'Abort, back to before'
    case 'worktree-add':
      return 'Check out'
    case 'merge-branch':
      return req.mode === 'squash' ? 'Squash & merge' : 'Merge'
    case 'merge-continue':
      return 'Finish the merge'
    case 'remove-landed':
      return 'Remove'
    case 'rebase-branch':
      return 'Rebase'
    default:
      return OP_TITLE[req.op]
  }
}

function dialogTitle(req: GitOpRequest, mode: 'undo' | 'revert' | null, target: string | null): string {
  if (req.op === 'undo-commit' && mode === 'revert') return 'Undo last commit — revert'
  if (req.op === 'rebase') return `Rebase onto ${target ?? (req.onto === 'main' ? 'main' : 'the upstream')}`
  if (req.op === 'rebase-abort') return 'Abort the rebase'
  if (req.op === 'worktree-add') return `Check out “${req.branch}” to a worktree`
  if (req.op === 'merge-branch') return `Merge “${req.branch}” into ${target ?? 'main'}`
  if (req.op === 'rebase-branch') return `Rebase “${req.branch}” onto ${target ?? 'main'}`
  if (req.op === 'remove-landed') return `Remove “${req.branch}”`
  return OP_TITLE[req.op]
}

export function GitOpDialog({ repo, req: initial, title: fixedTitle }: { repo: RepoState; req: GitOpRequest; title?: string }): React.JSX.Element {
  const closeDialog = useGitOpsStore((s) => s.closeDialog)
  const running = useGitOpsStore((s) => s.running[repo.root])
  const [req, setReq] = useState<GitOpRequest>(initial)
  const [url, setUrl] = useState(initial.op === 'connect-remote' ? initial.url : '')
  const setComposer = useGitOpsStore((s) => s.setComposer)
  const openDialog = useGitOpsStore((s) => s.openDialog)
  const [checked, setChecked] = useState<string | null>(initial.op === 'connect-remote' && initial.url ? initial.url : null)
  const [failure, setFailure] = useState<{ message: string; copy?: string; detail?: string; kind: string; restored?: boolean } | null>(null)
  const connect = req.op === 'connect-remote'
  const previewReq: GitOpRequest | null = connect ? (checked ? { op: 'connect-remote', url: checked } : null) : req
  const { preview: p, loading, error, reload } = usePreview(repo.root, previewReq, connect ? '' : repoKeyOf(repo))
  const mode = p?.op === 'undo-commit' ? p.mode : null
  const n = p?.op === 'discard' ? p.items.length : 0
  const title =
    fixedTitle ??
    dialogTitle(req, mode, p?.op === 'rebase' || p?.op === 'rebase-branch' ? p.target : p?.op === 'merge-branch' ? p.into : null)
  // Merge into main: the message box, prefilled once from the first preview.
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    if (message === null && p?.op === 'merge-branch' && !p.blocked) setMessage(squashMessage(p.branch, p.subjects))
  }, [p, message])
  const merge = req.op === 'merge-branch'
  const busy = !!running || loading
  const canRun = !!p && !p.blocked && !busy && (!connect || checked === url.trim()) && (!merge || !!message?.trim())

  const run = async (): Promise<void> => {
    if (!canRun || !p) return
    setFailure(null)
    const result = await runGitOp(repo.root, repo.name, previewReq!, { token: p.token, ...(merge ? { message: message ?? '' } : {}) })
    if (result.ok) {
      // A landing opens the removal offer in its place (runGitOp).
      if (!result.landed) closeDialog()
      return
    }
    if (result.failure.kind === 'changed') setFailure(null)
    setFailure({ ...result.failure, message: failureText(result.failure) })
    reload()
  }

  const footer = (
    <>
      <Button data-testid="git-op-cancel" onClick={closeDialog}>
        {failure ? 'Close' : 'Cancel'}
      </Button>
      <Button
        variant={req.op === 'discard' ? 'danger' : 'primary'}
        disabled={!canRun}
        data-testid="git-op-run"
        onClick={() => void run()}
      >
        {running ? 'Working…' : confirmLabel(req, mode, n)}
      </Button>
    </>
  )

  return (
    <Modal title={title} onClose={closeDialog} testId="git-op-dialog" width={460} footer={footer}>
      <div className={styles.dialogBody} data-op={req.op} data-mode={mode ?? undefined}>
        <div className={styles.dialogRepo}>
          <GitTerm term="repository">{repo.name}</GitTerm>
          {repo.branch && (
            <>
              {' · '}
              <GitTerm term="branch">{repo.branch}</GitTerm>
            </>
          )}
        </div>

        {connect && (
          <form
            className={styles.urlRow}
            onSubmit={(e) => {
              e.preventDefault()
              setFailure(null)
              setChecked(url.trim())
              if (checked === url.trim()) reload()
            }}
          >
            <TextInput
              value={url}
              autoFocus
              placeholder="git@github.com:you/repo.git or https://…"
              aria-label="Remote address"
              data-testid="git-remote-url"
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button type="submit" disabled={!url.trim() || loading} data-testid="git-remote-check">
              {loading ? 'Checking…' : 'Check'}
            </Button>
          </form>
        )}
        {connect && !checked && (
          <div className={styles.previewPending}>
            Paste the address of a repository you created on GitHub, GitLab or elsewhere — Pomade checks it answers before adding it.
          </div>
        )}

        {req.op === 'create-branch' && (
          <TextInput
            value={req.name}
            autoFocus
            placeholder="e.g. fix/login-typo"
            aria-label="Branch name"
            data-testid="git-branch-name"
            onChange={(e) => setReq({ op: 'create-branch', name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
            }}
          />
        )}
        {req.op === 'merge-branch' && (
          <>
            <div className={styles.branchList} role="radiogroup" aria-label="How it lands" data-testid="git-merge-mode">
              {(
                [
                  ['squash', 'Squash into one commit', 'Its commits become one new commit on main — the usual choice.'],
                  ['merge', 'Merge commit', 'Its commits come along, joined by a merge commit.']
                ] as const
              ).map(([m, name, meta]) => (
                <div
                  key={m}
                  role="radio"
                  aria-checked={req.mode === m}
                  aria-selected={req.mode === m}
                  tabIndex={0}
                  className={styles.branchRow}
                  data-testid={`git-merge-mode-${m}`}
                  onClick={() => setReq({ ...req, mode: m })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setReq({ ...req, mode: m })
                    }
                  }}
                >
                  <span className={styles.branchName}>
                    <GitTerm term={m === 'squash' ? 'squash' : 'merge'}>{name}</GitTerm>
                  </span>
                  <span className={styles.branchMeta}>{meta}</span>
                </div>
              ))}
            </div>
            <textarea
              className={styles.message}
              value={message ?? ''}
              rows={5}
              placeholder="What this lands, in a sentence"
              aria-label="Commit message"
              data-testid="git-merge-message"
              onChange={(e) => setMessage(e.target.value)}
            />
          </>
        )}
        {req.op === 'switch-branch' && p?.op === 'switch-branch' && (
          <ul className={styles.branchList} role="listbox" aria-label="Branches" data-testid="git-branch-list">
            {p.branches.map((b) => (
              <li
                key={b.name}
                role="option"
                aria-selected={b.name === req.branch}
                aria-disabled={b.current || undefined}
                tabIndex={b.current ? -1 : 0}
                className={styles.branchRow}
                data-testid={`git-branch-${b.name}`}
                data-current={b.current || undefined}
                onClick={() => !b.current && setReq({ op: 'switch-branch', branch: b.name })}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !b.current) {
                    e.preventDefault()
                    setReq({ op: 'switch-branch', branch: b.name })
                  }
                }}
              >
                <span className={styles.branchName}>{b.name}</span>
                {b.current && <span className={styles.branchTag}>current</span>}
                {b.remote && <span className={styles.branchTag}>only on the remote</span>}
                <span className={styles.branchMeta}>
                  {b.subject} · {relativeTime(b.date, Date.now())}
                </span>
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <OpNote tone="failed" message={error} copy={error} testId="git-op-error" />
        ) : previewReq && (!p || (loading && connect)) ? (
          <div className={styles.previewPending}>{connect ? 'Asking the remote…' : 'Checking what this will do…'}</div>
        ) : p ? (
          <>
            <PreviewLine preview={p} testId="git-op-preview" />
            {p.op === 'discard' && (p.items.length > 0 || p.skipped.length > 0) && (
              <ul className={styles.fileList} data-testid="git-op-files">
                {p.items.map((it) => (
                  <li key={it.path} data-testid={`git-op-file-${it.path}`}>
                    {discardLine(it)}
                  </li>
                ))}
                {p.skipped.map((s) => (
                  <li key={s.path} className={styles.skipped} data-testid={`git-op-skipped-${s.path}`}>
                    {skipLine(s)}
                  </li>
                ))}
              </ul>
            )}
            {p.op === 'switch-branch' && p.conflicts.length > 0 && (
              <ul className={styles.fileList} data-testid="git-op-files">
                {p.conflicts.map((c) => (
                  <li key={c} data-testid={`git-op-file-${c}`}>
                    {c.slice(c.lastIndexOf('/') + 1)} — changed here, different there
                  </li>
                ))}
              </ul>
            )}
            {p.blocked && (
              <OpNote
                tone="blocked"
                message={p.blocked.message}
                copy={p.blocked.copy}
                testId="git-op-blocked"
                action={
                  p.op === 'switch-branch' && p.conflicts.length > 0 ? (
                    <>
                      <button
                        type="button"
                        className={styles.noteAction}
                        data-testid="git-switch-commit-first"
                        onClick={() => {
                          closeDialog()
                          setComposer(repo.root, true)
                        }}
                      >
                        Commit first…
                      </button>
                      <button
                        type="button"
                        className={styles.noteAction}
                        data-testid="git-switch-discard-first"
                        onClick={() => openDialog(repo.root, repo.name, { op: 'discard', paths: p.conflicts })}
                      >
                        Discard {p.conflicts.length === 1 ? 'it' : 'them'} first…
                      </button>
                    </>
                  ) : undefined
                }
              />
            )}
          </>
        ) : null}

        {failure && (
          <OpNote
            tone={failure.restored ? 'restored' : 'failed'}
            message={failure.message}
            copy={failure.copy}
            detail={failure.detail}
            testId="git-op-failure"
            action={
              failure.kind === 'remote-moved' && req.op !== 'sync-push' ? (
                <button
                  type="button"
                  className={styles.noteAction}
                  data-testid="git-op-sync"
                  onClick={() => {
                    setFailure(null)
                    setReq({ op: 'sync-push' })
                  }}
                >
                  Get their changes, then push…
                </button>
              ) : undefined
            }
          />
        )}
      </div>
    </Modal>
  )
}

/** The one operation dialog (git-ops-store `dialog`), mounted once in the app shell: the Git panel
 *  and the conflict tab both open it, whatever the side panel shows. Portalled to the body. */
export function GitOpDialogHost(): React.JSX.Element | null {
  useGitStateSubscription()
  const dialog = useGitOpsStore((s) => s.dialog)
  const repo = useGitStateStore((s) => (dialog ? s.snapshot.repos.find((r) => r.root === dialog.repo) : undefined))
  if (!dialog || !repo) return null
  return createPortal(
    <GitOpDialog key={`${dialog.repo}:${dialog.req.op}`} repo={repo} req={dialog.req} title={dialog.title} />,
    document.body
  )
}
