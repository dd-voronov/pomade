// Pomade E-001 (T-012) — in-document find panel for the RENDERED (Milkdown) view. Raw mode
// uses CodeMirror's own themed panel instead, so this component is rendered-mode only. Find
// with match count + step-through (Enter / Shift+Enter, or the arrows); Esc closes. Replace
// is raw-only for v1 — stated in the panel, never failing silently.

import { useEffect, useRef } from 'react'

import { Tooltip } from '../../components/Tooltip'
import type { FindMatchInfo } from './editor-controller'
import styles from './EditorPane.module.css'

interface EditorFindPanelProps {
  query: string
  caseSensitive: boolean
  info: FindMatchInfo
  // T-096 — the panel serves BOTH the rendered-markdown view and the CSV table; `data-mode`
  // reflects which, instead of the old hardcoded `rendered`.
  mode: 'rendered' | 'table'
  onQueryChange: (q: string) => void
  onCaseSensitiveChange: (v: boolean) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function EditorFindPanel({
  query,
  caseSensitive,
  info,
  mode,
  onQueryChange,
  onCaseSensitiveChange,
  onNext,
  onPrev,
  onClose
}: EditorFindPanelProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Focus + select on open so a prefilled selection is easy to replace.
  useEffect(() => {
    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const count = info.count
  const label = count === 0 ? (query ? 'No results' : '') : `${info.current} of ${count}`

  return (
    <div className={styles.findPanel} role="search" data-testid="find-panel" data-mode={mode}>
      <input
        ref={inputRef}
        className={styles.findInput}
        data-testid="find-input"
        type="text"
        placeholder="Find in document"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className={styles.findCount} data-testid="find-count">
        {label}
      </span>
      <Tooltip lines={['Match case']}>
        <button
          type="button"
          className={`${styles.findBtn} ${caseSensitive ? styles.findBtnActive : ''}`}
          data-testid="find-case"
          aria-pressed={caseSensitive}
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
        >
          Aa
        </button>
      </Tooltip>
      <Tooltip lines={['Previous match (Shift+Enter)']}>
        <button
          type="button"
          className={styles.findBtn}
          data-testid="find-prev"
          aria-label="Previous match"
          disabled={count === 0}
          onClick={onPrev}
        >
          ↑
        </button>
      </Tooltip>
      <Tooltip lines={['Next match (Enter)']}>
        <button
          type="button"
          className={styles.findBtn}
          data-testid="find-next"
          aria-label="Next match"
          disabled={count === 0}
          onClick={onNext}
        >
          ↓
        </button>
      </Tooltip>
      <Tooltip lines={['Close (Esc)']}>
        <button
          type="button"
          className={styles.findBtn}
          data-testid="find-close"
          aria-label="Close find"
          onClick={onClose}
        >
          ✕
        </button>
      </Tooltip>
      <span className={styles.findNote} data-testid="find-replace-note">
        Replace is available in raw mode.
      </span>
    </div>
  )
}
