// Pomade E-024 — the LIVE view's CodeMirror theme, built from the live tokens.css
// variables (same single-source-of-truth discipline as cm-theme.ts). The live view must
// READ like the Milkdown rendered view — prose font, 82ch measure, the same heading
// scale / code chip / quote border — while remaining a plain text editor underneath.
//
// Layout note: unlike the raw editor (whose CodeMirror owns its scroller), the live view
// grows to its natural height and scrolls in an OUTER container (.liveScroll), exactly the
// architecture the rendered view uses — that is what lets the properties panel share one
// scroll with the body (E-013 Obsidian-style).

import { EditorView } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

import { buildHighlightStyle, token } from './cm-theme'

/** Build the live-view theme. Recomputed once per pane mount (token snapshot). */
export function buildLiveTheme(): Extension {
  const bg = token('--panel-raised', '#ffffff')
  const text = token('--text', '#1f2933')
  const muted = token('--text-muted', '#5a6b7a')
  const faint = token('--text-faint', '#8a99a6')
  const border = token('--border', '#e2e8ec')
  const panel = token('--panel', '#f1f4f6')
  const accent = token('--accent', '#4fb8d8')
  const accentActive = token('--accent-active', '#2f92b2')
  const selection = token('--selection', 'rgba(79, 184, 216, 0.18)')
  const warningSoft = token('--warning-soft', 'rgba(217, 138, 31, 0.14)')
  const fontUi = token('--font-ui', '-apple-system, system-ui, sans-serif')
  const fontMono = token('--font-mono', '"SF Mono", Menlo, monospace')

  const theme = EditorView.theme(
    {
      '&': {
        color: text,
        backgroundColor: bg,
        // Natural height — the outer .liveScroll owns scrolling (rendered-view parity).
        height: 'auto',
        fontSize: '14px'
      },
      '.cm-scroller': {
        fontFamily: fontUi,
        lineHeight: '1.65',
        overflow: 'visible'
      },
      '.cm-content': {
        caretColor: accentActive,
        padding: 'var(--space-5) var(--space-6)',
        maxWidth: '82ch',
        margin: '0 auto'
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: accentActive },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: selection },

      // ── Headings (Milkdown scale parity) ──
      '.cm-live-heading': { fontWeight: '600', lineHeight: '1.3' },
      '.cm-live-h1': {
        fontSize: '1.7em',
        paddingBottom: '0.2em',
        borderBottom: `1px solid ${border}`
      },
      '.cm-live-h2': { fontSize: '1.4em' },
      '.cm-live-h3': { fontSize: '1.15em' },
      '.cm-live-h4, .cm-live-h5, .cm-live-h6': { fontSize: '1em' },

      // ── Inline constructs ──
      '.cm-live-strong': { fontWeight: '600' },
      '.cm-live-em': { fontStyle: 'italic' },
      '.cm-live-strike': { textDecoration: 'line-through' },
      '.cm-live-highlight': { backgroundColor: warningSoft, borderRadius: '2px' },
      '.cm-live-code': {
        fontFamily: fontMono,
        fontSize: '0.9em',
        backgroundColor: panel,
        padding: '1px var(--space-1)',
        borderRadius: 'var(--radius-sm)'
      },
      '.cm-live-dim': { color: faint },

      // ── Blocks ──
      '.cm-live-codeblock': {
        fontFamily: fontMono,
        fontSize: '0.9em',
        backgroundColor: panel
      },
      '.cm-live-fence': { color: faint },
      '.cm-live-table': {
        fontFamily: fontMono,
        fontSize: '0.85em',
        backgroundColor: panel
      },
      '.cm-live-quote': {
        borderLeft: `3px solid ${accent}`,
        paddingLeft: 'var(--space-3)',
        color: muted
      },

      // ── Atomic objects ──
      '.cm-live-hr': {
        display: 'inline-block',
        width: '100%',
        verticalAlign: 'middle',
        borderTop: `1px solid ${border}`
      },
      '.cm-live-bullet': { color: accentActive },
      '.cm-live-list-mark': { color: accentActive },
      '.cm-live-checkbox': {
        margin: '0 0.45em 0 0',
        verticalAlign: 'text-top',
        width: '1em',
        height: '1em',
        cursor: 'pointer',
        accentColor: accent
      },
      '.cm-live-image-chip': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35em',
        maxWidth: '32ch',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        padding: '0 var(--space-2)',
        border: `1px solid ${border}`,
        borderRadius: 'var(--radius-sm)',
        backgroundColor: panel,
        color: muted,
        fontSize: '0.9em',
        cursor: 'pointer',
        verticalAlign: 'baseline'
      },

      // ── Links ──
      '.cm-live-link': { color: accentActive, cursor: 'pointer' },
      '.cm-wikilink': { color: accentActive }
    },
    { dark: false }
  )

  return [theme, syntaxHighlighting(buildHighlightStyle())]
}
