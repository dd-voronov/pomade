// Pomade — the TerminalPane's xterm MOUNT lifecycle (T-171). One effect, keyed by termId/status,
// builds the @xterm/xterm instance and wires everything that lives and dies WITH that instance:
// the file/URL link provider, copy-on-select + Cmd+C, the pty-write forward (with the T-128 replay
// guard), genuine-input attention/submit signals, the scrollback attach-paint, and fit/resize. The
// body is a set of small `attach*`/`replay*` setup functions, EACH returning its own dispose, so the
// teardown is symmetric by construction instead of a hand-maintained list of 14 disposals.
//
// LIFECYCLE INVARIANT (T-097 hidden-not-unmounted): panes are hidden, never unmounted, on project
// switch, and `term.projectId` is deliberately NOT a dependency of this effect — a cross-project
// move must not rebuild xterm (that would lose scrollback beyond the pty ring buffer and any
// full-screen TUI state). The effect reaches the tab's CURRENT project through `projectIdRef`.
//
// E-020 (the copy-out / navigation UX) mount wiring lives here:
//   T-084 — auto-copy-on-select + Cmd+C (attachCopyOnSelect).
//   T-085 — Option+click moves the shell's cursor (xterm's altClickMovesCursor, set at creation).
//   T-086/T-092 — the Cmd+click file/URL link provider (attachLinkProvider), always running; Cmd
//                 only toggles the decorations. The buffer→link geometry is `computeRowLinks`
//                 (term-link-rows.ts), shared with the pane's e2e provider hook.

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { Terminal, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'

import type { TerminalTab } from '@shared/types'
import { fontStackFor } from '../../font-catalog'
import { useTabsStore } from '../../stores/tabs-store'
import { useTerminalsStore } from '../../stores/terminals-store'
import { computeRowLinks, type CellPos } from './term-link-rows'
import { activateResolved, type LinkContext } from './term-link-open'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// T-128 — the mode RESETS written to xterm (never to the pty) once the attach paint has been
// parsed: any-motion + button mouse tracking off (`?1003l`/`?1000l`), SGR mouse encoding off
// (`?1006l`), focus reporting off (`?1004l`), cursor visible (`?25h`). They undo the mode ENABLES
// that the replayed agent-era byte stream turned back on in a terminal whose pty is now a plain
// zsh that never asked for any of them. DECRST/DECSET emit no reply, so writing these can never
// re-trigger the storm they exist to stop.
const REPLAY_MODE_RESET = '\x1b[?1003l\x1b[?1000l\x1b[?1006l\x1b[?1004l\x1b[?25h'
// Applied only when the paint actually left xterm in the alternate buffer (see the call site).
const ALT_SCREEN_EXIT = '\x1b[?1049l'

/** T-086 — the disambiguation popover for a bare filename that exists in several places. */
export interface PickerState {
  x: number
  y: number
  name: string
  matches: string[]
  line?: number
}

export function buildTheme(): Record<string, string> {
  return {
    background: cssVar('--panel-raised') || '#ffffff',
    foreground: cssVar('--text') || '#1f2933',
    cursor: cssVar('--accent') || '#4fb8d8',
    cursorAccent: cssVar('--panel-raised') || '#ffffff',
    selectionBackground: cssVar('--selection') || 'rgba(79,184,216,0.18)'
  }
}

/** T-116/T-128 — the shared attach-paint gate. `painting` is true while the restore paint is being
 *  PARSED; the pty-write forward is suppressed (attachPtyForwarding) and live data is queued
 *  (replayScrollback) until the paint and its mode-reset tail have been fully parsed. */
interface PaintGate {
  painting: boolean
}

// T-193 — the clicked buffer cell (0-based column, ABSOLUTE 0-based row) for a mouse event, via
// xterm's OWN mouse service so the hit-test matches the Linkifier exactly (element padding, measured
// cell metrics, DPR — none of which are re-derivable from public API without drifting). Reached
// through the private `_core`; feature-detected, so an xterm upgrade that renames it degrades to "no
// click fallback" (the hover path still works) rather than throwing.
function clickedCell(xterm: Terminal, event: MouseEvent): CellPos | null {
  const core = (
    xterm as unknown as {
      _core?: {
        screenElement?: HTMLElement
        _mouseService?: {
          getCoords: (
            e: { clientX: number; clientY: number },
            el: HTMLElement,
            cols: number,
            rows: number,
            isSelection?: boolean
          ) => [number, number] | undefined
        }
      }
    }
  )._core
  const mouseService = core?._mouseService
  const screen = core?.screenElement
  if (!mouseService || !screen) return null
  const coords = mouseService.getCoords(event, screen, xterm.cols, xterm.rows, false)
  if (!coords) return null
  // getCoords returns 1-based [col, viewportRow]. Convert to 0-based column and ABSOLUTE 0-based
  // buffer row: `buffer.active.viewportY` is the absolute row at the top of the viewport — the same
  // `ydisp` the Linkifier adds in `_positionFromMouseEvent`, so a scrolled buffer maps correctly.
  return { x: coords[0] - 1, y: coords[1] - 1 + xterm.buffer.active.viewportY }
}

// ── T-086/T-092: Cmd+click file / URL link provider ──────────────────────────
export function attachLinkProvider(
  xterm: Terminal,
  container: HTMLElement,
  opts: {
    metaRef: MutableRefObject<boolean>
    buildLinkContextRef: MutableRefObject<() => LinkContext>
    setPicker: Dispatch<SetStateAction<PickerState | null>>
  }
): () => void {
  const { metaRef, buildLinkContextRef, setPicker } = opts
  // One reusable cell for the line reader — `getCell()` allocates, and this runs for every hovered
  // row while Cmd is held.
  const scratchCell = xterm.buffer.active.getNullCell()
  // T-092 — the links of the MOST RECENT provider reply, kept so a Meta transition can repaint
  // them in place (see `syncMeta`). xterm caches ONE reply per active line, so this list is the
  // only thing a modifier change can still influence.
  let activeLinks: ILink[] = []
  // T-193 — set true by `activate` (below) whenever the Linkifier DID open a link for a click, so
  // the click-time fallback (further below) never opens the same link a second time. `activate`
  // runs synchronously inside the Linkifier's own `mouseup` on the SCREEN element, which bubbles to
  // the fallback's window listener AFTER it — so the flag is always set before the fallback reads it.
  let linkifierActivated = false
  const linkProvider = xterm.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      // T-092 — the provider ALWAYS runs, Cmd or no Cmd (VS Code parity). Withholding links
      // while the modifier was up was a latent trap: xterm caches one provider reply per active
      // line and its `_handleMouseMove` early-returns when the position equals the last buffer
      // cell, so a row hovered without Cmd stayed link-DEAD until the pointer changed row, and
      // pressing Cmd while parked on a path could never wake it. Cmd now only picks the
      // DECORATIONS; "plain click = selection" is guaranteed by `activate`'s metaKey re-check.
      // `bufferLineNumber` is an ABSOLUTE, 1-based buffer row: xterm's Linkifier builds it as
      // `coords[1] + buffer.ydisp` and compares the ranges we hand back in that same absolute
      // space (it subtracts ydisp again only when painting the underline). Round 1 treated it as
      // viewport-relative and added `viewportY` a SECOND time, so every scrolled terminal read a
      // row `viewportY` below the hovered one — usually past the end of the buffer, hence "links
      // never work in a long agent session" while an unscrolled pane (viewportY === 0) worked.
      void (async () => {
        const ctx = buildLinkContextRef.current()
        const rowLinks = await computeRowLinks(xterm, bufferLineNumber - 1, scratchCell, ctx)
        // Read at REPLY time, not at query time: the modifier may have changed while the
        // probes were in flight.
        const held = metaRef.current
        const links: ILink[] = rowLinks.map(({ from, to, target, resolved }) => ({
          // Absolute buffer coordinates, 1-based on both axes (see the note above).
          range: {
            start: { x: from.x + 1, y: from.y + 1 },
            end: { x: to.x + 1, y: to.y + 1 }
          },
          text: target,
          // T-092 — the affordance, not the existence, follows Cmd.
          decorations: { pointerCursor: held, underline: held },
          activate: (event) => {
            // Cmd+click activates; a plain click is a selection gesture and must never
            // navigate (locked decision).
            if (!event.metaKey) return
            // T-193 — tell the click-time fallback the Linkifier handled THIS click (it opens the
            // same link otherwise). Set for both branches: an ambiguous picker is still a handled click.
            linkifierActivated = true
            if (resolved.kind === 'ambiguous') {
              setPicker({
                x: event.clientX,
                y: event.clientY,
                name: resolved.name,
                matches: resolved.matches,
                ...(resolved.line !== undefined ? { line: resolved.line } : {})
              })
              return
            }
            activateResolved(resolved)
          }
        }))
        activeLinks = links
        callback(links.length ? links : undefined)
      })()
    }
  })

  // T-092 — Meta (Cmd) tracking. A modifier change can NOT make xterm re-query the provider
  // (one cached reply per active line; `_handleMouseMove` early-returns on same-cell moves, so
  // the old synthetic-mousemove "nudge" was structurally a no-op — it is deleted). Instead we
  // flip the decorations on the reply we already handed over: xterm 5.5's `_handleNewLink`
  // replaces the ACTIVE link's `decorations` object with live accessors whose setters fire the
  // underline show/hide and toggle the pointer-cursor class — so a stationary pointer repaints.
  const syncMeta = (held: boolean): void => {
    if (held === metaRef.current) return
    metaRef.current = held
    for (const link of activeLinks) {
      // Assign the PROPERTIES, never `link.decorations = {…}`: replacing the object would drop
      // xterm's accessors and with them the repaint. Links in the reply that are not the active
      // one keep a plain object here, which is exactly what xterm reads if one becomes active.
      if (link.decorations) {
        link.decorations.underline = held
        link.decorations.pointerCursor = held
      }
    }
  }
  const onKeyChange = (e: KeyboardEvent): void => syncMeta(e.metaKey)
  // A window losing focus never delivers the keyup, so the modifier would stay "held".
  const onWindowBlur = (): void => syncMeta(false)
  window.addEventListener('keydown', onKeyChange)
  window.addEventListener('keyup', onKeyChange)
  window.addEventListener('blur', onWindowBlur)

  // ── T-193: click-time resolution FALLBACK (mirrors the editors' cold path) ─────────────────────
  // xterm's Linkifier only activates a link that already resolved by MOUSEDOWN (`_mouseDownLink ===
  // _currentLink` at mouseup). Our provider is async (per-row `computeRowLinks` → probePath IPC), so
  // the FIRST Cmd+click on a freshly printed path — before hover resolution has landed — could never
  // open it (T-193's "click twice" bug). On a Cmd+click the Linkifier did NOT handle, re-derive the
  // clicked cell, re-resolve its row link FRESH (bypassing the hover cache — a click is fresh intent,
  // so a 30 s-stale NEGATIVE must not eat a since-created file), and open through the SAME activation
  // path as the provider. This also covers xterm's `_isMouseOut` reply-drop dead row: the click no
  // longer depends on a stored provider reply. Its OWN scratch cell (the provider's may be mid-read
  // in a concurrent async provideLinks).
  const fallbackCell = xterm.buffer.active.getNullCell()
  let downX = 0
  let downY = 0
  const onMouseDown = (e: MouseEvent): void => {
    downX = e.clientX
    downY = e.clientY
  }
  const onMouseUp = (event: MouseEvent): void => {
    // T-193 rider — this listener is WINDOW-scoped so it fires after the Linkifier's screen-element
    // handler (bubbling), but that means it also fires for EVERY OTHER mounted terminal pane on the
    // same click. Every project's every tab is mounted at once (PaneHost hides inactive panes with
    // display:none, never unmounts them), so without this gate a hidden pane's `clickedCell` maps the
    // global click coords onto a bogus in-grid cell — a display:none element's getBoundingClientRect
    // is all-zeros, so xterm's getCoords reads raw clientX/clientY and clamps them into that pane's
    // grid — and opens a "random" file resolved against that OTHER project's buffer/root. Only the
    // pane whose terminal actually received the click may act; the reset keeps the one-shot flag from
    // leaking across clicks on non-target panes.
    if (!container.contains(event.target as Node | null)) {
      linkifierActivated = false
      return
    }
    // Read-and-reset the one-shot flag: on a mouseup the Linkifier activated, it already opened the
    // link (its screen-element handler ran before this window handler), so do nothing here.
    const handledByLinkifier = linkifierActivated
    linkifierActivated = false
    if (handledByLinkifier) return
    // Cmd+left-click only — a plain click is a selection/focus gesture (never navigates), and a
    // Cmd+DRAG is a selection too, so only fire for a click that stayed in place.
    if (event.button !== 0 || !event.metaKey) return
    if (Math.abs(event.clientX - downX) > 3 || Math.abs(event.clientY - downY) > 3) return
    void (async () => {
      const cell = clickedCell(xterm, event)
      if (!cell) return
      const ctx = buildLinkContextRef.current()
      const rowLinks = await computeRowLinks(xterm, cell.y, fallbackCell, ctx, { bypassCache: true })
      if (rowLinks.length === 0) return
      // The link covering the clicked cell, in reading order (matches xterm's `_linkAtPosition`);
      // a wrapped-path join link spans rows, so compare linear cell indices, not (x,y) pairs.
      const cols = xterm.cols
      const at = cell.y * cols + cell.x
      const hit = rowLinks.find(
        (l) => l.from.y * cols + l.from.x <= at && at <= l.to.y * cols + l.to.x
      )
      if (!hit) return
      if (hit.resolved.kind === 'ambiguous') {
        setPicker({
          x: event.clientX,
          y: event.clientY,
          name: hit.resolved.name,
          matches: hit.resolved.matches,
          ...(hit.resolved.line !== undefined ? { line: hit.resolved.line } : {})
        })
        return
      }
      activateResolved(hit.resolved)
    })()
  }
  // Window-level so the fallback fires after the Linkifier's screen-element handler (bubbling) — the
  // ordering the double-activation flag relies on; same window-scoping precedent as attachCopyOnSelect.
  window.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)

  return () => {
    linkProvider.dispose()
    window.removeEventListener('keydown', onKeyChange)
    window.removeEventListener('keyup', onKeyChange)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('mouseup', onMouseUp)
  }
}

