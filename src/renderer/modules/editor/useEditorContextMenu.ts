// Pomade — the editor pane's right-click context menu: the T-083 round-2 "park-and-mount" flow
// (PINNED CONTRACT). The menu must NOT mount synchronously in onContextMenu — its full-pane scrim
// would sit under Chromium's context-menu hit test at the click point and kill the spellcheck
// params (isEditable:false, misspelledWord empty). So the handler PARKS the menu and it mounts when
// main's per-right-click EV.spellContext push arrives (strictly after Chromium built the params),
// with a short timer as the only fallback. Preserve this flow exactly.

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

import type { EditorController, EditorSelection } from './editor-controller'

export interface MenuState {
  x: number
  y: number
  hasSelection: boolean
  selectionText: string
  // Engine-specific selection range captured at right-click time (the click can collapse
  // the live selection, so Cut/Paste must act on this snapshot, not on read-back).
  from: number
  to: number
}

export interface EditorContextMenuState {
  menu: MenuState | null
  setMenu: (m: MenuState | null) => void
  spell: { word: string; suggestions: string[] } | null
  setSpell: (s: { word: string; suggestions: string[] } | null) => void
  onContextMenu: (e: React.MouseEvent) => void
  onHeaderContextMenu: (e: React.MouseEvent) => void
  onBodyMouseDownCapture: () => void
}

export function useEditorContextMenu(
  controllerRef: MutableRefObject<EditorController | null>,
  commitPreview: (projectId: string, tabId: string) => void,
  projectId: string,
  tabId: string
): EditorContextMenuState {
  const [menu, setMenu] = useState<MenuState | null>(null)
  // T-083 — misspelled word + suggestions from main's 'context-menu' listener (the renderer
  // can't see Chromium's spellcheck markers).
  const [spell, setSpell] = useState<{ word: string; suggestions: string[] } | null>(null)
  // T-083 round 2 — the menu must NOT mount synchronously in onContextMenu. React flushes
  // discrete events synchronously, so the menu's full-viewport scrim was already in the DOM
  // when Chromium ran the context-menu default action's hit test at the click point — the
  // test hit the SCRIM (non-editable), so params arrived with isEditable:false and
  // misspelledWord forever empty. Proven by a real-CGEvent probe: shielding only the
  // contextmenu handler (stopPropagation, no preventDefault) made the same click return the
  // word + real macOS suggestions. So the handler now PARKS the menu here, and the menu
  // mounts when main's per-right-click EV.spellContext push arrives — strictly after
  // Chromium built the params — with a short timer as the only fallback.
  const pendingMenuRef = useRef<MenuState | null>(null)
  const pendingTimerRef = useRef<number | null>(null)
  const menuOpenRef = useRef(false)
  menuOpenRef.current = menu !== null
  useEffect(() => {
    return window.pomade.app.onSpellContext((ctx) => {
      // Every mounted pane hears every right-click in the window — only the pane that just
      // parked a menu (or has one open) cares.
      const next = ctx.misspelledWord
        ? { word: ctx.misspelledWord, suggestions: ctx.suggestions }
        : null
      const pending = pendingMenuRef.current
      if (pending) {
        pendingMenuRef.current = null
        if (pendingTimerRef.current !== null) {
          window.clearTimeout(pendingTimerRef.current)
          pendingTimerRef.current = null
        }
        setSpell(next)
        setMenu(pending)
        return
      }
      // Menu already open (fallback timer fired first, or a late re-check): pop the section in.
      if (menuOpenRef.current) setSpell(next)
    })
  }, [])

  // A mousedown collapses CodeMirror's state selection (view.state.selection) BEFORE the
  // contextmenu event fires — so reading getSelection() in onContextMenu returned empty and the
  // with-selection menu (Cut/Copy/Paste, Find & replace) went dead (T-043, E-001). This is not
  // limited to the secondary button: on macOS a Ctrl+click (and some trackpad right-click paths)
  // delivers a PRIMARY-button (button 0) mousedown before contextmenu, which also collapses the
  // selection. So snapshot on EVERY mousedown, in the capture phase on the pane ancestor — this
  // runs before CodeMirror's own handler, while the range is still intact. The ref is overwritten
  // on each mousedown, so a stale snapshot can't accumulate; onContextMenu still prefers the live
  // selection and only falls back to this snapshot when the click already collapsed it.
  const preContextSelRef = useRef<EditorSelection | null>(null)
  const onBodyMouseDownCapture = (): void => {
    preContextSelRef.current = controllerRef.current?.getSelection() ?? null
    // T-063 — a click into the editor body is an "interaction" that commits this preview tab, so
    // the next tree click opens a NEW tab instead of replacing this one.
    commitPreview(projectId, tabId)
  }

  const onContextMenu = (e: React.MouseEvent): void => {
    // T-083 — deliberately NO preventDefault: canceling the DOM contextmenu stops Chromium
    // from ever raising the browser-level context-menu request, which is the ONLY carrier of
    // spellcheck data (misspelledWord/dictionarySuggestions → main's 'context-menu' listener
    // → EV.spellContext → this menu's suggestions section). Electron shows no default menu
    // of its own, so letting the event through changes nothing visible.
    const live = controllerRef.current?.getSelection()
    // Prefer the live selection; fall back to the pre-collapse snapshot when the click that
    // opened the menu already cleared the editor's selection (CodeMirror collapses on the
    // preceding mousedown — secondary button, or a primary-button Ctrl+click on macOS).
    const sel = live && !live.empty ? live : preContextSelRef.current
    preContextSelRef.current = null
    setSpell(null) // T-083 — stale spell context must not leak into a new menu
    // T-083 round 2 — PARK the menu; it mounts on the EV.spellContext push (see above).
    // Mounting it here put the scrim under Chromium's context-menu hit test and killed the
    // spellcheck params for every editor right-click.
    pendingMenuRef.current = {
      x: e.clientX,
      y: e.clientY,
      hasSelection: !!sel && !sel.empty,
      selectionText: sel?.text ?? '',
      from: sel?.from ?? 0,
      to: sel?.to ?? 0
    }
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current)
    // Fallback: if main's push never arrives (it fires for every right-click in the window,
    // so this is belt-and-suspenders), open without spell data rather than not at all.
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null
      const pending = pendingMenuRef.current
      if (pending) {
        pendingMenuRef.current = null
        setMenu(pending)
      }
    }, 200)
  }

  // T-090 — right-clicking the header NAME FIELD opens the same menu the editor shows with no
  // selection, acting on THIS doc (the handlers below are per-pane, so that comes for free).
  // Unlike the editable's handler above this one CAN mount the menu synchronously: the T-083
  // park-until-EV.spellContext dance exists only so the menu's scrim doesn't occlude Chromium's
  // context-menu hit test at the click point — and the header has no spellcheck data to lose. It
  // therefore also preventDefaults (nothing needs the browser-level context-menu request), so main
  // never pushes a spellContext for this click and no spelling section can flash in.
  const onHeaderContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    setSpell(null)
    setMenu({ x: e.clientX, y: e.clientY, hasSelection: false, selectionText: '', from: 0, to: 0 })
  }

  // T-083 round 2 — never leave the fallback timer running past unmount.
  useEffect(() => {
    return () => {
      if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current)
    }
  }, [])

  // Close the context menu on Esc.
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  return {
    menu,
    setMenu,
    spell,
    setSpell,
    onContextMenu,
    onHeaderContextMenu,
    onBodyMouseDownCapture
  }
}
