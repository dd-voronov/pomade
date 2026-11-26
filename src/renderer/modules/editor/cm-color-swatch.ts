// Pomade E-019 · T-067 / T-068 — inline color swatches in the raw CodeMirror editor.
//
// A small VS Code-style square sits immediately BEFORE every valid color code.
// Implemented as a MatchDecorator over the universal regex
// detector in color-codes.ts + a `Decoration.widget` (the repo's first widget decoration) —
// so it works in every text format, including `.txt`/unknown extensions that load no language
// extension at all. Scoping is automatic: RawEditor is the only mount site, so rendered
// markdown and the CSV table never see a swatch.
//
// T-068: clicking a swatch calls `onOpen` with the live document range of that code plus the
// swatch's viewport rect, which RawEditor turns into an anchored picker popup. The range is
// RE-RESOLVED from the DOM at click time (`posAtDOM` + a re-scan of the line) rather than
// captured at decoration time, so it can't drift after edits.

import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'

import { colorCodeRegexp, parseColorCode, toCssColor, toHexKey, type ParsedColor } from './color-codes'

/** A resolved color code in the document. */
export interface ColorHit {
  from: number
  to: number
  text: string
  parsed: ParsedColor
}

/** What RawEditor needs to open the picker: the hit + where the swatch is on screen. */
export interface ColorSwatchOpen extends ColorHit {
  rect: DOMRect
}

/**
 * Resolve the color code at (or immediately next to) `pos`. `preferText` — the code the clicked
 * swatch was rendered for — is used as a fallback anchor if the position lookup is off.
 */
export function findColorAt(state: EditorState, pos: number, preferText?: string): ColorHit | null {
  const line = state.doc.lineAt(pos)
  const re = colorCodeRegexp()
  const hits: ColorHit[] = []
  for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
    const parsed = parseColorCode(m[0])
    if (!parsed) continue
    const from = line.from + m.index
    hits.push({ from, to: from + m[0].length, text: m[0], parsed })
  }
  if (hits.length === 0) return null
  const near = hits.filter((h) => Math.abs(h.from - pos) <= 2)
  const pool = near.length > 0 ? near : preferText ? hits.filter((h) => h.text === preferText) : []
  if (pool.length === 0) return null
  return pool.reduce((best, h) => (Math.abs(h.from - pos) < Math.abs(best.from - pos) ? h : best))
}

class ColorSwatchWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly key: string,
    readonly css: string,
    readonly onOpen: (hit: ColorSwatchOpen) => void
  ) {
    super()
  }

  eq(other: ColorSwatchWidget): boolean {
    return other.key === this.key && other.code === this.code
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-color-swatch'
    el.setAttribute('data-testid', 'color-swatch')
    el.setAttribute('data-color', this.key)
    el.setAttribute('data-code', this.code)
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', `Color ${this.code} — click to edit`)
    el.title = `${this.code} — click to edit`

    // Fill sits over the host's checkerboard so a translucent color reads honestly.
    const fill = document.createElement('span')
    fill.className = 'cm-color-swatch-fill'
    fill.style.backgroundColor = this.css
    el.appendChild(fill)

    // Never let the click reach CodeMirror's own mouse handling: it must not move the caret,
    // start a selection, or steal focus from the picker we are about to open.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pos = view.posAtDOM(el)
      const hit = findColorAt(view.state, pos, this.code)
      if (hit) this.onOpen({ ...hit, rect: el.getBoundingClientRect() })
    })
    return el
  }

  /** Keep every event inside the widget out of the editor's input handling. */
  ignoreEvent(): boolean {
    return true
  }
}

// All colors/sizes come from tokens.css; the swatch's FILL is the one inline style, since it is
// computed from the document text. `0.9em` square + `vertical-align` keeps it on the text
// baseline without growing the line box (line-height is 1.55 → ~20px for a ~11.7px swatch).
const colorSwatchTheme = EditorView.theme({
  '.cm-color-swatch': {
    position: 'relative',
    display: 'inline-block',
    boxSizing: 'border-box',
    width: '0.9em',
    height: '0.9em',
    margin: '0 0.3em 0 0',
    verticalAlign: '-0.1em',
    lineHeight: '0',
    // Half of --radius-sm: on a ~12px chip the full 4px reads as a circle, not a square.
    borderRadius: 'calc(var(--radius-sm) / 2)',
    border: '1px solid var(--border-strong)',
    overflow: 'hidden',
    cursor: 'pointer',
    // Checkerboard: one conic tile = a 2×2 check, so alpha is visible rather than composited.
    backgroundColor: 'var(--panel-raised)',
    backgroundImage:
      'conic-gradient(var(--border-strong) 0 25%, var(--panel-raised) 0 50%, var(--border-strong) 0 75%, var(--panel-raised) 0)',
    backgroundSize: '6px 6px',
    transition: 'border-color var(--dur-fast) var(--ease)'
  },
  '.cm-color-swatch:hover': {
    borderColor: 'var(--accent-active)'
  },
  '.cm-color-swatch-fill': {
    position: 'absolute',
    inset: '0',
    display: 'block'
  }
})

/**
 * The raw-editor color-swatch extension. `onOpen` is invoked when a swatch is clicked (T-068);
 * pass a no-op to get passive swatches only.
 */
export function colorSwatches(onOpen: (hit: ColorSwatchOpen) => void): Extension {
  const matcher = new MatchDecorator({
    regexp: colorCodeRegexp(),
    decorate: (add, from, _to, match) => {
      const parsed = parseColorCode(match[0])
      if (!parsed) return
      add(
        from,
        from,
        Decoration.widget({
          widget: new ColorSwatchWidget(match[0], toHexKey(parsed.rgba), toCssColor(parsed.rgba), onOpen),
          side: -1
        })
      )
    }
  })

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate): void {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (v) => v.decorations }
  )

  return [plugin, colorSwatchTheme]
}
