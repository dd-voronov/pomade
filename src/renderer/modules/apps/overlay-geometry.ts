// Pomade — E-027 app overlay geometry (docs/HOST-API.md §5 "Overlay"): the sizes the overlay card
// takes, the clamp that keeps it whole inside the window, and where it opens. Positions are in the
// window's coordinates (the viewport's top-left corner is 0, 0). The card may sit anywhere in the
// window below the title bar — over the pane area, the Projects panel, the side panel, the strip —
// a margin from every edge; the title bar stays the window's drag region and the traffic lights'.
// Pure.

import { OVERLAY_DEFAULT_HEIGHT, OVERLAY_WIDTH } from 'pomade-kit/protocol'
import type { OverlayAnchor } from 'pomade-kit/protocol'

import type { OverlayPosition } from '@shared/types'

export interface Size {
  w: number
  h: number
}

/** A rectangle in the window's coordinates. */
export interface Rect extends Size {
  x: number
  y: number
}

/** The gap the card keeps from every edge of the area it may sit in (`--space-4`). */
export const OVERLAY_MARGIN = 16
/** The card's drag handle above the frame. */
export const OVERLAY_HANDLE_HEIGHT = 14
/** The card's own border, per side. */
export const OVERLAY_BORDER = 1
/** The smallest frame height an app gets. */
export const OVERLAY_MIN_HEIGHT = 120
/** The largest frame height, as a share of the height of the area the card may sit in. */
export const OVERLAY_MAX_HEIGHT_SHARE = 0.6

/** Frame height the app gets for `requested`: whole pixels between the minimum and 60% of the
 *  bounds' height (and never so tall the card leaves its margins). */
export function frameHeight(requested: number | undefined, bounds: Size): number {
  const room = bounds.h - 2 * OVERLAY_MARGIN - OVERLAY_HANDLE_HEIGHT - 2 * OVERLAY_BORDER
  const cap = Math.max(OVERLAY_MIN_HEIGHT, Math.min(Math.floor(bounds.h * OVERLAY_MAX_HEIGHT_SHARE), room))
  return Math.min(cap, Math.max(OVERLAY_MIN_HEIGHT, Math.round(requested ?? OVERLAY_DEFAULT_HEIGHT)))
}

/** The card's outer size: a 420-wide frame (narrower in a narrow window) under the handle, in a border. */
export function cardSize(requested: number | undefined, bounds: Size): Size {
  const frameW = Math.max(0, Math.min(OVERLAY_WIDTH, bounds.w - 2 * OVERLAY_MARGIN - 2 * OVERLAY_BORDER))
  return {
    w: frameW + 2 * OVERLAY_BORDER,
    h: frameHeight(requested, bounds) + OVERLAY_HANDLE_HEIGHT + 2 * OVERLAY_BORDER
  }
}

/** `pos` moved the least that keeps the card whole inside `bounds`, margins kept. */
export function clampPosition(pos: OverlayPosition, card: Size, bounds: Rect): OverlayPosition {
  const maxLeft = bounds.x + bounds.w - card.w - OVERLAY_MARGIN
  const maxTop = bounds.y + bounds.h - card.h - OVERLAY_MARGIN
  const left = Math.round(Math.max(bounds.x + OVERLAY_MARGIN, Math.min(pos.left, maxLeft)))
  const top = Math.round(Math.max(bounds.y + OVERLAY_MARGIN, Math.min(pos.top, maxTop)))
  return left === pos.left && top === pos.top ? pos : { left, top }
}

/** Where a fresh overlay opens, kept whole inside `bounds`. An explicit place (`"panel"`) never reads
 *  the remembered one: beside the side panel — the pane area's near corner — while the panel column
 *  is open, centred over the pane area while it is collapsed. An open that names no place
 *  (`"center"`: the shortcut, or `overlay.open` without an anchor) opens where the user left that
 *  app's last one, else centred over the pane area. */
export function openPosition(
  card: Size,
  bounds: Rect,
  pane: Rect,
  anchor: OverlayAnchor,
  remembered: OverlayPosition | undefined,
  panelOpen: boolean
): OverlayPosition {
  if (anchor === 'panel' && panelOpen) {
    return clampPosition({ left: pane.x + OVERLAY_MARGIN, top: pane.y + OVERLAY_MARGIN }, card, bounds)
  }
  if (anchor !== 'panel' && remembered) return clampPosition(remembered, card, bounds)
  const centre = { left: Math.round(pane.x + (pane.w - card.w) / 2), top: Math.round(pane.y + (pane.h - card.h) / 2) }
  return clampPosition(centre, card, bounds)
}
