// Pomade T-088 — viewport clamping for pointer-positioned overlays (context menus, pickers).
//
// Every renderer-built menu is placed at the pointer and grows DOWN-RIGHT, so a right-click near
// the bottom/right edge of the window used to push its last items off-screen (unclickable). The
// clamp was implemented ad hoc in the file tree (E-018) and the terminal (T-084) and missing in
// the editor and tab menus; this module is the single implementation all four share.
//
// Behavior:
//   • measured with getBoundingClientRect in a useLayoutEffect — after mount, BEFORE paint, so
//     the corrected position is the first thing painted and there is no visible jump;
//   • 8px margin from every viewport edge;
//   • horizontal: Math.max(margin, Math.min(anchor, limit)) — slide left until it fits;
//   • vertical: FLIP — no room below ⇒ the menu opens UPWARD, bottom anchored at the click
//     (see flipVertical; T-088 round 2);
//   • re-measures whenever the anchor moves (a new right-click) or the overlay closes.
//
// One thing the ad-hoc copies got wrong: the menu must be measured where it is NOT squeezed.
// A `position: fixed` box with auto width shrink-to-fits the space between its `left` and the
// viewport edge, so measuring it AT the pointer (6px from the right edge) returned its min-width
// with the labels wrapped — and clamping to that too-small width still left the real menu hanging
// off-screen. So the measurement pass parks the box at the viewport origin first (inside the same
// layout effect, so this never reaches the screen) and reads its natural size there.
//
// Compatible with the T-083 round-2 invariant (the editor menu mounts asynchronously, on main's
// EV.spellContext push): the clamp is driven by the overlay's own mount, whenever that happens.

import { useLayoutEffect, useRef, useState } from 'react'

/** Minimum distance an overlay keeps from every viewport edge. */
export const OVERLAY_MARGIN = 8

export interface ClampedPosition<T extends HTMLElement> {
  /** Attach to the positioned element — it is what gets measured. */
  ref: React.MutableRefObject<T | null>
  /** Clamped `left`/`top` for the element's inline style (the raw anchor until measured). */
  left: number
  top: number
}

/** Clamp `value` into `[margin, limit - size - margin]`, favouring the near edge when it can't fit. */
function clamp(value: number, size: number, limit: number, margin: number): number {
  return Math.max(margin, Math.min(value, limit - size - margin))
}

/**
 * Vertical placement FLIPS, it doesn't slide (T-088 round 2 — the Owner: the up/down case is
 * the one that matters). A menu that fits below the anchor opens down as usual; one that
 * doesn't anchors its BOTTOM at the click and opens UPWARD — native menu behavior
 * (Chrome/VS Code/NSMenu). Sliding the menu up instead (the round-1 clamp) kept it
 * on-screen but left the pointer hovering some midway item. Only when the menu fits on
 * neither side (taller than the viewport) does it fall back to the plain clamp.
 */
function flipVertical(y: number, height: number, limit: number, margin: number): number {
  if (y + height <= limit - margin) return y // fits below — open down at the anchor
  const bottom = Math.min(y, limit - margin) // bottom edge anchored at the click (margin kept)
  const above = bottom - height
  if (above >= margin) return above // fits above — open up
  return clamp(y, height, limit, margin)
}

/**
 * The element's UNSQUEEZED size: measured at the viewport origin, as a fixed box, so neither the
 * right nor the bottom edge can shrink-to-fit or wrap it. Called from a layout effect only — the
 * temporary styles are reverted synchronously, before the browser paints, and React rewrites the
 * inline `left`/`top` on the render that follows.
 */
function measureNatural(el: HTMLElement): DOMRect {
  const { position, left, top, right, bottom } = el.style
  el.style.position = 'fixed'
  el.style.left = '0px'
  el.style.top = '0px'
  el.style.right = 'auto'
  el.style.bottom = 'auto'
  const rect = el.getBoundingClientRect()
  el.style.position = position
  el.style.left = left
  el.style.top = top
  el.style.right = right
  el.style.bottom = bottom
  return rect
}

/**
 * Keeps a fixed-position overlay anchored at (x, y) fully inside the viewport.
 *
 * Pass `null` for either coordinate while the overlay is closed (callers that keep the hook
 * mounted alongside a nullable menu state); the stored position resets so the next open measures
 * fresh instead of flashing at the previous spot.
 *
 * `remeasureKey` re-runs the measurement when the overlay's CONTENT changes size without moving
 * (the editor menu's spelling section pops in a beat after the menu opens — T-083 — which makes
 * it taller than it was when first clamped).
 */
export function useClampedPosition<T extends HTMLElement = HTMLDivElement>(
  x: number | null | undefined,
  y: number | null | undefined,
  remeasureKey?: unknown
): ClampedPosition<T> {
  const ref = useRef<T | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (x == null || y == null) {
      setPos(null)
      return
    }
    const el = ref.current
    if (!el) return
    const rect = measureNatural(el)
    setPos({
      left: clamp(x, rect.width, window.innerWidth, OVERLAY_MARGIN),
      top: flipVertical(y, rect.height, window.innerHeight, OVERLAY_MARGIN)
    })
  }, [x, y, remeasureKey])

  return { ref, left: pos?.left ?? x ?? 0, top: pos?.top ?? y ?? 0 }
}

