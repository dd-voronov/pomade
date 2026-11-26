// Pomade T-050 (+ T-077 amendment) — GFM checkbox completion in the RAW editor.
//
// Typing `[` right after a bare list marker (`- ` / `* `, any indent) completes to `- [ ] ` with
// the caret after it, in ONE `isolateHistory('full')` transaction. Mirrors the rendered-mode
// Milkdown input rule (`md-config.ts` `checkboxInputRule()`).
//
// T-077 amendment — the completion is CANCELLABLE, VS Code style: Backspace or Escape as the VERY
// NEXT keystroke reverts it to the bare typed `[` (drops the auto-inserted ` ] `, keeps the `[`).
// Anything else — typing, an arrow key, a click — COMMITS the completion, after which Backspace is
// an ordinary character delete again. That "very next keystroke" window is the `pendingCheckbox`
// state field: any transaction that changes the document or moves the selection clears it.
//
// Precedences live here so the mount site (RawEditor) only lists the extension: the input handler
// must beat T-077's pair handling (`- ` + `[` is a checkbox, not `[]`) and the revert binding must
// beat both closeBrackets' Backspace and `defaultKeymap`'s delete-backward / Escape.

import { isolateHistory } from '@codemirror/commands'
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type StateCommand
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

/** A line that is nothing but a bare list marker — the only context the completion fires in. */
export const CHECKBOX_CONTEXT = /^\s*[-*] $/

/** What the typed `[` expands to. The `[` itself is the first character, so a revert keeps it. */
export const CHECKBOX_COMPLETION = '[ ] '

/** Marks a just-inserted completion; the payload is the caret position right after it. */
const startCheckbox = StateEffect.define<number>()

/**
 * The caret position right after a completion that is still cancellable, or `null`. Cleared by the
 * next document change or selection move — so exactly one keystroke gets to take it back.
 */
const pendingCheckbox = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(startCheckbox)) return effect.value
    return tr.docChanged || tr.selection ? null : value
  }
})

/** Is a checkbox completion still cancellable? (Exported for tests/debugging.) */
export function checkboxCompletionPending(state: EditorState): boolean {
  return state.field(pendingCheckbox, false) != null
}

const completeCheckbox = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '[') return false
  // A non-empty selection belongs to T-077 selection wrapping — completing here would silently
  // delete the selected text.
  if (!view.state.selection.main.empty) return false
  const line = view.state.doc.lineAt(from)
  if (!CHECKBOX_CONTEXT.test(view.state.sliceDoc(line.from, from))) return false
  const caret = from + CHECKBOX_COMPLETION.length
  view.dispatch({
    changes: { from, to, insert: CHECKBOX_COMPLETION },
    selection: { anchor: caret },
    effects: startCheckbox.of(caret),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.complete'
  })
  return true
})

/**
 * Backspace / Escape immediately after a completion: revert to the bare typed `[`. One coherent
 * history step of its own (`isolateHistory('full')`), so Cmd+Z after a revert steps back to the
 * completed `- [ ] ` rather than to some half-state. Returns false whenever no completion is
 * pending, so both keys keep their normal behavior.
 */
export const revertCheckboxCompletion: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const pending = state.field(pendingCheckbox, false)
  if (pending == null) return false
  const sel = state.selection.main
  if (!sel.empty || sel.head !== pending) return false
  const from = pending - CHECKBOX_COMPLETION.length
  if (state.sliceDoc(from, pending) !== CHECKBOX_COMPLETION) return false
  // Keep the `[` the user actually typed; drop what the completion added after it.
  const keep = from + 1
  dispatch(
    state.update({
      changes: { from: keep, to: pending },
      selection: { anchor: keep },
      scrollIntoView: true,
      annotations: isolateHistory.of('full'),
      userEvent: 'delete.backward'
    })
  )
  return true
}

/** The raw-editor checkbox-completion extension (input rule + its cancellation window). */
export function checkboxCompletion(): Extension {
  return [
    pendingCheckbox,
    Prec.highest(completeCheckbox),
    Prec.highest(
      keymap.of([
        { key: 'Backspace', run: revertCheckboxCompletion },
        { key: 'Escape', run: revertCheckboxCompletion }
      ])
    )
  ]
}
