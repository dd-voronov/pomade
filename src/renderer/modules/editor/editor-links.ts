// Pomade T-184 — EDITOR link detection, the engine-agnostic core.
//
// The editor gets the terminal's Cmd+click stack (E-020 / T-086 / T-092) as SHARED infrastructure:
// this module imports the terminal module's scanner (`term-links.ts`) and resolver/router
// (`term-link-open.ts`) DIRECTLY and never re-implements them (locked decision — extraction of a
// neutral `links/` home is deferred to the P-025 queue, so terminal-owned files are imported in
// place, not moved). Everything here is pure and synchronous EXCEPT `resolveCandidate` (async,
// cached in the terminal resolver) — so it is cheap enough to run per hovered line and testable by
// reading.
//
// Three link kinds live side by side on a line:
//   • PLAIN paths / URLs — found by the terminal `scanCandidates` scanner verbatim (bare ws paths,
//     `./` relative, absolute, `~/`, bare filenames, extension-less stems, http(s)).
//   • `[[wikilinks]]` — Obsidian semantics: strip `|alias` and `#heading`, the target is a basename
//     ("link by basename" is the vault convention), `.md` implied when extension-less. Resolved
//     through the SAME resolver via a synthetic `LinkCandidate` (stem ⇒ findByStem / .md implied,
//     with-extension ⇒ findByName), so unique ⇒ open, several ⇒ picker, none ⇒ not a link.
//   • markdown `[text](href)` links — the destination is EXPLICIT, so it is never guessed at: an
//     http(s) href is a URL, anything else is a filesystem path resolved against the DOC's own
//     folder (CommonMark semantics — no project/workspace fallback, no basename index), `file://`
//     included, and existence-checked like every other link (`resolveMarkdownHref`). The whole
//     `[text](href)` span is one region, and it masks the plain scanner (which would otherwise see
//     the href as a token glued to the surrounding `)` / `**` markup).

import { scanCandidates, type LinkCandidate } from '../terminal/term-links'
import {
  activateResolved,
  resolveCandidate,
  type LinkContext,
  type ResolvedLink
} from '../terminal/term-link-open'

// Re-export the resolver surface the CM extension / PM plugin consume, so the two editor engines
// import their whole link vocabulary from this one module (the single shared-consumer seam).
export {
  resolveCandidate,
  activateResolved,
  activatePickedMatch
} from '../terminal/term-link-open'
export type { LinkContext, ResolvedLink } from '../terminal/term-link-open'
export type { LinkCandidate } from '../terminal/term-links'

/** A `[[…]]` run: brackets excluded from `[^[\]\n]` so nested brackets never over-match. Mirrors
 *  the visual-only `WIKILINK_RE` in cm-theme.ts / md-config.ts (kept in lock-step by shape). */
const WIKILINK_RE = /\[\[[^[\]\n]+\]\]/g

/** An inline markdown link `[text](href "title")`, NOT an image (`![…]`, excluded by the lookbehind).
 *  Group 1 = the destination: `<…>` (may hold spaces) or a bare run that may contain one level of
 *  balanced parentheses (`a_(b).md`), per CommonMark. An optional `"title"` / `'title'` is allowed. */
const MD_LINK_RE =
  /(?<!!)\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g

/** A trailing file extension: letter-initial, ≤8 chars — the same shape `term-links.BARE_FILE_RE`
 *  accepts, so `note.md`/`image.png` read as extensioned while `1.5` / a bare word do not. */
const EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/

/**
 * The disambiguation popover request for a wikilink basename / bare name that exists in several
 * places. EditorPane owns the React popover (built on the design-system primitives, the terminal
 * picker being inline-and-terminal-specific rather than a standalone component); the CM extension
 * and PM plugin only ASK for it via a callback carrying this.
 */
export interface EditorLinkPickerState {
  x: number
  y: number
  name: string
  matches: string[]
  line?: number
}

/** Obsidian wikilink target: strip `|alias`, then `#heading`, then reduce to the BASENAME (the
 *  vault "link by basename" convention). `null` when nothing resolvable remains. */
export function wikilinkTarget(inner: string): string | null {
  const stripped = inner.split('|')[0].split('#')[0].trim()
  if (!stripped) return null
  const base = stripped.slice(stripped.lastIndexOf('/') + 1)
  return base || null
}

/** Turn a wikilink target into a resolver `LinkCandidate`. Extension-less ⇒ `stem` (resolves via
 *  the workspace stem index — `.md` implied, plus exact-name files like `LICENSE`); with an
 *  extension ⇒ `path` (a bare filename, resolved against the doc/project/ws bases then `findByName`).
 *  No 4-char minimum — a wikilink target is an explicit reference, not a scraped prose word. */
export function wikilinkCandidate(target: string, start: number, end: number): LinkCandidate {
  return { start, end, target, kind: EXT_RE.test(target) ? 'path' : 'stem' }
}

/** What a markdown link destination points at, before touching the disk. */
export type HrefTarget = { kind: 'url'; url: string } | { kind: 'path'; path: string }

/**
 * Normalize a markdown link destination: unwrap `<…>`; http(s) ⇒ URL; `file://` ⇒ its decoded
 * absolute path; any other scheme (`mailto:`, `obsidian:` …) or a pure `#anchor` ⇒ not a file link
 * (null); otherwise a path with its `?query` / `#fragment` dropped and percent-escapes decoded
 * (`my%20note.md` names `my note.md`). Pure — shared by the Cmd+click layer and the Live popover's
 * Open.
 */
