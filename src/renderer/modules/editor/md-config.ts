// Pomade Wave 4 / E-002 — shared Milkdown / remark-stringify configuration.
// Both the live rendered editor and the headless round-trip guard use THIS exact config so
// the guard faithfully predicts what a save would produce. Nudges the serializer toward
// vault-friendly output (dash bullets/rules) to reduce gratuitous reformatting; the
// round-trip guard (see md-roundtrip.ts) is the real safety net against lossy rewrites.

import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import {
  bulletListSchema,
  commonmark,
  hardbreakAttr,
  hardbreakSchema,
  remarkPreserveEmptyLinePlugin
} from '@milkdown/kit/preset/commonmark'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import { inputRules, InputRule } from '@milkdown/kit/prose/inputrules'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { $useKeymap } from '@milkdown/kit/utils'
import type { Handle, Join } from 'mdast-util-to-markdown'
import type { Text } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'

// E-023 — commonmark preset WITHOUT `remark-preserve-empty-line`.
//
// milkdown's preset-commonmark ships `remarkPreserveEmptyLinePlugin`, which is the single root
// cause of two defects (survey 2026-08-19):
//   • PARSE half (`visitEmptyLine`): it strips EVERY html node whose value is a `<br>` variant
//     (`<br />`/`<br>`/`<br >`/`<br/>`) out of the mdast tree, so `a<br>b` silently becomes `ab`
//     on load — the ONLY true data loss in the pipeline (other inline HTML round-trips fine via
//     htmlSchema).
//   • SERIALIZE half (paragraphSchema.toMarkdown): when the plugin is registered it emits
//     `<br />` for every EMPTY non-last paragraph. Its `lastNode` guard compares by IDENTITY
//     against `editorViewCtx…doc.lastChild`; in the headless guard the parsed doc is a different
//     instance from the view's doc, so even an empty doc's sole paragraph serialized to `<br />`
//     (i.e. `serialize(parse('')) === '<br />\n'`).
//
// Removing the plugin fixes both at once: `<br>` html nodes now survive parse AND serialize
// verbatim (htmlSchema owns them), and empty paragraphs serialize to nothing — the same
// blank-line collapse the PARSER already applies, so the pipeline stays internally consistent.
//
// The plugin is exported as a 2-element array `[options, plugin]` (both flattened into the
// `commonmark` collection), so we drop both members by identity. The live editor
// (RenderedMarkdown) and the headless guard (md-roundtrip) BOTH `.use()` this filtered preset so
// their parser/serializer stay in lock-step (same discipline as bulletListSpreadFix/softBreakFix).
const preserveEmptyLineParts = new Set<unknown>(
  remarkPreserveEmptyLinePlugin as unknown as unknown[]
)
export const commonmarkNoEmptyLine = (commonmark as unknown[]).filter(
  (pl) => !preserveEmptyLineParts.has(pl)
) as typeof commonmark

// T-041 — stop the serializer emitting escapes the parser never required.
//
// mdast-util-to-markdown's default `text` handler escapes CONSERVATIVELY: every character that
// *could* start a construct in *some* context gets a backslash (`[` → `\[`, intraword `_` →
// `\_`, …). That corrupts the vault's dialect on save — `[[wikilink]]` became `\[\[wikilink]]`
// on disk, and ordinary files with `snake_case` or `[[…]]` failed the byte-exact round-trip
// guard and were forced open in raw mode (T-015 "plain .md opens rendered" appeared broken).
//
// The principled fix: escape a text run only when the escape is actually LOAD-BEARING. We keep
// the default (correct, over-eager) escaping as the fallback, but before emitting it we VERIFY
// whether the *raw* value would survive a re-parse as a single literal text node. If it would
// (`[[wikilink]]`, `snake_case` — neither forms a link/emphasis in commonmark+gfm), the escapes
// were gratuitous and we drop them. If it would NOT (`_foo_` is emphasis, `[a](b)` is a link),
// we keep the full escaping so `parse(serialize(doc)) === doc` still holds. This is verification,
// not a blind regex un-escape: any string the escape genuinely protects stays protected.
//
// Because ProseMirror docs only ever originate from the same parser, an emphasis/link/code run
// is always its own node — a `text` node never legitimately holds `_foo_`/`[a](b)`; those only
// appear when the escape is truly needed, and the re-parse check catches exactly those.
//
// The verify uses commonmark+gfm (matching the editor's own preset stack), so it agrees with
// what a real load would parse. Applied via `handlers.text` on the shared remark-stringify
// options → identical in the live editor (RenderedMarkdown) and the guard (md-roundtrip).

