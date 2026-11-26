// Pomade E-024 — the LIVE view engine: a CodeMirror 6 decoration layer over the raw
// markdown source (the Obsidian architecture, minus its marker-reveal warts). The file IS
// the document — there is NO serializer anywhere on this path, so byte fidelity holds BY
// CONSTRUCTION: only the user's typed bytes ever change the buffer.
//
// The P-024 §4 contract this file implements (LOCKED, the Owner 2026-08-19):
//   • ZERO-REVEAL — hidden markup NEVER reveals itself, whatever the caret does. No
//     Obsidian-style `**`-flash, no layout shift on headings/links.
//   • ATOMIC MARKERS — the caret never lands inside a hidden marker pair. Hidden marker
//     runs are replace-decorations registered as atomic ranges (cursor motion skips them
//     whole) AND a transaction filter snaps any selection that would land inside one to its
//     nearest edge (covers mouse clicks / programmatic selections, which atomicRanges
//     doesn't).
//   • TYPING RAW SYNTAX WORKS — `**x**` folds the moment the pair closes in the parse;
//     unclosed markers are ordinary visible text (the lezer parser only emits emphasis
//     nodes for closed pairs, so this needs no special casing).
//   • BACKSPACE DELETES LETTERS, NOT MARKERS — deleting backward "through" a hidden marker
//     run deletes the letter beyond it (the rest stays styled); deleting the last letter
//     between a marker pair removes the now-empty pair with it, recursively for nested
//     constructs, so the buffer never holds an orphaned `**`/`****`. Forward delete
//     mirrors this. "Delete as a unit" applies only to atomic OBJECTS (horizontal rule,
//     image chip, a link's URL half) — those use widget decorations and the default atomic
//     behavior.
//
// Construct coverage is E-024's v1 list; everything unknown renders as plain text (a text
// editor can't fail to display text), which is the whole point of the architecture.

import {
  EditorState,
  Facet,
  Prec,
  RangeSet,
  findClusterBreak,
  type Extension,
  type Range
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import {
  LanguageDescription,
  ensureSyntaxTree,
  syntaxTree
} from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { MarkdownConfig } from '@lezer/markdown'
import type { SyntaxNode, Tree } from '@lezer/common'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { yaml } from '@codemirror/lang-yaml'

// ─── ==highlight== (Obsidian mark syntax) as a lezer inline extension ──────────
// Modeled on @lezer/markdown's own Strikethrough extension (`~~` → Strikethrough/
// StrikethroughMark): `==` delimiters resolve to Highlight/HighlightMark nodes. Only a
// CLOSED pair produces nodes — a lone `==` stays plain text, exactly like a lone `**`.
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

export const highlightExtension: MarkdownConfig = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark' }],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true)
      },
      after: 'Emphasis'
    }
  ]
}

// Fenced-code languages for the live view — built from the languages the app already
// ships (doc-kind.ts loads the same packages); no @codemirror/language-data dependency.
const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx', 'node'], load: async () => javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], load: async () => javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: 'json', load: async () => json() }),
  LanguageDescription.of({ name: 'css', load: async () => css() }),
  LanguageDescription.of({ name: 'html', alias: ['htm'], load: async () => html() }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], load: async () => yaml() })
]

/** The live view's markdown language: GFM (tables, task lists, strikethrough, autolinks)
 *  plus ==highlight==. HTML tag autocompletion and paste-URL-as-link are OFF — both write
 *  bytes the user didn't type, which the Live contract forbids. The bundled markdown keymap
 *  stays ON: Enter continues lists/quotes by COPYING the current marker (style-matched by
 *  construction) and Backspace deletes list markup levels. */
export function liveMarkdownLanguage(): Extension {
  return markdown({
    base: markdownLanguage,
    extensions: [highlightExtension],
    codeLanguages,
    completeHTMLTags: false,
    pasteURLAsLink: false
  })
}

// ─── Decoration building blocks ────────────────────────────────────────────────

// One shared instance per role so the backspace handler can tell hidden MARKER runs
// (skip-and-delete-letters semantics) apart from atomic OBJECT widgets (delete-as-a-unit).
const hiddenMarker = Decoration.replace({})

