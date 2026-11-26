// Pomade E-020 (T-086) — terminal link RESOLUTION + ROUTING.
//
// `term-links.ts` says which tokens LOOK like links; this module decides whether they really are
// (by probing main) and what Cmd+clicking one does. The routing matrix is a locked product
// decision — see `routeProbe` below, which is written to be read as that table.
//
// Resolution order for a relative path: terminal cwd → project root → workspace root. A BARE
// filename (`me.md`) additionally falls back to the workspace basename index, which may return
// several matches — the caller then shows a picker rather than guessing. An extension-LESS word
// (`VISION`) is probed against the cwd and then looked up in the same index by STEM. A SLASHED token
// that resolves against no probe base falls back to the workspace suffix indexes: FILES by full
// segment-aligned suffix (`findFilesBySuffix`, Fix A) then DIRECTORIES (`findDirsBySuffix`, r4).

import type { PathProbe } from '@shared/types'
import { treePathUnderRoot } from '@shared/paths'

import { useTabsStore } from '../../stores/tabs-store'
import { buildAllProjects, useWorkspaceStore } from '../../stores/workspace-store'
import { useRevealStore } from '../../stores/reveal-store'
import { useMountsStore } from '../../stores/mounts-store'
import { opensInEditor } from '../editor/doc-kind'
import type { LinkCandidate } from './term-links'

/** Where a relative token is resolved from, most-specific first. */
export interface LinkContext {
  /** The shell's current working directory (absolute; '' when not yet known). */
  cwdAbs: string
  /** The active project's root (absolute). */
  projectRootAbs: string
  /** The workspace root (absolute). */
  wsRootAbs: string
}

export type ResolvedLink =
  | { kind: 'url'; url: string }
  | { kind: 'path'; probe: PathProbe; line?: number }
  /** A bare filename that exists in several places — the user picks. */
  | { kind: 'ambiguous'; name: string; matches: string[]; line?: number }

// Resolution results are cached: xterm re-queries the link provider for every hovered row, and
// since T-092 that happens on EVERY hover (not only while Cmd is held) — without this, sweeping
// the mouse across a screenful of output would fire hundreds of IPC probes.
//
// Two TTLs, because the two answers age very differently:
//   • NEGATIVE ("not a file") is effectively permanent. The overwhelming majority of candidates
//     are prose words that STEM_RE waved through, and a word that isn't a filename now will not
//     become one. Held long — the cost is that a file created THIS second stays unclickable for
//     up to the negative TTL, which is a fair trade for not re-probing prose on every hover.
//   • POSITIVE is held briefly so a file that was deleted or moved stops being clickable fast.
const POSITIVE_TTL_MS = 5_000
const NEGATIVE_TTL_MS = 30_000
const cache = new Map<string, { at: number; value: ResolvedLink | null }>()

// T-188 — the key keeps the EXACT-CASE `cand.target` (not a folded form). Matching folds
// case-insensitively, but the RANKING it returns is exact-case-first, so `Northwind` and `northwind`
// legitimately produce different orderings (each leads with its own casing). Folding the key would
// serve one case's ranking to the other and defeat the exact-case tiebreak this ticket introduces;
// the only cost of not folding is one extra probe when both casings appear on screen — negligible.
// `projectRootAbs` is already in the key, so the ranking's project bias is cached correctly too.
function cacheKey(cand: LinkCandidate, ctx: LinkContext): string {
  return `${ctx.cwdAbs}\u0000${ctx.projectRootAbs}\u0000${ctx.wsRootAbs}\u0000${cand.kind}\u0000${cand.target}`
}

function withLine<T extends object>(value: T, line?: number): T & { line?: number } {
  return line === undefined ? value : { ...value, line }
}

/** Re-attach THIS candidate's `:line` to a cached resolution (the cache key ignores it — the
 *  same path with two different line numbers resolves to the same file). A cached NEGATIVE stays
 *  negative: spreading `null` would produce a `{ line }` object that reads as a valid link. */
function fromCache(value: ResolvedLink | null, line?: number): ResolvedLink | null {
  if (value === null) return null
  return withLine(value, line) as ResolvedLink
}

/** Probe `target` against each base in turn (first hit wins) — the locked resolution order. */
async function probeBases(target: string, bases: string[]): Promise<PathProbe | null> {
  for (const base of bases) {
    const probe = await window.pomade.fs.probePath(target, base)
    if (probe) return probe
  }
  return null
}

/**
 * Resolve one candidate against the filesystem. `null` means "not a link" — which is exactly
 * what keeps a nonexistent path from ever being underlined (locked decision: no dead links).
 *
 * T-193 — `opts.bypassCache` skips the cache READ (always resolves fresh) but still WRITES the
 * fresh outcome back, so a subsequent hover is warm. This exists for the click-time fallback: an
 * explicit Cmd+click is fresh user intent, and a 30 s-stale NEGATIVE ("this word was not a file")
 * cached by an earlier hover must not eat a click on a file that has since been created. The hover
 * provider never bypasses (it must stay cheap on every row), so the negative cache still protects
 * the sweep-the-mouse case exactly as before.
 */
