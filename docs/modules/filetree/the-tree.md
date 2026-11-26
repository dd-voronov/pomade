---
doc: docs/modules/filetree/the-tree.md
audience: engineers, product
holds: the Files panel — roots, lazy loading, live refresh (path-batched watcher events, targeted re-reads, settle), ignored items, unwatched folders, header and options menu, go-to-path, git marks, reveal requests; how it is built
kind: reference
---

# File tree — the project-rooted, live file browser

**Module:** `filetree` · **UI:** the Files panel in the side panel ([side panels](../core/side-panels.md)) · **Code:**
`src/renderer/modules/filetree/` (`FileTree.tsx` composition; `use-tree-data.ts` cache and watchers;
`tree-refresh.ts` which folders a change re-reads; `TreeToolbar.tsx`, `GotoBox.tsx`, `TreeSection.tsx`,
`TreeNodes.tsx`, `TreeContextMenu.tsx`), `src/renderer/stores/reveal-store.ts`, `src/main/fs-tree.ts`,
`src/main/fs-watch.ts`, `src/main/skipped-paths.ts`, `src/shared/skipped-paths.ts`, `src/shared/change-batch.ts`, `src/shared/settle.ts`, `src/shared/paths.ts`,
`src/renderer/modules/terminal/term-link-open.ts` (`routeProbe`) · **e2e:**
`filetree-constant-writes.spec.ts`, `filetree-ignore.spec.ts`, `filetree-manage.spec.ts`,
`filetree-mounts.spec.ts`, `filetree-settle-cost.spec.ts`, `filetree-unwatched.spec.ts`, `goto-out-of-scope.spec.ts`,
`goto-reveals-in-mounts.spec.ts`, `watchers-settle.spec.ts`, `smoke.spec.ts`

## What it does

Shows the **active project's** folder (the whole workspace for the Workspace project) as the
first root, followed by any folders the project has [mounted](./mounts.md). Directories load lazily,
one level per expand. The tree stays live through filesystem watchers, hides the
workspace's ignored items, jumps to any typed path, and reveals items in Finder. A click on a file opens
it as a doc tab (with *Single click opens a preview tab* on, in the preview slot — see
[preview tabs](../tabs/preview-tabs.md)); a click on a folder toggles it.

## Roots

The panel body is a stack of **root sections**: the pinned project root first, then each mount in
stored order. Each section has a header (diamond, label, kebab) and, when open, the root's children.
The header toggles the section's collapse; the collapsed set is per project and persisted. Mounts,
their scope marks and their missing state are described in [mounts](./mounts.md). The project root's
header shows its path (`<workspace root>` for the Workspace project) with a `home` chip, and
is a drop target: dropping a row on it moves the item to the project root.

## Data loading

`fs.tree` (workspace-relative path) and `fs.treeOutside` (absolute path) return one level per call
(`depth 1`); `children` are sorted folders first, then by name. Every entry costs one `lstat`; a
symlink costs one more `stat` to learn its target's kind and whether it is broken. A symlinked
directory is walked only when it is the root of the call (an explicit expand), never deeper, so link
cycles cannot loop (see [symlinks](./symlinks.md)). The renderer caches children by path; workspace
paths are relative and never begin with `/`, outside paths are absolute, so both live in one cache.

A switch of project or workspace resets the cache, the expansion set and the selection, then loads
every root of the new project. A root whose read throws is marked **missing** (see [mounts](./mounts.md)).

## Live refresh