// ── T-084: auto-copy when a selection COMMITS + Cmd+C ─────────────────────────
export function attachCopyOnSelect(
  xterm: Terminal,
  container: HTMLElement,
  opts: {
    autoCopyRef: MutableRefObject<boolean>
    copyTextRef: MutableRefObject<(text: string) => void>
    lastCopiedRef: MutableRefObject<string>
  }
): () => void {
  const { autoCopyRef, copyTextRef, lastCopiedRef } = opts
  // xterm's onSelectionChange fires on every drag tick, so the commit point is the mouseup
  // that ends the drag — one selection, one copy, one hint. The listener sits on the window
  // because a drag routinely ends outside the pane; `dragging` keeps it scoped to drags that
  // STARTED here. The read is deferred a tick so xterm's own mouseup handler has finalized
  // the range first.
  let dragging = false
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) dragging = true
  }
  const onMouseUp = (): void => {
    if (!dragging) return
    dragging = false
    setTimeout(() => {
      const selection = xterm.getSelection()
      if (!selection) {
        lastCopiedRef.current = '' // a click that CLEARED the selection — nothing to copy
        return
      }
      // A collapse/re-commit of the SAME text must not copy (or flash) twice.
      if (!autoCopyRef.current || selection === lastCopiedRef.current) return
      copyTextRef.current(selection)
    }, 0)
  }
  container.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mouseup', onMouseUp)

  // T-084 — Cmd+C copies the selection whatever the auto-copy setting says. Handled here
  // because xterm paints to a canvas: there is no DOM selection for the platform's own Copy
  // command to pick up. With NO selection the key is passed straight through, so Ctrl+C still
  // sends SIGINT to the foreground process. Cmd+V is deliberately NOT intercepted — the
  // browser's paste event already reaches xterm's textarea, which writes it to the pty.
  // (No dispose: the handler dies with `xterm.dispose()`, exactly as pre-T-171.)
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      const selection = xterm.getSelection()
      if (!selection) return true
      copyTextRef.current(selection)
      return false
    }
    return true
  })

  return () => {
    window.removeEventListener('mouseup', onMouseUp)
    container.removeEventListener('mousedown', onMouseDown)
  }
}

