// Pomade — E-020 terminal link geometry: reading the xterm buffer into logical lines and turning a
// row into resolved links (single-line candidates + one hard-wrapped-path join link). Pure buffer
// math + resolution — no React, no xterm side effects — so it is the SINGLE SOURCE OF TRUTH shared
// by the link provider (useXtermSession's `attachLinkProvider`) and the e2e `__pomadeTermProvideLinks`
// hook, which is why it lives in its own module rather than inside either consumer.

import type { Terminal, IBufferCell } from '@xterm/xterm'

import { scanCandidates, type LinkCandidate } from './term-links'
import { resolveCandidate, type LinkContext, type ResolvedLink } from './term-link-open'

/** T-086 — one buffer cell's position: 0-based column, ABSOLUTE buffer row. */
export interface CellPos {
  x: number
  y: number
}

/**
 * T-086 — the full LOGICAL line containing absolute row `absY`, plus a per-character map back to
 * buffer cells.
 *
 * Two subtleties this exists for: (1) a long path or URL is usually WRAPPED across several rows,
 * and scanning one row at a time would only ever see fragments; (2) a character's index in the
 * string is not its column — a wide glyph (CJK, emoji) occupies two cells whose second one is a
 * zero-width spacer — so the underline range has to be derived from the cells themselves rather
 * than from arithmetic on the string.
 */
export interface LogicalLine {
  text: string
  map: CellPos[]
  /** Absolute buffer rows this logical line spans (inclusive), after stitching soft-wraps. */
  startY: number
  endY: number
}

export function readLogicalLine(xterm: Terminal, absY: number, cell: IBufferCell): LogicalLine {
  const buf = xterm.buffer.active
  let startY = absY
  while (startY > 0 && buf.getLine(startY)?.isWrapped) startY--
  let endY = absY
  while (buf.getLine(endY + 1)?.isWrapped) endY++

  let text = ''
  const map: CellPos[] = []
  for (let y = startY; y <= endY; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    for (let x = 0; x < xterm.cols; x++) {
      line.getCell(x, cell)
      if (cell.getWidth() === 0) continue // spacer half of a wide glyph — not its own character
      const chars = cell.getChars() || ' '
      for (const ch of chars) {
        text += ch
        map.push({ x, y })
      }
    }
  }
  return { text, map, startY, endY }
}

// ── T-086 (Fix B): hard-wrapped path joining ─────────────────────────────────
// Agent CLIs (Claude Code) HARD-wrap long output: a path is printed as one row ending in a
// fragment, then `\n`, then a hanging-indent row continuing it — two SEPARATE logical lines
// (`isWrapped=false`), so `readLogicalLine` never stitches them and neither fragment resolves on
// its own. (xterm SOFT-wraps are already stitched above.) The join heuristic below reconstructs the
// original path across up to 3 physical fragments and resolves it through the normal pipeline (Fix
// A's file-suffix fallback included), emitting ONE link whose range spans the rows it covers.
//
// Conservative by construction: it only ever fires when a path-like candidate at a line EDGE
// FAILED to resolve, it only ever joins on a path-like fragment boundary, and it emits a link ONLY
// when the joined target actually resolves on disk — so "no dead links" holds and ordinary prose
// rows do zero join work.
//
// Fix B r2 — the wrap can break INSIDE the filename. The Owner's vault names reviewed docs with ~50-char
// UUID stems, so Claude Code's hard wrap routinely splits a path mid-basename: the continuation
// fragment (`4867-s01-reviewed.md`, or a bare stem chunk `5136c229`) has NO slash. r1 required every
// chain fragment to contain a `/` (the `pathCands`-only EDGE predicates), so those slashless
// continuations broke the chain and the joined doc never linked. r2 lets slashless fragments be chain
// CONTINUATIONS (middles and tails), while the chain-inclusion rule — a SLASHED head, enforced by
// `headContribution` using `pathCands` — still keeps a pair of slashless prose words from ever being
// probed. See the EDGE predicates (`edgeCands`) and the perf-gate note in `tryJoinLink`.
const MAX_JOIN_FRAGMENTS = 3

/** First run of non-space chars: its string + start index in `text`, or null (blank line). */
function firstToken(text: string): { str: string; idx: number } | null {
  const m = /\S+/.exec(text)
  return m ? { str: m[0], idx: m.index } : null
}

/** SLASHED path candidates only: a `path` token that actually contains a slash. This is the
 *  chain-inclusion gate — `headContribution` requires one, so a window whose FIRST fragment has no
 *  slash is never probed (a pair of slashless prose words can never join). A wrapped path's HEAD
 *  always carries the slash. */
function pathCands(text: string): LinkCandidate[] {
  return scanCandidates(text).filter((c) => c.kind === 'path' && c.target.includes('/'))
}
/** All non-URL link candidates on a line — SLASHED paths, bare-file paths, AND stems. Used for the
 *  chain-walk EDGE predicates (`beginsOpen`/`endsOpen`): a hard wrap can break INSIDE a filename, so
 *  a continuation fragment is often slashless (`4867-s01-reviewed.md`, a bare stem chunk `5136c229`)
 *  and must still count as an open edge (Fix B r2). URLs are excluded — the join is paths only. */