export async function resolveCandidate(
  cand: LinkCandidate,
  ctx: LinkContext,
  opts?: { bypassCache?: boolean }
): Promise<ResolvedLink | null> {
  const key = cacheKey(cand, ctx)
  if (!opts?.bypassCache) {
    const hit = cache.get(key)
    const ttl = hit?.value === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS
    if (hit && Date.now() - hit.at < ttl) return fromCache(hit.value, cand.line)
  }
  const value = await resolveUncached(cand, ctx)
  cache.set(key, { at: Date.now(), value })
  return value
}

async function resolveUncached(
  cand: LinkCandidate,
  ctx: LinkContext
): Promise<ResolvedLink | null> {
  if (cand.kind === 'url') return { kind: 'url', url: cand.target }
  if (cand.kind === 'stem') return resolveStem(cand, ctx)

  const target = cand.target
  const absolute = target.startsWith('/') || target.startsWith('~')
  if (absolute) {
    const probe = await window.pomade.fs.probePath(target)
    return probe ? withLine({ kind: 'path' as const, probe }, cand.line) : null
  }

  // Relative: cwd → project root → workspace root. Duplicates are dropped so a project rooted
  // at the workspace root (the Workspace project (`__workspace__`)) doesn't probe twice.
  const bases = [...new Set([ctx.cwdAbs, ctx.projectRootAbs, ctx.wsRootAbs].filter(Boolean))]
  const probe = await probeBases(target.replace(/^\.\//, ''), bases)
  if (probe) return withLine({ kind: 'path' as const, probe }, cand.line)

  // A BARE filename gets one more chance: the workspace basename index (folded case-insensitively
  // since T-188 — `Northwind` finds `northwind.md`). `projectRootAbs` lets main rank matches
  // current-project-first (after exact-case), so the picker leads with the file the user is in.
  if (!target.includes('/')) {
    const matches = await window.pomade.fs.findByName(target, ctx.projectRootAbs)
    if (matches.length === 0) return null
    if (matches.length === 1) {
      const only = await window.pomade.fs.probePath(matches[0], ctx.wsRootAbs)
      return only ? withLine({ kind: 'path' as const, probe: only }, cand.line) : null
    }
    return withLine({ kind: 'ambiguous' as const, name: target, matches }, cand.line)
  }

  // A SLASHED token that resolved against no probe base falls back to the workspace index by full
  // trailing-segment suffix. This runs ONLY after every probe base missed, so a real cwd-/project-/
  // ws-relative path always wins; it costs one Map lookup + a ≤FIND_BY_NAME_MAX suffix filter on the
  // main side (no new walk, no new I/O) and rides the same POSITIVE/NEGATIVE renderer cache above.
  //
  // Two suffix indexes, tried FILE-first when the token has no trailing slash:
  //  • Fix A — `findFilesBySuffix`: a FILE printed relative to a deep folder
  //    (`session-docs-reviewed/…-reviewed.md`) that r4 left dead because its fallback was
  //    directories-only. Case-insensitive, segment-aligned (`docs-reviewed/x.md` must NOT match a path
  //    ending `session-docs-reviewed/x.md`).
  //  • T-086 r4 — `findDirsBySuffix`: a "statement of the folder" (`Docs/`, `_templates/`,
  //    `docs/superpowers/specs/`). Case-insensitive.
  // A trailing slash (or a token that names a directory) skips the file leg and goes straight to the
  // dir index — a trailing slash IS a directory reference. A bare-basename guess is still NEVER made
  // for a slashed token (that would jump a log typo to an unrelated file); only a full-suffix match
  // on segment boundaries, re-confirmed on disk by `probePath`, is ever linked (no dead links).
  const endsWithSlash = target.endsWith('/')
  if (!endsWithSlash) {
    const fileMatches = await window.pomade.fs.findFilesBySuffix(target, ctx.projectRootAbs)
    if (fileMatches.length === 1) {
      const only = await window.pomade.fs.probePath(fileMatches[0], ctx.wsRootAbs)
      if (only) return withLine({ kind: 'path' as const, probe: only }, cand.line)
    } else if (fileMatches.length > 1) {
      return withLine({ kind: 'ambiguous' as const, name: target, matches: fileMatches }, cand.line)
    }
  }
  const dirMatches = await window.pomade.fs.findDirsBySuffix(target, ctx.projectRootAbs)
  if (dirMatches.length === 0) return null
  if (dirMatches.length === 1) {
    const only = await window.pomade.fs.probePath(dirMatches[0], ctx.wsRootAbs)
    // Confirm it exists and is a directory (a trailing slash is a directory reference; the index
    // could also be a step stale between watcher patches).
    return only && !only.isFile ? withLine({ kind: 'path' as const, probe: only }, cand.line) : null
  }
  return withLine({ kind: 'ambiguous' as const, name: target, matches: dirMatches }, cand.line)
}

/**
 * An extension-LESS word (`VISION`, `ARCHITECTURE`, `Makefile`): the cwd first — a file sitting
 * right where the shell is beats anything the index might offer — then the workspace index keyed
 * by basename-minus-extension. Unique ⇒ open; several ⇒ the picker; none ⇒ NOT a link.
 *
 * Cost model (revised by T-092, which made the provider run on EVERY hovered row rather than only
 * while Cmd is held): a stem candidate is resolved once per row per negative-TTL window — a
 * non-filename word is a permanent negative and is cached as one — and the index behind
 * `findByStem` is the SAME cached walk `findByName` already builds (30s TTL). So a hovered word
 * costs one stat plus one map lookup, once, and no per-keystroke work whatsoever.
 */
async function resolveStem(cand: LinkCandidate, ctx: LinkContext): Promise<ResolvedLink | null> {
  const word = cand.target
  if (ctx.cwdAbs) {
    const probe = await window.pomade.fs.probePath(word, ctx.cwdAbs)
    // A file OR a directory sitting in the cwd wins outright (T-086 r3 relaxed the round-2
    // file-only rule): folders are link targets now — E-020 r2 reveals an in-project folder in
    // the tree — so a bare `docs`/`.superpowers` naming a real cwd directory is as much a
    // navigation target as a bare filename is. Still gated on EXISTENCE (probe non-null), so a
    // prose word that names nothing on disk is never underlined (no dead links holds).
    if (probe) return withLine({ kind: 'path' as const, probe }, cand.line)
  }
  const matches = await window.pomade.fs.findByStem(word, ctx.projectRootAbs)
  if (matches.length === 0) return null
  if (matches.length === 1) {
    const only = await window.pomade.fs.probePath(matches[0], ctx.wsRootAbs)
    return only ? withLine({ kind: 'path' as const, probe: only }, cand.line) : null
  }
  return withLine({ kind: 'ambiguous' as const, name: word, matches }, cand.line)
}

// (No explicit cache invalidation on a workspace switch: the key includes all three resolution
// bases, so entries from the old workspace can never be served to the new one — they simply age
// out. A `clearLinkCache()` would be dead code plus an import edge from the workspace store into
// a terminal module.)

/**
 * Open a file as a REAL doc tab (never the T-063 preview slot: Cmd+clicking a path is a deliberate
 * navigation, and a preview tab would be replaced by the next one), reveal it in the file tree when
 * `reveal` is set, and — for files that open RAW — put the caret on `line`.
 *
 * `targetProjectId` is the project whose tab strip receives the doc — always the active project
 * (see `routeProbe`). `path` is the tab's path: workspace-relative inside the workspace, absolute
 * outside it (EditorPane routes an absolute path through the outside-workspace doors). `reveal` is
 * set only when the tree shows `path` — under the project's root or a visible mount.
 *
 * T-170 — `symlink`: `probePath` resolves `wsRel`/`abs` through a realpath-follow (the tab always
 * ends up pointing at the REAL target, never an intermediate link), so this route can't discover
 * "was this a symlink" from the opened path itself the way a file-tree click can. `routeProbe`
 * passes along `PathProbe.isSymbolicLink` (one `lstat` on the RAW, pre-realpath target) instead.
 */
export function openDocFromLink(
  targetProjectId: string,
  path: string,
  line?: number,
  reveal = true,
  symlink = false
): void {
  // T-170 — the shared `openDocByPath` action: dedupe-or-activate, `initialDocMode`, the symlink
  // flag (known up front from `probePath`, so the action skips its own stat), and (via `opts.line`)
  // the jump handoff. Always a REAL tab (no `usePreviewMode` opt) — preserved verbatim, per this
  // function's own doc above ("never the T-063 preview slot"). Previously this hand-rolled Tab
  // literal never set `symlink` at all, so a doc opened via a terminal link to a symlinked path
  // silently lost the tab-strip glyph the tree/editor paths set.
  useTabsStore.getState().openDocByPath(targetProjectId, path, {
    symlink,
    ...(line !== undefined ? { line } : {})
  })
  // Reveal + focus in the tree whenever the tree can actually show the file. Kept OUTSIDE the
  // shared action — it's a term-link-only concern (the tree/editor call sites never reveal).
  if (reveal) useRevealStore.getState().reveal(path, targetProjectId)
}

/**
 * The canonical absolute path of each visible mount of `projectId`, paired with its tree path
 * (workspace-relative, or absolute outside the workspace). Mounts are stored as typed, so each is
 * resolved through `fs.probePath` — the same realpath the target went through — before comparing.
 * A missing mount resolves to nothing and is left out.
 */
async function visibleMountRoots(projectId: string, wsRootAbs: string): Promise<{ path: string; canonAbs: string }[]> {
  const mountsStore = useMountsStore.getState()
  await mountsStore.hydrateProject(projectId)
  const mounts = useMountsStore.getState().mountsByProject[projectId] ?? []
  const resolved = await Promise.all(
    mounts.map(async (m) => {
      const abs = m.path.startsWith('/') ? m.path : m.path ? `${wsRootAbs}/${m.path}` : wsRootAbs
      const probe = await window.pomade.fs.probePath(abs, wsRootAbs).catch(() => null)
      return probe && !probe.isFile ? { path: m.path, canonAbs: probe.abs } : null
    })
  )
  return resolved.filter((r): r is { path: string; canonAbs: string } => r !== null)
}

/** The tree path of `probe` under the first visible mount of `projectId` that holds it, or null. */
async function mountTreePath(probe: PathProbe, projectId: string): Promise<string | null> {
  const wsRootAbs = useWorkspaceStore.getState().root ?? ''
  for (const root of await visibleMountRoots(projectId, wsRootAbs)) {
    const treePath = treePathUnderRoot(probe.abs, root)
    if (treePath !== null) return treePath
  }
  return null
}

/**
 * The routing matrix for a resolved on-disk target — shared by terminal Cmd+click, editor links and
 * the file tree's go-to-path row. It never switches the active project. A path the tree shows is
 * one under the active project's root or under one of its visible mounts (whatever the mount's
 * scope); app scope folders are never shown, so a target in one routes as a path the tree can't show.
 *
 *   | target                                                  | action                               |
 *   |---------------------------------------------------------|--------------------------------------|
 *   | directory the tree shows                                | reveal in the FILE TREE              |
 *   | any other directory                                     | Reveal in Finder                     |
 *   | in-workspace file the editor can't open (img/bin)       | Reveal in Finder                     |
 *   | file the tree shows                                     | doc tab here, revealed in the tree   |
 *   | other file inside the workspace                         | doc tab here (workspace-relative)    |
 *   | other file outside the workspace, any type              | doc tab here (absolute path)         |
 *
 * A doc tab's path is workspace-relative inside the workspace and absolute outside it; the tab strip
 * computes its scope mark. A file under an outside mount opens on the mount's tree path (the form a
 * tree click opens), so the two entry points share one tab. An outside file of any type opens as a
 * tab: the editor shows its refusal panel for an image, binary or oversize file.
 */
export async function routeProbe(probe: PathProbe, line?: number): Promise<void> {
  const ws = useWorkspaceStore.getState()
  const activeId = ws.activeProjectId
  const active = buildAllProjects(ws.projects).find((p) => p.id === activeId)
  const rootPath = active?.rootPath ?? ''
  // The Workspace project (rootPath '') is rooted at the workspace, so nothing inside the
  // workspace is ever "outside" it.
  const insideActive =
    probe.wsRel !== null &&
    (rootPath === '' || probe.wsRel === rootPath || probe.wsRel.startsWith(rootPath + '/'))
  const treePath = insideActive ? probe.wsRel : await mountTreePath(probe, activeId)

  if (!probe.isFile) {
    if (treePath !== null) {
      useRevealStore.getState().reveal(treePath, activeId)
      return
    }
    void window.pomade.app.showItemInFolder(probe.abs)
    return
  }
  // `opensInEditor` inspects the extension only.
  if (probe.wsRel !== null && !opensInEditor(probe.wsRel)) {
    void window.pomade.app.showItemInFolder(probe.abs)
    return
  }
  const tabPath = treePath ?? probe.wsRel ?? probe.abs
  openDocFromLink(activeId, tabPath, line, treePath !== null, probe.isSymbolicLink)
}

/** Act on a resolved link. `ambiguous` is the caller's business (it owns the picker UI). */
export function activateResolved(resolved: ResolvedLink): void {
  if (resolved.kind === 'url') {
    void window.pomade.app.openExternal(resolved.url)
    return
  }
  if (resolved.kind === 'path') {
    void routeProbe(resolved.probe, resolved.line)
  }
}

/** Open one candidate chosen from the ambiguity picker (a workspace-relative path). */
export async function activatePickedMatch(wsRel: string, line?: number): Promise<void> {
  const wsRootAbs = useWorkspaceStore.getState().root ?? ''
  const probe = await window.pomade.fs.probePath(wsRel, wsRootAbs)
  if (probe) await routeProbe(probe, line)
}
