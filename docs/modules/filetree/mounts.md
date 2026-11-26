---
doc: docs/modules/filetree/mounts.md
audience: engineers, product
holds: mounted roots — extra folders in a project's tree, inside or outside the workspace; scope marks, missing state, the outside-workspace doors, persistence; how it is built
kind: reference
---

# Mounts — extra roots in a project's file tree

**Module:** `filetree` · **UI:** root headers in the Files panel; the `Mount new folder…` item of the
File tree options menu; the `Mount a folder` dialog · **Code:** `src/renderer/stores/mounts-store.ts`,
`src/renderer/stores/project-scope.ts`, `src/shared/paths.ts`,
`src/renderer/modules/filetree/{TreeSection,MountPopup,use-tree-data,filetree-ops}.ts(x)`,
`src/main/{fs-tree,fs-watch,fs-ops,fs-service,ws-path}.ts` · **e2e:** `filetree-mounts.spec.ts`,
`project-scope.spec.ts`, `goto-reveals-in-mounts.spec.ts`, `outside-fs-door.spec.ts`

## What it does

A project's tree shows its own folder first. A **mount** adds another folder below it as a further
root section: a folder elsewhere in the workspace, or any folder on disk outside the workspace.
Mounts belong to one project (the Workspace project can mount too) and are shown only while
that project is active. A mounted folder behaves like a peer of the project root: expand, open,
create, rename, move, copy and trash all work in it, and it is live.

## Adding, renaming, removing

**File tree options (⋯) ▸ Mount new folder…** opens the `Mount a folder` dialog: one text input
(`Folder path (e.g. Knowledge)`) — no folder picker — and **Mount** / **Cancel**; **Enter**
submits. The path may be workspace-relative, absolute, or `~`-prefixed (`validateMountPath`).
A path inside the workspace is stored workspace-relative; any other absolute path is stored absolute
with `outside: true`. A live hint under the input reads:

- `Inside this project — already visible in the tree.` (the folder is under the project's root; it
  still mounts);
- `Outside this project — mounts with an orange mark.`;
- `Outside the workspace — mounts with a red mark.`;
- `Already shown — Mount jumps to it.` when the path equals a visible root's path.

Below the hint sits the **Add to project scope** checkbox (off for every new dialog) with an (i) whose
tooltip reads `Files in this folder count as part of this project: no 'Outside this project' mark.`
Ticked, the hint for a folder outside the project reads `Outside this project — in project scope, so
no mark.` or `Outside the workspace — in project scope, so no mark.` (see "Project scope" below).

Only an empty input is refused (**Mount** is disabled). A duplicate adds nothing: the existing root
scrolls into view and flashes. A new mount flashes its header.

