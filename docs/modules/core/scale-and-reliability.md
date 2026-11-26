---
doc: docs/modules/core/scale-and-reliability.md
audience: engineers, product
holds: how Pomade stays alive on a ~60k-file workspace — one recursive watcher per root, the watcher settle, the always-warm name index, the ignore lists, and the smoke:scale guard; how it is built
kind: reference
---

# Scale & reliability — staying alive on a 60k-file workspace

**Module:** `core` · **Code:** `src/main/fs-watch.ts` (watchers), `src/main/name-index.ts` (name index),
`src/main/fs-shared.ts` + `src/shared/ignore-names.ts` (ignore lists, bounded walk),
`src/main/watch-scope.ts` + `src/shared/settle.ts` (watcher settle), `scripts/smoke-scale.mjs` +
`scripts/gen-scale-workspace.mjs` · **Guard:** `npm run smoke:scale` · **e2e:**
`watchers-settle.spec.ts`, `name-index-freshness.spec.ts`, `filetree-mounts.spec.ts`

## What it does

Pomade is built to run against a real, large workspace (~30k directories / ~60k files)
without exhausting file descriptors, stalling startup, or going stale. Two engineering
invariants carry that, a settle step covers what a native watcher can miss, and a standalone smoke
harness fails any regression.

## One recursive watcher per root — the EMFILE lesson

Watching the tree with **one watcher per directory** holds one file descriptor each: ~28k directories
mean tens of thousands of descriptors and an `EMFILE` ("too many open files") crash. Pomade uses **one
native recursive `fs.watch` per watched root**, backed by FSEvents on macOS — a single descriptor
regardless of tree size. Per-directory watchers are forbidden; the smoke harness exists largely to keep
it that way.

- **In-workspace entries** are keyed by workspace-relative root (the project's tree root, each mounted
  folder). The file tree holds an entry (`fs.watch` / `fs.unwatch`, idempotent per key); a hosted app's
  `files.watch` *holds* the entry that already covers its folder (counted), opening a new one only when
  none does, so apps never get a watcher of their own. The descriptor closes when neither holds it; only
  a tree-held entry broadcasts `EV.fsChanged`.
- **Outside mounts** (an explicitly mounted folder outside the workspace) get one recursive watcher on
  the root plus one *non-recursive* watcher on its nearest existing ancestor, which catches the root's
  own creation, deletion and rename (a recursive watch is torn down by the OS when its directory is
  deleted, often without an event). Events re-arm the pair when the root appeared or vanished; content
  changes never thrash descriptors. Broadcasts are keyed by absolute path (workspace-relative keys
  never start with `/`, so the two key spaces never collide).
- **Taps.** Git state and local history listen to the same raw events through `tapWorkspaceChanges`; git's
  own metadata (`.git/index`, `HEAD`, `packed-refs`, `MERGE_HEAD`, `config`, `refs/…`) goes through a
  narrow second tap, because a commit or fetch changes repo state without touching a working file.
  Neither opens a watcher.
- **Filtering and debounce.** Events are filtered by `WATCH_IGNORE_NAMES` (`.git`, `node_modules`,
  `.DS_Store`, `.pomade`, `dist`, `out`, `.venv`, `__pycache__`) — deliberately broader than the
  user-editable ignored items, since it only governs refresh noise, not what the tree displays —
  debounced 180 ms per root, and broadcast as one "something under this root changed" event (the tree
  refetches).
- **Skipped paths.** Before any tap or broadcast, an event is tested against `isSkippedRel`
  (`src/main/skipped-paths.ts`): the two local-history stores and the workspace's unwatched folders
  (`fileTree.unwatched`), matched by workspace-relative path, never by name, against the live list. The
  name index and `walkWorkspace` skip the same paths, so neither Pomade's own history writes nor a
  folder the user declared noisy feed the watcher or the walks.
- Watching is best-effort: a watcher error closes the entry without killing the app, and the tree still
  refreshes on user actions. All watchers are closed on a workspace switch.

## The watcher settle