const inlineMark: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: 'cm-live-strong' }),
  Emphasis: Decoration.mark({ class: 'cm-live-em' }),
  Strikethrough: Decoration.mark({ class: 'cm-live-strike' }),
  Highlight: Decoration.mark({ class: 'cm-live-highlight' }),
  InlineCode: Decoration.mark({ class: 'cm-live-code' })
}

const headingLine: Record<number, Decoration> = {}
for (let level = 1; level <= 6; level++) {
  headingLine[level] = Decoration.line({ class: `cm-live-heading cm-live-h${level}` })
}
const setextMarkDeco = Decoration.mark({ class: 'cm-live-dim' })
const quoteLine = Decoration.line({ class: 'cm-live-quote' })
const tableLine = Decoration.line({ class: 'cm-live-table' })
const codeBlockLine = Decoration.line({ class: 'cm-live-codeblock' })
const fenceLine = Decoration.line({ class: 'cm-live-codeblock cm-live-fence' })

class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-live-hr'
    el.setAttribute('data-testid', 'live-hr')
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}
const hrDeco = Decoration.replace({ widget: new HrWidget() })

// ── Bullet: the `-`/`*`/`+` list mark renders as a proper bullet dot (replace-widget over
// the single marker char; the following space stays a real, visible character). ──
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-live-bullet'
    el.textContent = '•'
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}
const bulletDeco = Decoration.replace({ widget: new BulletWidget() })
const orderedMarkDeco = Decoration.mark({ class: 'cm-live-list-mark' })
const linkTextMark = Decoration.mark({ class: 'cm-live-link' })

// ── Task checkbox: `- [ ]`/`- [x]` (bullet + marker) renders as ONE clickable checkbox
// widget. A click writes the ONE-CHAR diff at the marker's state character — the exact
// contract the rendered view's checkbox keeps (T-016), now serializer-free. ──
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** Doc offset of the state char between the brackets ('x'/'X'/' '). */
    readonly statePos: number
  ) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.statePos === this.statePos
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-live-checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete')
    box.setAttribute('data-testid', 'live-task-checkbox')
    // Don't let the click move the selection or start a drag.
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('change', () => {
      // Re-verify against the LIVE doc — the widget may outlive edits around it.
      const ch = view.state.doc.sliceString(this.statePos, this.statePos + 1)
      if (ch !== ' ' && ch.toLowerCase() !== 'x') return
      view.dispatch({
        changes: { from: this.statePos, to: this.statePos + 1, insert: box.checked ? 'x' : ' ' },
        userEvent: 'input.toggle'
      })
      // The mousedown was prevented (no selection move), so the editor never took focus —
      // take it back here or the very next Cmd+S would fall outside the pane.
      view.focus()
    })
    return box
  }
  ignoreEvent(): boolean {
    return true
  }
}

// ── Image chip: `![alt](target)` renders as a compact atomic 🖼 chip with the filename;
// a click opens the image via the pane-provided callback (EditorPane routes it: http(s) →
// default browser, local → the image's own doc tab). Real embeds are a later slice. ──
export const openImageTarget = Facet.define<(target: string) => void>()

function imageLabel(target: string, alt: string): string {
  const clean = target.split(/[?#]/)[0]
  const base = clean.slice(clean.lastIndexOf('/') + 1)
  return base || alt || target
}

class ImageChipWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly alt: string
  ) {
    super()
  }
  eq(other: ImageChipWidget): boolean {
    return other.target === this.target && other.alt === this.alt
  }
  toDOM(view: EditorView): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'cm-live-image-chip'
    chip.setAttribute('data-testid', 'live-image-chip')
    chip.title = this.target
    const icon = document.createElement('span')
    icon.textContent = '🖼'
    const name = document.createElement('span')
    name.textContent = imageLabel(this.target, this.alt)
    chip.append(icon, name)
    chip.addEventListener('mousedown', (e) => e.preventDefault())
    chip.addEventListener('click', (e) => {
      e.preventDefault()
      view.state.facet(openImageTarget)[0]?.(this.target)
    })
    return chip
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** Marker node names the live view hides. Kept in one set so the caret-snap filter and the
 *  decoration builder can never disagree about what counts as "hidden markup". */
const HIDDEN_MARK_NODES = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'HighlightMark'])