export function normalizeHref(raw: string): HrefTarget | null {
  let href = raw.trim()
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1).trim()
  if (!href || href.startsWith('#')) return null
  if (/^https?:\/\//i.test(href)) return { kind: 'url', url: href }
  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href)
      if (url.host && url.host !== 'localhost') return null // a remote host is not a local file
      const path = decodeURIComponent(url.pathname)
      return path ? { kind: 'path', path } : null
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  const cut = href.search(/[?#]/)
  if (cut >= 0) href = href.slice(0, cut)
  if (!href) return null
  try {
    href = decodeURIComponent(href)
  } catch {
    /* a stray `%` — keep the literal text */
  }
  return { kind: 'path', path: href }
}

/**
 * Resolve a markdown link destination to something `activateResolved` can route: a URL, or an
 * EXISTING file/directory. A relative path resolves against the doc's own folder (`ctx.cwdAbs`)
 * only; `/abs` and `~/…` stand alone. Nonexistent ⇒ null (no dead links, same as every other
 * editor link). Not cached: it runs once per Cmd+hovered line / click, one probe per href.
 */
export async function resolveMarkdownHref(href: string, ctx: LinkContext): Promise<ResolvedLink | null> {
  const target = normalizeHref(href)
  if (!target) return null
  if (target.kind === 'url') return target
  const standalone = target.path.startsWith('/') || target.path === '~' || target.path.startsWith('~/')
  if (!standalone && !ctx.cwdAbs) return null
  const probe = await window.pomade.fs.probePath(target.path, standalone ? undefined : ctx.cwdAbs)
  return probe ? { kind: 'path', probe } : null
}

/** One link region within a single line's text: `[from, to)` are 0-based offsets INTO that line's
 *  text (not doc positions — each engine maps them to its own coordinate space). A region is either
 *  a scanned `candidate` (plain token / wikilink — resolved by the terminal resolver) or a markdown
 *  link's explicit `href` (resolved by `resolveMarkdownHref`). */
export type LineLinkRegion = { from: number; to: number } & (
  | { candidate: LinkCandidate }
  | { href: string }
)

/** Resolve one region through the resolver its kind calls for. */
export function resolveRegion(region: LineLinkRegion, ctx: LinkContext): Promise<ResolvedLink | null> {
  return 'href' in region ? resolveMarkdownHref(region.href, ctx) : resolveCandidate(region.candidate, ctx)
}

/**
 * Every link-shaped region on ONE line of text — wikilinks, markdown links and plain paths — in
 * order of kind (callers sort when they need document order). Wikilinks and markdown links are
 * scanned first and their spans MASK the plain scanner: `scanCandidates` treats `[`/`(` as token
 * delimiters, so `[[Knowledge/foo.md]]` would otherwise ALSO surface `Knowledge/foo.md`, and
 * `**[x](../a.md)**` would surface `../a.md)**` — double (or garbled) detections. A plain candidate
 * overlapping either span is therefore dropped; the bracketed region owns that range. A markdown
 * link inside a wikilink span (`[[a](b)]]` is not a thing) is never produced.
 *
 * Pointer-line-scoped by construction (the caller passes only the hovered line's text) — no
 * whole-document scan, and the async `resolveCandidate` cache dedups repeat probes.
 */
export function scanLineRegions(text: string): LineLinkRegion[] {
  const regions: LineLinkRegion[] = []
  const masked: { from: number; to: number }[] = []
  const overlapsMask = (from: number, to: number): boolean =>
    masked.some((w) => from < w.to && to > w.from)

  WIKILINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const from = m.index
    const to = from + m[0].length
    masked.push({ from, to })
    const target = wikilinkTarget(m[0].slice(2, -2))
    if (target) regions.push({ from, to, candidate: wikilinkCandidate(target, from, to) })
  }

  MD_LINK_RE.lastIndex = 0
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const from = m.index
    const to = from + m[0].length
    if (overlapsMask(from, to)) continue
    masked.push({ from, to })
    if (m[1]) regions.push({ from, to, href: m[1] })
  }

  for (const cand of scanCandidates(text)) {
    if (overlapsMask(cand.start, cand.end)) continue
    regions.push({ from: cand.start, to: cand.end, candidate: cand })
  }
  return regions
}

/**
 * Act on a resolved editor link at screen point `(x, y)`. Ambiguous ⇒ ask the owner to open the
 * picker there; everything else ⇒ the terminal router VERBATIM (`activateResolved` → `routeProbe`:
 * doc tab + tree reveal inside the active project, orange outside-badge elsewhere in the workspace,
 * Finder for dirs / non-editor files, absolute outside-workspace paths as T-106 doc tabs, URLs to
 * the browser). No fifth open-tab copy is hand-rolled here (T-170).
 */
export function activateEditorLink(
  resolved: ResolvedLink,
  x: number,
  y: number,
  onAmbiguous: (picker: EditorLinkPickerState) => void
): void {
  if (resolved.kind === 'ambiguous') {
    onAmbiguous({
      x,
      y,
      name: resolved.name,
      matches: resolved.matches,
      ...(resolved.line !== undefined ? { line: resolved.line } : {})
    })
    return
  }
  activateResolved(resolved)
}

/** What the CM extension and the PM plugin both need from their host editor. */
export interface EditorLinkNav {
  /** The doc's resolution bases, read FRESH at hover/click time (project / ws root can change
   *  under a mounted pane): `cwdAbs` = the doc's own directory, then project root, then ws root. */
  getContext: () => LinkContext
  /** Open the ambiguity picker at a screen point. */
  onAmbiguous: (picker: EditorLinkPickerState) => void
}
