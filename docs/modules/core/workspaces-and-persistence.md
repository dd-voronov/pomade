---
doc: docs/modules/core/workspaces-and-persistence.md
audience: engineers, product
holds: the workspace folder, where every kind of state persists (workspace, project, app settings, local history, user data), write discipline and the quit handshake, startup, and switching workspaces; how it is built
kind: reference
---

# Workspaces & persistence — where everything lives and how it survives

**Module:** `core` · **UI:** first-run picker (`pick-workspace`), Settings ▸ General ▸ `Change
workspace…`, File ▸ `Change Workspace…`, optional startup prompt · **Code:**
`src/main/config-store.ts`, `src/main/atomic-write.ts`, `src/main/index.ts` (quit handshake, hooks),
`src/renderer/stores/workspace-store.ts`, `project-state-persistence.ts`, `workspace-ui-store.ts`,
`src/renderer/layout/WorkspacePicker.tsx` · **e2e:** `workspace-switch.spec.ts`, `settings.spec.ts`,
`persistence-unification.spec.ts`, `smoke.spec.ts`

## What it does

Pomade runs against exactly **one workspace folder** at a time — the directory holding your
projects, apps, and agents. Everything shareable about the workspace (groups, projects, the file-tree
ignored and unwatched folders, agent overrides) lives in a **`.pomade/` folder inside the workspace itself**, so it
travels with the folder (git, another machine). Machine-local state — app settings, window layout,
open tabs — lives in the workspace's gitignored `.pomade/` files; only the remembered workspace root,
unsaved-document recovery and the Host API's run files live in the app's own `userData` storage. On launch Pomade silently reopens the last workspace; switching to another one is a full,
clean teardown-and-rebuild.

## Where each thing persists

Inside the workspace, `<workspace>/.pomade/`:

- **`workspace.json`** — shared config: `groups`, `projects`, the workspace identity icon, Ungrouped's
  top-level position (`ungroupedOrder`), `fileTree.ignore` (names the tree hides) and `fileTree.unwatched` (workspace-relative folders the watcher and indexes skip, [settings](./settings.md) "File tree"). Meant to be committed. Read field by
  field: an unknown key is ignored on load and dropped on the next save; a missing `fileTree` defaults;
  a project without a `visibleAgents` list offers every agent (`['*']`). The group tree is normalized on
  load (dangling parents, cycles and over-deep chains repaired) and a repair is written back.
- **`settings.json`** — the app's preferences (`AppPreferences`): every `AppSettings` field except the
  view-state keys — markdown default mode and formatting, preview tabs, terminal font and copy-on-select,
  em-dash replacement, fonts, confirm-workspace-on-startup, git status marks, muted notice sources, the
  local-history lists and size cap ([settings](./settings.md)). Not gitignored: it travels with the
  workspace. Unknown keys are dropped on read; a missing or partial file reads as the defaults for what
  it lacks.
