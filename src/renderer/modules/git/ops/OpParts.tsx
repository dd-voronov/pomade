// Pomade — E-039: the pieces every operation surface shares — loading a preview, the note that
// says why an operation cannot run or why it failed (with a copy button), and the preview line.

import { useCallback, useEffect, useRef, useState } from 'react'

import { previewSentence, type GitOpPreview, type GitOpRequest } from '@shared/git-ops'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { Sentence } from '../GitTerm'
import styles from './GitOps.module.css'

export interface PreviewState {
  preview: GitOpPreview | null
  loading: boolean
  error: string | null
  reload: () => void
}

/** The preview of `req` on `repo`, reloaded when `key` changes (the repo's HEAD and changes) and
 *  on `reload()`. `req` null = not yet (connect-remote before a URL is checked). */
export function usePreview(repo: string, req: GitOpRequest | null, key: string): PreviewState {
  const [preview, setPreview] = useState<GitOpPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const gen = useRef(0)
  const reqKey = req ? JSON.stringify(req) : ''
  useEffect(() => {
    const g = ++gen.current
    if (!reqKey) {
      setPreview(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    window.pomade.git.preview(repo, JSON.parse(reqKey) as GitOpRequest).then(
      (p) => {
        if (gen.current !== g) return
        setPreview(p)
        setLoading(false)
      },
      (err: unknown) => {
        if (gen.current !== g) return
        setError(cleanIpcError(err))
        setPreview(null)
        setLoading(false)
      }
    )
  }, [repo, reqKey, key, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { preview, loading, error, reload }
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className={styles.copyBtn}
      data-testid="git-op-copy"
      data-copied={copied || undefined}
      onClick={() => {
        void window.pomade.app.clipboardWrite(text)
        setCopied(true)
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** Why an operation cannot run, or why it failed: the plain sentence, git's own line under it when
 *  the sentence is Pomade's wording, a copy button for the command to run (or git's line), and an
 *  optional next step. */
export function OpNote({
  tone,
  message,
  copy,
  detail,
  action,
  testId
}: {
  tone: 'blocked' | 'failed' | 'restored'
  message: string
  copy?: string
  detail?: string
  action?: React.ReactNode
  testId: string
}): React.JSX.Element {
  return (
    <div className={styles.note} data-tone={tone} data-testid={testId} role={tone === 'failed' ? 'alert' : undefined}>
      <div className={styles.noteText} data-testid={`${testId}-message`}>
        {message}
      </div>
      {detail && detail !== message && (
        <div className={styles.noteDetail} data-testid={`${testId}-detail`}>
          {detail}
        </div>
      )}
      {(copy || action) && (
        <div className={styles.noteActions}>
          {copy && <CopyButton text={copy} />}
          {action}
        </div>
      )}
    </div>
  )
}

/** The preview line of a loaded preview. */
export function PreviewLine({ preview, testId }: { preview: GitOpPreview; testId: string }): React.JSX.Element {
  return (
    <div className={styles.preview} data-testid={testId}>
      <Sentence segs={previewSentence(preview)} />
    </div>
  )
}