// Small bounded memo — the same runs recur across keystrokes; the check only runs for runs the
// default escaping actually touched (rare), so this stays tiny in practice.
const gratuitousCache = new Map<string, boolean>()
const CACHE_MAX = 4096

// True iff every escape the default `text` handler added to `value` is gratuitous — i.e. the RAW
// value re-parses (commonmark+gfm, matching the editor's own preset stack) to exactly the same
// literal text. We parse `value` standalone, which places it at a block start: the MOST
// construct-friendly context there is (headings, lists, definitions AND every inline construct
// are all live there). So anything that survives as a lone text node here survives in every
// context — the check can never under-escape (drop a load-bearing escape); its only cost is
// occasionally KEEPING a needless escape when a leading `- `/`# `/`_`-flank looks block-ish
// standalone but is inert mid-paragraph. Erring toward more escaping is always safe.
//
// The parser strips a paragraph's surrounding whitespace (which never carries escapes anyway),
// so we compare the whitespace-trimmed cores.
function escapesAreGratuitous(value: string): boolean {
  const cached = gratuitousCache.get(value)
  if (cached !== undefined) return cached
  let ok = false
  try {
    const tree = fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    const para = tree.children[0]
    ok =
      tree.children.length === 1 &&
      para.type === 'paragraph' &&
      para.children.length === 1 &&
      para.children[0].type === 'text' &&
      para.children[0].value === value.trim()
  } catch {
    ok = false
  }
  if (gratuitousCache.size >= CACHE_MAX) gratuitousCache.clear()
  gratuitousCache.set(value, ok)
  return ok
}

const minimalEscapeText: Handle = (node, _parent, state, info) => {
  const value = (node as Text).value
  const escaped = state.safe(value, info)
  // Fast path: default escaping changed nothing — nothing to reconsider.
  if (escaped === value) return escaped
  // The default WANTED to escape something; drop it only when the raw value re-parses to the
  // exact same literal text (the escape was gratuitous, e.g. `[[wikilink]]`, `snake_case`).
  return escapesAreGratuitous(value) ? value : escaped
}

// T-124 — nested list items stop gaining a blank line when serialized.
//
// mdast-util-to-markdown decides whether to put a blank line BETWEEN a flow child and the next
// (i.e. between a list item's paragraph and its nested list) via its `join` runners. The default
// runner (`joinDefaults`, lib/join.js) honors `parent.spread` ONLY when it is a strict boolean;
// otherwise it falls through and emits a blank line. commonmark's list-item schema breaks that in
// two ways, so tight nested lists came back loose (blank line inserted, which then re-parses as a
// genuinely loose list — the compounding the user saw):
//   (a) a PARSED item stores `spread` as the STRING `"false"`/`"true"` (preset-commonmark
//       stringifies the attr), which is never `typeof === 'boolean'` → default falls through →
//       blank line, even for a tight source list;
//   (b) a FRESHLY-CREATED item (Enter/Tab in rendered mode: sink/split/wrap) gets the schema
//       default `spread: true` (a real boolean) → default returns 1 → blank line, even though the
//       user never asked for a loose list.
// `bulletListSpreadFix` already coerces the LIST node's spread; the LIST-ITEM node was left. This
// `join` hook closes that gap. User joins are appended to the defaults and `between()` (container
// -flow.js) iterates them BACKWARDS, so this runs BEFORE joinDefaults; returning 0 forces tight,
// 1 forces a blank line, `undefined` falls through to joinDefaults.
//
// The key decision for a `listItem` parent: an item is loose ONLY when the PARSER marked it so —
// spread arrives as the STRING `'true'` (the source genuinely had a blank line). A BOOLEAN `true`
// is the schema-default junk stamped on freshly-created items and is NOT evidence of a blank line
// → treated as TIGHT. String `'false'`, boolean `false`, and `undefined` → tight.
//
// Exceptions mirror joinDefaults so non-list flow and must-separate cases are never broken:
//   • two adjacent paragraphs (or a paragraph then a definition/heading) inside one item MUST keep
//     their blank line or they misparse (paragraphs would merge). We fall through for those, so
//     joinDefaults/`between` emit the required `\n\n`. This is also why a genuinely loose item —
//     one holding multiple paragraphs — stays loose: such items always carry the parser's string
//     `'true'` AND hit this paragraph→paragraph exception, so both paths keep them separated.
//     (Probed: a freshly-created SECOND paragraph inside an item — boolean-true item — still
//     separates correctly here because the paragraph→paragraph branch falls through regardless of
//     spread; only the paragraph→list join is forced tight for boolean-true items.)
//   • "indented code after a (nested) list" is deferred to joinDefaults, which inserts the required
//     `<!---->` separator we must not flatten.
const listJoin: Join = (left, right, parent) => {
  // List NODE: children are items. Honor a real loose flag (boolean `true` here is legitimate —
  // list-node spread is coerced to boolean by bulletListSpreadFix / upstream for ordered lists —
  // and the string `'true'` a parsed list may still carry means loose too).
  if (parent.type === 'list') {
    return parent.spread === true || (parent as { spread?: unknown }).spread === 'true' ? 1 : 0
  }
  if (parent.type === 'listItem') {
    // Defer indented-code-after-list to joinDefaults (it emits the `<!---->` guard separator).
    if (right.type === 'code' && left.type === 'list') return undefined
    // Blocks that would misparse if packed tight against a preceding paragraph must stay
    // separated regardless of spread → fall through and let joinDefaults/`between` blank-line them.
    if (
      left.type === 'paragraph' &&
      (right.type === 'paragraph' || right.type === 'definition' || right.type === 'heading')
    ) {
      return undefined
    }
    // The fix: loose ONLY when the parser said so (string `'true'`). Boolean-true junk → tight.
    return (parent as { spread?: unknown }).spread === 'true' ? 1 : 0
  }
  return undefined
}

