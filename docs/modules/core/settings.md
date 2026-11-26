---
doc: docs/modules/core/settings.md
audience: engineers, product
holds: the unified Settings modal — sections, every setting, where each is stored; settings without a row; how it is built
kind: reference
---

# Settings — the one unified settings surface

**Module:** `core` · **UI:** the sectioned Settings modal (`settings-modal`) · **Code:**
`src/renderer/modules/settings/` (`SettingsModal`, `sections.ts`, `GeneralSection`,
`FileTreeSection`, `LocalHistoryLimits`, `NameListEditor`, `CommandsPathRow`, `StartupWorkspacePrompt`), `src/renderer/stores/app-settings-store.ts`,
`src/renderer/font-catalog.ts` · **e2e:** `settings.spec.ts`, `font-settings.spec.ts`, `local-history-streaming.spec.ts` (the Local history lists), `settings-in-workspace.spec.ts`, `local-history-limits.spec.ts`

## What it does

All settings live in **one sectioned modal** titled "Settings": a left nav rail with one button per
section, the active section's controls on the right. `Esc` or × closes it. Three entry points open the
same surface (`useSettingsStore.openSettings(sectionId?)`):

- the Projects panel footer **Settings** button (gear + label; gear-only on the collapsed rail);
- **Cmd+,** — the File ▸ `Settings…` menu item;
- the file tree header's **File tree options** (⋯) menu ▸ `Ignored items…`, which deep-links straight to
  the *File tree* section.

Sections come from an extensible registry (`SETTINGS_SECTIONS` in `sections.ts`): **General** (the
default) and **File tree**. A new section is one registry entry plus its component; the modal shell
needs no change.

## General

Everything here is **app-level**: persisted in the active workspace's `.pomade/settings.json` (preferences) and
`.pomade/state/view.json` (view state), shared by every Pomade opened on that workspace
([workspaces and persistence](./workspaces-and-persistence.md)). Rows are grouped under small headings.

**Editor**

- **New markdown opens as** — `Rich` (default) / `Raw`; the stored value is `rendered` / `raw`. Whether a
  freshly opened `.md` file starts in a rich view — the one "Editing markdown" picks — or raw; a file the
  rich editor cannot parse still opens raw. The
  editor's ⋯ menu carries the same control. (`markdownDefaultMode`)
