import type { CaretAnchor } from './caret-anchor'

// Pomade E-001 — the imperative surface EditorPane drives on whichever editor is mounted
// (CodeMirror in raw mode, ProseMirror/Milkdown in rendered mode). The context menu
// (T-010/T-011) and in-document find (T-012) act through this one interface so EditorPane
// doesn't branch on the editor engine everywhere.

export interface EditorSelection {
  /** The selected text ('' when the selection is empty). */
  text: string
  /** True when nothing is selected (caret only). */
  empty: boolean
  /** Engine-specific range (CodeMirror doc offsets / ProseMirror positions). Captured at
   *  right-click time so Cut/Paste act on it even after the click collapses the live
   *  selection. */
  from: number
  to: number
}

export interface FindMatchInfo {
  /** Total matches of the current query in the document. */
  count: number
  /** 1-based index of the current match (0 when there are none). */
  current: number
}

/** Find controller for the rendered (ProseMirror) view — custom, since ProseMirror has no
 *  built-in search. Raw mode uses CodeMirror's own search panel instead (see EditorController
 *  .openFind), so this sub-API is rendered-mode only. Replace is raw-only for v1. */
export interface RenderedFindApi {
  /** Set/replace the active query; returns match info. An empty query clears highlights. */
  setQuery(query: string, opts: { caseSensitive: boolean }): FindMatchInfo
  /** Move to the next match (wraps); returns updated info. */
  next(): FindMatchInfo
  /** Move to the previous match (wraps); returns updated info. */
  prev(): FindMatchInfo
  /** Clear the query + highlights. */
  clear(): void
}

/** The editor engine currently mounted (also the discriminant on `EditorController.kind`). */
export type EditorKind = 'raw' | 'rendered' | 'table' | 'live'

export interface EditorController {
  // 'raw' → CodeMirror (its own search panel); 'live' → the E-024 CodeMirror live view
  // (also CM's own search panel); 'rendered' → ProseMirror/Milkdown; 'table' → the CSV
  // grid. 'rendered' and 'table' both drive the custom find panel via `find` below (T-043).
  kind: 'raw' | 'rendered' | 'table' | 'live'
  /** Current selection text + range, read live at call time. */
  getSelection(): EditorSelection
  /** Replace the range [from, to) with `text` ('' deletes it). Used by Cut/Paste with the
   *  range captured at right-click time (from === to inserts at the caret). */
  replaceRange(from: number, to: number, text: string): void
  /** Return focus to the editor. */
  focus(): void
  /** Replace everything the engine shows with `text` (raw: the whole file; live and rendered: the
   *  body without frontmatter) as ONE undoable edit that never merges with the typing around it —
   *  Cmd+Z puts the previous text back. Document history's Restore. Rendered returns false when
   *  its parser cannot read `text`, leaving the document untouched. Absent on the CSV table. */
  replaceDocument?(text: string): boolean
  /** Emit any edit the engine has not reported through `onChange` yet, synchronously. Rendered
   *  (Milkdown) reports edits through a 200 ms debounce; the save door, quit's save, draft keeping
   *  and the quick peek call this first so they never act on a buffer missing the last keystrokes.
   *  Engines that report every edit at once omit it. */
  flushPendingEdits?(): void

  // ── raw (CodeMirror) only ──
  /** Open CodeMirror's search panel, optionally prefilled with `prefill` (else the current
   *  selection). Themed to tokens via cm-theme. */
  openFind?(prefill?: string): void
  /** Close CodeMirror's search panel. */
  closeFind?(): void
  /** E-020 (T-086) — put the caret at the start of 1-based line `n`, scroll it into view and
   *  focus. Clamped to the document's line count, so a `file.ts:9999` link from stale terminal
   *  output lands at the last line instead of failing. Raw-only by design: a rendered markdown
   *  view has no line numbers to jump to (the E-020 routing ignores `:line` for .md). */
  gotoLine?(n: number): void

  // ── custom find panel (rendered ProseMirror AND the CSV table, T-043) ──
  find?: RenderedFindApi

  // ── T-004: caret preservation across a raw/rendered toggle ──
  // Both raw (CodeMirror) and rendered (ProseMirror) report/accept a *caret anchor*: the PLAIN
  // TEXT of the block the caret sits in, plus the offset inside it and a proportional fallback
  // (see caret-anchor.ts for the full rationale and the two approaches this replaced).
  // EditorPane snapshots the anchor at toggle time and hands it to the successor editor.
  /** Describe where the caret is, in engine-independent terms (null when there's no caret). */
  getCaretAnchor?(): CaretAnchor | null
  /** Restore the caret from `anchor`: the matching block, the offset inside it, scrolled into
   *  view and focused. Always lands somewhere sensible — never at the top by accident. */
  setCaretAnchor?(anchor: CaretAnchor): void

  // ── T-185: per-doc reading position (viewport top, NOT the caret) ──
  /** The block at the TOP of the visible viewport, as the same engine-independent anchor the caret
   *  bridge uses (null when the editor isn't laid out / not visible). Captured on tab switch /
   *  close / quit and persisted as `DocTab.viewport`; restored FIRST-PAINT via the initial-view
   *  path (not through `setCaretAnchor`, which moves the caret and centers). */
  getViewportAnchor?(): CaretAnchor | null
  /** Restore a reading position by scrolling the matching block to the TOP of the viewport WITHOUT
   *  moving the caret — the imperative counterpart to the initial-state scroll baking, used when a
   *  background pane (mounted hidden) is shown for the first time. */
  scrollToViewportAnchor?(anchor: CaretAnchor): void

  // ── T-194: mode-toggle restore (keep the on-screen viewport; decouple the caret) ──
  /** Restore across a raw⇄live⇄rendered mode toggle: place the caret from `selection` WITHOUT
   *  scrolling it into view (the caret bridge supplies the SELECTION only), and scroll `viewport`'s
   *  block to the TOP so the outgoing reading position is kept. Either may be null; with no
   *  viewport the caret is centered as a fallback (never a jump to the top). Focus returns to the
   *  editor without scrolling. The imperative counterpart to the `toggle` first-paint bake, used by
   *  the post-mount survivor guard. */
  applyToggleView?(selection: CaretAnchor | null, viewport: CaretAnchor | null): void
}