// ── The pty-write forward (with the T-128 replay guard) ───────────────────────
function attachPtyForwarding(
  xterm: Terminal,
  opts: { termId: string; paintGate: PaintGate }
): () => void {
  const { termId, paintGate } = opts
  // `onData` = every byte destined for the pty. It fires not only for keystrokes/paste but for
  // the terminal's OWN AUTO-REPLIES to escape queries the application prints (CPR `ESC[6n`, DSR,
  // DA1/DA2, DECRQM, window-ops size reports, OSC 10/11/12 color reports, mode-1004 focus
  // reports `ESC[I`/`ESC[O`, …) — no keystroke, no focus, no visible pane required. So this
  // handler only forwards to the pty; it must NOT double as the "user acted" signal.
  //
  // T-128 — THE REPLAY GUARD. While the attach paint is being parsed, this forward is
  // SUPPRESSED. The T-116 snapshot/ring replay is a recording of the AGENT ERA's raw byte
  // stream, queries included, and xterm cannot tell a replayed `ESC[6n` from a live one: it
  // answers every one of them on `onData`. Pre-guard those answers were forwarded to the FRESH
  // zsh, which received them as typed input and echoed the `^[[I ^[[?1;2c ^[[?39;3R…` garbage
  // the Owner reported on the `/exit` → relaunch path. Nothing a terminal emits WHILE painting a
  // recording is user input, so nothing from that window may reach the pty. This is the T-123
  // lesson ("`onData` carries auto-replies") applied to the replay path.
  //
  // DELIBERATE COST: a genuine keystroke landing inside the paint window (one IPC round trip
  // plus the parse of ≤200 KB — sub-100 ms, before the pane is even legible) is dropped with the
  // same suppression. Dropping a keystroke nobody could have aimed yet is strictly better than
  // feeding a reply storm into a live shell, and the alternative (telling the two apart) is
  // exactly what xterm's data event cannot do. The T-123 signals (`onKey`/`paste`) are NOT
  // suppressed — they are not pty writes.
  const onInput = xterm.onData((d) => {
    if (paintGate.painting) return
    void window.pomade.pty.write(termId, d)
  })
  return () => onInput.dispose()
}