interface BuiltDecorations {
  decorations: DecorationSet
  /** Hidden marker runs only — the ranges backspace "deletes letters through". */
  markers: DecorationSet
  /** Everything cursor motion must treat as one unit: markers + object widgets. */
  atomics: DecorationSet
}

function buildDecorations(state: EditorState): BuiltDecorations {
  const doc = state.doc
  // Prefer a complete tree (bounded work); fall back to whatever has parsed — the plugin
  // rebuilds when the parser finishes (tree identity changes on a later update).
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state)

  const deco: Range<Decoration>[] = []
  const markers: Range<Decoration>[] = []
  const objects: Range<Decoration>[] = []

  const hideMarker = (from: number, to: number): void => {
    if (to <= from) return
    deco.push(hiddenMarker.range(from, to))
    markers.push(hiddenMarker.range(from, to))
  }
  // Hidden like a marker but atomic like an OBJECT: cursor motion skips it whole, and
  // Backspace does NOT tunnel through it to a letter beyond (block markup like `> ` is
  // deleted level-by-level by the markdown keymap's deleteMarkupBackward instead).
  const hideObject = (from: number, to: number): void => {
    if (to <= from) return
    deco.push(hiddenMarker.range(from, to))
    objects.push(hiddenMarker.range(from, to))
  }
  const objectWidget = (from: number, to: number, d: Decoration): void => {
    deco.push(d.range(from, to))
    objects.push(d.range(from, to))
  }
  const lineDecosFor = (from: number, to: number, d: Decoration, headOnly = false): void => {
    let line = doc.lineAt(from)
    for (;;) {
      deco.push(d.range(line.from))
      if (headOnly || line.to >= to) break
      line = doc.lineAt(line.to + 1)
    }
  }

  tree.iterate({
    from: 0,
    to: doc.length,
    enter: (n) => {
      const name = n.name

      // Styled-source containers: style the lines, then DON'T descend — inline markers
      // inside must stay visible text (v1 renders these as source, never widgets).
      if (name === 'Table') {
        lineDecosFor(n.from, n.to, tableLine)
        return false
      }
      if (name === 'FencedCode' || name === 'CodeBlock') {
        const first = doc.lineAt(n.from)
        const last = doc.lineAt(n.to)
        for (let ln = first.number; ln <= last.number; ln++) {
          const line = doc.line(ln)
          const isFence =
            name === 'FencedCode' && (ln === first.number || /^\s*(```|~~~)/.test(line.text))
          deco.push((isFence ? fenceLine : codeBlockLine).range(line.from))
        }
        return false
      }

      // Headings: style the line by level; hide the ATX `#…` run (+ its separating space)
      // and any closing run (+ its preceding space). Setext underlines stay visible, dimmed
      // (hiding a whole line would shift layout — exactly what zero-reveal forbids).
      if (name.startsWith('ATXHeading')) {
        const level = Number(name.slice('ATXHeading'.length)) || 1
        lineDecosFor(n.from, n.to, headingLine[level], true)
        return true
      }
      if (name.startsWith('SetextHeading')) {
        const level = name.endsWith('1') ? 1 : 2
        lineDecosFor(n.from, n.to, headingLine[level], true)
        return true
      }
      if (name === 'HeaderMark') {
        const parent = n.node.parent
        if (parent && parent.name.startsWith('ATXHeading')) {
          let from = n.from
          let to = n.to
          if (doc.sliceString(to, to + 1) === ' ') to += 1 // opening `# ` — the space goes too
          else if (doc.sliceString(from - 1, from) === ' ') from -= 1 // closing ` #`
          hideMarker(from, to)
        } else {
          deco.push(setextMarkDeco.range(n.from, n.to))
        }
        return true
      }

      if (name === 'HorizontalRule') {
        objectWidget(n.from, n.to, hrDeco)
        return true
      }

      // Blockquotes (incl. Obsidian callouts, which are plain blockquotes in v1): hide the
      // `> ` markers, style the quoted lines with the border/color the rendered view uses.
      if (name === 'Blockquote') {
        lineDecosFor(n.from, n.to, quoteLine)
        return true
      }
      if (name === 'QuoteMark') {
        // `> ` — the marker plus its conventional following space.
        const to = doc.sliceString(n.to, n.to + 1) === ' ' ? n.to + 1 : n.to
        hideObject(n.from, to)
        return true
      }

      // Lists. A bullet's `-`/`*`/`+` renders as a • widget; an ordered item's `1.` stays
      // real (editable) text, tinted. A TASK item's bullet + `[ ]` render as ONE clickable
      // checkbox widget (handled at the Task node below — its ListMark is skipped here).
      // Every item's first line gets a hanging indent so wrapped text aligns under itself.
      if (name === 'ListItem') {
        const markChild = n.node.getChild('ListMark')
        if (markChild) {
          const line = doc.lineAt(n.from)
          const cols = markChild.to + 1 - line.from
          deco.push(
            Decoration.line({
              class: 'cm-live-li',
              attributes: { style: `text-indent:-${cols}ch;padding-inline-start:${cols}ch;` }
            }).range(line.from)
          )
        }
        return true
      }
      if (name === 'ListMark') {
        const item = n.node.parent
        if (item?.getChild('Task')) return true // the Task widget swallows the bullet
        const isBullet = /[-*+]/.test(doc.sliceString(n.from, n.to))
        if (isBullet && n.to - n.from === 1) objectWidget(n.from, n.to, bulletDeco)
        else deco.push(orderedMarkDeco.range(n.from, n.to))
        return true
      }
      if (name === 'Task') {
        const marker = n.node.getChild('TaskMarker')
        if (marker) {
          const item = n.node.parent
          const listMark = item?.getChild('ListMark')
          const from = listMark ? listMark.from : marker.from
          const checked = /x/i.test(doc.sliceString(marker.from + 1, marker.to - 1))
          objectWidget(from, marker.to, Decoration.replace({ widget: new CheckboxWidget(checked, marker.from + 1) }))
        }
        return true
      }
      if (name === 'TaskMarker') return true // consumed by the Task widget above

      // Regular links `[text](url)` — E-024 v1 contract: the TEXT shows link-styled and
      // edits letter-by-letter; `[` and the whole `](url…)` tail are hidden markers (the
      // URL half only ever changes through the click-popover or disappears with the whole
      // link — never letter-edited in the buffer). Reference-style `[text][ref]` and
      // autolinks keep their visible source, link-styled.
      if (name === 'Link') {
        const node = n.node
        const linkMarks = node.getChildren('LinkMark')
        const url = node.getChild('URL')
        deco.push(linkTextMark.range(n.from, n.to))
        if (url && linkMarks.length >= 2) {
          hideMarker(linkMarks[0].from, linkMarks[0].to) // `[`
          hideMarker(linkMarks[1].from, n.to) // `](url "title")`
        }
        return true
      }

      // Images: the whole `![alt](target)` becomes a compact atomic chip.
      if (name === 'Image') {
        const node = n.node
        const urlChild = node.getChild('URL')
        const target = urlChild ? doc.sliceString(urlChild.from, urlChild.to) : ''
        // Alt text = what sits between `![` and `]`.
        const alt = /^!\[([^\]]*)\]/.exec(doc.sliceString(n.from, n.to))?.[1] ?? ''
        objectWidget(n.from, n.to, Decoration.replace({ widget: new ImageChipWidget(target, alt) }))
        return false
      }

      // Inline emphasis family: style the content, hide the marker runs (atomic).
      const mark = inlineMark[name]
      if (mark) {
        deco.push(mark.range(n.from, n.to))
        return true
      }
      if (HIDDEN_MARK_NODES.has(name)) {
        hideMarker(n.from, n.to)
        return true
      }
      return true
    }
  })

  const markerSet = Decoration.set(markers, true)
  const objectSet = Decoration.set(objects, true)
  return {
    decorations: Decoration.set(deco, true),
    markers: markerSet,
    // Cursor motion treats markers AND object widgets as atoms.
    atomics: RangeSet.join([markerSet, objectSet]) as DecorationSet
  }
}

// ─── The view plugin ────────────────────────────────────────────────────────────

class LivePreviewPlugin {
  decorations: DecorationSet
  markers: DecorationSet
  atomics: DecorationSet
  private tree: Tree

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state)
    const built = buildDecorations(view.state)
    this.decorations = built.decorations
    this.markers = built.markers
    this.atomics = built.atomics
  }

  update(u: ViewUpdate): void {
    const tree = syntaxTree(u.state)
    // Rebuild whenever the document OR the parse changed — the tree keeps arriving after
    // the transaction for larger docs, and folding must follow the parse, not the keystroke.
    if (!u.docChanged && tree === this.tree) return
    this.tree = tree
    const built = buildDecorations(u.state)
    this.decorations = built.decorations
    this.markers = built.markers
    this.atomics = built.atomics
  }
}

const livePlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (v) => v.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomics ?? Decoration.none)
})

// ─── Caret containment (the atomic-markers invariant, click-proof) ──────────────
// atomicRanges only governs cursor MOTION; a mouse click (or a programmatic setSelection)
// can still resolve to a position strictly inside a hidden marker run. This filter snaps
// such a caret to the nearest marker edge, so the invariant holds for EVERY entry path.
// Resolved from the syntax tree (not the plugin's ranges) so the filter needs no view.
function snapOutOfMarkers(state: EditorState, pos: number): number {
  const node = syntaxTree(state).resolveInner(pos, 0)
  let cur: SyntaxNode | null = node
  while (cur) {
    if (HIDDEN_MARK_NODES.has(cur.name) && pos > cur.from && pos < cur.to) {
      return pos - cur.from <= cur.to - pos ? cur.from : cur.to
    }
    // A regular link's hidden `](url…)` tail: snap to the end of the link TEXT (its inner
    // edge) or past the whole link, whichever is nearer — never inside the tail.
    if (cur.name === 'Link') {
      const marks = cur.getChildren('LinkMark')
      if (cur.getChild('URL') && marks.length >= 2) {
        const tailFrom = marks[1].from
        if (pos > tailFrom && pos < cur.to) {
          return pos - tailFrom <= cur.to - pos ? tailFrom : cur.to
        }
      }
    }
    cur = cur.parent
  }
  return pos
}

const caretSnapFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.selection) return tr
  const sel = tr.newSelection.main
  if (!sel.empty) return tr
  const snapped = snapOutOfMarkers(tr.state, sel.head)
  if (snapped === sel.head) return tr
  return [tr, { selection: { anchor: snapped }, sequential: true }]
})

// ─── Backspace / forward-delete through hidden markers ──────────────────────────
// Slice-1 subset of the P-024 §4 semantics: deleting "through" a hidden marker run deletes
// the LETTER beyond it — never the marker bytes (the default atomic behavior would delete
// the whole `**` run, orphaning its partner). The empty-pair removal half (deleting the
// last letter takes the now-empty pair with it) lands with the editing-semantics slice.

/** Chain-skip hidden marker runs that END exactly at `pos`, returning the position before
 *  the run(s) — or `pos` when none touches it. */
function skipMarkersBack(markers: DecorationSet, pos: number): number {
  let target = pos
  for (;;) {
    let next: number | null = null
    markers.between(0, target, (from, to) => {
      if (to === target && from < to) next = from
    })
    if (next === null) return target
    target = next
  }
}

function skipMarkersForward(markers: DecorationSet, pos: number, docLen: number): number {
  let target = pos
  for (;;) {
    let next: number | null = null
    markers.between(target, docLen, (from, to) => {
      if (from === target && to > from) next = to
    })
    if (next === null) return target
    target = next
  }
}

// ── Empty-construct removal (P-024 §4: "deleting the last character between the markers
// removes the now-empty marker pair with it — the buffer never holds an orphaned pair").
// Given the letter range about to be deleted, expand it to every enclosing construct whose
// TEXT content the deletion empties, recursively outward — so deleting the last letter of
// the innermost of `**_a_**` takes `_…_` AND `**…**` in one transaction. Currently covers
// regular links (`[a](url)` → whole link goes with its last letter); the editing-semantics
// slice extends the set to the emphasis family.
const markerPairRange =
  (markName: string) =>
  (node: SyntaxNode): { from: number; to: number } | null => {
    const marks = node.getChildren(markName)
    if (marks.length < 2) return null
    return { from: marks[0].to, to: marks[marks.length - 1].from }
  }