The tree watches each in-workspace root (one recursive watcher per root, `fs.watch`) and each
outside root (`fs.watchOutside`); the watched keys also include a within-workspace mount's parent
folder, so the mount's own deletion is seen. The watcher's own skip-list (`.git`, `node_modules`,
`.DS_Store`, `.pomade`, `dist`, `out`, `.venv`, `__pycache__`; see `src/shared/ignore-names.ts`) is
broader than the ignored items, so un-ignoring `node_modules` shows it without turning each change in
it into a refresh storm. Beyond names, the watcher skips **by workspace-relative path** the
local-history stores and the workspace's [unwatched folders](#unwatched-folders): an event under one
reaches no tap (tree, git state, local history, apps' `files.watch`). The path list is read on every
event (`isSkippedRel`, `src/main/skipped-paths.ts`), so an edit applies without a restart.

A refresh re-reads only what a change can have altered:

1. **Main batches paths.** Each watcher root collects the changed paths in a batch
   (`createChangeBatch`, `src/shared/change-batch.ts`): it closes after 180 ms without a new path and
   never later than `BATCH_MAX_WAIT_MS` (1 s) after its first, so a file written more often than
   every 180 ms cannot hold the batch off. The batch is sent as `FsChangedEvent { root, changes }` —
   each path (workspace-relative; absolute under an outside root) with whether it exists when the
   batch closes. `changes` is `null` when the batch cannot name its paths: an event without a path,
   more than `BATCH_MAX_PATHS` (1000) distinct paths, or an outside root's own appearance or removal.
2. **The tree batches again** (150 ms quiet, the same 1 s maximum wait) across all watched roots.
3. **`foldersToReread`** (`tree-refresh.ts`) picks the loaded folders to re-read: a changed path whose
   existence disagrees with its parent's listing (an entry appeared, disappeared or was renamed)
   re-reads that parent; a path that no longer exists re-reads every loaded folder at or under it; a
   root that is the changed path or lies under it is re-read. Existence decides, never the native
   event kind — macOS reports a plain write as a rename. A name the tree hides (the workspace's
   ignored items unless *Show ignored items* is on; the fixed index ignore names under an outside
   root) is in no listing, so changes to it re-read nothing.
4. A `null` batch re-reads everything the tree shows.
5. **Skip-list folders are polled.** The watcher drops every change below a skip-list folder, so no
   batch ever names a path in one. `skipListFolders` (`tree-refresh.ts`) picks the loaded, expanded
   folders that sit inside a skip-list name below their root (measured from the nearest root; a root
   itself is never one); the tree re-reads them every 2 s (`SKIP_LIST_POLL_MS`, one pass at a time,
   nothing when none is expanded) and again when such a folder is expanded, since its cached listing
   goes stale while collapsed.

A write to a file the tree already lists therefore costs no folder read. Git marks, hosted apps'
`files.watch` and local history take their own taps on the watcher and are unaffected.

macOS file events can drop a change (one made just as the watch opens; a second change moments after
the first). The tree therefore **settles**, re-reading at 0.3 s and 1.2 s (`SETTLE_DELAYS_MS`) and
restarting the sequence whenever a re-read finds something new:

- **Full settle** — re-reads everything the tree shows. It runs once the watches are registered and
  after a `null` batch, where nothing narrower is known.
- **Targeted settle** — after a refresh a path-naming batch caused, re-reads only the folders the
  refreshes of that settle re-read: a dropped event is a second change to a path changed moments
  before, whose folder the first change already named. The set of folders resets when the sequence
  ends. A batch that re-reads no folder starts no settle.

Idle costs nothing. No manual refresh exists. Moves and renames done inside Pomade also retarget open
doc tabs (see [file-management](./file-management.md)).

## Ignored items

The workspace's ignored items — names (default `.git`, `node_modules`, `.DS_Store`; stored per
workspace in `workspace.json` as `fileTree.ignore`) — are not returned by `fs.tree`. The list governs
display only; dot-files not on it show like any other entry. Outside roots use the fixed index ignore names in `fs-shared` and ignore the setting and
the toggle below.

## Unwatched folders

Settings ▸ File tree ▸ **Unwatched folders** is a per-workspace list of folders (workspace-relative,
`/`-separated; stored as `fileTree.unwatched` in `.pomade/workspace.json`). A folder on it, and
everything inside, is skipped **by path, never by name**, by the watcher, the name index and the
frontmatter index walk (`isSkippedPath` in `src/shared/skipped-paths.ts`, the same check that skips the
local-history stores, `Apps/Pomade/local-history/` and `Apps/Pomade/dev/local-history/`). Entries are
normalized on add (`normalizeUnwatchedFolder`): trailing `/` and leading `./` dropped; empty, absolute,
the workspace root and `..` paths are refused. Adding or removing applies at once: `setUnwatchedFolders`
runs on activation and on every config save, the name index re-walks the folders that left the list
and forgets the ones that entered, and the tree re-reads every loaded listing.

The tree still lists the folder and its contents, read on expand (`fs.tree` is not filtered). Nothing
refreshes them live, so an expand re-reads the folder even when cached (`use-tree-data.ts`). The
folder's own row (not its descendants) carries a faint struck-bell mark, `FileNode.unwatched`, tooltip
`Not watched — changes inside show when you expand the folder again` (`data-unwatched`,
`tree-unwatched-<path>`). Local-history stores are shown only with *Show ignored items*, dimmed.
Settings lists a path that is gone from disk dimmed (`Not in the workspace any more`), still stored.
Only workspace-relative paths match: an outside mount's absolute paths are never unwatched.

## Header and options menu

The tree header reads `Files` (plus the selection count while more than one row is selected) and has
four buttons:

- **Collapse** (`«`, tooltip `Collapse side panel (Cmd+Shift+B)`) — hides the side panel, leaving
  only the icon strip. A pure width change; panes, terminals and the tree's state are untouched.
- **New file** (＋) and **New folder** — open the name prompt. The target folder follows the
  selection's anchor: a selected folder → inside it, a selected file → its parent, nothing selected →
  the project root. A name containing `/` creates the folders in between.
