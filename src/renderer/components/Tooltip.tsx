// Pomade — shared design-system tooltip. A light, tokens-driven, portalled hover/focus tooltip for
// arbitrary chrome (buttons, icons), and the one tooltip bubble every themed tooltip renders
// (`TooltipBubble`: this component, ScopeMark, the glossary terms and every other caller go through it).
//
// One sizing rule: short text stays on one line and the box hugs it; longer text wraps inside a
// max width (320px, never wider than the window minus its margins); a long unbroken name breaks
// rather than overflowing the border. Placement is measured AFTER wrapping and clamped fully inside
// the window — centred under the anchor, shifted off the left/right edges, flipped above the
// anchor near the bottom — by the shared `useClampedTooltip` hook (the same clamp the context
// menus use). Portalled to <body> so no overflow:hidden ancestor clips it.

import { cloneElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { useClampedTooltip } from '../hooks/use-clamped-position'

import styles from './Tooltip.module.css'

/** A tooltip line: plain text, or text set in the muted secondary colour (a detail under the main
 *  line). */
export type TooltipLine = string | { text: string; muted: true }

interface TooltipProps {
  /** One tooltip line per entry, in order. */
  lines: TooltipLine[]
  /** The single element the tooltip is anchored to: a DOM element, or a component that forwards
   *  its ref to one (the shared `Button`, `TextInput`, `TextArea` do). Its own ref is preserved; it
   *  may be disabled — the tip still shows. */
  children: ReactElement
  /** Test id for the portalled tooltip node (`<testId>` on the tip span). */
  testId?: string
  /**
   * Optional guard measured on the anchor element AT hover time. When supplied, the tip
   * shows only if it returns true; the anchor's live geometry is read fresh on every mouseenter/
   * focus (a render-time conditional goes stale on resize/rename). Used by the tab strip to show
   * the full-name tooltip ONLY when the title span is truncated (`scrollWidth > clientWidth`).
   * Omitted ⇒ always show.
   */
  showIf?: (anchorEl: HTMLElement) => boolean
}

/**
 * Wrap a single focusable/hoverable element; show a themed tooltip on hover or keyboard focus.
 * It renders no wrapper element, so the child's position in the reserved hover strip is unchanged —
 * critical for the T-135 no-layout-shift guarantee.
 */
export function Tooltip({ lines, children, testId, showIf }: TooltipProps): React.JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)

  const show = (): void => {
    const el = ref.current
    if (!el) return
    // A per-hover guard (e.g. "only when truncated") measured on the live anchor.
    if (showIf && !showIf(el)) return
    setAnchorRect(el.getBoundingClientRect())
  }
  const hide = (): void => setAnchorRect(null)

  // The listeners are native, not React props: React drops `onMouseEnter` on a disabled button, but
  // the browser still dispatches mouseenter/mouseleave to it, so a disabled control's tip (its
  // "blocked" reason) shows without a wrapper element or any change to the child's layout. Focus
  // events are native `focusin`/`focusout`, which is what React's onFocus/onBlur listen to.
  // Re-bound after every render, so a child that swaps its DOM node keeps its tip.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('mouseenter', show)
    el.addEventListener('mouseleave', hide)
    el.addEventListener('focusin', show)
    el.addEventListener('focusout', hide)
    return () => {
      el.removeEventListener('mouseenter', show)
      el.removeEventListener('mouseleave', hide)
      el.removeEventListener('focusin', show)
      el.removeEventListener('focusout', hide)
    }
  })

  // Preserve any ref the child already carries while capturing our own.
  const childRef = (children as { ref?: React.Ref<HTMLElement> }).ref
  const setRef = (node: HTMLElement | null): void => {
    ref.current = node
    if (typeof childRef === 'function') childRef(node)
    else if (childRef && typeof childRef === 'object')
      (childRef as React.MutableRefObject<HTMLElement | null>).current = node
  }

  return (
    <>
      {cloneElement(children, { ref: setRef } as Record<string, unknown>)}
      {anchorRect && <TooltipBubble lines={lines} anchorRect={anchorRect} testId={testId} />}
    </>
  )
}

/**
 * The tooltip box: portalled to <body>, sized to its text (wrapping past the max width), clamped
 * inside the window next to `anchorRect`. Mount it only while the tip is showing.
 */
export function TooltipBubble({
  lines,
  anchorRect,
  testId
}: {
  lines: TooltipLine[]
  anchorRect: DOMRect
  testId?: string
}): React.JSX.Element {
  // Re-measured when the text changes while the tip stays open.
  const textKey = lines.map((l) => (typeof l === 'string' ? l : l.text)).join('\n')
  const { ref, left, top } = useClampedTooltip<HTMLSpanElement>(anchorRect, textKey)
  return createPortal(
    <span ref={ref} className={styles.tooltip} role="tooltip" data-testid={testId} style={{ left, top }}>
      {lines.map((l) =>
        typeof l === 'string' ? (
          <span key={l} className={styles.tooltipLine}>
            {l}
          </span>
        ) : (
          <span key={l.text} className={`${styles.tooltipLine} ${styles.muted}`} data-muted="true">
            {l.text}
          </span>
        )
      )}
    </span>,
    document.body
  )
}
