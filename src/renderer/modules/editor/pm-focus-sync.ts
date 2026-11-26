// Pomade T-206 — a native caret move right after the editor gains focus must survive ProseMirror's
// deferred focus re-assert.
//
// ProseMirror's focus handler arms a 20 ms timer that writes ITS selection onto the DOM when the two
// differ (it corrects a browser's own caret placement at focus). ProseMirror reads a native caret move
// (Cmd+ArrowDown, Home, arrows) into its state only from the `selectionchange` event, a task queued
// behind that timer when the renderer is busy: the timer then runs first and overwrites the caret the
// user just moved, and what is typed next lands at the stale position.
//
// This plugin runs the same focus bookkeeping as ProseMirror's handler (`ProseMirror-focused` class,
// `focused`, `lastFocus`) and replaces only the timer: when a key was pressed since the focus the DOM
// selection is the user's intent and is read into the state; otherwise ProseMirror's state is written
// onto the DOM, exactly as its own timer would. The bookkeeping touches ProseMirror internals, so the
// plugin steps aside (ProseMirror's own handler runs) when they are not the expected shape.

import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'

/** ProseMirror's own delay before it re-asserts its selection after focus. */
const REASSERT_DELAY_MS = 20

interface FocusInternals {
  focused: boolean
  input: { lastFocus: number }
  domObserver: { stop(): void; start(): void }
}

function internalsOf(view: EditorView): FocusInternals | null {
  const v = view as unknown as Partial<FocusInternals>
  const ok =
    typeof v.focused === 'boolean' &&
    typeof v.input?.lastFocus === 'number' &&
    typeof v.domObserver?.stop === 'function' &&
    typeof v.domObserver?.start === 'function'
  return ok ? (v as FocusInternals) : null
}

/** Dispatch the DOM selection into `view`'s state when it is a text selection that differs. */
function syncSelectionFromDom(view: EditorView): void {
  if (view.composing || !(view.state.selection instanceof TextSelection)) return
  const dom = (view.root as Document).getSelection?.()
  if (!dom?.anchorNode || !dom.focusNode) return
  if (!view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return
  try {
    const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
    const head = view.posAtDOM(dom.focusNode, dom.focusOffset)
    const cur = view.state.selection
    if (cur.anchor === anchor && cur.head === head) return
    const { doc } = view.state
    view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(anchor), doc.resolve(head))))
  } catch {
    /* a DOM position outside the document — leave ProseMirror's own reading to decide */
  }
}

export function focusSelectionSyncPlugin(): Plugin {
  let keyedSinceFocus = false
  return new Plugin({
    props: {
      handleDOMEvents: {
        focus: (view) => {
          const pm = internalsOf(view)
          if (!pm) return false
          pm.input.lastFocus = Date.now()
          if (pm.focused) return true
          pm.domObserver.stop()
          view.dom.classList.add('ProseMirror-focused')
          pm.domObserver.start()
          pm.focused = true
          keyedSinceFocus = false
          setTimeout(() => {
            if (view.isDestroyed || !view.hasFocus()) return
            if (keyedSinceFocus) syncSelectionFromDom(view)
            else view.updateState(view.state)
          }, REASSERT_DELAY_MS)
          return true
        },
        keydown: () => {
          keyedSinceFocus = true
          return false
        }
      }
    }
  })
}
