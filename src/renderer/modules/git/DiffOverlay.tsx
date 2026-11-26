// Pomade Wave 3 — global Cmd+Shift+G handler + the quick-peek diff overlay.
// When a doc pane is active, Cmd+Shift+G opens a read-only side-by-side diff for that doc:
// Saved ↔ Unsaved for any doc, plus the git modes inside a repo (E-035, quick-peek.ts). A
// non-doc target explains itself via a toast.

import { useEffect } from 'react'

import { useTabsStore } from '../../stores/tabs-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useToast } from '../../hooks/useToast'
import { cleanIpcError } from '../../lib/ipc-errors'
import { useGitUiStore } from './git-ui-store'
import { DiffView } from './DiffView'
import { openQuickPeek } from './quick-peek'
import styles from './DiffOverlay.module.css'

export function DiffOverlay(): React.JSX.Element | null {
  const diff = useGitUiStore((s) => s.diff)
  const closeDiff = useGitUiStore((s) => s.closeDiff)
  const toast = useToast()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== 'g') return
      e.preventDefault()
      const ws = useWorkspaceStore.getState()
      const tabsState = useTabsStore.getState()
      const pid = ws.activeProjectId
      const activeTabId = tabsState.activeTabByProject[pid]
      const tab = (tabsState.tabsByProject[pid] ?? []).find((t) => t.id === activeTabId)
      if (!tab || tab.kind !== 'doc') {
        toast('Open a document to diff it (Cmd+Shift+G).', 'info')
        return
      }
      openQuickPeek(tab).catch((err: unknown) => {
        toast(`Could not open diff: ${cleanIpcError(err)}`, 'error')
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toast])

  // Escape closes the overlay.
  useEffect(() => {
    if (!diff) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDiff()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [diff, closeDiff])

  if (!diff) return null

  return (
    <div className={styles.scrim} data-testid="diff-overlay" onMouseDown={closeDiff}>
      <div className={styles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Diff · {diff.title}</span>
          <button
            type="button"
            className={styles.close}
            aria-label="Close diff"
            data-testid="diff-close"
            onClick={closeDiff}
          >
            ×
          </button>
        </div>
        <div className={styles.body}>
          <DiffView key={`${diff.tabId}:${diff.mode}`} target={diff} />
        </div>
      </div>
    </div>
  )
}