/** Gap between a tooltip and its anchor. */
const TOOLTIP_GAP = 6

export interface AnchoredTooltip<T extends HTMLElement> {
  /** Attach to the portalled tip element — it is what gets measured. */
  ref: React.MutableRefObject<T | null>
  /** Clamped left and top edges for the tip's inline style (`position: fixed`, no transform). */
  left: number
  top: number
}

/**
 * Places the shared tooltip bubble relative to its anchor and keeps it fully on-screen, reusing
 * the SAME margin + `clamp` as the context-menu overlays above.
 *
 * The tip is centred under the anchor and opens DOWNWARD by default; when it would overflow the
 * bottom margin it FLIPS to open above the anchor (native tooltip behavior), falling back to a
 * plain vertical clamp only when it fits on neither side. Horizontally its LEFT edge is clamped,
 * so neither edge crosses the viewport margin near the left/right of the screen.
 *
 * The tip is measured in its FINAL shape — already wrapped inside its max width (the box is
 * `width: max-content`, so the viewport edge never squeezes it) — so the clamp uses the real
 * width and height. `remeasureKey` re-runs the measurement when the content changes while the
 * tip stays open.
 */
export function useClampedTooltip<T extends HTMLElement = HTMLSpanElement>(
  anchor: DOMRect,
  remeasureKey?: unknown
): AnchoredTooltip<T> {
  const ref = useRef<T | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = measureNatural(el)
    const centreX = anchor.left + anchor.width / 2
    const left = clamp(centreX - width / 2, width, window.innerWidth, OVERLAY_MARGIN)
    // Vertical: open below the anchor; FLIP to above when the bottom would clip; last-resort clamp.
    const below = anchor.bottom + TOOLTIP_GAP
    const above = anchor.top - TOOLTIP_GAP - height
    const limitBottom = window.innerHeight - OVERLAY_MARGIN
    let top: number
    if (below + height <= limitBottom) top = below
    else if (above >= OVERLAY_MARGIN) top = above
    else top = clamp(below, height, window.innerHeight, OVERLAY_MARGIN)
    setPos({ left, top })
  }, [anchor, remeasureKey])

  return { ref, left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.bottom + TOOLTIP_GAP }
}

export interface ClampedSubmenu<T extends HTMLElement> {
  /** Attach to the submenu element. */
  ref: React.MutableRefObject<T | null>
  /** True once the submenu was measured as overflowing right and now opens to the LEFT. */
  flipped: boolean
  /** Inline style driving the flyout's `position: fixed` viewport placement. */
  style: React.CSSProperties
}

/**
 * Same clamp, for a submenu that flies out of a parent menu row. The flyout is positioned
 * `fixed` to the VIEWPORT (its left/top computed here from the wrapper row's rect) — NOT
 * absolute-in-flow — because the parent `.menu` sets `overflow-y: auto`, which per the CSS spec
 * forces `overflow-x` to `auto` too: an absolutely-positioned flyout at `left: 100%` would then
 * be CLIPPED inside the menu's scroll box (and would extend its scrollWidth, adding a spurious
 * horizontal scrollbar) instead of flying out beside it. A fixed box escapes every ancestor's
 * overflow. Placement:
 *   • no room on the right of the row → flip to its LEFT (right edge lands on the wrapper's left);
 *   • bottom overflow → shift up so it fits (never above the top margin).
 * Measured on open, before paint, from the un-flipped geometry.
 */
export function useClampedSubmenu<T extends HTMLElement = HTMLDivElement>(
  open: boolean
): ClampedSubmenu<T> {
  const ref = useRef<T | null>(null)
  const [pos, setPos] = useState<{ flipped: boolean; left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const el = ref.current
    if (!el) return
    // The flyout's own box is measured free of the viewport edges; where it WOULD land comes from
    // its wrapper row (the flyout sits at the wrapper row's top-right corner by default).
    const natural = measureNatural(el)
    const wrap = el.parentElement?.getBoundingClientRect()
    if (!wrap) return
    const flipped = wrap.right + natural.width > window.innerWidth - OVERLAY_MARGIN
    setPos({
      flipped,
      left: flipped ? wrap.left - natural.width : wrap.right,
      top: clamp(wrap.top, natural.height, window.innerHeight, OVERLAY_MARGIN)
    })
  }, [open])

  const flipped = pos?.flipped ?? false
  return {
    ref,
    flipped,
    // Before the layout-effect measures (pos === null) the box is parked off-screen-invisible so
    // it is never painted at a stale spot; the effect runs before paint, so the first painted
    // frame already carries the clamped coordinates.
    style: pos
      ? { position: 'fixed', left: pos.left, top: pos.top }
      : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }
  }
}
