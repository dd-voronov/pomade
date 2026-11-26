// Pomade — the shared anchored-popover shell (T-169). One scrim + panel implementation for every
// click-anchored popover: SymlinkPopover, UnboundPopover, ColorPickerPopover, and the file tree's
// go-to-path suggestion popover were four copy-pasted implementations of exactly this pair of
// elements. Dismiss semantics (Escape, focus) stay with each caller — they differ per popover
// (the color picker also commits on Enter) — this component owns only the scrim/panel shell.

import type { CSSProperties, ReactNode, Ref } from 'react'

import styles from './Popover.module.css'

export interface PopoverProps {
  /** Called when the scrim is clicked (mousedown-through prevented via onContextMenu already). */
  onDismiss: () => void
  /** Inline position/size for the panel (left/top/width — computed by the caller off an anchor). */
  style: CSSProperties
  ariaLabel: string
  /** data-testid on the panel. */
  testId: string
  /** data-testid on the scrim, when a test needs to click it directly. */
  scrimTestId?: string
  /** Extra class(es) layered onto the shared panel shell for this popover's own chrome. */
  panelClassName?: string
  panelRef?: Ref<HTMLDivElement>
  tabIndex?: number
  children: ReactNode
}

export function Popover({
  onDismiss,
  style,
  ariaLabel,
  testId,
  scrimTestId,
  panelClassName,
  panelRef,
  tabIndex,
  children
}: PopoverProps): React.JSX.Element {
  return (
    <>
      <div
        className={styles.scrim}
        data-testid={scrimTestId}
        onClick={onDismiss}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        ref={panelRef}
        className={panelClassName ? `${styles.panel} ${panelClassName}` : styles.panel}
        style={style}
        role="dialog"
        aria-label={ariaLabel}
        data-testid={testId}
        tabIndex={tabIndex}
      >
        {children}
      </div>
    </>
  )
}