// ── T-123 attention-clear + E-025 first-prompt-submit (GENUINE user input only) ──
function attachGenuineInput(
  xterm: Terminal,
  container: HTMLElement,
  opts: { projectIdRef: MutableRefObject<string>; tabId: string }
): () => void {
  const { projectIdRef, tabId } = opts
  // T-123 — clear the attention dot on GENUINE user input only. Two rounds of "genuine":
  //
  // r1: T-111 wired the clear to `onData` on the premise it "fires only for the focused
  // terminal" — false. `onData` is every byte destined for the pty, including xterm's own
  // auto-replies to the escape queries a Claude TUI fires constantly (CPR/DA/DECRQM/window-ops/
  // OSC-color/mode-1004 focus reports), produced on `write()` with no focus or visible pane —
  // so the dot self-cleared in <1 s even on inactive/fresh agent tabs (plain shells query none).
  //
  // r2: r1 moved the clear to xterm's `coreService.onUserInput` — sound against the reply storm
  // (probed: 0 fires) but xterm sets the SAME internal `userInput` flag for MOUSE-MOTION reports,
  // not just keyboard/paste. Claude's TUI enables any-motion tracking (mode 1003 + SGR 1006), so
  // a passive pointer move over the focused pane — trackpad micro-motion, or a Chromium hover
  // `mousemove` synthesized when the TUI redraws under a resting cursor — fired `onUserInput` and
  // cleared the dot ~1 redraw after marking. `onUserInput` is payload-less, so it can't be
  // filtered to keyboard-only. So we DON'T use it: clear on `onKey` (keystrokes — immune to both
  // the reply storm AND mouse motion/click/wheel; probed 0 on both) plus a capture-phase DOM
  // `paste` listener (xterm's paste path never reaches onKey). Guarded in the store → a no-op
  // after the first clear. Deliberate: a bare click/scroll into the active pane no longer clears
  // its own dot (mousing ≠ reading); an inactive tab's activating click still clears via the
  // T-111 `setActive` edge, so nothing gets stuck. The paste-menu action clears explicitly too.
  const clearAttention = (): void =>
    useTabsStore.getState().clearTabAttention(projectIdRef.current, tabId)

  // E-025 — first-prompt-submit detection rides the SAME genuine-input path as the T-123
  // attention clear: xterm `onKey` (keystrokes) + the capture-phase DOM `paste` listener —
  // NEVER `onData` (auto-replies + mode-1003 mouse reports) and never pty output. Best-effort
  // line tracking per the locked spec: printable keys and pasted text append, Backspace trims,
  // Enter resets; Esc / Ctrl+C / Ctrl+U discard (the TUI's own input-clearing gestures).
  // Submit = Enter WITHOUT Shift/Alt while the since-last-submit input is non-empty. Imperfect
  // detection degrades gracefully: a false submit opens a window where nothing appears
  // (harmless); a missed one resolves to Unbound, which the user can recover. The store owns
  // every guard (agent-kind, live, phase), so firing this for plain terminals costs nothing.
  let inputLine = ''
  const onKeyDisp = xterm.onKey(({ key, domEvent }) => {
    clearAttention()
    const e = domEvent
    if (e.key === 'Enter') {
      if (e.shiftKey || e.altKey) {
        inputLine += '\n' // the TUI inserts a newline — content, not a submit
        return
      }
      const line = inputLine.trim()
      inputLine = ''
      if (line) {
        useTerminalsStore.getState().handleSubmit(projectIdRef.current, tabId, line)
      }
      return
    }
    if (e.key === 'Backspace') {
      inputLine = inputLine.slice(0, -1)
      return
    }
    if (e.key === 'Escape') {
      inputLine = '' // claude/codex Esc clears the input box
      return
    }
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'c' || e.key === 'u') inputLine = '' // SIGINT / kill-line discard the line
      return
    }
    if (key.length === 1) inputLine += key
  })
  const onPaste = (ev: Event): void => {
    clearAttention()
    // Pasted text counts as line content (a paste-then-Enter is a real submit). Multi-line
    // pastes are bracketed by the TUI (no auto-submit), so they simply append.
    const text = (ev as ClipboardEvent).clipboardData?.getData('text') ?? ''
    if (text) inputLine += text
  }
  container.addEventListener('paste', onPaste, true)

  return () => {
    onKeyDisp.dispose()
    container.removeEventListener('paste', onPaste, true)
  }
}