- **Editing markdown** — `Keep formatting` (default) / `Adjust formatting`. Picks which rich view
  markdown gets: Keep = **Live** (the file changes only where you type); Adjust = **Rendered** (saving
  an edited document rewrites its body in Pomade's canonical style). Read at open/toggle time only —
  already-open documents keep their view. (`markdownFormatting`; see [editing modes](../editor/editing-modes.md))
- **Editor font (raw)** — the raw source editor's *prose* font: a curated dropdown (no free text) of
  monospace faces — `SF Mono (default)`, `PT Mono`, `Monaco`, `JetBrains Mono (bundled)`,
  `IBM Plex Mono (bundled)` — plus proportional faces `System UI (sans-serif)`, `Serif (Georgia)`,
  `Sans (Helvetica Neue)`. Code-shaped regions (fenced and indented code, inline code, tables, YAML
  frontmatter) stay monospace whichever is picked. Changing it restyles open raw editors live.
  (`editorRawFont`; [fonts](../editor/fonts.md))
- **Replace -- with — while typing** — on by default. Typing `--` followed by a space, Tab or Enter
  becomes an em-dash in the three editable markdown views; never inside code blocks, inline code or
  frontmatter. (`emDashReplace`)

**Tabs**

- **Single click opens a preview tab** — on by default. A single click on a file in the tree, or on a row
  in the Git panel / a commit tab / a branch tab, reuses one preview tab (title in italics), replaced
  by the next single click until the tab is used (clicked into, edited, another tab selected). Off:
  every click opens its own tab. (`previewTabMode`; [preview tabs](../tabs/preview-tabs.md))

**Terminal**

- **Terminal font** — the xterm font for terminals **and** agent panes: the same curated monospace list
  (monospace only — an xterm grid requires it). Bundled fonts render without being installed on the Mac.
  Changing it restyles live sessions. (`terminalFont`; [rendering](../terminal/rendering.md))
- **Copy on select** — on by default. Finishing a mouse selection in a terminal copies it and flashes a
  confirmation; Cmd+C and the terminal's right-click Copy work either way. (`terminalAutoCopy`)

**Commands** (`CommandsPathRow`; hidden when Pomade's commands are off, as in a test run without the
hooks)

- **Commands in other terminals** — shows the state of Pomade's one marked PATH line in `~/.zprofile`
  and a button, `Add line` / `Remove line`. Status reads `On — ~/.zprofile puts <bin> on PATH.`,
  `Off — ~/.zprofile has no Pomade line.`, "has a Pomade line that was edited; adding repairs it", or
  "puts another Pomade's commands on PATH (…)". Pomade's own terminals always have the commands;
  nothing writes the rc file except this row (or `pomade path install` / `remove`). Removing takes only
  the marked line out. A failure shows an inline alert. (`commands.pathLine` / `commands.setPathLine`)

**Local history** (`data-testid="settings-local-history"`; two `NameListEditor`s, then `LocalHistoryLimits`)

A hint states the rule: a version for each change to a project text file, for 7 days; open documents,
the user's saves in Pomade and files in the first list keep every change; any other file that changes
more than 12 times within an hour gets none until it has been quiet for an hour; files in the second
list never get versions. The 12-per-hour limit is not a setting
([local history](../git/local-history.md) "Which changes keep a version").

- **Always keep every change for** — extensions whose files get a version for every change. Default
  `.md`, `.txt`. (`localHistoryAlways`; `DEFAULT_LOCAL_HISTORY_ALWAYS`)
- **Never keep versions of** — extensions of streaming files, which get none. Default `.log`, `.jsonl`,
  `.ndjson`. (`localHistoryNever`; `DEFAULT_LOCAL_HISTORY_NEVER`)

Each list is the file tree's ignore editor: a row per entry with a × (`Stop keeping every change for
<ext>`, `Keep versions of <ext> again`), an input (`extension, e.g. .md`; Enter or `Add`) and `Reset to
default`. A typed entry is normalized by `normalizeExtension` (`src/shared/local-history.ts`): trimmed,
lower-cased, a leading dot added (`md` → `.md`); a name with a `/`, whitespace or nothing after the dot
stays in the input and is not added; a duplicate adds nothing. An empty list reads "No extensions — only
open documents and saves keep every change." / "No extensions — every text file can get versions." Main
hears every save of the app settings (`onAppSettingsChanged` in `config-store.ts`), so an edit applies
at once, without a restart.

Below the lists (`LocalHistoryLimits.tsx`):

- **Space for local versions** (`setting-lh-cap`) — a select of `64 MB`, `128 MB`, `256 MB` (default),
  `512 MB`, `1 GB`, `2 GB` (`LOCAL_HISTORY_CAP_CHOICES_MB`; `localHistoryCapMb`). The hint "When local
  versions take more, the oldest go first." shows the store's current size (`Now: …`, `lh-usage`).
  Lowering the cap below what is kept asks first — "Lower the space to …?" with the size that will be
  deleted, button `Lower and delete`; the oldest versions go until the rest fit.
- **Delete versions now** — **Group** (`lh-purge-group`: `Local versions` or `Discarded`; Discarded is
  unsaved text closed and changes discarded in the Git panel), **Older than** (`lh-purge-age`), a live
  preview (`lh-purge-preview`: count and size, or `Nothing to delete`) for this workspace, and `Delete…`
  (`lh-purge`, disabled when nothing matches), which confirms ("Delete local versions?" / "Delete discarded
  versions?") before deleting. Local versions are deleted by `purge` in the store, discarded drafts by
  `purgeDrafts` in `recovery-store.ts`. A failure toasts "Could not delete the versions: …".

**Startup**

- **Confirm workspace on startup** — off by default. On: a "Continue in this workspace?" modal at
  launch, showing the root path with `Change workspace…` and `Continue`. The decision to show is latched
  at the first launch-time hydration — flipping the setting mid-session never pops it.
  (`confirmWorkspaceOnStartup`; `StartupWorkspacePrompt`)

**Workspace**

- **Current workspace** — the active root path (`(none)` before one is chosen) with the
  `Change workspace…` button (`setting-change-workspace`).

## File tree

Workspace-level, stored in `.pomade/workspace.json`, shared with the workspace. Two lists.

**Ignored items** — the list — names the file tree hides (`.git`, `node_modules`,
`.DS_Store` out of the box). Each entry has a × (`Stop ignoring <name>`); an input
(`folder or file name`, Enter or `Add`) appends one; `Reset to default` (the same `NameListEditor` as the Local history lists) restores the three defaults;
an empty list reads "Nothing is ignored — everything shows in the tree." The same ⋯ menu's `Show ignored items` / `Hide ignored items`
shows the ignored items dimmed without editing this list. The list controls only what the *tree displays*;
the watchers and the terminal name index keep their own broader hardcoded ignore sets
([scale and reliability](./scale-and-reliability.md)). Stored as `fileTree.ignore`.

**Unwatched folders** (`data-testid="unwatched-settings"`; a `NameListEditor` with a `Choose…` folder
picker) — workspace-relative folders the watcher and indexes skip, stored as `fileTree.unwatched`. For a
folder full of constantly changing files (logs, exports, caches). The tree still shows the folder and reads
it again when it is expanded; changes inside it are not followed, and no git state, app watch or local
history hears its writes. Each row has a × (`Watch <folder> again`); a typed or picked folder is
normalized by `normalizeUnwatchedFolder` (`src/shared/skipped-paths.ts`: workspace-relative, `/`-separated;
absolute paths, the workspace root and `..` are refused); an entry whose folder no longer exists is
dimmed ("Not in the workspace any more"). An empty list reads "No folders — Pomade watches the whole
workspace." The tree marks an unwatched folder with a "Not watched — changes inside show when you expand
the folder again" mark. The list is live: `config-store` hands it to `skipped-paths.ts`
(`setUnwatchedFolders`) on activation and every save; the watcher, the name index and the index walks
test each path against it (`isSkippedRel`, by workspace-relative path, never by name), and the name index
reconciles a folder entering or leaving the list. The stores of local history are skipped the same way.

## Settings stored without a Settings row

These live in the same settings files (view state in `state/view.json`) but are changed by direct manipulation:

| Field | Changed by |
|---|---|
| `editorHeaderShowPath` | clicking the editor header's name field (one global for every doc and pane) |
| `layout` (`projectsPanelWidth`, `fileTreeWidth`, `projectsPanelCollapsed`, `fileTreeCollapsed`) | dragging the dividers, Cmd+B, Cmd+Shift+B |
| `showGitStatus` | the file tree's ⋯ menu (File tree options), `Show git status` / `Hide git status` |
| `mutedNoticeSources` | the bell-slash on a notice toast, `Unmute` in the Notices panel ([notices](./notices.md)) |
| `docHistoryFolded` | folding a group in Document history ([document history](../git/document-history.md)) |
| `compareChangesOnly` | the **Changes only** checkbox in a comparison tab's header — one choice for every comparison tab, off by default ([comparison tab](../git/comparison-tab.md) "Changes only") |

## How it is built

- **UI state vs data.** `settings-store.ts` holds only `open` and `sectionId`; `openSettings` with an
  unknown or omitted id falls back to the first registered section. Setting values live in
  `app-settings-store.ts`, hydrated once at launch from `app.getSettings`.
- **Persistence.** Every plain-value setter is `persistSetting(patch)`: optimistic `set`, then
  `app.setSettings(patch)` and a merge of the returned full settings. Main deep-merges the nested `layout`
  object over its defaults (`mergeAppSettings`), so a partial patch never drops sibling fields and an
  older settings file picks up new defaults. Layout width setters update state live (no IPC); the caller
  persists once at drag end (`persistLayout`); collapse toggles persist immediately.
- **Font catalog.** `font-catalog.ts` is the single id → CSS-stack mapping and the curated option lists;
  persisted values are font ids, so a catalog change never strands a stored value as a raw stack.

## Boundaries worth knowing

- **The storage split is the map:** General = app-level (`.pomade/settings.json` and `.pomade/state/view.json`);
  File tree = workspace-level (`workspace.json`, shared). Per-project state (tabs, properties-panel state, side
  panel, mounts) is not a setting and never appears here.
- No dark-theme or language setting exists; Pomade has one light theme.
- Standalone settings modals do not exist; new settings register in `SETTINGS_SECTIONS`.

- `Esc` closes only the topmost modal: a confirm opened over Settings closes alone, Settings stays
  (`Modal.tsx`, the open-modal stack).

Tickets: T-267, T-274, T-313, T-315, T-234.
