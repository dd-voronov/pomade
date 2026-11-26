// Pomade T-185 — the "where does this editor open" contract, applied at FIRST PAINT.
//
// Whenever a target position is known BEFORE the editor exists — a saved reading position
// (DocTab.viewport), a `:line` on a fresh open, or the T-004 caret bridge across a mode toggle —
// the position is baked into the initial editor state / scroll instead of being dispatched after
// mount, so the doc APPEARS already at the right spot (no visible open-at-line-1-then-jump).
//
// EditorPane computes an `InitialView` once per editor mount (via `useInitialView` / the
// `getInitialView` callback it hands down) and each engine applies it while building its view:
//   • raw  — CM `EditorState.create({ selection })` + `new EditorView({ scrollTo })` (true pre-paint).
//   • live — CM selection baked; the OUTER scroll container is scrolled synchronously in the mount
//            effect (CM's own scroller has natural height, so `scrollTo` can't move it).
//   • rendered — the ProseMirror selection + outer-container scroll are applied synchronously in the
//            `mounted` callback (Milkdown owns view construction; best-effort — see the note there).
//
// PRECEDENCE (resolved in EditorPane, highest first): a pending `:line` jump (fresh open) → the
// T-004 caret bridge (mode toggle) → the saved viewport. A fresh tab from the tree has none of
// these, so it opens at the top. See docs/modules/editor/editing-modes.md for the full precedence rules
// and how this coexists with the post-mount jump/caret machinery (which stays for the ALREADY-open
// `:line` override and owns the StrictMode one-shot clearing).

import type { EditorView } from '@codemirror/view'

import type { CaretAnchor } from './caret-anchor'
import { offsetOfLine, resolveAnchorOffset } from './caret-anchor'

/** A position known before the editor mounts. `line` is raw-only (rendered/live receive the line
 *  pre-translated to a `caret` anchor by EditorPane). `caret` places the caret + scrolls it into
 *  view; `viewport` scrolls the block to the TOP without moving the caret.
 *
 *  `toggle` (T-194) is the mode-toggle case: the outgoing engine's on-screen viewport is the SCROLL
 *  source (`viewport`, scrolled to the top, keeping the reading position), while the caret bridge
 *  supplies only the SELECTION (`selection`, baked in but NOT scrolled to). Either may be null. */
export type InitialView =
  | { type: 'line'; line: number }
  | { type: 'caret'; anchor: CaretAnchor }
  | { type: 'viewport'; anchor: CaretAnchor }
  | { type: 'toggle'; selection: CaretAnchor | null; viewport: CaretAnchor | null }

/** How an applied InitialView wants the target positioned. */
export interface InitialTarget {
  /** Whether to place the caret at `pos` (caret/line) or leave it (viewport). */
  moveCaret: boolean
  /** Put the target block at the container TOP (viewport) or CENTER it (caret/line). */
  place: 'start' | 'center'
}

export function targetOf(iv: InitialView): InitialTarget {
  return iv.type === 'viewport'
    ? { moveCaret: false, place: 'start' }
    : { moveCaret: true, place: 'center' }
}

/** The nearest scrollable ancestor of `el` (itself included). The raw editor's own `.cm-scroller`
 *  scrolls; the live/rendered views have a natural-height body inside an OUTER `.mdScroll` that
 *  scrolls — one walk covers both. Falls back to `el` when nothing scrolls. */
export function scrollParent(el: HTMLElement): HTMLElement {
  let n: HTMLElement | null = el
  while (n) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
    n = n.parentElement
  }
  return el
}

/** Resolve an InitialView to a SOURCE offset + how to place it, for the CodeMirror engines (raw
 *  over the full file, live over the frontmatter-less body). `line`/`caret`/`viewport` only — a
 *  `toggle` carries two positions and is resolved by `initialCMParts` instead. Clamped. */
export function resolveInitialCM(
  iv: Exclude<InitialView, { type: 'toggle' }>,
  source: string
): { pos: number; moveCaret: boolean; place: 'start' | 'center' } {
  const t = targetOf(iv)
  const pos = iv.type === 'line' ? offsetOfLine(source, iv.line) : resolveAnchorOffset(source, iv.anchor)
  return { pos: Math.min(Math.max(0, pos), source.length), moveCaret: t.moveCaret, place: t.place }
}

/** T-194 — the two positions a mode toggle needs, in CodeMirror source offsets: where to place the
 *  caret (`selectionPos`, set WITHOUT scrolling — the caret bridge's SELECTION only) and where to put
 *  the viewport top (`scrollPos`, the outgoing on-screen anchor). Either anchor may be null. */
export function resolveToggleCM(
  iv: { selection: CaretAnchor | null; viewport: CaretAnchor | null },
  source: string
): { selectionPos: number | null; scrollPos: number | null } {
  const clamp = (n: number): number => Math.min(Math.max(0, n), source.length)
  return {
    selectionPos: iv.selection ? clamp(resolveAnchorOffset(source, iv.selection)) : null,
    scrollPos: iv.viewport ? clamp(resolveAnchorOffset(source, iv.viewport)) : null
  }
}

/** The unified first-paint / first-show inputs for the CodeMirror engines (raw + live): the caret to
 *  bake into the initial selection (`selectionPos`, null = don't move the caret) and the offset to
 *  scroll to (`scrollPos`) with its placement (`place`). For a `toggle` the scroll follows the kept
 *  VIEWPORT (place 'start'); with no viewport captured it degrades to keeping the caret visible
 *  (place 'center'), never a jump to the document top. */
export function initialCMParts(
  iv: InitialView,
  source: string
): { selectionPos: number | null; scrollPos: number | null; place: 'start' | 'center' } {
  if (iv.type === 'toggle') {
    const t = resolveToggleCM(iv, source)
    return t.scrollPos != null
      ? { selectionPos: t.selectionPos, scrollPos: t.scrollPos, place: 'start' }
      : { selectionPos: t.selectionPos, scrollPos: t.selectionPos, place: 'center' }
  }
  const r = resolveInitialCM(iv, source)
  return { selectionPos: r.moveCaret ? r.pos : null, scrollPos: r.pos, place: r.place }
}

/** The SOURCE offset of the line at the TOP of the visible viewport, for a CodeMirror view. Works
 *  whether the view's own `.cm-scroller` scrolls (raw) or an OUTER container does (live): the
 *  document-relative height is `viewportTopScreenY − documentTop`, and the viewport-top screen Y is
 *  the nearest scrollable ancestor's rect top. Returns 0 for a not-laid-out (hidden) view. */
export function cmViewportTopOffset(view: EditorView): number {
  const sp = scrollParent(view.scrollDOM)
  const topY = sp.getBoundingClientRect().top
  return view.lineBlockAtHeight(topY - view.documentTop).from
}

/** Scroll `container` so `el` sits at its top (`start`) or centered (`center`). Used for the
 *  live/rendered first-paint scroll, where CM/PM's own `scrollIntoView` can't move the outer
 *  container. Delta-based (works whatever the current scroll) and clamped by the browser. */
export function scrollElementIntoContainer(
  el: HTMLElement,
  container: HTMLElement,
  place: 'start' | 'center'
): void {
  const er = el.getBoundingClientRect()
  const cr = container.getBoundingClientRect()
  const delta =
    place === 'center'
      ? er.top - cr.top - (cr.height / 2 - er.height / 2)
      : er.top - cr.top
  container.scrollTop += delta
}