// ── T-116 (E-022): the attach paint (scrollback replay) + pty onData/onExit ──────
function replayScrollback(
  xterm: Terminal,
  opts: {
    termId: string
    projectIdRef: MutableRefObject<string>
    tabId: string
    paintGate: PaintGate
  }
): () => void {
  const { termId, projectIdRef, tabId, paintGate } = opts
  // T-116 (E-022) — the ATTACH PAINT. `pty.replay` returns, in one atomic reply, this term's
  // restored scrollback snapshot + the dim `── session restored ──` divider + its ring buffer
  // (just the ring buffer for a term with nothing restored — the pre-T-116 behaviour). It must
  // reach xterm BEFORE any live chunk, or a revived pane would show its history *below* the
  // fresh prompt, so live data is QUEUED until the paint lands.
  //
  // Dedupe on flush: `pty-manager` appends to the ring buffer BEFORE it broadcasts, so anything
  // the queue holds is normally already inside the paint. "Normally" is not "always" (an invoke
  // reply and an event are two message streams), hence the overlap trim below rather than a
  // blind drop — losing the first prompt would be worse than a duplicated line.
  // (`paintGate.painting` is read by the pty-write forward — the T-128 replay guard.)
  const queued: string[] = []
  const offData = window.pomade.pty.onData(termId, (d) => {
    if (paintGate.painting) queued.push(d)
    else xterm.write(d)
  })
  const offExit = window.pomade.pty.onExit(termId, () => {
    useTerminalsStore.getState().handlePtyExit(projectIdRef.current, tabId, termId)
  })

  let disposed = false
  void (async () => {
    let paint = ''
    try {
      paint = await window.pomade.pty.replay(termId)
    } catch {
      /* the term vanished between mount and reply — the exit handler owns that case */
    }
    if (disposed) return
    // The queued bytes are a SUFFIX of the same byte stream the paint ends with: trim the part
    // the paint already covered and write only what it missed. Bounded scan — the window is one
    // IPC round trip, so the queue is a few KB at most; beyond the cap we prefer a possible
    // duplicate over dropped output.
    const flushQueue = (): void => {
      const tail = queued.join('')
      queued.length = 0
      paintGate.painting = false
      if (!tail) return
      let overlap = Math.min(tail.length, paint.length, 32 * 1024)
      while (overlap > 0 && !paint.endsWith(tail.slice(0, overlap))) overlap--
      const rest = tail.slice(overlap)
      if (rest) xterm.write(rest)
    }
    if (!paint) {
      flushQueue() // nothing replayed (a brand-new pty) — no guard window worth holding open
      return
    }
    // T-128 — the guard window closes only when the paint has actually been PARSED, not when
    // `write` returns: `xterm.write` is asynchronous (it queues bytes for the parser, which
    // emits the auto-replies on `onData` while it works), so flipping `painting` on the next
    // line would let the whole reply storm through. The write callback fires after this chunk
    // is parsed, and callbacks are ordered, so everything the replay provokes is answered
    // inside the suppression window.
    xterm.write(paint, () => {
      if (disposed) return
      // …and the modes the recording LEFT ON are reset — to XTERM ONLY, never to the pty. The
      // replayed stream contains the agent TUI's mode ENABLES (`?1004h` focus reporting, `?1003h`
      // any-motion mouse + `?1006h` SGR, `?1000h`), and a mode is state, not a one-off reply:
      // without this, `^[[I`/`^[[O` keep flowing on every focus change long after the paint (the
      // second half of the Owner's repro) and a pointer move keeps emitting mouse reports into a
      // plain zsh. The fresh shell re-enables what IT needs (bracketed paste, 2004) at its next
      // prompt — those are live bytes, unaffected. Alt screen is exited only when the paint
      // genuinely LEFT us there (a RING_MAX trim can strand a replay mid-alt-screen): a blind
      // `?1049l` on the normal screen would restore a never-saved cursor and move it to 0,0.
      const altScreen = xterm.buffer.active.type === 'alternate'
      xterm.write(`${REPLAY_MODE_RESET}${altScreen ? ALT_SCREEN_EXIT : ''}`)
      flushQueue()
    })
  })()

  return () => {
    // T-128 — set `disposed` BEFORE detaching so a still-pending paint (its `replay` await or its
    // write callback) bails instead of writing to a disposing xterm or flushing the queue.
    disposed = true
    offData()
    offExit()
  }
}