export function configureRemarkStringify(ctx: Ctx): void {
  ctx.set(remarkStringifyOptionsCtx, {
    ...ctx.get(remarkStringifyOptionsCtx),
    bullet: '-',
    rule: '-',
    listItemIndent: 'one',
    handlers: { text: minimalEscapeText },
    join: [listJoin]
  })
}

// E-002 (T-016) — tight-list round-trip fix.
// commonmark's bullet_list toMarkdown forwards the node's `spread` attr straight to mdast,
// but at parse time that attr is stringified ("false" / "true"). A non-empty string is
// truthy, so mdast-util-to-markdown renders EVERY bullet list as LOOSE (blank line between
// items) even when the source was tight. That breaks byte-exact round-trip, so any note with
// a tight bullet list (extremely common — incl. GFM task lists) was wrongly flagged lossy and
// forced to raw, meaning checkboxes never rendered. Coerce `spread` back to a real boolean.
// (ordered_list already coerces correctly upstream, so only bullet_list needs this.) Applied
// identically in the live editor and the guard, keeping their predictions in lock-step.
const asBool = (v: unknown): boolean => v === true || v === 'true'

export const bulletListSpreadFix = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state
          .openNode('list', undefined, { ordered: false, spread: asBool(node.attrs.spread) })
          .next(node.content)
          .closeNode()
      }
    }
  }
})

// E-002 (T-038) — Obsidian soft-break semantics, render half.
// Supersedes T-017's paragraph-CSS model. Files in the Owner's vault put SINGLE newlines inside a
// paragraph (`line1\nline2`, Obsidian style); commonmark treats that as a soft break. Milkdown's
// `remarkLineBreak` already turns each source `\n` into a `break{isInline:true}` → a `hardbreak`
// node with `isInline:true`, and serializes it back to exactly one `\n` (byte-exact). The bug was
// purely visual: commonmark's default toDOM renders the inline break as `<span> </span>` (a
// trailing space the browser collapses), so two lines LOOKED merged. Render every hardbreak as a
// real `<br>` instead. Parse + serialize are untouched, so the round-trip guard stays byte-exact —
// which is why this override is applied identically in the live editor AND the guard (md-roundtrip),
// exactly like `bulletListSpreadFix`.
export const softBreakFix = hardbreakSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    toDOM: (node: ProseNode) => ['br', ctx.get(hardbreakAttr.key)(node)]
  }
})

