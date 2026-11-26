---
doc: docs/modules/tabs/per-project-tab-state.md
audience: engineers, product
holds: per-project state — what persists in .pomade/state/<projectId>.json, who owns which field, when it is written, what restores and what does not
kind: reference
---

# Per-project state — each project keeps its own tabs, mounts and panel

**Module:** `projects` · **UI:** implicit — switch projects and each one's tabs are exactly as you
left them · **Code:** `src/renderer/stores/{tabs-store,mounts-store,side-panel-store,project-state-persistence}.ts`,
`src/main/config-store.ts` (`loadState`, `saveState`, `removeState`) · **e2e:** `tabs.spec.ts`,
`workspace-switch.spec.ts`, `persistence-unification.spec.ts`, `project-teardown.spec.ts`

## What it does

Every project — the Workspace project included — owns its own tab strip: its open tabs, their
order, and which one is active. Switching projects swaps the whole set instantly (nothing is torn
down — see [pane host](../tabs/pane-host.md)). Each project persists to
`.pomade/state/<projectId>.json` inside the workspace; the key is the project id, not its path.

## What persists

One file per project, written as **partial patches** by three owners, each sending only its own
fields; `config-store.saveState` merges a patch over the last-known state, so no owner clobbers
another:

| Owner | Fields |
|---|---|
| `tabs-store` | `openTabs`, `activeTabId`, `reopenStack` (the undo-close stack, most recent last, capped at 10), `propertiesPanelExpanded` |
| `mounts-store` | `mounts` (each with its optional `inScope` flag — in-scope folders decide the project's [scope marks](./scope-marks.md)), `collapsedRoots` ([mounts](../filetree/mounts.md)) |
| `side-panel-store` | `sidePanel` — the strip icon whose panel the side panel shows (absent = Files) |

Per tab (every kind: doc, terminal, agent, app, commit, comparison, attached terminal, conflict,
branch): title, kind, color, the user-renamed flag, the red unread dot. For docs also the path,
mode (raw / rendered / live), the doc's rich-view choice, dirty flag, symlink flag and the reading
position (`viewport`). For terminals and agents also the agent id, working directory, status, last
command, `lastExec` (the last command the shell ran) and the resume session id. Terminal scrollback
snapshots are separate files under `.pomade/state/scrollback/`, owned by the terminal module.

State of the Projects panel is not here: collapsed groups and the last active project live in
`.pomade/state/workspace-ui.json` ([groups and projects](../projects/groups-and-projects.md)).

At startup every project's tab state **and** mounts are hydrated, so a background project's panes
classify their docs' scope marks against the right in-scope folders.

## When it is written

`project-state-persistence` sends the owner's patch **immediately** after each mutation (no renderer
debounce) and tracks every in-flight `state.save`; main coalesces the disk write with a 500 ms
debounce and atomic writes. A quit or a workspace switch first awaits all in-flight saves
(`flushAllProjectState`), then main drains its write queue, so a change made just before quitting is
not lost. A save for a project that is not hydrated yet is skipped, so an empty store can never
overwrite a state file.

## What restoring looks like

- **Doc tabs** reopen their file from disk, in their saved mode and at their saved reading position.
  The dirty *flag* persists, but unsaved text is held by the recovery store, not by this file (see
  [unsaved recovery](../editor/unsaved-recovery.md)). An outside-workspace doc whose
  absolute path no longer resolves is dropped at restore; if it was the active tab, the active
  tab falls to its right neighbour (else left).
- **Terminal and agent tabs** are revived when their project is opened: a terminal reopens where it
  was, an agent resumes its session through `resumeSessionId`; only tabs that were already dead, and
  agents whose session cannot be backed, show the dead pane — see
  [panes and lifecycle](../terminal/panes-and-lifecycle.md) § "Restore & revive".
- **The reopen stack** survives a restart, so **Reopen closed tab** still works.

## What is deliberately not persisted

- The **preview-tab slot** (a restored preview would be a stale surprise — every restored tab is
  real).
- The tree's selection and expansion, and the Show ignored items toggle.
- Jump-to-line requests from terminal links (persisting one would re-jump the caret on each restart).
- Activation history (the most-recently-used order) — session-local.

## Boundaries worth knowing

- Renaming a project keeps its tabs: state is keyed by project id.
- **Deleting a project removes its state file** (`state.remove`, which also cancels queued writes
  for it); its tabs are closed first, which kills its terminals and agents (see
  [groups and projects](../projects/groups-and-projects.md)).
- A **workspace switch** flushes the old workspace's state first, then resets every per-project
  store and loads the new workspace's — the one other moment PTYs are killed. An in-flight
  hydration from the old workspace is discarded.
- `.pomade/.gitignore` contains `state/`, so per-project state (tabs, mounts, scrollback) is
  machine-local and does not travel with the repository. `workspace.json` (groups, projects, ignore
  list, identity) does.

Tickets: E-004, E-026, T-149, T-156, T-157, T-290.