// ── Fit / RAF / ResizeObserver ────────────────────────────────────────────────
function attachResize(
  xterm: Terminal,
  fit: FitAddon,
  container: HTMLElement,
  opts: { termId: string }
): () => void {
  const { termId } = opts
  let lastCols = -1
  let lastRows = -1
  const doFit = (): void => {
    try {
      fit.fit()
      // Only tell the pty when the grid actually changed — a same-size SIGWINCH is
      // deduped by the kernel anyway, but skipping it also spares the IPC chatter of
      // ResizeObserver storms (live window drags, wake-time display reconfiguration).
      if (xterm.cols !== lastCols || xterm.rows !== lastRows) {
        lastCols = xterm.cols
        lastRows = xterm.rows
        void window.pomade.pty.resize(termId, xterm.cols, xterm.rows)
      }
    } catch {
      /* container has no dimensions (hidden) — refit on re-show */
    }
  }
  const raf = requestAnimationFrame(doFit)
  const ro = new ResizeObserver(() => doFit())
  ro.observe(container)

  return () => {
    cancelAnimationFrame(raf)
    ro.disconnect()
  }
}

/** A Pomade terminal view: the theme, the user's font, Unicode 11 widths and the fit addon — the
 *  same for a PTY tab and an attached tab (E-034). Not yet opened into a container. */
