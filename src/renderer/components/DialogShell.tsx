// Pomade — the pane-scoped modal shell (T-160, promoted to components/ in T-169). A thin
// presentational wrapper over dialog.module.css's scrim/modal/title/row — the confirm/prompt
// dialogs that live INSIDE a pane (an editor pane or a terminal pane) rather than over the whole
// window. Deliberately distinct from the window-level Modal (components/Modal.tsx): its scrim is
// `position: absolute` (centers within the pane), it has no header bar or × close button, and its
// footer can hold any number of buttons (Modal's ConfirmDialog is fixed at two).

import type { ReactNode } from 'react'

import styles from './dialog.module.css'

export function DialogShell({
  testId,
  ariaLabel,
  title,
  children,
  footer,
  onScrimClick
}: {
  testId: string
  ariaLabel: string
  title: string
  children?: ReactNode
  footer: ReactNode
  /** Only set where the scrim must stop a click from reaching whatever sits behind the pane
   *  (TerminalPane — a click landing on the xterm surface behind the scrim has side effects). */
  onScrimClick?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div className={styles.modalScrim} data-testid={testId} onClick={onScrimClick}>
      <div className={styles.modal} role="dialog" aria-label={ariaLabel}>
        <div className={styles.modalTitle}>{title}</div>
        {children}
        <div className={styles.modalRow}>{footer}</div>
      </div>
    </div>
  )
}
