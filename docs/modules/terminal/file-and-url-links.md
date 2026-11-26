---
doc: docs/modules/terminal/file-and-url-links.md
audience: engineers, product
holds: Cmd+click links in terminal output — what is detected, how a token resolves, the routing matrix, the name index, caching and click-time resolution; how it is built
kind: reference
---

# File & URL links — Cmd+click paths in terminal output to open them

**Module:** `terminal` · **UI:** Cmd+hover underline, Cmd+click, the ambiguity picker
(`terminal-link-picker`) · **Code:** `src/renderer/modules/terminal/term-links.ts` (scanner),
`term-link-open.ts` (resolver, router `routeProbe`, mount lookup, resolution cache), `term-link-rows.ts` (buffer→link geometry,
wrapped-path join), `useXtermSession.ts` (`attachLinkProvider`, click-time fallback),
`TerminalPane.tsx` (picker JSX, e2e hooks), `src/main/name-index.ts` (name index),
`src/main/fs-service.ts` (the `fs.find*` handlers) · **e2e:** `terminal-links.spec.ts`,
`terminal-link-meta.spec.ts`, `terminal-first-click.spec.ts`, `terminal-link-case-insensitive.spec.ts`,
`terminal-link-dir-suffix.spec.ts`, `terminal-link-file-suffix.spec.ts`,
`terminal-link-folders.spec.ts`, `terminal-link-hidden-pane.spec.ts`, `terminal-link-jump.spec.ts`,
`terminal-link-line-range.spec.ts`, `terminal-link-picker-line.spec.ts`,
`terminal-link-picker-scroll.spec.ts`, `terminal-link-wrap-join.spec.ts`,
`terminal-link-wrap-join-r2.spec.ts`, `terminal-outside-workspace.spec.ts`

## What it does

File paths and URLs in terminal output are live links. Hold **Cmd** and hover — anything that
resolves to a real file, folder or URL underlines with a pointer cursor; **Cmd+click** opens it (doc
tab, file-tree reveal, Finder, or browser, per the routing matrix below). A **plain click never
navigates** — it stays a selection/focus gesture, so copying a path is never blocked. Links that do
not resolve are never underlined: **no dead links**. The same links work in an attached tab, resolved
against the session's folder ([attached-terminals](./attached-terminals.md)).

## The Cmd behavior

Links are *detected and resolved on every hover*, Cmd or no Cmd — the modifier only toggles the
**decorations** (underline + pointer). Pressing Cmd while the pointer is parked on a path lights it
up at once; releasing Cmd (or the window losing focus) drops the underline. Activation re-checks the
modifier on the click itself, which is what guarantees a plain click never opens anything. xterm
caches one provider reply per hovered line, so a modifier change flips the decorations on the reply
already handed over instead of re-querying.

## First-click fallback

A Cmd+click opens a link on the **first** click — no hover dwell required. xterm's own link
activation only fires for a link that had *already resolved by mousedown*, and resolution is async
(a probe round trip per candidate), so the pane runs a **click-time resolution fallback**: on a
Cmd+click xterm did not itself activate, it takes the clicked cell, resolves that row's links on the
spot and opens the one under the cell through the same path as a hover-driven click. The fallback
resolves **fresh, bypassing the negative cache** — an explicit click is fresh intent, so a path
cached as "not a file" opens the moment it exists. A one-shot guard ensures a click xterm already
handled never opens twice; a plain click, a non-left button and a Cmd+drag (moved more than 3 px)
never trigger it.

The fallback's `mouseup` listener is window-scoped (it must run after xterm's screen-element
handler), so it fires for **every mounted terminal pane** — and all projects' tabs stay mounted,
hidden with `display:none`. It therefore acts **only when the click landed inside its own terminal**
(`container.contains(event.target)`); without that gate a hidden pane would map the global click
coordinates onto a clamped cell of its own grid and open a stray file from another project's buffer.

## What is detected

Tokens are split on whitespace **and opening brackets/quotes** (`( [ { < " ' \` «`) — agent CLIs print
tool headers like `Read(docs/CONTRACTS.md)`, so the path inside is found. Trailing closers and
punctuation ``)]}>"'`»,;.!?:`` are trimmed. A candidate is:

