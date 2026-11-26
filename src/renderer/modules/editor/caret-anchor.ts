// Pomade T-004 (round 7) — the caret bridge between the two editor engines.
//
// Toggling raw ⇄ rendered destroys one editor and mounts the other, so the caret can only be
// carried across as a description of the CONTENT it sat in. Two earlier attempts failed:
//
//  1. a block INDEX bridge — raw counted blank-line groups, rendered counted top-level doc
//     children, so lists/frontmatter desynced the two counts (round 5);
//  2. a text SIGNATURE bridge that stripped only leading BLOCK markers (`# `, `- `, `> `) —
//     so a raw line kept its INLINE markup while the rendered side reported markup-free
//     `textContent`. `Beta with **bold** and [link](url)` vs `Beta with bold and link` never
//     matched, and every real vault line (bold, links, `[[wikilinks]]`, inline code) fell through
//     to "no match ⇒ leave the caret at its default" = position 0. The round-5/6 specs only used
//     marker-free plain paragraphs, so they passed while the app was broken (round 6).
//
// Round 7 compares the ONE representation both engines can produce faithfully: the caret's block
// as PLAIN TEXT. The rendered side reads it off the ProseMirror textblock; the raw side derives it
// from the real markdown AST (mdast — the same parser stack md-config already uses), which knows
// exactly which characters are markup and which are text. No marker regexes, and inline markup is
// handled by construction.
//
// An anchor therefore carries:
//   key      — the block's plain text, whitespace-stripped and lowercased (the MATCH key; the two
//              engines disagree only about whitespace, e.g. a soft break is "\n" in the source and
//              nothing in `textContent`, so whitespace is dropped from the key)
//   offset   — how far into the block's plain text the caret sat, so it lands mid-block rather than
//              at the block start (clamped on arrival; exact whenever the two plain texts agree)
//   fraction — the caret's relative position in the body, the LAST-RESORT fallback so an
//              unmatched anchor lands nearby instead of at the top of the document
//
// Matching is deterministic and never throws away the caret: exact key → containment → longest
// shared prefix+suffix (fuzzy, for the rare block whose two renderings still differ, e.g. a table
// row or an HTML block) → proportional fallback.

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import type { Root, RootContent } from 'mdast'

export interface CaretAnchor {
  /** Plain text of the caret's block, whitespace-stripped + lowercased ('' when the block is empty). */
  key: string
  /** Caret index inside the block's PLAIN text (not the key). Best-effort, clamped on arrival. */
  offset: number
  /** Caret position in the body as a 0..1 fraction — fallback when no block matches. */
  fraction: number
}

/** Longest key we compare/transport. Blocks are short; this only bounds pathological lines. */
const KEY_MAX = 400

/** Minimum evidence (chars of shared prefix+suffix) before a FUZZY match is trusted. */
const FUZZY_MIN = 8

/** Plain text → match key: drop all whitespace (the two engines disagree about soft breaks and
 *  indentation) and case, then bound the length. */
export function anchorKey(plain: string): string {
  return plain.replace(/\s+/g, '').toLowerCase().slice(0, KEY_MAX)
}