// E-002 (T-038) / E-013 (T-053) — Obsidian soft-break semantics, keymap half (live editor only;
// the guard never types). Split of the two keys (T-053, sanctioned revision of T-038's "Enter =
// soft break" model):
//   • Shift+Enter → inserts a single-`\n` soft break INSIDE the current paragraph (this command).
//   • Enter → a normal paragraph split (`\n\n`). We deliberately DON'T bind Enter here at all, so
//     it falls through to Milkdown's own keymaps: a list item splits into a new item
//     (`listItemKeymap`), a plain paragraph splits into a new paragraph (core `baseKeymap` →
//     `splitBlock`), headings/code keep their defaults. That gives every block its natural Enter
//     for free — the old code hijacked Enter even inside list-item paragraphs, so lists never got
//     a new item on Enter; this fixes that too.
//
// Rendering of existing single-`\n` soft breaks is untouched (softBreakFix still emits a real
// <br>), and serialization stays byte-exact: this command pins `isInline:true` so the break
// serializes to exactly one `\n`, never a two-space or backslash hard break. The guard never
// types, so it's unaffected. Priority 100 beats commonmark's default (50) Shift-Enter
// `hardbreakKeymap` (which would otherwise set the `hardbreak` meta → a backslash hard break).
const insertSoftBreak =
  (ctx: Ctx): Command =>
  (state, dispatch) => {
    const { selection, tr } = state
    if (!(selection instanceof TextSelection)) return false
    const { $from } = selection
    if ($from.parent.type.name !== 'paragraph') return false

    const hbType = hardbreakSchema.type(ctx)
    // Inline soft break (serializes to exactly one `\n`). We deliberately do NOT set commonmark's
    // `hardbreak` transaction meta: its `hardbreakClearMarkPlugin` reacts to that meta by resetting
    // the new node's attrs to defaults (`isInline:false`), which serializes as a backslash hard
    // break — exactly what the guard must never see. The table/code-block filter that meta also
    // drives is unnecessary here since this command only fires inside a paragraph.
    dispatch?.(tr.replaceSelectionWith(hbType.create({ isInline: true })).scrollIntoView())
    return true
  }

export const softBreakKeymap = $useKeymap('softBreak', {
  InsertSoftBreak: {
    shortcuts: ['Shift-Enter'],
    priority: 100,
    command: (ctx) => insertSoftBreak(ctx)
  }
})