function edgeCands(text: string): LinkCandidate[] {
  return scanCandidates(text).filter((c) => c.kind !== 'url')
}

/** The index of the first non-space column in `text` (the hanging-indent width). */
function firstNonSpace(text: string): number {
  return text.length - text.replace(/^\s+/, '').length
}
/** The length of `text` with trailing whitespace removed (its content end). */
function contentEnd(text: string): number {
  return text.replace(/\s+$/, '').length
}

/** Does `line` BEGIN with a link candidate at its first non-indent column? (So a fragment ABOVE it
 *  could continue into it — and so walking further UP is worthwhile.) Uses `edgeCands`, so a
 *  slashless continuation (`4867-s01-reviewed.md`, a bare stem chunk) counts (Fix B r2). A bulleted
 *  head line (`- path`) is NOT begins-open: its first candidate does not start at the bullet's
 *  column, so this returns false and the upward walk stops at the head. A prose line whose first
 *  word is a ≥4-char stem IS begins-open — but it can only ever be a window's non-head fragment
 *  (`headContribution` needs a slash), so it is never probed. */
function beginsOpen(line: LogicalLine): boolean {
  const c = edgeCands(line.text)[0]
  return !!c && c.start === firstNonSpace(line.text)
}
/** Does `line` END with a link candidate reaching its content end, with NO trailing punctuation?
 *  (So it can continue into the fragment BELOW.) Uses `edgeCands`, so a fragment ending mid-filename
 *  in a slashless chunk still counts (Fix B r2). A line ending `…reviewed.md,` or `…reviewed.md.` is
 *  NOT ends-open — the candidate's end is trimmed before the punctuation — so it is a TERMINAL
 *  fragment, never extended downward. */
function endsOpen(line: LogicalLine): boolean {
  const cs = edgeCands(line.text)
  const c = cs[cs.length - 1]
  return !!c && c.end === contentEnd(line.text)
}

/** The head token a window's FIRST fragment contributes (its LAST path token) and the cell it
 *  starts at. */
function headContribution(line: LogicalLine): { str: string; from: CellPos } | null {
  const cs = pathCands(line.text)
  const c = cs[cs.length - 1]
  if (!c) return null
  const from = line.map[c.start]
  return from ? { str: line.text.slice(c.start, c.end), from } : null
}
/** The token a CONTINUATION fragment contributes (its FIRST token, hanging indent stripped) and
 *  the cell its last char sits on. Uses the raw first token (not a trimmed candidate) so a trailing
 *  `,`/`:line` rides along and is handled by re-classification of the joined string. */
function tailContribution(line: LogicalLine): { str: string; to: CellPos } | null {
  const t = firstToken(line.text)
  if (!t) return null
  const endIdx = Math.min(t.idx + t.str.length, line.map.length) - 1
  const to = line.map[endIdx]
  return to ? { str: t.str, to } : null
}

/**
 * Reconstruct a hard-wrapped path chain through the hovered row and, if the joined target
 * resolves, return ONE link's payload (the resolved target + the absolute cells the link spans).
 *
 * `hovered` is the hovered logical line, `resolutions` its already-resolved candidates (so the perf
 * gate costs nothing extra). Returns null when the row is not a wrapped-path edge, or when no
 * resolvable join exists.
 */