/** Clamp a transported caret offset to a block's plain text. */
export function clampOffset(plain: string, offset: number): number {
  return Math.min(Math.max(0, offset), plain.length)
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

function commonSuffix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/** How strongly two keys name the same block. Tiered so an exact match always beats containment,
 *  which always beats fuzzy overlap — the tiers can't be confused by long text. */
export function anchorScore(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1e9 + a.length
  if (a.includes(b) || b.includes(a)) return 1e6 + Math.min(a.length, b.length)
  const overlap = commonPrefix(a, b) + commonSuffix(a, b)
  return overlap >= FUZZY_MIN ? overlap : 0
}

/** Index of the best-matching candidate key, or -1 when none is credible. First match wins ties,
 *  so the mapping is stable and order-deterministic. */
export function bestMatch(keys: readonly string[], anchorKeyText: string): number {
  let best = -1
  let bestScore = 0
  for (let i = 0; i < keys.length; i++) {
    const s = anchorScore(keys[i], anchorKeyText)
    if (s > bestScore) {
      bestScore = s
      best = i
    }
  }
  return best
}

// ── raw (markdown source) side ────────────────────────────────────────────────────────────────
// A leaf block of the source, with the map needed to translate between source offsets and the
// block's plain text. `segments` are the text-bearing inline runs in document order; the gaps
// between them are markup (`**`, `[`, `](url)`, backticks …).

interface TextSegment {
  srcFrom: number
  srcTo: number
  plainFrom: number
}

export interface SourceBlock {
  /** Source offsets of the whole block. */
  from: number
  to: number
  /** The block's plain text — what the rendered view shows for the same content. */
  plain: string
  /** `anchorKey(plain)`. */
  key: string
  segments: TextSegment[]
}

// Blocks that hold text directly (the rendered view's "textblocks"). Containers (list, blockquote,
// table, listItem) are recursed into instead.
const LEAF_BLOCKS = new Set(['paragraph', 'heading', 'code', 'tableCell'])

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

function collectText(
  node: MdNode,
  source: string,
  out: { plain: string; segments: TextSegment[] }
): void {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
    const value = node.value ?? ''
    const from = node.position?.start.offset
    const to = node.position?.end.offset
    if (from != null && to != null && value.length > 0) {
      // A `text` node's position IS its value. `inlineCode`/`code` positions span the delimiters
      // (backticks / fences + info string), which are markup like `**` — locate the value itself
      // so offsets inside a code run stay meaningful.
      let srcFrom = from
      if (to - from !== value.length) {
        const found = source.indexOf(value, from)
        srcFrom = found >= 0 && found < to ? found : from
      }
      out.segments.push({ srcFrom, srcTo: srcFrom + value.length, plainFrom: out.plain.length })
    }
    out.plain += value
    return
  }
  if (node.type === 'break') {
    out.plain += ' '
    return
  }
  for (const child of node.children ?? []) collectText(child, source, out)
}

function collectBlocks(node: MdNode, source: string, out: SourceBlock[]): void {
  if (LEAF_BLOCKS.has(node.type)) {
    const from = node.position?.start.offset
    const to = node.position?.end.offset
    if (from != null && to != null) {
      const acc = { plain: '', segments: [] as TextSegment[] }
      collectText(node, source, acc)
      out.push({ from, to, plain: acc.plain, key: anchorKey(acc.plain), segments: acc.segments })
    }
    return
  }
  for (const child of node.children ?? []) collectBlocks(child, source, out)
}

// Frontmatter is not part of the rendered document at all (EditorPane hides it), so it must not
// offset the proportional fallback. Same shape as splitFrontmatter's own leading-fence match.
const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/

export function bodyStartOffset(source: string): number {
  const m = FRONTMATTER.exec(source)
  return m ? m[0].length : 0
}

// One-entry memo: a toggle asks for the same document twice (snapshot then restore), and a doc can
// be megabytes. Keyed by identity of the source string.
let memoSource: string | null = null
let memoBlocks: SourceBlock[] = []

/** Leaf text blocks of a markdown source, in document order, with source offsets. */
export function sourceBlocks(source: string): SourceBlock[] {
  if (memoSource === source) return memoBlocks
  let blocks: SourceBlock[] = []
  try {
    const tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()]
    }) as Root
    for (const child of tree.children as RootContent[]) {
      collectBlocks(child as unknown as MdNode, source, blocks)
    }
  } catch {
    blocks = []
  }
  memoSource = source
  memoBlocks = blocks
  return blocks
}

/** The block containing `offset` (or the last one before it — a caret parked on a blank line
 *  belongs to the paragraph above, matching how the rendered view has no such gap). */
export function blockAt(blocks: readonly SourceBlock[], offset: number): SourceBlock | null {
  let candidate: SourceBlock | null = null
  for (const b of blocks) {
    if (offset >= b.from && offset <= b.to) return b
    if (b.to <= offset) candidate = b
  }
  return candidate ?? blocks[0] ?? null
}

