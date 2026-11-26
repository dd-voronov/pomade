// Pomade Wave 3 — side-by-side diff for a doc, powered by @codemirror/merge.
// Read-only on both sides; a mode switcher flips between "Saved ↔ Unsaved" (disk vs the editor
// buffer — every doc, E-035) and, for a file inside a repo, "Working vs HEAD" and "HEAD vs
// Previous" (revision labels from GitService). App-themed via cm-theme.

import { useEffect, useRef, useState } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'

import type { FileDiff } from '@shared/ipc-api'
import { buildEditorTheme } from '../editor/cm-theme'
import { languageExtension } from '../editor/doc-kind'
import { normalize, readPath } from '../editor/doc-io'
import { readDocBuffer } from '../editor/doc-buffers'
import { cleanIpcError } from '../../lib/ipc-errors'
import type { DiffTarget, PeekMode } from './git-ui-store'
import styles from './DiffView.module.css'

const SAVED_MODE: { id: PeekMode; label: string } = { id: 'saved-vs-unsaved', label: 'Saved ↔ Unsaved' }
const REPO_MODES: { id: PeekMode; label: string }[] = [
  { id: 'working-vs-head', label: 'Working vs HEAD' },
  { id: 'head-vs-prev', label: 'HEAD vs Previous' }
]

/** Saved ↔ Unsaved: the file as on disk (line endings normalized like the editor's buffer) vs
 *  the tab's live buffer. An Untitled or vanished file has an empty saved side. */
async function savedVsUnsaved(target: DiffTarget): Promise<FileDiff> {
  let saved = ''
  let labelA = 'Saved (not on disk)'
  if (target.path) {
    try {
      saved = normalize(await readPath(target.path)).text
      labelA = 'Saved (on disk)'
    } catch {
      /* vanished — empty saved side */
    }
  }
  if (saved.includes('\u0000')) throw new Error('it looks like a binary file')
  return { a: saved, b: readDocBuffer(target.tabId) ?? saved, labelA, labelB: 'Unsaved (editor)' }
}

function readOnlyExtensions(path: string): Extension[] {
  return [
    lineNumbers(),
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    buildEditorTheme(),
    languageExtension(path)
  ]
}

export function DiffView({ target }: { target: DiffTarget }): React.JSX.Element {
  const { path } = target
  const [mode, setMode] = useState<PeekMode>(target.mode)
  const modes = target.repo ? [SAVED_MODE, ...REPO_MODES] : [SAVED_MODE]
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mergeRef = useRef<MergeView | null>(null)

  // Fetch the two sides whenever the file or mode changes.
  useEffect(() => {
    let cancelled = false
    setError(null)
    setDiff(null)
    void (async () => {
      try {
        const d =
          mode === 'saved-vs-unsaved'
            ? await savedVsUnsaved(target)
            : await window.pomade.git.fileDiff(path, mode)
        if (!cancelled) setDiff(d)
      } catch (err) {
        if (!cancelled) setError(cleanIpcError(err))
      }
    })()
    return () => {
      cancelled = true
    }
    // `target` is replaced (never mutated) on each open, so it is a stable dependency.
  }, [target, path, mode])

  // (Re)build the MergeView when new content arrives.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !diff) return
    const view = new MergeView({
      parent: host,
      orientation: 'a-b',
      highlightChanges: true,
      gutter: true,
      a: { doc: diff.a, extensions: readOnlyExtensions(path) },
      b: { doc: diff.b, extensions: readOnlyExtensions(path) }
    })
    mergeRef.current = view
    return () => {
      view.destroy()
      mergeRef.current = null
    }
  }, [diff, path])

  return (
    <div className={styles.diff} data-testid="diff-view" data-doc-path={path}>
      <div className={styles.switcher}>
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`${styles.modeBtn} ${mode === m.id ? styles.modeActive : ''}`}
            data-testid={`diff-mode-${m.id}`}
            data-active={mode === m.id}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {diff && (
        <div className={styles.labels}>
          <span className={styles.labelA} data-testid="diff-label-a">
            {diff.labelA}
          </span>
          <span className={styles.labelB} data-testid="diff-label-b">
            {diff.labelB}
          </span>
        </div>
      )}

      {error ? (
        <div className={styles.error} data-testid="diff-error">
          Could not diff {target.title}: {error}
        </div>
      ) : !diff ? (
        <div className={styles.loading} data-testid="diff-loading">
          Loading diff…
        </div>
      ) : (
        <div className={styles.mergeHost} ref={hostRef} data-testid="diff-merge" />
      )}
    </div>
  )
}