export function createTerminal(terminalFont: string): { xterm: Terminal; fit: FitAddon } {
  const xterm = new Terminal({
    // T-153 — the user's terminal font (defaults to the SF Mono stack, = today's --font-mono).
    fontFamily: fontStackFor(terminalFont) || 'monospace',
    fontSize: 12.5,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10000,
    theme: buildTheme(),
    // T-085 — Option+click moves the shell's cursor to the clicked cell (xterm emits the
    // arrow-key sequences for it). Set EXPLICITLY even though xterm's own default is `true`:
    // this is a LOCKED product decision, not an inherited default, so a future xterm release
    // flipping the default must not silently change Pomade's behavior. It applies only at a
    // prompt in the normal buffer with mouse reporting off, so a full-screen TUI (vim, an
    // agent CLI) still receives the click itself.
    altClickMovesCursor: true,
    // T-084 — xterm defaults `rightClickSelectsWord` to TRUE on macOS, which would make a
    // right-click SELECT the word under the cursor: it would silently replace whatever the
    // user had highlighted (the very thing they opened the menu to copy) and leave Copy
    // enabled on text they never chose. Our menu is a pure overlay — it must not touch the
    // selection — so this is turned off deliberately.
    rightClickSelectsWord: false,
    allowProposedApi: true // the `unicode` API below is still flagged proposed
  })
  const fit = new FitAddon()
  xterm.loadAddon(fit)
  // T-081 — xterm's built-in width tables are Unicode 6, where most emoji are 1 cell wide.
  // Agent TUIs (Claude Code's status line: 📁 🌿 ⏱️) size them as 2 cells, so every
  // cursor-addressed partial rewrite after an emoji landed shifted — garbled status bars,
  // mis-cleared repaint frames. Unicode 11 tables match what the CLIs assume (VS Code
  // ships the same addon, default terminal.integrated.unicodeVersion = "11").
  xterm.loadAddon(new Unicode11Addon())
  xterm.unicode.activeVersion = '11'
  return { xterm, fit }
}