// ── T-050: checkbox autocomplete (rendered mode) ───────────────────────────────
// Typing `[` at the very start of an EMPTY list item (i.e. right after `- ` / `* ` created the
// bullet list) turns that item into a GFM task item — the mirror of the raw-mode `- [` → `- [ ] `
// expansion. The `[` is NOT inserted; the list_item's `checked` attr is set to false, so the
// node view renders a real checkbox and the serializer writes `- [ ] `. A single ProseMirror
// transaction ⇒ one-step undo. Live editor only (the headless round-trip guard never types).
const checkboxRule = new InputRule(/^\[$/, (state) => {
  const { $from } = state.selection
  if ($from.parent.type.name !== 'paragraph' || $from.parent.content.size !== 0) return null
  const listItem = $from.node(-1)
  if (!listItem || listItem.type.name !== 'list_item') return null
  if (listItem.attrs.checked != null) return null // already a task item
  const pos = $from.before(-1)
  return state.tr.setNodeMarkup(pos, undefined, { ...listItem.attrs, checked: false })
})

export function checkboxInputRule(): Plugin {
  return inputRules({ rules: [checkboxRule] })
}

// ── T-152: em-dash auto-replacement (rendered mode) ─────────────────────────────
// Mirror of the CodeMirror `cm-emdash.ts` behavior for the ProseMirror/Milkdown editor: typing
// `--` then a BOUNDARY (space / Tab / Enter) replaces the `--` with an em-dash `—` (U+2014),
// prose contexts only (never a code_block node or an inline `code` mark; frontmatter is already
// stripped from this view). Read the toggle live via `isEnabled()`.
//
// Boundary handling matches Model C, with one engine nuance forced by Milkdown's own keymap:
//   • SPACE — fully owned in `handleTextInput`: one `closeHistory`-isolated transaction inserts
//     `—`+space and arms a cancellable pending state. Backspace as the very next key restores the
//     literal `-- `; Cmd+Z reverts the whole conversion in one step.
//   • TAB — fully owned in `handleKeyDown` (inserts `—`+`\t`), because Milkdown binds Tab to
//     SinkListItem: outside a list a native Tab would blur the editor, so we never delegate it.
//   • ENTER — seed-then-native: we dispatch the isolated `--`→`—` replacement and return false, so
//     Milkdown's own Enter (NextListItem / paragraph split) produces the line break as its own step.
const EM_DASH = '—'
const DASHES = '--'
const emDashKey = new PluginKey<number | null>('pomadeEmDash')

/** The `--` immediately before the (empty) selection is a real, convertible prose `--`. */
function emDashConvertible(state: EditorState): boolean {
  const sel = state.selection
  if (!sel.empty) return false
  const $from = sel.$from
  if ($from.parent.type.spec.code) return false // fenced / indented code block
  if ($from.parentOffset < 2) return false
  if ($from.parent.textBetween($from.parentOffset - 2, $from.parentOffset) !== DASHES) return false
  const codeMark = state.schema.marks.code
  if (codeMark && state.doc.rangeHasMark(sel.from - 2, sel.from, codeMark)) return false // inline code
  return true
}

/** Replace the `--` before the caret with `—`+`boundary`, isolated, arming the pending revert. */
function emDashConvert(view: EditorView, boundary: string): boolean {
  if (!emDashConvertible(view.state)) return false
  const from = view.state.selection.from
  const tr = view.state.tr.insertText(EM_DASH + boundary, from - 2, from)
  closeHistory(tr) // its own history step (Cmd+Z reverts the whole conversion in one)
  tr.setMeta(emDashKey, from) // pending caret sits right after `—`+boundary → `(from-2)+2 = from`
  view.dispatch(tr)
  return true
}

/** Seed just the `--`→`—` replacement (its own step), leaving the boundary to the native key. */
function emDashSeed(view: EditorView): void {
  if (!emDashConvertible(view.state)) return
  const from = view.state.selection.from
  const tr = view.state.tr.insertText(EM_DASH, from - 2, from)
  closeHistory(tr)
  view.dispatch(tr)
}

/** Backspace immediately after a `— ` conversion: restore the literal `-- ` (boundary kept). */
function emDashRevert(view: EditorView): boolean {
  const pending = emDashKey.getState(view.state)
  if (pending == null) return false
  const sel = view.state.selection
  if (!sel.empty || sel.head !== pending) return false
  const emStart = pending - 2 // `—` at [emStart, emStart+1], boundary at [emStart+1, pending]
  if (view.state.doc.textBetween(emStart, emStart + 1) !== EM_DASH) return false
  const tr = view.state.tr.insertText(DASHES, emStart, emStart + 1)
  tr.setSelection(TextSelection.create(tr.doc, pending + 1)) // grew by one char; caret after boundary
  closeHistory(tr)
  tr.setMeta(emDashKey, null)
  view.dispatch(tr)
  return true
}

export function emDashProsePlugin(isEnabled: () => boolean): Plugin {
  return new Plugin<number | null>({
    key: emDashKey,
    // The cancellable pending caret (space/Tab boundary): cleared by the next doc change or
    // selection move, so exactly one Backspace can take the conversion back.
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(emDashKey)
        if (meta !== undefined) return meta as number | null
        return tr.docChanged || tr.selectionSet ? null : value
      }
    },
    props: {
      handleTextInput(view, _from, _to, text) {
        if (text !== ' ') return false
        if (!isEnabled()) return false
        return emDashConvert(view, ' ')
      },
      handleKeyDown(view, event) {
        if (event.key === 'Backspace') return emDashRevert(view)
        if (!isEnabled()) return false
        if (event.key === 'Tab') return emDashConvert(view, '\t')
        if (event.key === 'Enter') {
          emDashSeed(view)
          return false // let Milkdown's own Enter run on the converted text as a separate step
        }
        return false
      }
    }
  })
}

// ── T-054: wikilink decoration (rendered mode) ─────────────────────────────────
// Purely a ProseMirror VIEW decoration — it adds a `.pm-wikilink` class to every `[[target]]` /
// `[[target|alias]]` text run so it reads as a link (styled in EditorPane.module.css with the same
// link token raw mode uses). Decorations never touch the document, so serialization stays
// byte-exact and the round-trip guard is unaffected — this plugin is used ONLY by the live editor
// (RenderedMarkdown), never by the headless guard (md-roundtrip).
const WIKILINK_RE = /\[\[[^[\]\n]+\]\]/g

function wikilinkDecorations(doc: ProseNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    WIKILINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = WIKILINK_RE.exec(node.text)) !== null) {
      const from = pos + m.index
      decos.push(Decoration.inline(from, from + m[0].length, { class: 'pm-wikilink' }))
    }
  })
  return DecorationSet.create(doc, decos)
}

export function wikilinkProsePlugin(): Plugin {
  return new Plugin({
    state: {
      init: (_config, state) => wikilinkDecorations(state.doc),
      apply: (tr, old) => (tr.docChanged ? wikilinkDecorations(tr.doc) : old)
    },
    props: {
      decorations(state) {
        return this.getState(state)
      }
    }
  })
}
