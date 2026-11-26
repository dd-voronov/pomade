// Pomade — modal shell (Wave 2a). A centered dialog over a scrim, used by the
// project/group config modals, delete confirmations, and the file-tree name prompt.

import { useEffect, useRef, type ReactNode } from 'react'

import styles from './Modal.module.css'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  testId?: string
  width?: number
}

/** The open modals, the newest last: Esc closes only the topmost one (a confirm over Settings). */
const openModals: symbol[] = []

export function Modal({ title, onClose, children, footer, testId, width }: ModalProps): React.JSX.Element {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const me = Symbol('modal')
    openModals.push(me)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && openModals[openModals.length - 1] === me) close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      openModals.splice(openModals.indexOf(me), 1)
    }
  }, [])

  return (
    <div className={styles.scrim} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.title}>{title}</span>
          <button
            type="button"
            className={styles.close}
            aria-label="Close"
            data-testid="modal-close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  )
}
