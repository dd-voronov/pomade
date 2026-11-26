// Pomade T-152 — app-level em-dash auto-replacement in the CodeMirror editors (raw + live).
//
// Typing `--` immediately followed by a BOUNDARY — space, Tab, or Enter — replaces the `--`
// with an em-dash `—` (U+2014). The boundary is kept (`-- ` → `— `). Prose contexts ONLY:
// never inside a fenced/indented code block, inline code, or (raw) frontmatter — `--flag` in a
// code fence must survive. Markdown docs only (mounted only for markdown paths). App-level
// toggle (default ON) read live via `isEnabled()`.
//
// Two boundary shapes (the ticket's Model C, with one CM-specific choice for Tab):
//   • SPACE and TAB are FULLY OWNED: the handler consumes the keystroke and does ONE isolated
//     transaction (`--`→`—` PLUS the boundary — a space or a literal `\t`), leaving a cancellable
//     pending state. Backspace as the very next keystroke restores the literal `-- `/`--\t`
//     (T-050/T-077 pending-revert pattern); Cmd+Z reverts the whole conversion in one step. Tab is
//     owned rather than delegated because CM's `indentWithTab` is `indentMore`, which prepends
//     LINE indentation — not a trailing boundary after the word — so a fully-owned trailing `\t`
//     is the behavior that matches the feature (and the rendered engine).
//   • ENTER is SEED-THEN-NATIVE: the keymap seeds the `--`→`—` replacement as its own isolated
//     transaction, then returns false so the editor's native Enter (newline, list continuation)
//     runs on the updated doc as a SEPARATE step. So the line break is the real editor behavior,
//     and Cmd+Z peels the newline first, then the conversion. (No immediate backspace-revert for
//     Enter — normal editing applies.)
//
// PRECEDENCE (input-handler ladder — see cm-pairs.ts / cm-checkbox.ts): this extension is
// ORTHOGONAL to checkbox (`[`) → wrap (pair chars / `*` `_`) → closeBrackets, because its
// triggers (space / Tab / Enter) are disjoint from theirs. It is registered at `Prec.highest`
// so its Tab beats `indentWithTab` and its Enter beats the list-continuation Enter (both of
// which it only touches for the one keystroke that follows a `--`, then — for Enter — delegates
// back). Its Backspace revert sits at `Prec.highest` ALONGSIDE the checkbox revert; the two are
// mutually exclusive (only one pending state can be live) so their relative order is not
// load-bearing.

import { syntaxTree } from '@codemirror/language'
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
import type { SyntaxNode } from '@lezer/common'

/** The em-dash the `--` becomes (U+2014). */
export const EM_DASH = '—'
const DASHES = '--'

/** Lezer-markdown node names where `--` is CODE, not prose — the replacement must never fire. */
const CODE_NODES = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'InlineCode',
  'CodeMark',
  'CodeInfo'
])

/** True when `pos` resolves inside any code construct (fenced/indented block or inline code). */
function inCodeContext(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1)
  for (; node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true
  }
  return false
}

export interface EmDashOptions {
  /** Live-read app setting (default ON). Read at keystroke time so a toggle takes effect at once. */
  isEnabled: () => boolean
  /** Raw editor only: `pos` sits in the (unparsed) YAML frontmatter — skip. Live gets no frontmatter. */
  inFrontmatter?: (state: EditorState, pos: number) => boolean
}

// ── The cancellable pending state (space / Tab boundary) ─────────────────────────
// Payload = the caret position right after a just-inserted `—`+boundary. Cleared by the next
// document change or selection move, so exactly one keystroke (a Backspace) can take the
// conversion back — the exact shape of cm-checkbox.ts's `pendingCheckbox`.
const startEmDash = StateEffect.define<number>()

const pendingEmDash = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(startEmDash)) return effect.value
    return tr.docChanged || tr.selection ? null : value
  }
})

/** Is an em-dash conversion still cancellable by Backspace? (Exported for tests/debugging.) */
export function emDashRevertPending(state: EditorState): boolean {
  return state.field(pendingEmDash, false) != null
}