async function tryJoinLink(
  xterm: Terminal,
  cell: IBufferCell,
  hovered: LogicalLine,
  resolutions: { cand: LinkCandidate; resolved: ResolvedLink | null }[],
  ctx: LinkContext,
  opts?: { bypassCache?: boolean }
): Promise<{ resolved: ResolvedLink; from: CellPos; to: CellPos; target: string } | null> {
  // ── Perf gate (Fix B r2 — the exact predicate set). Attempt ONLY when a candidate at a line EDGE
  // failed to resolve AND that edge looks open. `canDown` = the hovered line ends open and its
  // content-end candidate failed alone; `canUp` = the hovered line begins open (at the hanging
  // indent) and its first candidate failed alone. Both edges now accept SLASHLESS candidates
  // (`edgeCands`), so a slashless continuation row is itself a legitimate up-trigger — this is the
  // loosening that Fix B r2 needs. The cost of the loosening is bounded: a prose row ending in a
  // failing ≥4-char stem can make `canDown` fire, but the chain it then builds has no SLASHED head,
  // so `headContribution` returns null for every window and NO `resolveCandidate` (IPC) probe ever
  // runs — the chain-inclusion rule kills it before any probe, and the per-target resolution cache
  // absorbs repeats. A row whose edge path already resolved does zero join work. ──
  const failedAt = (idxPredicate: (c: LinkCandidate) => boolean): boolean =>
    resolutions.some((r) => !r.resolved && idxPredicate(r.cand))
  const canDown = endsOpen(hovered) && failedAt((c) => c.end === contentEnd(hovered.text))
  const canUp = beginsOpen(hovered) && failedAt((c) => c.start === firstNonSpace(hovered.text))
  if (!canDown && !canUp) return null

  // ── Build the maximal fragment chain (≤ MAX_JOIN_FRAGMENTS) through the hovered line. ──
  const chain: LogicalLine[] = [hovered]
  let hoveredIdx = 0
  // Walk UP while the top begins-open and the line above ends-open.
  while (chain.length < MAX_JOIN_FRAGMENTS && beginsOpen(chain[0]) && chain[0].startY > 0) {
    const prev = readLogicalLine(xterm, chain[0].startY - 1, cell)
    if (!endsOpen(prev)) break
    chain.unshift(prev)
    hoveredIdx++
  }
  // Walk DOWN while the bottom ends-open and the line below begins-open.
  const lastRow = xterm.buffer.active.length - 1
  while (chain.length < MAX_JOIN_FRAGMENTS && endsOpen(chain[chain.length - 1])) {
    const bottom = chain[chain.length - 1]
    if (bottom.endY >= lastRow) break
    const next = readLogicalLine(xterm, bottom.endY + 1, cell)
    if (!beginsOpen(next)) break
    chain.push(next)
  }
  if (chain.length < 2) return null

  // ── Try windows [i..j] that include the hovered line, SIZE 2 before 3, first resolvable wins.
  // (Growing outward guards the rare case where a shorter join already resolves and a further
  // fragment was only appended because its boundary happened to look open.) ──
  for (let size = 2; size <= chain.length; size++) {
    for (let i = Math.max(0, hoveredIdx - (size - 1)); i + size - 1 < chain.length && i <= hoveredIdx; i++) {
      const j = i + size - 1
      const head = headContribution(chain[i])
      if (!head) continue
      let joined = head.str
      let to: CellPos | null = null
      let ok = true
      for (let k = i + 1; k <= j; k++) {
        const tail = tailContribution(chain[k])
        if (!tail) {
          ok = false
          break
        }
        joined += tail.str
        to = tail.to
      }
      if (!ok || !to) continue
      const [joinedCand] = scanCandidates(joined)
      if (!joinedCand) continue
      const resolved = await resolveCandidate(joinedCand, ctx, opts)
      if (resolved) return { resolved, from: head.from, to, target: joinedCand.target }
    }
  }
  return null
}

/** One resolved link's payload in ABSOLUTE, 0-based buffer cells (the provider turns it into an
 *  ILink; a test hook reads it directly). `target` is what the link points at (a URL or a path). */
export interface RowLink {
  from: CellPos
  to: CellPos
  target: string
  resolved: ResolvedLink
}

/**
 * All links for the logical line containing absolute row `absY`: every single-line candidate that
 * resolves, PLUS at most one hard-wrapped-path join link (Fix B). The single source of truth for
 * the provider AND the e2e hook, so the two can never drift.
 *
 * T-092 — candidates resolve IN PARALLEL (row latency = max, not sum) and the reply is ordered by
 * position; a join link can start on an earlier ROW, so the final order is (row, column).
 *
 * T-193 — `opts.bypassCache` forwards to every `resolveCandidate` so the click-time fallback in
 * `attachLinkProvider` re-resolves FRESH (a click is fresh user intent — a stale hover NEGATIVE must
 * not eat it). The hover provider and the e2e hook call without it, so they stay cache-backed.
 */
export async function computeRowLinks(
  xterm: Terminal,
  absY: number,
  cell: IBufferCell,
  ctx: LinkContext,
  opts?: { bypassCache?: boolean }
): Promise<RowLink[]> {
  const hovered = readLogicalLine(xterm, absY, cell)
  const candidates = hovered.text.trim() ? scanCandidates(hovered.text) : []
  if (candidates.length === 0) return []
  const resolutions = await Promise.all(
    candidates.map(async (cand) => ({ cand, resolved: await resolveCandidate(cand, ctx, opts) }))
  )
  resolutions.sort((a, b) => a.cand.start - b.cand.start)
  const out: RowLink[] = []
  for (const { cand, resolved } of resolutions) {
    // Validation is what turns a token into a link: an unresolvable path resolves to null and is
    // therefore never underlined (locked decision — no dead links).
    if (!resolved) continue
    const from = hovered.map[cand.start]
    const to = hovered.map[Math.min(cand.end, hovered.map.length) - 1]
    if (!from || !to) continue
    out.push({ from, to, target: cand.target, resolved })
  }
  // Fix B — a hard-wrapped path whose fragments each failed on their own: reconstruct the chain
  // and, if the joined target resolves, add ONE link spanning the rows it covers. Runs only on a
  // failing EOL/BOL path-like edge (the perf gate lives in `tryJoinLink`), so prose rows and rows
  // whose edge path already resolved do zero extra work.
  const join = await tryJoinLink(xterm, cell, hovered, resolutions, ctx, opts)
  if (join) out.push({ from: join.from, to: join.to, target: join.target, resolved: join.resolved })
  out.sort((a, b) => a.from.y - b.from.y || a.from.x - b.from.x)
  return out
}
