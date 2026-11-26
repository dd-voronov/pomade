// Pomade — T-101 (E-021) scope mark: the exclamation-triangle indicator shown on a doc tab and
// in the editor header when a doc lives outside the active project (orange), outside the workspace
// (red), or is open as copies across multiple projects (adds a tooltip line, colour unchanged).
//
// It occupies its OWN slot — independent of the blue (unsaved) and red (attention) dots; a tab may
// show a dot AND a triangle at once. Only ONE triangle ever shows per tab (orange XOR red).
//
// The triangle carries its own hover/focus trigger and renders the shared `TooltipBubble` (the one
// themed tooltip box: sized to its text, wrapping past the max width, clamped inside the window),
// one stacked line per active reason.

import { useRef, useState } from 'react'

import { TooltipBubble } from './Tooltip'

import styles from './ScopeMark.module.css'

export type ScopeTone = 'warning' | 'danger'

// Bootstrap "exclamation-triangle-fill" (viewBox 0 0 16 16): the exclamation is a reverse-wound
// sub-path, so with the default nonzero fill rule it reads as a cutout — the triangle body is
// currentColor (tinted --warning / --danger by the wrapper) and the mark shows the background
// through, which is always correct regardless of any per-tab colour tint.
function WarningTriangleIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"
      />
    </svg>
  )
}

interface ScopeMarkProps {
  tone: ScopeTone
  /** One tooltip line per active reason, in order (location first, duplicate appended). */
  lines: string[]
  testId?: string
  /** E-025 — makes the mark CLICKABLE (role=button, pointer cursor): the Unbound ⚠️ on an agent
   *  tab opens its recovery popover here. The click never bubbles (a mark click must not
   *  activate/deactivate the tab underneath). Absent = the original passive indicator. */
  onClick?: (anchorRect: DOMRect) => void
}

export function ScopeMark({ tone, lines, testId, onClick }: ScopeMarkProps): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const show = (): void => {
    const el = ref.current
    if (!el) return
    setAnchorRect(el.getBoundingClientRect())
  }
  const hide = (): void => setAnchorRect(null)

  const activate = (e: { stopPropagation: () => void }): void => {
    if (!onClick) return
    e.stopPropagation()
    hide()
    const rect = ref.current?.getBoundingClientRect()
    if (rect) onClick(rect)
  }

  return (
    <span
      ref={ref}
      className={`${styles.mark} ${tone === 'danger' ? styles.danger : styles.warning} ${onClick ? styles.clickable : ''}`}
      data-testid={testId}
      data-tone={tone}
      role={onClick ? 'button' : 'img'}
      aria-label={lines.join('. ')}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={onClick ? activate : undefined}
      onKeyDown={
        onClick
          ? (e): void => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                activate(e)
              }
            }
          : undefined
      }
    >
      <WarningTriangleIcon />
      {anchorRect && (
        <TooltipBubble lines={lines} anchorRect={anchorRect} testId={testId ? `${testId}-tooltip` : undefined} />
      )}
    </span>
  )
}