/** The `--` immediately before `pos` is a real, convertible prose `--`. */
function convertibleAt(state: EditorState, pos: number, opts: EmDashOptions): boolean {
  if (!opts.isEnabled()) return false
  if (pos < 2) return false
  if (state.sliceDoc(pos - 2, pos) !== DASHES) return false
  if (opts.inFrontmatter?.(state, pos)) return false
  if (inCodeContext(state, pos)) return false
  return true
}

/**
 * Fully-owned conversion at the caret: replace the `--` with `—`+`boundary` in ONE isolated step
 * and arm the pending revert. `boundary` is exactly one code unit (a space or `\t`), so the
 * revert can recover the caret uniformly. Returns false (no-op) when the caret is not right after
 * a convertible `--`.
 */
function ownedConvert(view: EditorView, boundary: string, opts: EmDashOptions): boolean {
  if (view.composing || view.state.readOnly) return false
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const from = sel.head
  if (!convertibleAt(view.state, from, opts)) return false
  const caret = from - 2 + EM_DASH.length + boundary.length // (from-2) + `—`(1) + boundary(1) = from
  view.dispatch({
    changes: { from: from - 2, to: from, insert: EM_DASH + boundary },
    selection: { anchor: caret },
    effects: startEmDash.of(caret),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.type'
  })
  return true
}

// ── SPACE boundary — fully owned via the input handler ──────────────────────────
function spaceInputHandler(opts: EmDashOptions): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== ' ') return false
    const sel = view.state.selection.main
    // Only a plain caret-typed space (guards IME / paste-shaped events and selection replaces).
    if (!sel.empty || from !== sel.from || to !== sel.to) return false
    return ownedConvert(view, ' ', opts)
  })
}

/**
 * Backspace immediately after a conversion: restore the literal `--`+boundary (em-dash → `--`,
 * the boundary kept). Its own isolated history step, so a later Cmd+Z steps cleanly. Returns
 * false when no conversion is pending, so Backspace keeps every other behavior (and the checkbox
 * revert).
 */
export const revertEmDash: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const pending = state.field(pendingEmDash, false)
  if (pending == null) return false
  const sel = state.selection.main
  if (!sel.empty || sel.head !== pending) return false
  const emStart = pending - 2 // `—` at [emStart, emStart+1], boundary at [emStart+1, pending]
  if (state.sliceDoc(emStart, emStart + 1) !== EM_DASH) return false
  dispatch(
    state.update({
      changes: { from: emStart, to: emStart + 1, insert: DASHES },
      selection: { anchor: pending + 1 }, // grew by one char (`—` → `--`); caret stays after the boundary
      scrollIntoView: true,
      annotations: isolateHistory.of('full'),
      userEvent: 'delete.backward'
    })
  )
  return true
}

// ── ENTER boundary — seed the conversion, then let the native key run ────────────
// Dispatches ONLY the `--`→`—` replacement (its own isolated step) and returns false, so the
// following handler in the keymap chain (the list-continuation or default Enter) produces the
// line break on the already-converted text as a separate step.
function seedConversion(view: EditorView, opts: EmDashOptions): void {
  const sel = view.state.selection.main
  if (!sel.empty) return
  const from = sel.head
  if (!convertibleAt(view.state, from, opts)) return
  view.dispatch({
    changes: { from: from - 2, to: from, insert: EM_DASH },
    selection: { anchor: from - 1 },
    annotations: isolateHistory.of('full'),
    userEvent: 'input.replace'
  })
}

/** The em-dash auto-replacement extension for a CodeMirror markdown editor (raw or live). */
export function emDashReplace(opts: EmDashOptions): Extension {
  return [
    pendingEmDash,
    Prec.highest(spaceInputHandler(opts)),
    Prec.highest(
      keymap.of([
        { key: 'Backspace', run: revertEmDash },
        {
          key: 'Enter',
          run: (view) => {
            seedConversion(view, opts)
            return false // let the native Enter (newline / list continuation) run as its own step
          }
        },
        { key: 'Tab', run: (view) => ownedConvert(view, '\t', opts) }
      ])
    )
  ]
}