A native recursive watcher is not a complete record: a descriptor that has just opened is not live yet,
and a second change to a path changed moments before can be coalesced away or dropped. Every watcher
that must not miss a change (`files.watch` in main, the file tree in the renderer) therefore re-reads
what it watches at 300 ms and 1200 ms after each trigger (its registration and each burst of events);
a re-check that finds something new restarts the sequence, one that finds nothing moves on, and after
the last delay it goes idle — nothing runs while the disk is quiet. The reading (`watch-scope.ts`) maps
each path in scope to a signature (a folder is its presence; a file its size and mtime; symlinks read,
never followed), honours the workspace's ignored items, the watcher's ignore names and `.pomade`, and gives up
past 5000 entries, after which the watch settles only the paths its events named.

## The always-warm name index

The second full-workspace walk backs terminal file links (Cmd+click on a bare filename or an
extension-less stem — see [file and URL links](../terminal/file-and-url-links.md)). The basename/stem
index is built **eagerly** when the workspace root is set (boot and workspace switch), not on first
hover, so the first Cmd+hover never waits on a walk. It stays fresh through its **own single recursive
watcher** — dirty-directory tracking, a 200 ms patch window (the first event starts the clock, so a build
spewing events still gets patched every 200 ms), patch-not-rebuild — with a full stale-while-revalidate
rebuild every 5 minutes to repair drift, and degrades to a lazy build with a 30 s TTL when `fs.watch` is
unavailable. The watcher starts *before* the first walk, so a file created during the build is not lost.
Lookups return at most 20 matches per name (the stored bucket holds 40 so ranking — exact case first,
then current project — has real candidates); a token containing `/` is resolved by `probePath`, which
never consults the index.

The walk (`walkWorkspace`) is level-by-level with 24 concurrent reads, never descends a symlinked
directory (cycle-safe) and is shared with the frontmatter index.

## Ignore lists

Several sets of names and paths coexist on purpose:

- the **ignored items** (`fileTree.ignore`, user-editable, display only);
- the **unwatched folders** (`fileTree.unwatched`, user-editable, by path: skipped by the watcher and every walk, still shown in the tree) and the local-history stores (always);
- **`WATCH_IGNORE_NAMES`** (watcher refresh noise);
- **`INDEX_IGNORE_NAMES`** — a superset adding build, cache and vendor directories (`build`, `target`,
  `release`, `.next`, `venv`, `.mypy_cache`, `coverage`, `site-packages`, `Pods`, `.repo`, …) — plus
  the user's ignored items. It is hardcoded so that un-ignoring `node_modules` in the tree (a display
  choice) can never turn every index build into a 100k-entry walk.

## The smoke:scale harness

`npm run smoke:scale` is standalone, **not** part of `npm run e2e`; run it before release-ish
milestones (macOS only: the descriptor assertions use `lsof`). It builds the app, generates or reuses a
cached synthetic ~30k-directory/~60k-file workspace in the OS temp dir, launches Pomade against it, and
asserts:

- **[A]** startup + tree render < 15 s (a per-directory watcher design alone would blow this);
- **[B]** main-process fd count < 1000 after startup *and* after a watcher event — the definitive
  per-directory-watcher retro-fail;
- **[C]** the watcher works at scale: a new top-level file propagates into the tree;
- **[D]** symlink indicators render and a directory-symlink cycle does not loop the walk;
- **[E]/[F]** no uncaught main or renderer errors; clean exit;
- **[G]** name index: eager build < 5 s, first lookup < 12 s, warm lookups < 250 ms, stem lookups ride the
  same index, the result cap holds, and the index never grows past its one watcher descriptor;
- **[H]** ten outside mounts arm ten recursive descriptors (one per mount), the fd count stays under
  budget, and unwatching releases every descriptor;
- **[I]** git state: bounded repo discovery plus one `git status` per repo within 3 s, finding the scale
  tree's repos by folder name, with no fd growth;
- **[J]** local history: a burst of 300 files is snapshotted, the main process stays responsive while it
  drains (round trip < 750 ms), and the fd count stays flat.

## Boundaries worth knowing

- The harness's fd assertions (and hence the full guard) are macOS-only.
- The settle bounds missed events to a short window; it does not make the watcher a complete record
  beyond 5000 entries per watch.
- The e2e window-disturbance handling (inactive, transparent, parked windows) is in [app shell](./app-shell.md)
  "Shell-level reliability".

Tickets: T-314, T-315.