export interface XtermSessionOptions {
  /** term.termId / term.status / term.id — the effect's re-run keys (T-097: projectId is NOT one). */
  termId: string
  status: TerminalTab['status']
  tabId: string
  /** T-153 — gate creation on the bundled fonts; a boot-window flip re-runs the effect. */
  fontsReady: boolean
  containerRef: MutableRefObject<HTMLDivElement | null>
  termRef: MutableRefObject<Terminal | null>
  fitRef: MutableRefObject<FitAddon | null>
  /** T-097 — the tab's CURRENT project, read fresh so a cross-project move never rebuilds xterm. */
  projectIdRef: MutableRefObject<string>
  /** T-153 — the terminal font, read at CREATION only (a change restyles the live xterm elsewhere). */
  terminalFontRef: MutableRefObject<string>
  metaRef: MutableRefObject<boolean>
  buildLinkContextRef: MutableRefObject<() => LinkContext>
  setPicker: Dispatch<SetStateAction<PickerState | null>>
  autoCopyRef: MutableRefObject<boolean>
  copyTextRef: MutableRefObject<(text: string) => void>
  lastCopiedRef: MutableRefObject<string>
}

/**
 * Build the xterm instance and everything that lives and dies with it, inside ONE effect keyed by
 * termId/status/id/fontsReady. Each concern is an `attach*`/`replay*` setup function returning its
 * own dispose; the composed cleanup runs them (then `xterm.dispose()`), so the teardown is
 * symmetric with the setup by construction.
 */
export function useXtermSession(opts: XtermSessionOptions): void {
  const {
    termId,
    status,
    tabId,
    fontsReady,
    containerRef,
    termRef,
    fitRef,
    projectIdRef,
    terminalFontRef,
    metaRef,
    buildLinkContextRef,
    setPicker,
    autoCopyRef,
    copyTextRef,
    lastCopiedRef
  } = opts

  useEffect(() => {
    if (status !== 'live') return
    // T-153 — hold off until the bundled fonts are loaded so the grid measures against the real
    // face; the effect re-runs when `fontsReady` flips true (only ever a boot-window wait).
    if (!fontsReady) return
    const container = containerRef.current
    if (!container) return

    const { xterm, fit } = createTerminal(terminalFontRef.current)
    xterm.open(container)
    termRef.current = xterm
    fitRef.current = fit

    // T-116/T-128 — the shared attach-paint gate (see PaintGate): the pty-write forward reads it,
    // replayScrollback owns and clears it.
    const paintGate: PaintGate = { painting: true }

    const disposeLinks = attachLinkProvider(xterm, container, { metaRef, buildLinkContextRef, setPicker })
    const disposeCopy = attachCopyOnSelect(xterm, container, {
      autoCopyRef,
      copyTextRef,
      lastCopiedRef
    })
    const disposeForward = attachPtyForwarding(xterm, { termId, paintGate })
    const disposeInput = attachGenuineInput(xterm, container, { projectIdRef, tabId })
    const disposeReplay = replayScrollback(xterm, { termId, projectIdRef, tabId, paintGate })
    const disposeResize = attachResize(xterm, fit, container, { termId })

    return () => {
      // T-128 — replayScrollback's dispose sets its `disposed` flag FIRST (the only order that is
      // observable here) so a still-pending async paint bails before touching a disposing xterm;
      // the other disposes are independent listener/handler detaches. `xterm.dispose()` runs LAST,
      // after every addon / provider / handler has been detached.
      disposeReplay()
      disposeResize()
      disposeForward()
      disposeInput()
      disposeLinks()
      disposeCopy()
      xterm.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // T-097 — `projectIdRef` (not `term.projectId`) reaches the current project, so a cross-project
    // move never rebuilds xterm. T-153 — `fontsReady` IS a trigger; `terminalFontRef` is read at
    // creation only (a font change restyles the live xterm in a separate pane effect). The refs and
    // `setPicker` are stable, so listing them changes nothing but satisfies exhaustive-deps.
  }, [
    termId,
    status,
    tabId,
    fontsReady,
    containerRef,
    termRef,
    fitRef,
    projectIdRef,
    terminalFontRef,
    metaRef,
    buildLinkContextRef,
    setPicker,
    autoCopyRef,
    copyTextRef,
    lastCopiedRef
  ])
}
