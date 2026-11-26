// Pomade — E-027 app overlay state (docs/HOST-API.md §1 `shortcuts`, action `overlay`; §4
// `overlay`). At most one overlay is open at a time: one app's overlay frame, over the active
// tab — opened by its shortcut, or by its own tab or panel frame (`overlay.open`). The element
// that gets focus back when it closes is kept (module-level, never in reactive state): the frame
// that called `overlay.open`, else the element that had focus when a shortcut opened it — a
// terminal, an editor, another app's frame.

import type { OverlayAnchor } from 'pomade-kit/protocol'
import { create } from 'zustand'

export interface OpenOverlay {
  appId: string
  /** The shortcut that opened it; absent when the app's frame opened it (`overlay.open`). */
  shortcutId?: string
  route: string
  /** The frame height the app asked for (px, before Pomade's clamp); absent = the default. */
  height?: number
  anchor: OverlayAnchor
  /** Bumped per open: a new open is a new frame. */
  seq: number
}

export interface ShowOptions {
  /** The shortcut that opened it: the same shortcut's overlay already open is only refocused. */
  shortcutId?: string
  height?: number
  /** Default `"center"`. */
  anchor?: OverlayAnchor
  /** The `<iframe>` of the frame that called `overlay.open`: focus returns to it on close. */
  opener?: HTMLElement
}

interface OverlayState {
  open: OpenOverlay | null
  /** Open `appId`'s overlay at `route` — for a shortcut (`shortcutId`: the same shortcut's overlay
   *  already open is only refocused), or for the app's own frame (no shortcut: always a fresh frame
   *  at `route`, replacing whatever overlay is open). */
  show: (appId: string, route: string, options?: ShowOptions) => void
  /** The open overlay's frame asks for another height (px, before Pomade's clamp). */
  resize: (height: number) => void
  /** Close the overlay and return focus where it was. */
  close: () => void
}

let returnFocus: HTMLElement | null = null
let seq = 0
/** Set by the mounted overlay frame: refocus it (a repeated shortcut press). */
let refocusOpen: (() => void) | null = null

export function setOverlayRefocus(fn: (() => void) | null): void {
  refocusOpen = fn
}

export const useOverlayStore = create<OverlayState>((set, get) => ({
  open: null,
  show: (appId, route, options = {}) => {
    const { shortcutId, height, anchor = 'center', opener } = options
    const cur = get().open
    if (cur && shortcutId !== undefined && cur.appId === appId && cur.shortcutId === shortcutId) {
      refocusOpen?.()
      return
    }
    // Replacing another overlay keeps the focus target of the first open.
    if (!cur) {
      const active = document.activeElement
      returnFocus = opener ?? (active instanceof HTMLElement && active !== document.body ? active : null)
    }
    set({
      open: {
        appId,
        ...(shortcutId !== undefined ? { shortcutId } : {}),
        route,
        ...(height !== undefined ? { height } : {}),
        anchor,
        seq: ++seq
      }
    })
  },
  resize: (height) => {
    const cur = get().open
    if (cur && cur.height !== height) set({ open: { ...cur, height } })
  },
  close: () => {
    if (!get().open) return
    set({ open: null })
    const target = returnFocus
    returnFocus = null
    if (target?.isConnected) target.focus({ preventScroll: true })
  }
}))
