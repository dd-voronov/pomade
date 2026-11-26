// Pomade — E-007 (T-029). A draggable vertical divider between two layout columns.
// It only reports pointer geometry: onDrag(clientX) fires on every move, onCommit() once
// at drag end (or after a keyboard step) so the caller persists the final width. Resizing
// is pure CSS width change on the columns, so panes (xterm/editors) never remount.
//
// Keyboard-accessible (a11y plus): focusable role="separator"; Left/Right arrows nudge the
// left column by one step and commit. The caller maps a step delta via onKeyStep.

import type { KeyboardEvent, PointerEvent } from 'react'

import styles from './ColumnDivider.module.css'

interface ColumnDividerProps {
  ariaLabel: string
  testId: string
  onDrag: (clientX: number) => void
  onCommit: () => void
  onKeyStep: (delta: number) => void
}

const KEY_STEP = 16

export function ColumnDivider({
  ariaLabel,
  testId,
  onDrag,
  onCommit,
  onKeyStep
}: ColumnDividerProps): React.JSX.Element {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const move = (ev: globalThis.PointerEvent): void => onDrag(ev.clientX)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onCommit()
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onKeyStep(-KEY_STEP)
      onCommit()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      onKeyStep(KEY_STEP)
      onCommit()
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      className={styles.divider}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}