- **`agents.json`** — agent roster overrides: `commands` (per agent id) and `hidden` (a list).
- **`state/<projectId>.json`** — per-project session state: `openTabs`, `activeTabId`, the closed-tab
  `reopenStack` (capped at 10), `propertiesPanelExpanded`, `mounts` (extra file-tree roots; each may be `inScope`, a folder counted
  as part of the project's scope) and `collapsedRoots`, and the side panel shown (`sidePanel`). Machine-local.
- **`state/view.json`** — the app's view state (`AppViewState`, `APP_VIEW_STATE_KEYS`): the `layout` block
  (column widths, Projects panel and side panel collapse), `editorHeaderShowPath`, `docHistoryFolded`,
  `compareChangesOnly`. Machine-local.
- **`state/workspace-ui.json`** — workspace-scoped Projects panel state: `lastActiveProjectId` (the project
  reopened at launch), `collapsedGroups`, and `overlayPositions` (where each app's overlay was left).
- **`state/scrollback/<tabId>`** — each terminal's saved scrollback (raw bytes), replayed above the
  restore rule after a restart ([panes and lifecycle](../terminal/panes-and-lifecycle.md)). Orphans (no
  tab in any `openTabs` or `reopenStack`) are collected at boot and after a workspace switch.
- **`assets/<id>.<ext>`** — images imported through the icon pickers, referenced by
  workspace-relative path so configs stay portable.

Opening a workspace creates `.pomade/state/scrollback/` and, if absent, `.pomade/.gitignore`
containing `state/`, so machine-local state never lands in git. Each project's tabs are keyed by its
nanoid; the Workspace project (`WORKSPACE_PROJECT_ID`) has a state file like any other and is
not stored in `workspace.json`.

Both settings files are read and written by `config-store.ts` through `app-settings-files.ts`; a patch
touches only the file whose keys it changes. A stable and a dev Pomade opened on the same workspace share
them.

**Local history** lives in the workspace: `Apps/Pomade/local-history/` for the stable Pomade,
`Apps/Pomade/dev/local-history/` for a dev build (`localHistoryStoreDir`), created with its own `.gitignore`
when the workspace activates (`createStoreDirs`). Records are keyed by the workspace-relative path alone, so
the store reads wherever the workspace sits. Every watcher and index walk skips both stores by path
(`isSkippedRel`) ([local history](../git/local-history.md)).

App-level, in Electron `userData` (`pomade-dev` when unpackaged, so a dev instance never touches the
installed app's files):

- **`app.json`** — `{ workspaceRoot }`: the remembered root, written whole on a pick or switch; any other
  key in the file is ignored.
- Other user-data folders, each owned by its module: `recovery/` (unsaved-doc copies and discarded
  drafts), `notices/queue/` ([notices](./notices.md)), the Host API
  socket, app state and commands, `zsh-integration/`.

`workspace.json` is shared config; machine-local preferences never go there ([contracts/types](../../contracts/types.md) "Workspace config" and "Per-project state").

## Write discipline

All main-process JSON writes go through `atomic-write.ts` — write a sibling `.<random>.tmp`, rename
over the target, remove the tmp on any failure, so a crashed write never leaves a half file or a stray
`.tmp`. The module also offers a conditional write (`ifMtime`, refused with `ChangedOnDiskError` when the
file moved), an exclusive create (hard-link, never replaces), and a synchronous form for the one caller
that cannot await.

Config writes are **debounced 500 ms**, coalesced per absolute path, and **serialized per path** through
a promise chain, so a save landing behind an in-flight write cannot have its older snapshot's rename
finish last. Every renderer store persists immediately (no renderer-side debounce); main's per-path
debounce is the single coalescing point. The per-project stores (tabs, mounts, side panel) route
through `createProjectStatePersistence`, which sends **partial** patches — main merges each over the
last-known state of that file, so two stores owning disjoint slices never clobber each other — tracks
in-flight saves, and exposes `flush()` ([contracts/stores](../../contracts/stores.md) "Per-project persistence"). `workspace-ui.json` is merged the same way
and seeds its cache with a synchronous read when a save races ahead of the first load.

On quit, a two-phase handshake runs after the confirmation ([app shell](./app-shell.md) "Quit
protection"): `before-quit` asks every window to flush — capture the visible panes' reading positions,
await every registered store's in-flight saves and the pending recovery copies — and waits for acks (1 s
timeout); then `will-quit` writes the scrollback snapshots, stops the host socket and drains the main
write queue while killing PTYs and stopping backends. A mutation made a moment before Cmd+Q is never
lost.

## Startup

1. **Root resolution:** the `POMADE_WORKSPACE` env var wins (testing hook); otherwise the
   persisted `app.json` root (`workspaceRoot`).
2. **No root known** → the full-screen picker ("Welcome to Pomade", button `Choose workspace folder`,
   `Opening…` while busy) opens the native directory dialog ("Choose your Pomade workspace folder",
   button `Open Workspace`, folders can be created) and remembers the choice. A failure shows an error
   toast "Could not open workspace: …".
3. **Root known** → Pomade opens it silently, lands on the project that was active at last use
   (`lastActiveProjectId`, written on every project switch; the Workspace project when that project no longer
   exists), and hydrates every project's tab state and mounts up front (`App.tsx`), so all panes can stay mounted and
   each pane's scope mark knows its project's in-scope folders. With
   Settings ▸ General ▸ **Confirm workspace on startup** enabled (default off), a one-time modal
   "Continue in this workspace?" shows the root path with **Continue** and **Change workspace…**. The
   decision to show is latched at launch-time hydration — flipping the setting mid-session never pops it.

After the window is created, main eagerly warms the terminal name index for the root and collects
orphaned scrollback snapshots (see [scale and reliability](./scale-and-reliability.md)).

## Switching workspaces

Entry points: Settings ▸ General ▸ **Change workspace…** (`setting-change-workspace`), the File-menu
item (`menu-change-workspace`), and the startup prompt. The flow:

1. An unconstrained native folder dialog ("Change Pomade workspace folder", button `Switch
   Workspace`) picks the new root; cancel or the same folder is a no-op.
2. The renderer **flushes every per-project store's in-flight saves**.
3. Main commits the switch: flushes pending writes, then runs the teardown hooks — **all PTYs are
   killed** (the one sanctioned exception to "PTYs live for the app's life", besides deleting a
   project), all fs watchers and the document watch closed, the name index dropped — then creates
   `.pomade` in the new root, persists the root, and fires the ready hooks (name-index rebuild,
   scrollback GC).
4. The renderer resets every registered per-project store atomically (a hydration still in flight from
   the old workspace cannot repopulate it), reloads `workspace-ui.json`, loads the new config, and lands
   on the Workspace project; each project's tabs rehydrate from the new workspace's own `state/`
   files.

Because writes are keyed by absolute path and flushed before the root changes, each workspace's
`.pomade` survives round-trip switching intact.

## Boundaries worth knowing

- **Switching kills every terminal and agent session** — they are per-workspace by design.
  Doc tabs come back (they are state); PTY processes do not.
- One window, one workspace. There is no multi-workspace view.
- A switch always lands on the Workspace project, while a relaunch lands on the last-active project.
- Deleting a project removes its `state/<projectId>.json` and closes its tabs (killing their PTYs);
  the scrollback files that leaves behind are collected by the next orphan pass.

Tickets: T-313, T-314.