const EXPANDABLE_TEXT_RANGE: Record<string, (node: SyntaxNode) => { from: number; to: number } | null> = {
  Link: (node) => {
    const marks = node.getChildren('LinkMark')
    if (!node.getChild('URL') || marks.length < 2) return null
    return { from: marks[0].to, to: marks[1].from }
  },
  // The emphasis family (P-024 §4 verbatim): deleting the last character between the
  // markers removes the now-empty pair with it. The parent-walk makes it recursive, so
  // emptying the innermost of `**_a_**` takes `_…_` AND `**…**` in one change — the buffer
  // never holds an orphaned `**`/`****`.
  StrongEmphasis: markerPairRange('EmphasisMark'),
  Emphasis: markerPairRange('EmphasisMark'),
  Strikethrough: markerPairRange('StrikethroughMark'),
  Highlight: markerPairRange('HighlightMark'),
  InlineCode: markerPairRange('CodeMark')
}

function expandDeletion(state: EditorState, from: number, to: number): { from: number; to: number } {
  let cur: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1)
  let out = { from, to }
  while (cur) {
    const textRange = EXPANDABLE_TEXT_RANGE[cur.name]?.(cur)
    if (textRange) {
      const removed =
        Math.min(out.to, textRange.to) - Math.max(out.from, textRange.from)
      const remaining = textRange.to - textRange.from - Math.max(0, removed)
      if (remaining <= 0) out = { from: cur.from, to: cur.to }
    }
    cur = cur.parent
  }
  return out
}

/** Grapheme-cluster-aware "one character before/after `pos`" (never splits a surrogate
 *  pair / emoji cluster; a line boundary is the single `\n`). */
function charBefore(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  if (pos === line.from) return pos - 1 // the newline
  return line.from + findClusterBreak(line.text, pos - line.from, false)
}
function charAfter(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos)
  if (pos === line.to) return pos + 1 // the newline
  return line.from + findClusterBreak(line.text, pos - line.from, true)
}

const liveDeleteKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Backspace',
      run: (view) => {
        const sel = view.state.selection.main
        if (!sel.empty) return false
        const plugin = view.plugin(livePlugin)
        if (!plugin) return false
        const target = skipMarkersBack(plugin.markers, sel.head)
        const tunneled = target !== sel.head
        if (target === 0) return tunneled // hidden pair at doc start: consume, delete nothing
        const from = charBefore(view.state, target)
        const range = expandDeletion(view.state, from, target)
        // Plain letter, no construct emptied, no marker tunneled → the DEFAULT chain owns it
        // (deleteMarkupBackward for list/quote markup, char merges, etc.).
        if (!tunneled && range.from === from && range.to === target) return false
        view.dispatch({
          changes: { from: range.from, to: range.to },
          selection: { anchor: range.from },
          scrollIntoView: true,
          userEvent: 'delete.backward'
        })
        return true
      }
    },
    {
      key: 'Delete',
      run: (view) => {
        const sel = view.state.selection.main
        if (!sel.empty) return false
        const plugin = view.plugin(livePlugin)
        if (!plugin) return false
        const docLen = view.state.doc.length
        const target = skipMarkersForward(plugin.markers, sel.head, docLen)
        const tunneled = target !== sel.head
        if (target >= docLen) return tunneled
        const to = charAfter(view.state, target)
        const range = expandDeletion(view.state, target, to)
        if (!tunneled && range.from === target && range.to === to) return false
        view.dispatch({
          changes: { from: range.from, to: range.to },
          selection: { anchor: range.from },
          scrollIntoView: true,
          userEvent: 'delete.forward'
        })
        return true
      }
    }
  ])
)

// ─── Style-matched formatting commands (P-024 §5 — kills convention-mixing) ─────
// Cmd+B / Cmd+I write markers matching the DOCUMENT's detected convention: a `_`-flavored
// doc gets `__…__` / `_…_`; Pomade's `**`/`*` only when the doc carries no signal. With the
// caret/selection inside an existing construct of the kind, the command toggles it OFF
// (markers deleted — the only sanctioned way to edit markers, which are atomic).

/** Count the doc's emphasis-marker flavor. `_` wins only on a real majority — no signal
 *  (or a tie) falls back to Pomade's `*` convention. */