Every root header has a **⋯** button (`Root actions`) and a right-click menu with **Copy path**,
**Copy full path**, **Reveal in Finder**; a mount's menu adds **Add to project scope** /
**Remove from project scope** (the same tooltips as the dialog's (i): the add tip, and `Files in this
folder stop counting as part of this project and get the scope mark again.`), **Rename** and **Unmount**. The project
root's menu has no Rename or Unmount. **Rename** edits a cosmetic label inline in the header
(Enter commits, Esc cancels, empty restores the path label); it never renames the folder, and
**Copy path** still copies the real path. **Unmount** removes the root from the tree only; nothing on
disk is touched.

## The header

Left to right: a **diamond** (collapse toggle: solid = expanded, hollow = collapsed), the label, the
`home` chip on the project root, a `⚠` when the root is missing, and the ⋯ button. The label is the
custom name when set, else the path as a dimmed parent plus an emphasized leaf; outside paths are
shown home-relative (`~/…`). Hovering shows the absolute path. The diamond's color is the root's
**scope** (`classifyScope(path, projectRoot, scopeFolders)`): accent (blue) for the project root,
anything inside it and an in-scope mount; orange for a workspace folder outside the project, red for
a folder outside the workspace.
Clicking anywhere on the header toggles the collapse; the collapsed set is stored with the project.
A header is a drop target: a row dropped on it moves into that root's top folder.

## Missing roots

A root whose read fails (folder deleted, moved, never existed, volume unmounted) is **missing**: its
header is muted and struck through, shows a red `⚠` with a two-line tooltip (the scope line, then
`Path doesn't exist`; the scope line of an in-scope mount is `In project scope`), and its children are not drawn. The mount is kept — never auto-removed — and
can still be unmounted. Missing is live in both directions: when the folder appears again the root
activates without switching project, because the watchers cover the root's parent (see below). A
persisted mount whose folder is gone at startup loads directly into the missing state.

## Project scope

A mount can be put in its project's **scope**: the project's scope is its root folder plus its
in-scope mounts (`useProjectScopeFolders`, derived from the mounts, never stored separately). A file
under an in-scope folder counts as the project's own: its doc tab and the editor header carry no
orange or red scope mark, and the editor header's path reads `<folder name>/…` from the deepest
in-scope folder holding the file (`classifyScope`, `scopeRelativePath` in `src/shared/paths.ts`).
The flag is per project: the same folder stays outside the scope of another project that mounts it
without the flag, and marks as before. Scope is set in the mount dialog's **Add to project scope**
box, or later through the mount menu's **Add to project scope** / **Remove from project scope**
(`setMountInScope`); the change repaints the diamond and the open tabs' marks at once. A mount's
section behaves the same either way: reveals and go-to-path treat every visible mount as a place the
tree shows, in scope or not.

## How outside roots are read and written

A path starting with `/` is the signal for "outside the workspace" throughout the renderer
(`isOutside`, `fetchTree`, the `*D` dispatch helpers in `filetree-ops.ts`); a workspace-relative path
never starts with `/`. Outside paths go through dedicated main-process doors that each require an
absolute path (`requireAbs`) and bypass the escape-refusing `abs()` guard used by every in-workspace
call:

| Operation | In-workspace channel | Outside channel |
|---|---|---|
| list a level | `fs.tree` | `fs.treeOutside` |
| watch | `fs.watch` | `fs.watchOutside` |
| create file / folder | `fs.createFile`, `fs.createDir` | `fs.createFileOutside`, `fs.createDirOutside` |
| rename | `fs.move` | `fs.renameOutside` (sibling name) |
| move / copy | `fs.move`, `fs.copy` | `fs.moveOutside`, `fs.copyOutside` |
| trash | `fs.trash` | `fs.trashOutside` |
| read / write / stat a doc | `fs.read`, `fs.write`, `fs.stat` | `fs.readOutside`, `fs.writeOutside`, `fs.statOutside` |

Both families share the same cores in `fs-ops.ts` (collision, self-descendant and OS-trash rules),
so the two cannot drift. Interface details: [contracts/ipc-workspace-and-files](../../contracts/ipc-workspace-and-files.md) "fs — outside-workspace doors", [contracts/types](../../contracts/types.md) "Per-project state".

Rules that differ outside the workspace:

- **Deleting always confirms** (`Delete “<name>”?` / `Delete N items?`, **Move to Trash**, text
  `… is outside your workspace and will be moved to the Trash.`); an in-workspace delete does not.
- **No crossing the boundary.** Paste is disabled with the tooltip `Can't paste across the workspace
  boundary` when the clipboard and the target folder are on different sides; a multi-selection that
  mixes inside and outside rows has Cut, Copy, Paste and Move to Trash disabled (`Selection mixes
  inside and outside the workspace`). Open, Copy path and Reveal stay enabled.
- **Tree-display and file operations only.** Outside paths are not in the terminal name index,
  carry no git marks, and no repository discovery follows them. The ignored items do not
  apply: a fixed list of build and cache names (`INDEX_IGNORE_NAMES`) is left out and **Show ignored
  items** does not reveal them.
- **Start new project from here** is disabled on a folder under an outside root (tooltip `This folder
  is outside your workspace`); under a within-workspace mount it works.

## Watching

Per-directory watchers are never used (descriptor exhaustion). A within-workspace mount shares the
workspace's recursive watcher machinery and additionally watches its parent folder so its deletion is
seen. An outside root has one recursive watcher on the root plus one non-recursive watcher on its
nearest existing ancestor: the ancestor watch sees the root appear, vanish or be renamed, and
re-arms the recursive watcher after such a change (`armOutside` in `fs-watch.ts`). Events arrive on
the same `fs.onChanged` channel, keyed by the absolute root path and carrying absolute changed paths; a
change to the root itself (appearing, vanishing) is reported without paths, so the tree re-reads
everything ([the tree](./the-tree.md) "Live refresh"). Workspace switches close all watchers. The workspace's unwatched folders and the local-history stores are
skipped by workspace-relative path, so they apply to a within-workspace mount's paths and never to an
outside root's absolute ones ([the tree](./the-tree.md) "Unwatched folders").

## Persistence

`mounts` (`{ id, path, outside?, name?, inScope? }[]`; `inScope` is written only when true) and `collapsedRoots` (mount ids, plus the sentinel
`__project_root__` for the project root) live in `.pomade/state/<projectId>.json` next to the tab
state; `mounts-store` owns only those two fields and main merges its partial saves over the tabs
store's (see [per-project tab state](../tabs/per-project-tab-state.md)). The state directory is
gitignored: mounts are machine-local. Deleting a project removes its mounts with its state file.

## Boundaries worth knowing

- A mount appears under the project it was added in; the same folder can be mounted in several
  projects independently.
- Mounts are never shown in the Projects panel and cannot be reordered.

## Known limits

- A drag-and-drop move checks for a name clash with the in-workspace `fs.exists`, which answers
  `false` for an absolute path. Inside an outside root a clash therefore ends in the
  `A file named "…" already exists` error toast instead of the collision dialog; Cut → Paste shows
  the dialog.
- Dragging a workspace row onto an outside root (or the reverse) fails with an error toast
  (`Path escapes workspace` or the outside door's absolute-path error); the boundary is only
  enforced up front for Cut / Copy / Paste.

Tickets: E-026, E-047, T-129, T-131, T-132, T-133, T-135, T-137, T-144, T-290, T-315.
