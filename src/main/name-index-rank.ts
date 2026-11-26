// Pomade — T-188: case-insensitive link matching, the pure ranking + folding logic for the
// name index (`name-index.ts`). Kept in its OWN import-light module (no node/fs, no config) so
// the vitest unit layer covers the fold + ranking rules directly, and so `name-index.ts` reads as
// "look the folded key up, then rank" with the sort semantics stated here once.
//
// WHY RANK AT ALL (T-188): the name/stem/suffix keys fold to lowercase, so `README.md`, `readme.md`
// and `ReadMe.md` now share ONE bucket. The bucket is filled in walk order and truncated to a cap,
// so without ranking a merged bucket would drop candidates arbitrarily and show them in walk order.
// Results are ordered:
//   1. EXACT-CASE match first — the on-screen token matched a file's real casing (`README.md` for a
//      `README.md` file), so that file leads even though case-variant siblings share the bucket.
//   2. CURRENT-PROJECT membership next — a match under the active project's root outranks one
//      elsewhere in the workspace (the user is far likelier to mean the file in front of them).
//   3. Otherwise walk order is preserved (a STABLE sort), so pre-existing tie-break intent — e.g.
//      `findByStem` listing stem hits before exact-basename hits — survives ranking untouched.

/** The locale-independent case fold used for EVERY name-index key and lookup (see docs/contracts/ipc-workspace-and-files.md "fs — indexes": a
 *  plain `toLowerCase()` is the accepted folding — no locale-aware collation, no NFC/NFD
 *  normalization; the index and the query fold identically, which is all that matters). */
export function foldKey(s: string): string {
  return s.toLowerCase()
}

/** Last path segment of a ws-relative path (`a/b/c.md` → `c.md`). */
function baseOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i >= 0 ? rel.slice(i + 1) : rel
}

/** Basename minus its last extension, mirroring `fs-shared.splitName` (a leading-dot file like
 *  `.zshrc` is all-stem). Inlined here to keep this module free of the node-heavy fs-shared. */
function stemOf(base: string): string {
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Is `rel` inside the active project? `projectRel` is the ws-relative project root; `''` means
 *  "no project bias" (the Workspace project is rooted at the ws root, so everything counts
 *  and this predicate collapses to a no-op tie-breaker). */
function inProject(rel: string, projectRel: string): boolean {
  return projectRel === '' || rel === projectRel || rel.startsWith(projectRel + '/')
}

export interface RankOpts {
  /** The user's EXACT-CASE query token (basename form) — what decides the exact-case bucket. */
  query: string
  /** ws-relative active-project root; `''` = workspace root / no project bias. */
  projectRel: string
  /** Compare the match's STEM instead of its whole basename — for `findByStem`, where the query is
   *  extension-less (`Northwind` should count `Northwind.md` as an exact-case hit, not `northwind.md`). */
  byStem?: boolean
}

/**
 * Order `matches` (all already sharing the folded key) exact-case-first, then current-project,
 * then walk order. Pure and stable — the caller slices to its return cap afterwards.
 */
export function rankMatches(matches: readonly string[], opts: RankOpts): string[] {
  const { query, projectRel, byStem } = opts
  const score = (rel: string): number => {
    const base = baseOf(rel)
    const cmp = byStem ? stemOf(base) : base
    const exact = cmp === query ? 0 : 1 // exact-case is the PRIMARY key (weight 2)…
    const proj = inProject(rel, projectRel) ? 0 : 1 // …current-project the SECONDARY key.
    return exact * 2 + proj
  }
  return matches
    .map((rel, i) => ({ rel, i, s: score(rel) }))
    .sort((a, b) => a.s - b.s || a.i - b.i) // stable: equal-score ties keep walk order
    .map((x) => x.rel)
}
