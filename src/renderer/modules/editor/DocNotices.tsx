// Pomade — a document's on-disk notices (rule 8), shared by the doc tab and the comparison tab that
// shares its buffer, so both say the same thing:
//   missing          the file is gone; saving recreates it
//   changed, clean   another writer changed the file — Reload / Dismiss (never a silent reload)
//   changed, dirty   the amber banner — the file changed under unsaved edits; Compare opens
//                    disk ↔ my edits in a comparison tab, where the edits are resolved
//   recovered        unsaved edits restored after a crash — Compare / Discard / Dismiss

import { formatRecoveredAt } from '@shared/recovery'
import styles from './EditorPane.module.css'

export function DocNotices(props: {
  missing: boolean
  changedOutside: boolean
  dirty: boolean
  refused: boolean
  onReload: () => void
  onDismissChange: () => void
  /** Absent where the comparison is already open (the disk ↔ my edits tab itself). */
  onCompareDisk?: () => void
  recoveredAt?: number | null
  onRecoveredCompare?: () => void
  onRecoveredDiscard?: () => void
  onDismissRecovered?: () => void
}): React.JSX.Element {
  const { missing, changedOutside, dirty, refused, recoveredAt = null } = props
  return (
    <>
      {missing && !refused && (
        <div className={styles.notice} data-testid="editor-missing">
          This file no longer exists on disk (moved or deleted). Saving will recreate it.
        </div>
      )}
      {changedOutside && !missing && !refused && !dirty && (
        <div className={styles.notice} data-testid="editor-changed-outside">
          This file changed on disk outside Pomade.
          <button type="button" className={styles.noticeBtn} data-testid="editor-reload" onClick={props.onReload}>
            Reload
          </button>
          <button
            type="button"
            className={styles.noticeBtn}
            data-testid="editor-dismiss-change"
            onClick={props.onDismissChange}
          >
            Dismiss
          </button>
        </div>
      )}
      {/* E-035 (rule 8) — the file changed under unsaved edits: neither side changes on its own. */}
      {changedOutside && !missing && !refused && dirty && props.onCompareDisk && (
        <div className={`${styles.notice} ${styles.noticeWarning}`} data-testid="editor-changed-dirty">
          File changed since your edits.
          <button
            type="button"
            className={styles.noticeBtn}
            data-testid="editor-compare-disk"
            title="Compare the file on disk with your unsaved edits, side by side"
            onClick={props.onCompareDisk}
          >
            Compare
          </button>
        </div>
      )}
      {/* E-035 — unsaved edits restored after a crash, force quit or reload. */}
      {recoveredAt !== null && dirty && !changedOutside && !refused && (
        <div className={styles.notice} data-testid="editor-recovered">
          Recovered unsaved edits from{' '}
          <span data-testid="editor-recovered-time">{formatRecoveredAt(recoveredAt, Date.now())}</span>.
          <button
            type="button"
            className={styles.noticeBtn}
            data-testid="editor-recovered-compare"
            onClick={props.onRecoveredCompare}
          >
            Compare
          </button>
          <button
            type="button"
            className={styles.noticeBtn}
            data-testid="editor-recovered-discard"
            title="Revert to the saved version; your edits are kept as a discarded draft"
            onClick={props.onRecoveredDiscard}
          >
            Discard
          </button>
          <button
            type="button"
            className={styles.noticeBtn}
            data-testid="editor-recovered-dismiss"
            onClick={props.onDismissRecovered}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