- **File tree options** (⋯) — a menu:
  - **Ignored items…** — opens Settings ▸ File tree, where the ignored items are edited (add,
    remove, reset to default).
  - **Hide git status** / **Show git status** — toggles all git marks in the tree; remembered across
    launches ([git in the tree](../git/git-in-the-tree.md)).
  - **Show ignored items** / **Hide ignored items** — reveals ignored entries dimmed in the project
    root and in within-workspace mounts. Held in the tree's state until Pomade quits (a project switch
    keeps it); it never changes the stored list.
  - **Mount new folder…** — opens the mount dialog ([mounts](./mounts.md)).

## Go-to-path row

A quiet `Go to path…` input under the header. Paste or type a path and press **Enter**; the
clipboard button (`Paste path`) fills the input from the clipboard (Enter still submits). **Esc**
clears the input. A path is **workspace-relative**, **absolute**, or **`~`-prefixed** (expanded
through `window.pomade.env.home`); a leading `./` and trailing `/` are dropped, and a path with a `..`
segment is resolved by main rather than matched against the project root. The inline error is `Not found`, cleared on the next edit.

A target **under the active project's root** is stat'ed; if it exists the tree reveals it (expands
the ancestors, selects the row, scrolls it into view) and, for a file, opens it as a doc tab. Any
other target is resolved on disk by main (`fs.probePath`, which canonicalizes through realpath) and
routed through the shared routing matrix (`routeProbe` in `term-link-open`), exactly as a terminal
Cmd+click is, so the two cannot drift. The tree **shows** a path that lies under the project's root
or under one of the project's visible mounts, whatever the mount's scope; a mount is compared by its
canonical path, and a missing mount is left out:

- a **folder the tree shows** is revealed in its section (see "Reveal requests"); no tab opens;
- a **file the tree shows** opens a doc tab keyed on its tree path — the form a tree click opens, so
  both share one tab — and is revealed in its section; a mount outside the project shows the
  tab's orange or red scope mark unless the mount is in the project's scope
  ([mounts](./mounts.md) "Project scope");
- any **other file inside the workspace** opens a doc tab keyed on its workspace-relative path
  (orange scope mark); the tree does not move;
- any **other file outside the workspace** opens a tab keyed on the absolute path (red scope mark);
  an image, binary or oversize file shows the standard refusal panel;
- a **folder the tree does not show** is revealed in Finder; an in-workspace image or binary the
  editor cannot open is too.

When a root-anchored path fails but the same path under `$HOME` exists — the usual result of deleting
the leading `~` from `~/Downloads/x` — a small cancelable popover under the input says
`Not found — did you mean ~/…?` with **Apply** and **×**. Apply fills the input with the `~/…`
variant and submits it; **×**, a click elsewhere, **Esc** or typing dismisses it and keeps the typed
text. The popover instead of an inline message keeps the input full-width.

## Git marks

Changed rows carry a git letter at the right edge and a tinted name (`M` `U` `C` `R`), folders with
changes inside carry a dot, gitignored rows are dimmed, and deleted files and folders stay in place as
red, struck-through ghost rows (click one to view its last committed version and restore it; ghost
rows are never selectable, draggable or drop targets, and have no context menu). Marks key on
workspace-relative paths, so rows under an outside mount carry none. Details:
[git in the tree](../git/git-in-the-tree.md).

## Reveal requests

Other surfaces post a reveal request to `reveal-store`
(`{ projectId, path, expand, nonce }`); the side panel brings Files forward and the tree performs it
once it is rooted at that project. The path is a tree path: workspace-relative under the project root
or a workspace mount, absolute under a mount outside the workspace. The tree finds the first root
section, in display order (project root, then mounts in stored order), that holds the path, opens that
section if it is collapsed, loads and expands the ancestors within it, selects the row and scrolls it
into view. A path equal to a root's own path scrolls that root's header into view and flashes it.
A path no root holds is ignored. A cross-project reveal switches the project first.

`expand` decides whether a revealed **folder** opens itself too. Pomade's own reveals — go-to-path,
a terminal link, the Git panel's untracked folder, the symlink popover's **Reveal in tree** — leave it
off, so the folder is selected and in view with its ancestors open and its own children collapsed. An
app's `files.reveal` (Host API) sets it: the folder is loaded and expanded. A file is selected either way.

## Boundaries worth knowing

- Selection and expansion are session state, cleared on every project or workspace switch; the
  collapse state of root sections is persisted per project.
- Chevrons, indent guides and file-type icons are display only.
- A change inside a folder on the watcher's skip-list (`node_modules`, `dist`, …) raises no event; an
  expanded listing of such a folder updates through the 2 s poll, so it can lag a change by that long.
- An unwatched folder is not polled: its open listing stays as read until it is collapsed and expanded
  again.

Tickets: E-026, T-019, T-105, T-122, T-143, T-144, T-243, T-273, T-275, T-292, T-296, T-314, T-315.
