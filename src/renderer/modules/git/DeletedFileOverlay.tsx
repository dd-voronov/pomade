// Pomade — E-036: a deleted file's last committed version, read-only, opened from its ghost row in
// the file tree. Titled "<name> · deleted"; **Restore file** writes it back to disk from the last
// commit (main refuses when something exists at the path — rule 8), after which the tree's ghost
// row becomes a normal row on the next git snapshot. Same overlay shell as the diff overlay.

import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'

import type { CommittedFile } from '@shared/git-state'
import { useToast } from '../../hooks/useToast'
import { cleanIpcError } from '../../lib/ipc-errors'
import { buildEditorTheme } from '../editor/cm-theme'
import { basename, languageExtension } from '../editor/doc-kind'
import { useGitUiStore } from './git-ui-store'
import overlay from './DiffOverlay.module.css'
import styles from './DeletedFileOverlay.module.css'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ReadOnlyText({ path, content }: { path: string; content: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          buildEditorTheme(),
          languageExtension(path)
        ]
      })
    })
    return () => view.destroy()
  }, [path, content])
  return <div className={styles.text} ref={hostRef} data-testid="deleted-file-content" />
}

export function DeletedFileOverlay(): React.JSX.Element | null {
  const path = useGitUiStore((s) => s.deleted)
  const close = useGitUiStore((s) => s.closeDeleted)
  const toast = useToast()
  const [file, setFile] = useState<CommittedFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!path) return
    let cancelled = false
    setFile(null)
    setError(null)
    window.pomade.git.committedFile(path).then(
      (f) => {
        if (!cancelled) setFile(f)
      },
      (err: unknown) => {
        if (!cancelled) setError(cleanIpcError(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [path])

  useEffect(() => {
    if (!path) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [path, close])

  if (!path) return null
  const name = basename(path)

  const restore = async (): Promise<void> => {
    setRestoring(true)
    try {
      await window.pomade.git.restoreFile(path)
      close()
      toast(`Restored ${name}`, 'info')
    } catch (err) {
      toast(`Could not restore ${name}: ${cleanIpcError(err)}`, 'error')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className={overlay.scrim} data-testid="deleted-file-overlay" onMouseDown={close}>
      <div className={overlay.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div className={overlay.header}>
          <span className={overlay.title} data-testid="deleted-file-title">
            {name} · deleted
          </span>
          <span className={styles.actions}>
            {file && (
              <span className={styles.caption} data-testid="deleted-file-caption">
                Last committed version ({file.commit})
              </span>
            )}
            <button
              type="button"
              className={styles.restore}
              data-testid="deleted-file-restore"
              disabled={restoring || !file}
              onClick={() => void restore()}
            >
              Restore file
            </button>
            <button
              type="button"
              className={overlay.close}
              aria-label="Close"
              data-testid="deleted-file-close"
              onClick={close}
            >
              ×
            </button>
          </span>
        </div>
        <div className={overlay.body}>
          {error ? (
            <div className={styles.message} data-testid="deleted-file-error">
              {error}
            </div>
          ) : !file ? (
            <div className={styles.message}>Loading…</div>
          ) : file.kind === 'binary' ? (
            <div className={styles.message} data-testid="deleted-file-binary">
              Binary file ({formatSize(file.size)}) — it can't be shown here. Restore it to open it.
            </div>
          ) : (
            <ReadOnlyText path={path} content={file.content} />
          )}
        </div>
      </div>
    </div>
  )
}
