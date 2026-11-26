// Pomade E-020 (T-086) — terminal link SCANNING: pure, synchronous, dependency-free.
//
// Turns one line of terminal text into the candidate tokens that MIGHT be links. Nothing here
// touches the filesystem or the stores: validation (which is what actually decides whether a
// token becomes a clickable link) happens in `term-link-open.ts` against main. Keeping the two
// apart is what makes the fiddly part — token boundaries, trailing punctuation, `:line:col`
// suffixes — testable by reading, and cheap enough to run on every hovered row.
//
// No dependency was added for URL matching (deliberately: @xterm/addon-web-links would have
// pulled a second linkifier with its own hover/activation model into a pane that already has
// one). The matcher below is intentionally conservative — it only claims http/https.

/** A token that could be a link, with its position in the source line. */
export interface LinkCandidate {
  /** Where the candidate starts/ends in the line string (end exclusive). Includes the
   *  `:line[:col]` suffix, so the underline covers exactly what the user is pointing at. */
  start: number
  end: number
  /** The token as it will be acted on: a full URL, or a path with its suffix stripped. */
  target: string
  /** `stem` is an extension-less bare WORD (`VISION`, `Makefile`): path-shaped only if the
   *  workspace happens to hold a file whose basename — or basename minus its last extension —
   *  is exactly that word, which only the resolver can say (see `term-link-open.ts`). */
  kind: 'url' | 'path' | 'stem'
  /** 1-based line/column from a `path:line[:col]` suffix (compiler / grep / stack-trace form). */
  line?: number
  col?: number
}

// Characters that commonly WRAP a path or URL in prose/log output and are never part of it.
// They are token DELIMITERS, not merely trimmed (see TOKEN_RE): agent CLIs print their tool
// headers as `Update(.github/workflows/mirror.yml)` / `Read(docs/CONTRACTS.md)`, and a purely
// whitespace-split token would keep `Update(` glued to the path — probing garbage, no link.
const OPENERS = '([{<"\'`«'
// Trailing set = the closers PLUS sentence punctuation. A trailing ':' goes too ("see foo.md:"),
// which is safe because the `:line` suffix is extracted from what remains AFTER this trim only
// when the colon is followed by digits (see SUFFIX_RE).
const CLOSERS = ')]}>"\'`»,;.!?:'

// http/https with a plausible host. Rejects a bare "http://" and anything with whitespace.
const URL_RE = /^https?:\/\/[\w.-]+(?::\d+)?(?:[/?#][^\s]*)?$/i
// A trailing `:12`, `:12:5`, or a line-RANGE `:12-30` (compilers, `grep -n`, stack traces, and the
// `path:N-M` range agents print for a hunk). Non-greedy head so the LAST numeric group(s) win:
// `/a/b:3:12` → path `/a/b`, line 3, col 12. For a range `path:N-M` the head is `path`, the line is
// N (open at the START of the range) and the `-M` tail is CONSUMED (matched, so it rides inside the
// token — the underline still covers `:132-134`) then IGNORED (group 4 is never read). The `-M`
// alternative fires ONLY after the mandatory `:(\d+)`, so a version-ish token with no colon
// (`1.5-2`, `v2.10-3`) still never matches here — the existing extension/stem guards are untouched.
const SUFFIX_RE = /^(.*?):(\d+)(?::(\d+)|-(\d+))?$/
// A bare filename with a real extension: `me.md`, `index.tsx`. The extension must START with a
// letter so version-ish and numeric tokens (`1.5`, `v2.10`, `0.0.1`) are never probed.
const BARE_FILE_RE = /^[^\s/]+\.[A-Za-z][A-Za-z0-9]{0,7}$/
// An extension-LESS bare word — `VISION`, `ARCHITECTURE`, `Makefile`, `LICENSE`. VS Code links
// these too, and agent output refers to docs by stem constantly. Four characters minimum keeps
// the noise down (`cd`, `ls`, `git`, `npm` never reach the resolver); no slash, since anything
// with one has already been classified as a relative path above.
const STEM_RE = /^[A-Za-z0-9._-]{4,}$/

/** Escape a literal string for use inside a regex character class. */
function classEscape(chars: string): string {
  return chars.replace(/[\\\]^-]/g, '\\$&')
}
// One token = a maximal run of characters that is neither whitespace nor an OPENER. Derived from
// OPENERS so the two can never drift apart. Module-level (built once — this runs per hovered
// row), so `lastIndex` is reset by every caller before use.
const TOKEN_RE = new RegExp(`[^\\s${classEscape(OPENERS)}]+`, 'g')

/** Trim wrapper/punctuation characters, reporting how much came off the front. */
function trimWrappers(token: string): { text: string; lead: number } {
  let from = 0
  let to = token.length
  while (from < to && OPENERS.includes(token[from])) from++
  while (to > from && CLOSERS.includes(token[to - 1])) to--
  return { text: token.slice(from, to), lead: from }
}

/**
 * Classify ONE whitespace-delimited token. Returns null when it is not link-shaped at all —
 * the cheap filter that keeps the async validation step down to a couple of probes per row.
 */
function classify(text: string): Omit<LinkCandidate, 'start' | 'end'> | null {
  // URLs are matched BEFORE the `:line` suffix is considered — otherwise `:8080` in
  // `http://localhost:8080/x` would be read as a line number.
  if (URL_RE.test(text)) return { kind: 'url', target: text }

  let path = text
  let line: number | undefined
  let col: number | undefined
  const suffix = SUFFIX_RE.exec(text)
  if (suffix) {
    path = suffix[1]
    line = Number(suffix[2])
    if (suffix[3] !== undefined) col = Number(suffix[3])
    // suffix[4] is the `-M` end of a `path:N-M` range: matched (so it is consumed and the underline
    // covers the whole token) but deliberately dropped — we open at the START of the range, line N.
  }
  if (!path) return null
  // `~` alone, or a lone `/`, are directories nobody means to click.
  if (path === '~' || path === '/' || path === '.' || path === '..') return null

  const looksLikePath =
    path.startsWith('/') || // absolute
    path.startsWith('~/') || // home-relative
    path.includes('/') || // relative (./x, src/x, ../x)
    BARE_FILE_RE.test(path) // bare filename with an extension
  if (!looksLikePath) {
    // Extension-less word: a POSSIBLE file stem. Deliberately a separate kind — it is resolved
    // through the workspace index rather than by probing a path, and it must not be underlined
    // unless that index actually knows the name.
    if (!STEM_RE.test(path)) return null
    return {
      kind: 'stem',
      target: path,
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {})
    }
  }

  return {
    kind: 'path',
    target: path,
    ...(line !== undefined ? { line } : {}),
    ...(col !== undefined ? { col } : {})
  }
}

/**
 * Every link-shaped token in `text`, in order. Split on whitespace AND on opening brackets/quotes:
 * terminal output columns are whitespace-separated by construction, and a path containing spaces
 * cannot be told apart from two paths without guessing (so we don't).
 */
export function scanCandidates(text: string): LinkCandidate[] {
  const out: LinkCandidate[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const { text: trimmed, lead } = trimWrappers(m[0])
    if (!trimmed) continue
    const classified = classify(trimmed)
    if (!classified) continue
    out.push({ ...classified, start: m.index + lead, end: m.index + lead + trimmed.length })
  }
  return out
}
