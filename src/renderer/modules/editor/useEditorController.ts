// Pomade — the editor pane's controller registration + caret bridge + jump-to-line. Whichever
// editor engine mounts (raw CM, rendered/live PM, CSV table) registers its controller here;
// setController owns the T-004 caret restore across a raw⇄rich remount and the StrictMode
// double-mount survivor guards, and the effect consumes a one-shot terminal `path:line` jump
// (E-020) once a SETTLED controller of the expected kind is available.

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

import { useJumpStore } from '../../stores/jump-store'
import { anchorForLine, type CaretAnchor } from './caret-anchor'
import { traceCaret } from './caret-trace'
import type { EditorController } from './editor-controller'
import type { RichKind } from './doc-kind'

type PendingToggle = {
  kind: 'raw' | 'rendered' | 'live'
  caret: CaretAnchor | null
  viewport: CaretAnchor | null
} | null

export function useEditorController(params: {
  controllerRef: MutableRefObject<EditorController | null>
  pendingToggleRef: MutableRefObject<PendingToggle>
  tabId: string
  loaded: boolean
  content: string
  richKind: RichKind
  docMode: string
  forceRendered: boolean
  mdGuard: 'unknown' | 'ok' | 'unparseable'
  renderedShown: boolean
  tableShown: boolean
  liveShown: boolean
}): (c: EditorController | null) => void {
  const {
    controllerRef,
    pendingToggleRef,
    tabId,
    loaded,
    content,
    richKind,
    docMode,
    forceRendered,
    mdGuard,
    renderedShown,
    tableShown,
    liveShown
  } = params

  // E-020 (T-086) — bumped whenever an editor registers its controller. `controllerRef` is a ref
  // (deliberately non-reactive), so this counter is what lets the jump-to-line effect below
  // re-run at the moment a freshly mounted editor becomes drivable.
  const [controllerNonce, setControllerNonce] = useState(0)

  // The latest loaded/edited text, read at jump time to map a `:line` onto a rendered block.
  const contentRef = useRef(content)
  contentRef.current = content
  const jumpRequest = useJumpStore((s) => s.request)

  // ── E-020 (T-086): jump to a line requested by a terminal `path:line` link ──────
  // The request can land BEFORE this pane exists (Cmd+click opens the tab and asks for the line in
  // one gesture) or while it is already open, so the effect waits on its preconditions — the request
  // is ours, the file is LOADED, and a SETTLED editor has registered a controller — then consumes
  // the one-shot slot.
  //
  // Round 3 — BOTH editor engines honor the jump now (was raw-only):
  //   • raw CodeMirror → `gotoLine` places the caret on the line, scrolls, focuses.
  //   • rendered markdown has no line numbers, so we translate the raw line into a caret ANCHOR
  //     (the source block's plain text, caret-anchor.ts) and hand it to the same `setCaretAnchor`
  //     bridge a raw⇄rendered toggle uses — it matches the block, scrolls it into the `md-scroll`
  //     container and focuses. This is why the link router no longer drops `:line` for rendered docs.
  useEffect(() => {
    if (!jumpRequest || jumpRequest.tabId !== tabId || !loaded) return
    const ctrl = controllerRef.current
    if (!ctrl) return
    // Wait for the SETTLED editor. A markdown doc set to render first mounts a TRANSIENT raw
    // CodeMirror while the parse-health gate (mdGuard) decides whether the body is parseable;
    // consuming the jump then would apply it to a CodeMirror instance about to be unmounted — the
    // round-2/3 rendered bug (the jump silently swallowed by the throwaway raw view). Wait it out.
    if (richKind === 'markdown' && docMode === 'rendered' && !forceRendered && mdGuard === 'unknown') return
    // Only the editor that will STAY may consume the jump: during the swap from the transient raw
    // view to the rendered view, `controllerRef` briefly still points at the dead raw controller —
    // a kind mismatch here makes the effect wait for the successor instead of jumping into a corpse.
    const expectedKind: 'raw' | 'rendered' | 'table' | 'live' = liveShown
      ? 'live'
      : renderedShown
        ? tableShown
          ? 'table'
          : 'rendered'
        : 'raw'
    if (ctrl.kind !== expectedKind) return
    // StrictMode survivor guard for the ONE-SHOT jump. In a React DEVELOPMENT bundle (`npm run
    // dev`) a fresh editor mount double-invokes (mount → simulated unmount → remount), so this
    // effect can `take()` the jump and apply it to the DOOMED first controller — whose view is
    // then destroyed, leaving the caret at line 1 (the Owner's `:132-134` link opening a doc at line
    // 1 in dev). We cannot know at apply time whether `ctrl` is the survivor, so after applying we
    // check on a deferred tick: if a newer controller has since registered (`controllerRef.current
    // !== ctrl`), the jump landed in a corpse — RE-POST it so the survivor consumes it. Bounded:
    // React only ever DOUBLES a mount, so at most the doomed controller re-posts once; the
    // survivor's own deferred check sees itself still current and does not re-post. In production
    // React (single mount) the check always passes and nothing is re-posted.
    const rejumpIfDoomed = (line: number): void => {
      setTimeout(() => {
        if (controllerRef.current !== ctrl) {
          traceCaret('jump-repost', { line })
          useJumpStore.getState().jumpTo(tabId, line)
        }
      }, 0)
    }
    if (ctrl.kind === 'raw') {
      if (!ctrl.gotoLine) return
      const line = useJumpStore.getState().take(tabId)
      if (line === null) return
      // Applied SYNCHRONOUSLY: `take()` clears the store slot, re-running this effect with
      // `jumpRequest === null`; a timer with a cleanup would always cancel its own jump.
      // `gotoLine` itself re-issues the scroll after layout (the fresh-mount scroll fix).
      ctrl.gotoLine(line)
      rejumpIfDoomed(line)
      return
    }
    if (ctrl.kind === 'rendered' || ctrl.kind === 'live') {
      // Neither rich view shows raw file line numbers — translate the line into a caret
      // ANCHOR against the FULL content (the anchor is block-text-based, so the live view's
      // frontmatter-less body still matches).
      if (!ctrl.setCaretAnchor) return
      const line = useJumpStore.getState().take(tabId)
      if (line === null) return
      ctrl.setCaretAnchor(anchorForLine(contentRef.current, line))
      rejumpIfDoomed(line)
      return
    }
    // The CSV table has no line to jump to — leave the one-shot request for a later toggle.
    //
    // T-173 triage: `controllerRef` is a ref (stable identity, safe to omit). `docMode` /
    // `forceRendered` / `richKind` are read only in the settled-editor gate above and are
    // deliberately NOT deps — this effect's re-run set is pinned to the StrictMode-survivor
    // dance documented above (jumpRequest/loaded/controllerNonce/tabId/mdGuard/*Shown); adding
    // them would re-fire the one-shot consume on every mode/kind change instead of only when
    // the jump-relevant signals change, risking a double-consume of the jump slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run set pinned to the jump signals, see the T-173 note above
  }, [jumpRequest, loaded, controllerNonce, tabId, mdGuard, renderedShown, tableShown, liveShown])

  const setController = (c: EditorController | null): void => {
    // Ignore null-clears: Milkdown's destroy listener fires ASYNC after teardown, so on a
    // rendered→raw toggle (or a reload remount) it lands AFTER the successor editor has
    // already registered its controller — and would clobber it, leaving the pane with no
    // selection/find access (the round-3/4 "raw .md context menu dead" bug). Every editor
    // state mounts a successor that overwrites the ref, so clearing is never needed.
    if (c === null) return
    controllerRef.current = c
    // Flight recorder: every controller registration. In a React DEVELOPMENT bundle (`npm run
    // dev`) StrictMode double-invokes a mount effect (mount → simulated unmount → remount), so a
    // SINGLE editor mount registers TWO controllers here — the first is destroyed immediately.
    // Recording each registration makes that doubling observable (the regime the survivor guards
    // below and in the jump effect defend against).
    traceCaret('register', { kind: c.kind })
    // E-020 — make "a controller is now available" observable to effects (jump-to-line).
    setControllerNonce((n) => n + 1)

    // T-004 / T-194 — restore across a raw⇄live⇄rendered toggle remount. Bridge the engines by
    // caret anchor (PLAIN text of the block + offset — caret-anchor.ts) for the SELECTION, and by
    // the outgoing viewport anchor for the SCROLL: `applyToggleView` sets the caret WITHOUT
    // scrolling it in and scrolls the kept viewport to the top, so the reading position survives the
    // toggle and the caret is decoupled from it. Deferred a tick so the fresh editor (esp. Milkdown)
    // is fully ready. Redundant with the `toggle` first-paint bake in production (same spot,
    // invisible); it exists for the StrictMode survivor dance below.
    const pending = pendingToggleRef.current
    if (
      pending &&
      (c.kind === 'raw' || c.kind === 'rendered' || c.kind === 'live') &&
      c.kind !== pending.kind &&
      c.applyToggleView
    ) {
      const apply = c.applyToggleView
      const { caret, viewport } = pending
      traceCaret('restore-scheduled', { from: pending.kind, to: c.kind })
      // StrictMode survivor guard. Do NOT clear the pending at SCHEDULE time: in a dev double
      // mount the DOOMED first controller would clear it, and the surviving controller would then
      // find nothing to restore (the caret lands on line 1 — the Owner's raw⇄live / rendered→raw
      // toggle report). Instead every registration schedules its OWN deferred apply, and the apply
      // consumes the pending only if THIS controller is still the live one (`controllerRef.current
      // === c`). The doomed controller's deferred apply sees the survivor's newer ref and bows out,
      // leaving the pending intact for the survivor's apply, which lands it and clears. In
      // production React (no double invoke) there is exactly one registration, so this is a plain
      // deferred apply. Both registrations share `c.kind` here (the same successor engine), so the
      // `c.kind !== pending.kind` gate passes for both — the pending MUST survive to the second.
      setTimeout(() => {
        if (controllerRef.current !== c) {
          traceCaret('restore-abandoned', { kind: c.kind })
          return
        }
        if (!pendingToggleRef.current) return
        pendingToggleRef.current = null
        apply(caret, viewport)
      }, 0)
    } else if (pending) {
      traceCaret('restore-skipped', {
        pendingFrom: pending.kind,
        mountedKind: c.kind,
        hasSetter: !!c.applyToggleView
      })
    }
  }

  return setController
}