/** Source offset of the START of 1-based `line` (clamped to the document). A line past the end
 *  lands at the document end; line ≤ 1 is offset 0. */
export function offsetOfLine(source: string, line: number): number {
  if (line <= 1) return 0
  let idx = 0
  let seen = 1
  while (seen < line) {
    const nl = source.indexOf('\n', idx)
    if (nl < 0) return source.length
    idx = nl + 1
    seen++
  }
  return idx
}

/**
 * E-020 (T-086 r3) — a CaretAnchor for the START of 1-based `line` in `source`. This is what lets
 * a terminal `path:line` link jump to that line in the RENDERED markdown view (which has no line
 * numbers): the anchor is the source block's plain text, handed to the rendered controller's
 * `setCaretAnchor`, which matches it to the ProseMirror textblock exactly as a raw⇄rendered toggle
 * does. Mirrors RawEditor.getCaretAnchor, but for an arbitrary line offset instead of the caret.
 */
export function anchorForLine(source: string, line: number): CaretAnchor {
  return anchorForOffset(source, offsetOfLine(source, line))
}

/**
 * A CaretAnchor for an arbitrary SOURCE offset — the block-text machinery generalized off the
 * caret head. Both `RawEditor.getCaretAnchor` (offset = caret) and the T-185 viewport capture
 * (offset = first-visible-line) build their anchor through this: the block containing the offset,
 * the offset inside that block's plain text, and the proportional body fallback. `bodyStartOffset`
 * keeps the fraction frontmatter-immune on the raw side (0 on the live body, which has none).
 */
export function anchorForOffset(source: string, offset: number): CaretAnchor {
  const bodyFrom = bodyStartOffset(source)
  const span = Math.max(1, source.length - bodyFrom)
  const fraction = Math.min(1, Math.max(0, (offset - bodyFrom) / span))
  const block = blockAt(sourceBlocks(source), offset)
  if (!block) return { key: '', offset: 0, fraction }
  return { key: block.key, offset: srcToPlain(block, offset), fraction }
}

/**
 * Resolve a CaretAnchor to a SOURCE offset in `source` — the inverse of `anchorForOffset`, and the
 * exact landing logic `RawEditor`/`LiveEditor` `setCaretAnchor` use (extracted so the T-185
 * first-paint restore lands identically): the best-matching block's in-plain-text offset, else a
 * proportional guess snapped to the nearest block start so an unmatched anchor lands NEARBY rather
 * than at the top. Clamped to the document by the caller.
 */
export function resolveAnchorOffset(source: string, anchor: CaretAnchor): number {
  const blocks = sourceBlocks(source)
  const hit = anchor.key ? bestMatch(blocks.map((b) => b.key), anchor.key) : -1
  if (hit >= 0) {
    const block = blocks[hit]
    return plainToSrc(block, clampOffset(block.plain, anchor.offset))
  }
  const bodyFrom = bodyStartOffset(source)
  const guess = bodyFrom + Math.round(anchor.fraction * Math.max(0, source.length - bodyFrom))
  const near = blocks.reduce<number | null>(
    (best, b) => (best == null || Math.abs(b.from - guess) < Math.abs(best - guess) ? b.from : best),
    null
  )
  return near ?? guess
}

/** Source offset → index in the block's plain text. */
export function srcToPlain(block: SourceBlock, srcOffset: number): number {
  for (const seg of block.segments) {
    if (srcOffset < seg.srcFrom) return seg.plainFrom
    if (srcOffset <= seg.srcTo) return seg.plainFrom + (srcOffset - seg.srcFrom)
  }
  return block.plain.length
}

/** Index in the block's plain text → source offset. */
export function plainToSrc(block: SourceBlock, plainOffset: number): number {
  for (const seg of block.segments) {
    const segEnd = seg.plainFrom + (seg.srcTo - seg.srcFrom)
    if (plainOffset <= segEnd) {
      return seg.srcFrom + Math.max(0, plainOffset - seg.plainFrom)
    }
  }
  const last = block.segments[block.segments.length - 1]
  return last ? last.srcTo : block.from
}
