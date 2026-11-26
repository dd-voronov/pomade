// Pomade Wave 2c — a minimal CodeMirror 6 theme + syntax highlight built from the
// live tokens.css variables (single source of truth — no hardcoded hex here).

import {
  EditorView,
  Decoration,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'

/** Read a tokens.css variable's live value (exported for the E-024 live theme, which is
 *  built from the same single source of truth). */
export function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** The token-derived syntax HighlightStyle, shared by the raw editor theme and the E-024
 *  live view (whose fenced code blocks highlight through the same tags). */
export function buildHighlightStyle(): HighlightStyle {
  const text = token('--text', '#1f2933')
  const faint = token('--text-faint', '#8a99a6')
  const muted = token('--text-muted', '#5a6b7a')
  const accentActive = token('--accent-active', '#2f92b2')
  const ok = token('--ok', '#2f9e6f')
  const danger = token('--danger', '#d1495b')
  const warning = token('--warning', '#d98a1f')
  const syntaxProperty = token('--syntax-property', '#2b6cb0')
  const syntaxType = token('--syntax-type', '#8250df')
  const syntaxFunction = token('--syntax-function', '#5a3ec8')

  return HighlightStyle.define([
    { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: accentActive },
    { tag: [t.string, t.special(t.string)], color: ok },
    { tag: [t.number, t.bool, t.null], color: warning },
    { tag: [t.comment, t.lineComment, t.blockComment], color: faint, fontStyle: 'italic' },
    { tag: [t.propertyName, t.attributeName], color: syntaxProperty },
    { tag: [t.typeName, t.className, t.namespace], color: syntaxType },
    { tag: [t.function(t.variableName), t.definition(t.variableName)], color: syntaxFunction },
    { tag: [t.tagName], color: danger },
    { tag: [t.heading], color: text, fontWeight: '600' },
    { tag: [t.strong], fontWeight: '600' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.link, t.url], color: accentActive, textDecoration: 'underline' },
    { tag: [t.meta], color: muted },
    { tag: [t.invalid], color: danger }
  ])
}

/** Build the editor theme from tokens. Recomputed once per pane mount.
 *
 *  T-153 — `scrollerFont` is the `.cm-scroller` font-family; it defaults to the standard mono
 *  stack (today's look, and what the code viewer / diff view keep). RawEditor passes the user's
 *  "Editor font (raw)" selection here so prose can render in a proportional face; code-shaped
 *  regions are pinned back to mono independently (cm-mono-pin.ts). */
export function buildEditorTheme(scrollerFont?: string): Extension {
  const bg = token('--panel-raised', '#ffffff')
  const text = token('--text', '#1f2933')
  const muted = token('--text-muted', '#5a6b7a')
  const faint = token('--text-faint', '#8a99a6')
  const border = token('--border', '#e2e8ec')
  const borderStrong = token('--border-strong', '#cdd6dc')
  const panel = token('--panel', '#f1f4f6')
  const accent = token('--accent', '#4fb8d8')
  const accentActive = token('--accent-active', '#2f92b2')
  const selection = token('--selection', 'rgba(79, 184, 216, 0.18)')
  const accentTintStrong = token('--accent-tint-strong', 'rgba(79, 184, 216, 0.45)')
  const warningTintStrong = token('--warning-tint-strong', 'rgba(217, 138, 31, 0.28)')
  const font = scrollerFont ?? token('--font-mono', '"SF Mono", Menlo, monospace')

  const theme = EditorView.theme(
    {
      '&': {
        color: text,
        backgroundColor: bg,
        height: '100%',
        fontSize: '13px'
      },
      '.cm-scroller': {
        fontFamily: font,
        lineHeight: '1.55',
        overflow: 'auto',
        // T-138 — reserve the scrollbar gutter so the source view never reflows horizontally
        // when the vertical scrollbar appears/disappears. Matches the CSS-module scroll areas.
        scrollbarGutter: 'stable'
      },
      '.cm-content': {
        caretColor: accentActive,
        padding: '8px 0'
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: accentActive },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: selection },
      // T-180 exception: one-off internal CM decoration tints, not duplicated elsewhere in the
      // codebase (unlike the searchMatch tints below, which mirror EditorPane.module.css and are
      // now tokenized) — left as literals rather than minting single-use tokens.
      '.cm-activeLine': { backgroundColor: 'rgba(79, 184, 216, 0.07)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(79, 184, 216, 0.10)' },
      '.cm-gutters': {
        backgroundColor: panel,
        color: faint,
        border: 'none',
        borderRight: `1px solid ${border}`
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 8px 0 12px',
        minWidth: '2.5ch'
      },
      '.cm-foldPlaceholder': {
        backgroundColor: panel,
        border: `1px solid ${border}`,
        color: muted
      },
      // T-180 exception: same rationale as .cm-activeLine above (one-off, unduplicated tint).
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: 'rgba(79, 184, 216, 0.20)',
        outline: `1px solid ${accent}`
      },
      // ── E-001 (T-012): the @codemirror/search panel + match highlights, themed to tokens ──
      '.cm-panels': {
        backgroundColor: panel,
        color: text,
        borderBottom: `1px solid ${border}`
      },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${border}` },
      '.cm-search': {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 8px'
      },
      '.cm-search label': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        fontSize: '12px',
        color: muted
      },
      '.cm-textfield': {
        backgroundColor: bg,
        color: text,
        border: `1px solid ${borderStrong}`,
        borderRadius: '4px',
        padding: '3px 6px',
        // T-153 — the search field stays mono even when the prose scroller is proportional.
        fontFamily: token('--font-mono', '"SF Mono", Menlo, monospace'),
        fontSize: '12px'
      },
      '.cm-textfield:focus': {
        outline: 'none',
        borderColor: accent
      },
      '.cm-button': {
        backgroundColor: bg,
        backgroundImage: 'none',
        color: text,
        border: `1px solid ${borderStrong}`,
        borderRadius: '4px',
        padding: '3px 8px',
        fontSize: '12px',
        cursor: 'pointer'
      },
      '.cm-button:hover': { backgroundColor: panel },
      '.cm-panel.cm-search [name="close"]': {
        color: muted,
        cursor: 'pointer'
      },
      '.cm-searchMatch': {
        backgroundColor: warningTintStrong,
        borderRadius: '2px'
      },
      '.cm-searchMatch-selected': {
        backgroundColor: accentTintStrong
      },
      // ── T-054: `[[wikilink]]` styling parity — same link token as the syntax link tag below,
      // so a wikilink LOOKS like a link in raw mode too (decoration added by wikilinkHighlighter).
      '.cm-wikilink': { color: accentActive }
    },
    { dark: false }
  )

  return [theme, syntaxHighlighting(buildHighlightStyle())]
}

// ── T-054: wikilink decoration (raw mode) ──────────────────────────────────────
// Visual only — mark every `[[target]]` / `[[target|alias]]` run with `.cm-wikilink` so it reads
// as a link (styled via the token rule in the theme above). No navigation, no serialization
// impact; the underlying text is untouched. Mirrors the rendered-mode ProseMirror decoration.
const WIKILINK_RE = /\[\[[^[\]\n]+\]\]/g
const wikilinkMark = Decoration.mark({ class: 'cm-wikilink' })
const wikilinkMatcher = new MatchDecorator({ regexp: WIKILINK_RE, decoration: wikilinkMark })

export const wikilinkHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = wikilinkMatcher.createDeco(view)
    }
    update(update: ViewUpdate): void {
      this.decorations = wikilinkMatcher.updateDeco(update, this.decorations)
    }
  },
  { decorations: (v) => v.decorations }
)