- an **http/https URL** (only those two schemes — terminal output is untrusted text);
- an **absolute** path (`/…`), **home-relative** (`~/…`), or **relative** path (contains `/`);
- a **bare filename** with a letter-initial extension of up to 8 characters (`me.md`, `index.tsx` —
  never `1.5`/`v2.10`);
- an **extension-less word** of ≥ 4 characters from `[A-Za-z0-9._-]` (`VISION`, `Makefile`,
  `CONTRACTS`) — a *stem*, linked only when the workspace actually holds a matching file (VS Code
  parity). `~`, `/`, `.` and `..` alone are never candidates.

A trailing `:line`, `:line:col` or line range `:N-M` (compilers, `grep -n`, stack traces, the hunk
range an agent prints) is part of the underlined token; the path resolves without it and the file
opens at the **start** of the range. A file that opens **raw** scrolls to the line, centered, and
places the caret there; Markdown opens rendered, where the line is mapped through the caret bridge
(a stale `file.ts:9999` clamps to the last line). URLs are classified before the suffix, so `:8080`
stays a port.

## How a token resolves

A candidate resolves to nothing (not a link), one target (opens directly) or several (the picker).

- **Absolute / `~`** — probed directly.
- **Relative** — probes, first hit wins: **terminal cwd → project root → workspace root** (a
  leading `./` is dropped; duplicates are skipped). The cwd is the shell's *live* `$PWD`, reported by
  the shim on every prompt, so a `cd` is tracked exactly ([shell-integration](./shell-integration.md)); before the first
  prompt it is the tab's launch directory.
- **Bare filename** that probed nowhere → the workspace **basename index**.
- **Stem** → `<cwd>/<word>` first (a file *or* a directory sitting where the shell is wins outright),
  then the index by basename-minus-extension (a name that is exactly the word also counts).
- **Slashed token** that missed every probe base → the **suffix indexes**, only after every probe
  failed so a real relative path always wins: files whose trailing path segments equal the token's
  segments (segment-aligned, so `docs-reviewed/x.md` does not match `session-docs-reviewed/x.md`),
  then directories the same way. A token with a trailing slash goes straight to directories. A
  bare-basename guess is never made for a slashed token; every index answer is re-confirmed on disk
  before it is linked.

**Matching is case-insensitive** everywhere: prose `Northwind` links `northwind.md`, and a path printed
in a different case than on disk still resolves. The index keys fold to lowercase and the exact case
is recovered from the stored path. Results **rank** exact-case first, then the current project, then
the rest.

- **exactly one match** → opens directly;
- **several** → a picker at the pointer: *"N files named "x""*, each row showing name and parent
  directory, ranked as above — click one to open it (Escape or a click outside cancels);
- **none** → not a link, no underline.

**Wrapped paths.** The provider reads the full logical line, so a path soft-wrapped across rows
underlines and opens as one link, and wide glyphs (CJK, emoji) never skew the underline. Agent CLIs
also **hard-wrap** long output: a path ends one row and continues on a hanging-indent row (a separate
logical line, sometimes breaking inside the filename). When a path-like candidate at a row edge fails
on its own, the provider joins up to 3 neighboring fragments (a slashed head, then continuations),
resolves the joined target, and emits **one** link spanning the rows — only if the join resolves on
disk. A continuation may be a slashless fragment (a hard wrap inside a long filename), but a join must
contain a slashed head: two slashless prose words on adjacent rows never join, and prose rows do no join
work (no probe runs).

## Routing matrix

