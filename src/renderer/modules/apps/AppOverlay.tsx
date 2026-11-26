// Pomade — E-027 app overlay (docs/HOST-API.md §1 `shortcuts`, action `overlay`; §4 `overlay`; §5):
// a small app frame (420 wide, as tall as the app asks, 220 to start) over whatever tab is active,
// opened by an app's shortcut even when the app was never opened, or by the app's own tab or panel
// frame. Its scrim lives inside PaneHost and dims the pane area only; the card is fixed in the
// window and stacks above the Projects panel, the side panel and the strip, so the user can drag it
// by its head anywhere in the window below the title bar (kept whole inside it; where it is left is
// where that app's overlay opens next, unless the open names a place). A fresh one opens beside the
// side panel when the app asked for that, else at the remembered place, else centred. Esc
// (pressed in Pomade, or forwarded by the frame), a click on the scrim, or the app's
// `overlay.close()` closes it, and focus returns to the frame that called `overlay.open`, else
// exactly where it was. Each open is a fresh frame: what an overlay must remember goes to the app state.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { HostedApp, OverlayPosition } from '@shared/types'
import dialog from '../../components/dialog.module.css'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useAppsStore } from '../../stores/apps-store'
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store'
import { AppFrame, focusAppFrame } from './AppPane'
import { cardSize, clampPosition, openPosition, type Rect } from './overlay-geometry'
import { setOverlayRefocus, useOverlayStore, type OpenOverlay } from './overlay-store'
import styles from './AppOverlay.module.css'

export function AppOverlay(): React.JSX.Element | null {
  const open = useOverlayStore((s) => s.open)
  const close = useOverlayStore((s) => s.close)
  const app = useAppsStore((s) => (open ? s.apps.find((a) => a.id === open.appId) : undefined))
  const available = !!app && !app.unavailable && !!app.entryUrl

  // The app went away while its overlay was open: nothing to show, close it.
  useEffect(() => {
    if (open && !available) close()
  }, [open, available, close])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close])

  if (!open || !app || !available) return null
  // A new open is a new card: its measure and position start over.
  return <OverlayCard key={open.seq} open={open} app={app} close={close} />
}

function OverlayCard({
  open,
  app,
  close
}: {
  open: OpenOverlay
  app: HostedApp
  close: () => void
}): React.JSX.Element {
  const scrimRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [bounds, setBounds] = useState<Rect | null>(null)
  const [pos, setPos] = useState<OverlayPosition | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; from: OverlayPosition; to: OverlayPosition } | null>(null)
  const card = useMemo(() => (bounds ? cardSize(open.height, bounds) : null), [bounds, open.height])

  useEffect(() => {
    setOverlayRefocus(() => {
      const frame = cardRef.current?.querySelector('iframe')
      if (frame) focusAppFrame(frame)
    })
    return () => setOverlayRefocus(null)
  }, [])

  // The area the card may sit in, before the first paint and on every window resize.
  useLayoutEffect(() => {
    const measure = (): void => {
      const next = windowBounds()
      setBounds((b) => (b && b.x === next.x && b.y === next.y && b.w === next.w && b.h === next.h ? b : next))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Where the card is: placed once (the anchor, the user's spot, the centre), then only kept inside
  // the window as it or the frame's height changes — it grows downward, not around its centre.
  useLayoutEffect(() => {
    const scrim = scrimRef.current
    if (!bounds || !card || !scrim) return
    setPos((p) => {
      if (p) return clampPosition(p, card, bounds)
      const r = scrim.getBoundingClientRect()
      const pane = { x: r.left, y: r.top, w: r.width, h: r.height }
      const remembered = useWorkspaceUiStore.getState().overlayPositions[app.id]
      const panelOpen = !useAppSettingsStore.getState().layout.fileTreeCollapsed
      return openPosition(card, bounds, pane, open.anchor, remembered, panelOpen)
    })
  }, [bounds, card, app.id, open.anchor])

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !pos) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, from: pos, to: pos }
    setDragging(true)
  }
  const onHandleMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || !card || !bounds) return
    d.to = clampPosition({ left: d.from.left + e.clientX - d.x, top: d.from.top + e.clientY - d.y }, card, bounds)
    setPos(d.to)
  }
  const onHandleUp = (): void => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    if (d && (d.to.left !== d.from.left || d.to.top !== d.from.top)) {
      useWorkspaceUiStore.getState().setOverlayPosition(app.id, d.to)
    }
  }

  return (
    <div
      ref={scrimRef}
      className={dialog.modalScrim}
      data-testid="app-overlay"
      data-app-id={open.appId}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        // No default focus move to the body: focus goes back where it was.
        e.preventDefault()
        close()
      }}
    >
      <div
        ref={cardRef}
        className={`${dialog.modal} ${styles.card}`}
        role="dialog"
        aria-label={app.shortcuts.find((s) => s.id === open.shortcutId)?.title ?? app.name}
        data-testid="app-overlay-card"
        style={{
          width: card?.w,
          height: card?.h,
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          // Unplaced for the one render before the first paint; not `visibility: hidden`, which
          // would keep the frame from taking focus as it mounts.
          opacity: pos ? 1 : 0
        }}
      >
        <div
          className={styles.handle}
          data-testid="app-overlay-handle"
          // Not a click that moves focus: the frame keeps typing while the card is dragged.
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onLostPointerCapture={onHandleUp}
        >
          <span className={styles.grip} aria-hidden="true" />
        </div>
        {/* While dragging, the frame lets the pointer through: a pointer over a frame reaches the
            frame, never the handle, and the release would be lost. */}
        <div className={`${styles.frameBox} ${dragging ? styles.frameBoxDragging : ''}`}>
          <AppFrame
            app={app}
            request={{ surface: 'overlay', route: open.route }}
            testId={`overlay-frame-${app.id}`}
            onCloseRequest={close}
            autoFocus
          />
        </div>
      </div>
    </div>
  )
}

/** The window below the title bar (`--titlebar-h`, the window's drag region), in window coordinates. */
function windowBounds(): Rect {
  const titlebar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) || 0
  return { x: 0, y: titlebar, w: window.innerWidth, h: Math.max(0, window.innerHeight - titlebar) }
}