export function emphasisConvention(state: EditorState): { strong: string; em: string } {
  let underscore = 0
  let star = 0
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === 'EmphasisMark') {
        const ch = state.doc.sliceString(n.from, n.from + 1)
        if (ch === '_') underscore++
        else if (ch === '*') star++
      }
    }
  })
  return underscore > star ? { strong: '__', em: '_' } : { strong: '**', em: '*' }
}

const toggleInline =
  (kind: 'strong' | 'em') =>
  (view: EditorView): boolean => {
    const state = view.state
    const sel = state.selection.main
    const nodeName = kind === 'strong' ? 'StrongEmphasis' : 'Emphasis'
    // Toggle OFF: the caret/selection sits inside a construct of this kind → delete its
    // marker pair (the text stays; nested constructs are untouched).
    let cur: SyntaxNode | null = syntaxTree(state).resolveInner(sel.from, 1)
    while (cur) {
      if (cur.name === nodeName && cur.from <= sel.from && cur.to >= sel.to) {
        const marks = cur.getChildren('EmphasisMark')
        if (marks.length >= 2) {
          const first = marks[0]
          const last = marks[marks.length - 1]
          view.dispatch({
            changes: [
              { from: first.from, to: first.to },
              { from: last.from, to: last.to }
            ],
            scrollIntoView: true,
            userEvent: 'delete'
          })
          return true
        }
      }
      cur = cur.parent
    }
    // Wrap: the selection, or the word at the caret. No word → consume (nothing to format;
    // inserting a bare empty pair would plant unclosed-marker junk in the buffer).
    let { from, to } = sel
    if (from === to) {
      const word = state.wordAt(from)
      if (!word) return true
      from = word.from
      to = word.to
    }
    const conv = emphasisConvention(state)
    const marker = kind === 'strong' ? conv.strong : conv.em
    view.dispatch({
      changes: [
        { from, insert: marker },
        { from: to, insert: marker }
      ],
      scrollIntoView: true,
      userEvent: 'input'
    })
    return true
  }

const liveFormatKeymap = keymap.of([
  { key: 'Mod-b', run: toggleInline('strong'), preventDefault: true },
  { key: 'Mod-i', run: toggleInline('em'), preventDefault: true }
])

// ─── Link click → URL popover (E-024: the URL is NEVER inline-revealed) ─────────
// Clicking anywhere in a link's visible text reports the link to the pane, which shows a
// popover (read + edit + open). The URL range is snapshotted at click time; the editor
// (LiveEditor) re-verifies it against the live doc before writing an edit back.

export interface LiveLinkHit {
  /** The URL as currently written in the source. */
  url: string
  /** Doc range of the URL text (empty range = `[text]()` — insert at `from`). */
  urlFrom: number
  urlTo: number
  /** Viewport coordinates of the click, for anchoring the popover. */
  x: number
  y: number
}

export function linkClickHandler(onLinkClick: (hit: LiveLinkHit) => void): Extension {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      // A Cmd+click is navigation, owned by the T-184 link layer (it opens the href on mousedown);
      // the popover is the PLAIN-click affordance only, so the two never both fire.
      if (event.metaKey) return false
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos == null) return false
      let cur: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 0)
      while (cur && cur.name !== 'Link') cur = cur.parent
      if (!cur) return false
      const url = cur.getChild('URL')
      const marks = cur.getChildren('LinkMark')
      if (marks.length < 2) return false
      // `[text]()` has no URL node — offer insertion right after the `(` mark.
      const urlFrom = url ? url.from : marks.length >= 3 ? marks[2].to : -1
      if (urlFrom < 0) return false
      const urlTo = url ? url.to : urlFrom
      onLinkClick({
        url: url ? view.state.doc.sliceString(url.from, url.to) : '',
        urlFrom,
        urlTo,
        x: event.clientX,
        y: event.clientY
      })
      return false // the caret still lands in the text — editing stays letter-by-letter
    }
  })
}

/** The complete live-preview decoration layer (language NOT included — see
 *  liveMarkdownLanguage). */
export function livePreview(): Extension {
  return [livePlugin, caretSnapFilter, liveDeleteKeymap, liveFormatKeymap]
}