| Target | Cmd+click does |
|---|---|
| URL | default browser |
| directory the tree shows — under the active project's root or under one of its visible mounts | reveal + focus in the file tree (a mount's folder in the mount's section) |
| any other directory (incl. outside the workspace) | Reveal in Finder |
| **in-workspace** file the editor cannot open (image/binary) | Reveal in Finder |
| file the tree shows | doc tab here, revealed in the tree (a file under a mount, in the mount's section) |
| other file in the workspace, outside this project | doc tab **here** + orange "outside this project" tab badge |
| other file **outside the workspace root**, any type | doc tab **here**, keyed on the ABSOLUTE path (image/binary/oversize → the refusal panel) |

**Visible mounts.** The tree shows a path when it lies under the active project's root or under one of
the project's visible mounts, whatever the mount's scope (`routeProbe` → `mountTreePath`). Each mount
is resolved through `fs.probePath` (realpath) and compared with the target's canonical path
(`treePathUnderRoot`, `src/shared/paths.ts`), so a mount typed through a symlink still matches. A
folder under a mount is revealed in the mount's section (ancestors loaded and expanded, row selected,
scrolled into view). A file under a mount opens on the **mount's tree path** — workspace-relative for
a mount inside the workspace, absolute for an outside one — the same path a tree click opens, so both
entry points share one tab; it is revealed in the section too, and the tab's scope mark follows the
project scope (an in-scope mount: no mark). A file under a mount inside the workspace that the
editor cannot open (image/binary) still goes to Finder. A file in an
app scope folder is not shown by the tree and routes as any other file the tree cannot show. The
same router serves the editor's links and the file tree's go-to-path row ([the-tree](../filetree/the-tree.md)).

A Cmd+click **never switches the active project** — a cross-project file opens in the current
project's tab strip (the tree cannot show it, so the orange badge is the affordance). Doc tabs open
as real tabs (never the preview slot); a file already open jumps to its tab; a symbolic link keeps
its tab-strip glyph.

**Outside the workspace root.** A file that resolves outside the workspace is a distinct object
class: it opens as a doc tab whose `path` is the **absolute** path (never in the tree, not indexed, no
workspace-relative form). The editor reads and writes it through the narrow `fs.readOutside` /
`fs.writeOutside` / `fs.statOutside` door; the first save in a tab session asks "Save outside your
workspace?" (later saves are silent; reopening the tab re-arms it), and a restored outside tab whose
path no longer resolves is dropped silently. An outside image/binary/oversize file shows the standard
refusal/unsupported panel (with a Reveal-in-Finder button); only an outside **folder** goes to
Finder. Full detail: [save-and-file-lifecycle](../editor/save-and-file-lifecycle.md) and [contracts/ipc-workspace-and-files](../../contracts/ipc-workspace-and-files.md) "fs — outside-workspace doors".

## The always-warm name index

Bare-name, stem and suffix lookups hit an in-memory index that is **built eagerly** when the
workspace opens (boot and workspace switch), so the first hover of a session never pays a build.
Freshness is watcher-driven: one recursive watcher at the workspace root marks changed directories
dirty and patches the index after a 200 ms debounce, with a low-priority full rebuild every 5 min as a
safety net. If the watcher cannot run, the index degrades to lazy-build with a 30 s TTL.

**Trade-off:** build outputs and vendored trees — `node_modules`, `.git`, `dist`, `out`, `build`,
`target`, `release`, `.next`, venvs, tool caches, `site-packages`, `Pods`, `.repo`, … — are **never
indexed**, even if you un-ignore them in the file tree (a display choice must not turn every hover
into a 100k-entry walk). What is lost is only *bare-name/stem/suffix* links into those trees; any
token containing a `/` that resolves by direct probing still works.

## Boundaries worth knowing

- **Resolution caching:** a resolved link stays cached 5 s (a deleted file stops being clickable
  fast); a *negative* — "this word is not a file" — is cached 30 s, so a file created seconds ago can
  take up to 30 s to underline on **hover** on a row you already hovered. A **Cmd+click** never waits
  on that window: the click-time fallback re-resolves fresh. The cache key keeps the token's exact
  case, so two casings of one name each get their own ranking.
- Paths with spaces cannot be told apart from two paths and are not guessed at.
- **The picker's 20 is a hard cap:** `FIND_BY_NAME_MAX = 20` in `name-index.ts` bounds every lookup
  result. Matches beyond 20 are absent until the token is narrowed by a longer suffix (e.g.
  `superpowers/specs/` instead of `specs/`).
- The picker is height-bounded and scrolls internally: on the shared `ContextMenu` primitive, its
  shell carries `max-height: calc(100vh - 16px)` and `overflow-y: auto`, so a list taller than the
  window stays reachable by scroll (`terminal-link-picker-scroll.spec.ts`).

Tickets: T-086, T-091, T-092, T-099, T-102, T-105, T-106, T-188, T-193, T-197, T-292.
