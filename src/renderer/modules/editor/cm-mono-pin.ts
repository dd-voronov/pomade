// Pomade T-153 — RAW editor: pin code-shaped regions to the standard mono stack.
//
// When the "Editor font (raw)" setting picks a PROPORTIONAL face, prose renders in it but
// code-shaped regions must stay monospace and internally aligned — the inverse of the Live
// view's pattern (Live is proportional and pins code to mono). Pinned regions:
//   • fenced + indented code blocks   (FencedCode / CodeBlock nodes → line decorations)
//   • markdown tables                 (Table node → line decorations across all rows)
//   • inline code                     (InlineCode node → mark decoration)
//   • YAML frontmatter                (no parser node — derived from bodyStartOffset)
//
// The pin sets `font-family: var(--font-mono)` (the token, NOT the selected font) so pinned
// regions are the standard mono regardless of the prose selection. Table nodes only exist under
// the GFM parser, which is why raw's markdown language switched from CommonMark to GFM (doc-kind).
//
// STABILITY (editor-spellcheck-stability.spec): decorations are rebuilt ONLY when the document
// or the parse changed (doc-change-keyed, tree-identity-keyed) — never on caret movement — so an
// unchanged line's text nodes keep their identity and Chromium's spell markers survive. Same
// guard the Live plugin uses.

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Extension, type Range } from '@codemirror/state'
import type { Tree } from '@lezer/common'

import { bodyStartOffset } from './caret-anchor'

const monoLine = Decoration.line({ class: 'cm-mono-pin' })
const monoInline = Decoration.mark({ class: 'cm-mono-pin-inline' })

// Frontmatter can only sit at the very top; scanning a bounded prefix avoids a full doc.toString
// on every rebuild (a frontmatter block larger than this is not a real document).
const FRONTMATTER_SCAN_MAX = 64 * 1024

function buildMonoPins(state: EditorState): DecorationSet {
  const doc = state.doc
  const ranges: Range<Decoration>[] = []

  const pinLines = (from: number, to: number): void => {
    let line = doc.lineAt(from)
    for (;;) {
      ranges.push(monoLine.range(line.from))
      if (line.to >= to || line.to + 1 > doc.length) break
      line = doc.lineAt(line.to + 1)
    }
  }

  // Frontmatter (no syntax node) — pin every line of the leading YAML block.
  const bodyFrom = bodyStartOffset(doc.sliceString(0, Math.min(doc.length, FRONTMATTER_SCAN_MAX)))
  if (bodyFrom > 0) pinLines(0, bodyFrom - 1)

  syntaxTree(state).iterate({
    from: 0,
    to: doc.length,
    enter: (n) => {
      const name = n.name
      if (name === 'FencedCode' || name === 'CodeBlock' || name === 'Table') {
        pinLines(n.from, n.to)
        return false // inner nodes inherit the pinned line; no need to descend
      }
      if (name === 'InlineCode') {
        ranges.push(monoInline.range(n.from, n.to))
        return false
      }
      return true
    }
  })

  return Decoration.set(ranges, true)
}

class MonoPinPlugin {
  decorations: DecorationSet
  private tree: Tree

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state)
    this.decorations = buildMonoPins(view.state)
  }

  update(u: ViewUpdate): void {
    const tree = syntaxTree(u.state)
    // Rebuild only when the document OR the parse changed (the tree keeps arriving after the
    // transaction for larger docs). NEVER on a bare selection/caret change — that is the
    // spellcheck-stability invariant.
    if (!u.docChanged && tree === this.tree) return
    this.tree = tree
    this.decorations = buildMonoPins(u.state)
  }
}

const monoPinTheme = EditorView.theme({
  '.cm-mono-pin': { fontFamily: 'var(--font-mono)' },
  '.cm-mono-pin-inline': { fontFamily: 'var(--font-mono)' }
})

/** The raw-editor mono-pin layer. Include ONLY for markdown files whose editor font is
 *  proportional — a mono selection needs no pinning (everything is already mono). */
export function monoPin(): Extension {
  return [ViewPlugin.fromClass(MonoPinPlugin, { decorations: (v) => v.decorations }), monoPinTheme]
}
