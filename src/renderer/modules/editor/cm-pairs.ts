// Pomade T-077 — paired elements in the RAW editor: auto-close + selection wrapping.
//
// Raw mode only (this module is imported by RawEditor and nowhere else), every text-like format
// EXCEPT .csv (its table view and its raw fallback both get nothing — see `pairsEnabledFor`).
// Rendered mode is deliberately untouched: a future wikilink-suggestion feature owns `[[` there.
//
// Two layers:
//   1. @codemirror/autocomplete's `closeBrackets` does the VS Code typing behaviors — the closer
//      is auto-inserted, typing the closer types OVER it, Backspace between the halves removes
//      both, and a quote does not pair right after a word character (`canStartStringAt`, which is
//      exactly the apostrophes-in-prose heuristic). We only widen its bracket set: the default is
//      `("[{'"` — Pomade also wants `<>` and `` ` ``. The set is published as language data at the
//      HIGHEST precedence, overriding the per-language `closeBrackets` config that
//      lang-javascript / lang-json / lang-html ship. It is uniform across formats with ONE
//      exception: `.html`/`.htm` drop `<` because lang-html's tag completion owns angle brackets
//      there (`closeBracketsConfigFor`).
//   2. `wrapSelectionHandler` (ours) owns every NON-EMPTY selection: typing EITHER half of a pair
//      wraps the selection and keeps the selection on the inner text, so pressing the mark again
//      stacks (`*foo*` → `**foo**`). `*` and `_` are wrap-ONLY — they are not in the bracket set,
//      so they never auto-close while typing (markdown emphasis must stay typable).
//
// Precedence (all three input handlers read the same keystroke):
//   T-050 checkbox (Prec.highest, cm-checkbox.ts) → wrapSelectionHandler (Prec.high) →
//   closeBrackets (default). So `- ` + `[` is still a checkbox, a selection + `[` is still a wrap,
//   and a bare `[` still auto-closes.

import {
  closeBrackets,
  closeBracketsKeymap,
  type CloseBracketConfig
} from '@codemirror/autocomplete'
import { isolateHistory } from '@codemirror/commands'
import {
  EditorSelection,
  EditorState,
  Prec,
  type Extension,
  type Transaction
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

import { extOf, hasTagCompletion } from './doc-kind'

/** A pair as it is inserted around text: the opening half and the closing half. */
export interface PairHalves {
  open: string
  close: string
}

/**
 * The auto-closing pairs (T-077 §1), opener → closer. Same-character pairs (quotes, backtick)
 * map to themselves; `closeBrackets` handles those through its `handleSame` path.
 */
export const AUTO_CLOSE_PAIRS: ReadonlyMap<string, string> = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`']
])

/**
 * Marks that WRAP a selection but never auto-close while typing: markdown emphasis. Typing `*`
 * with no selection must stay a plain `*` (lists, bold-in-progress, literal asterisks).
 */
export const WRAP_ONLY_MARKS: readonly string[] = ['*', '_']

/**
 * The `closeBrackets` language data for one document. `before` keeps CodeMirror's default (a newly
 * opened bracket closes only in front of whitespace, EOL, or one of these characters), so typing
 * `(` immediately before a word does not inject a stray `)` — VS Code semantics.
 *
 * The set is PER LANGUAGE in exactly one respect: `<` is dropped where the language completes tags
 * itself (`.html`/`.htm` — lang-html's `autoCloseTags` turns `<p>` into `<p></p>`, which beats a
 * generic `<>`, and both want the `>` keystroke). Everywhere else `<>` is a normal pair.
 */
export function closeBracketsConfigFor(path: string): CloseBracketConfig {
  const angleOwnedByTags = hasTagCompletion(path)
  return {
    brackets: [...AUTO_CLOSE_PAIRS.keys()].filter((b) => b !== '<' || !angleOwnedByTags),
    before: ')]}:;>'
  }
}

/** .csv is excluded from paired elements entirely — table view AND raw fallback (T-077 spec). */
export function pairsEnabledFor(path: string): boolean {
  return extOf(path) !== 'csv'
}

/**
 * The pair a single typed character wraps a selection in — EITHER half of an auto-close pair, or
 * a wrap-only emphasis mark. `null` for everything else.
 */
export function pairForWrap(text: string): PairHalves | null {
  if (WRAP_ONLY_MARKS.includes(text)) return { open: text, close: text }
  const close = AUTO_CLOSE_PAIRS.get(text)
  if (close) return { open: text, close }
  for (const [open, closer] of AUTO_CLOSE_PAIRS) {
    if (text === closer) return { open, close: closer }
  }
  return null
}

/**
 * Wrap every non-empty range of the selection in `pair`, as ONE transaction (isolated in the
 * history, so a single undo reverts the whole wrap and a later keystroke cannot merge into it).
 * The selection is kept on the INNER text — direction preserved — which is what makes stacking
 * work: `*` on `foo` gives `*foo*` with `foo` still selected, so `*` again gives `**foo**`.
 * A multi-line selection is wrapped as a whole (open before its first character, close after its
 * last). Degenerate empty ranges of a multi-cursor selection just take the literal character.
 */
export function wrapSelection(state: EditorState, pair: PairHalves, text: string): Transaction {
  const { open, close } = pair
  const spec = state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: text },
        range: EditorSelection.cursor(range.from + text.length)
      }
    }
    return {
      changes: [
        { from: range.from, insert: open },
        { from: range.to, insert: close }
      ],
      range: EditorSelection.range(range.anchor + open.length, range.head + open.length)
    }
  })
  return state.update(spec, {
    scrollIntoView: true,
    userEvent: 'input.type',
    annotations: isolateHistory.of('full')
  })
}

// Non-empty selection + either half of a pair (or `*` / `_`) ⇒ wrap. Sits ABOVE closeBrackets:
// closeBrackets can wrap with an OPENER too, but not with a closer and not with `*` / `_`, and it
// does not isolate the wrap in the history — one owner for all wrapping keeps the behavior and
// the undo granularity identical whichever half the user pressed.
const wrapSelectionHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || view.state.readOnly) return false
  if (text.length !== 1) return false
  const sel = view.state.selection
  // Only when this input really targets the selection (guards IME/paste-shaped events).
  if (sel.main.empty || from !== sel.main.from || to !== sel.main.to) return false
  const pair = pairForWrap(text)
  if (!pair) return false
  view.dispatch(wrapSelection(view.state, pair, text))
  return true
})

/**
 * The raw-editor paired-element extension. Returns nothing for .csv, so its raw fallback types
 * literally. Precedences are explicit (not array-position dependent): the wrap handler must beat
 * closeBrackets' own input handler, and the Backspace-deletes-the-pair binding must beat
 * `defaultKeymap`'s plain delete-backward.
 */
export function pairedElements(path: string): Extension {
  if (!pairsEnabledFor(path)) return []
  const closeBracketsData = closeBracketsConfigFor(path)
  return [
    Prec.highest(EditorState.languageData.of(() => [{ closeBrackets: closeBracketsData }])),
    Prec.high(wrapSelectionHandler),
    Prec.high(keymap.of([...closeBracketsKeymap])),
    closeBrackets()
  ]
}
