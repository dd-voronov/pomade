// Pomade — Unbound-session recovery popover (E-025 slice 5). Opened by clicking the ⚠️ mark on
// a live agent tab whose bind window closed with no uniquely-attributable session id (nothing
// qualifying appeared, or a submit-order tie forced a refusal — the watcher never binds on a
// coin-flip). Three exits, per the locked spec:
//   • Enter session-id + Bind — the id is VALIDATED against the tab's expected store (the same
//     cwd-at-launch key the revive gate uses) and bound ONLY if the transcript exists there; a
//     nonexistent id is refused inline (its resume would fail). Pairs with the agent's farewell
//     line in scrollback ("… run claude --resume <id>"), the natural copy source.
//   • Ignore — silence the mark for THIS unbound session only. The tab stays in the state
//     machine (a later `/clear` / exit-restart / retry submit rebinds it); the only consequence
//     of staying unbound is no auto-resume after a restart.
//   • Cancel / Esc / click-outside — close, keep the mark (deal with it later).
// Positioning/scrim mechanics follow SymlinkPopover (the tab strip's other mark popover).

import { useEffect, useState } from 'react'

import type { Id } from '@shared/types'
import { useTerminalsStore } from '../../stores/terminals-store'
import { Popover } from '../../components/Popover'
import styles from './UnboundPopover.module.css'

const POP_WIDTH = 340

export function UnboundPopover({
  projectId,
  tabId,
  anchorRect,
  onClose
}: {
  projectId: Id
  tabId: Id
  anchorRect: DOMRect
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - POP_WIDTH - 8))
  const top = anchorRect.bottom + 4

  const bind = async (): Promise<void> => {
    const id = value.trim()
    if (!id || busy) return
    setBusy(true)
    setError(null)
    const ok = await useTerminalsStore.getState().bindSessionManually(projectId, tabId, id)
    setBusy(false)
    if (ok) {
      onClose()
      return
    }
    // Refused: no transcript with this id in the tab's expected store — never bind it.
    setError('No session with this id in this tab’s store.')
  }

  const ignore = (): void => {
    useTerminalsStore.getState().silenceUnbound(projectId, tabId)
    onClose()
  }

  return (
    <Popover
      onDismiss={onClose}
      style={{ left, top, width: POP_WIDTH }}
      ariaLabel="Session not identified"
      testId="unbound-popover"
      panelClassName={styles.pop}
    >
      <div className={styles.head}>Session not identified</div>
      <p className={styles.text}>
        Pomade couldn’t tell which session this tab created, so it won’t auto-resume after a
        restart. Paste the session id (the agent’s “to resume, run … --resume &lt;id&gt;” line has
        it) to bind it manually.
      </p>
      <input
        className={styles.input}
        data-testid="unbound-id-input"
        placeholder="Session id"
        value={value}
        autoFocus
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void bind()
        }}
      />
      {error && (
        <div className={styles.error} data-testid="unbound-error">
          {error}
        </div>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          data-testid="unbound-bind"
          disabled={!value.trim() || busy}
          onClick={() => void bind()}
        >
          Bind
        </button>
        <button type="button" className={styles.btn} data-testid="unbound-ignore" onClick={ignore}>
          Ignore
        </button>
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} data-testid="unbound-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Popover>
  )
}
