---
doc: docs/contracts/stores.md
audience: engineers
holds: the renderer's zustand stores — their state shapes and actions, the shared per-project persistence, and the rules other code relies on (tab placement, close focus and guards, preview tabs, unread dots, cross-project moves, the PTY reaper, revive, workspace switch and project deletion)
kind: reference
---

# Renderer stores (zustand)

Stores live in `src/renderer/stores/` (shared) and `src/renderer/modules/<module>/` (module-owned).
A component derives lists with exported pure helpers plus `useMemo` — a store method returning a
fresh array would loop React. Every persisted mutation goes to main **immediately**; main's
debounced writer is the only coalescing point, so no renderer state is pending at quit.

## Per-project persistence (`stores/project-state-persistence.ts`)

Every store that owns a slice of `.pomade/state/<projectId>.json` builds one
`createProjectStatePersistence({ isHydrated, payload, hydrate, reset })` and self-registers:

| Store | Slice |
|---|---|
| `tabs-store` | `openTabs`, `activeTabId`, `propertiesPanelExpanded`, `reopenStack` |
| `mounts-store` | `mounts`, `collapsedRoots` |
| `app-scope-folders-store` | `{ foldersByProject: Record<Id, AppScopeFolder[]>, hydratedProjects, hydrateProject }` — read-only: hydrated from `state.load`, then set by `EV.appScopeFolders` (newer than a load in flight); never saves. `useProjectScopeFolders` hydrates the project it is asked about |
| `side-panel-store` | `sidePanel` |

- `persist(projectId)` sends the store's partial `state.save` at once (only once hydrated).
- `flush()` awaits the in-flight saves. `flushAllProjectState()` awaits every registered store (the
  quit flush, step 1 of a workspace switch).
- One in-flight `state.load` per project, shared by concurrent `hydrateProject` callers, with a
  generation guard: a load still in flight when the store resets never repopulates it.
- `resetAllProjectStateForWorkspaceSwitch()` resets every registered store in **one atomic `set()`**
  each (all per-project fields plus `hydratedProjects`).

## `workspace-store`

```ts
{ root: string | null; groups: Group[]; projects: Project[]; fileTree: FileTreeSettings
  identity: WorkspaceIdentity | undefined; ungroupedOrder: number | undefined
  activeProjectId: Id; hydrated: boolean
  hydrate(); changeWorkspace()
  addGroup(g); updateGroup(id, patch); deleteGroup(id)
  addProject(p); updateProject(id, patch); deleteProject(id)
  reorder(groups, projects, ungroupedOrder?); setActiveProject(id)
  setWorkspaceIdentity(identity | undefined); updateFileTree(patch)
  allProjects(); projectById(id) }
// pure exports: buildAllProjects(projects), buildProjectsPanelOrderedProjects(groups, projects, ungroupedOrder)
```

- Every config mutation persists via `workspace.saveConfig` at once. `hydrate` normalizes the group
  tree and writes a repaired tree back; the boot-time active project is the Workspace project until
  `workspace-ui-store`'s `lastActiveProjectId` restores.
- `deleteGroup` re-parents child groups to the deleted group's parent and moves its projects to
  Ungrouped.
- **`changeWorkspace()`**: `pickRoot` → (a different folder) `flushAllProjectState()` →
  `workspace.change(root)` → `resetAllProjectStateForWorkspaceSwitch()` → load the new config and
  `workspace-ui-store.hydrate()`.
- **`deleteProject(id)`** — the one teardown besides a workspace switch that kills PTYs: (1)
  silent-close every tab through `closeTab` (the reaper kills live terminals; closed tabs land on
  the reopen stack); (2) `tabs-store.dropProject`, `mounts-store.dropProject`,
  `side-panel-store.dropProject`; (3) `state.remove(id)`; (4) drop the project and repoint
  `activeProjectId` to the Workspace project if it was active. Switching projects never touches PTYs.

## `tabs-store`

```ts
{ tabsByProject: Record<Id, Tab[]>; activeTabByProject: Record<Id, Id | undefined>
  previewTabByProject: Record<Id, Id | undefined>            // runtime only
  propertiesPanelExpandedByProject: Record<Id, boolean | undefined>
  reopenStackByProject: Record<Id, ClosedTabEntry[]>
  activationHistoryByProject: Record<Id, Id[]>               // runtime only: MRU stack, cap 50
  hydratedProjects: Record<Id, boolean> }
```

Actions: `hydrateProject`, `openTab(tab, { afterTabId?, preview?, background? })`,
`openDocByPath(projectId, path, { title?, mode?, symlink?, usePreviewMode?, line?, background?, afterTabId? }) → Id`,
`closeTab`, `setActive`, `updateTab`, `setDocMeta`, `markDirty`, `markUnread`, `clearTabAttention`,
`commitPreview`, `replacePreviewTab`, `closeAllDocs`, `closeSavedDocs`, `reorderTab`,
`retargetPaths(oldPrefix, newPrefix)`, `moveTabToProject`, `openDocInProject`,
`restoreClosedTab`, `dropReopenEntry`, `dropProject`, `togglePropertiesPanelExpanded`, the guard
registries and request-close family (below), `flush`; selectors `tabsFor`, `activeTabFor`,
`reopenStackFor`, `propertiesPanelExpandedFor`, `dirtyDocs`.

- **Placement.** `openTab` inserts right of the project's active tab (`afterTabId` overrides; no
  anchor ⇒ append) and activates it, unless `background`. `restoreClosedTab` re-inserts at the
  original index (clamped) — the one exception.
- **`openDocByPath`** is the one "open or jump to a doc tab by path": an open doc tab for the path
  (`isDocTabOf`, never a version tab) is activated; else a new tab with `initialDocMode(path)`,
  `symlink` (resolved with one stat when not given), through the preview slot only when
  `usePreviewMode` and the setting are on; a `line` goes to `jump-store`.
- **Close focus.** Closing the **active** tab activates the most recent surviving tab in the MRU
  stack, else its right neighbour (left when it was last). Closing an inactive tab never moves
  focus. `closeAllDocs` / `closeSavedDocs` focus the first survivor at or right of the old slot.
- **Reopen stack.** Every close through `closeTab` pushes `{ tab, index }` (cap `REOPEN_STACK_CAP`
  10); `closeAllDocs` / `closeSavedDocs` push their own victims; moves, preview replacement,
  reorders and the hydration prune do not. A reopened tab keeps its original id.
- **Guards** (module-level maps, never reactive state): `registerCloseGuard(tabId, guard)` where
  `guard(done?: (outcome?: 'proceed' | 'cancel') => void)`; `requestClose`,
  `requestCloseMany(projectId, ids, onComplete?)`, `requestCloseOthers`, `requestCloseToRight`,
  `requestCloseAllDocs` route each target through its guard **sequentially**, and a `cancel` aborts
  the rest of the batch. No guard ⇒ close at once. A guard focuses its tab only when it is going to
  prompt. `registerSaveGuard(tabId, () => Promise<'ok' | 'blocked'>)` → `saveAllDirtyDocs()` (quit's
  Save all: non-interactive, `blocked` instead of any dialog). `registerDiscardGuard(tabId, () =>
  Promise<void>)` → `discardAllDirtyDocs()` (keeps each dirty doc as a `quit` draft).
- **Preview tabs** (`AppSettings.previewTabMode`): `openTab(tab, { preview: true })` records the
  project's preview slot; any non-preview open, an edit (`markDirty(true)`), a click into the pane or
  activating another tab commits it (`commitPreview`). `replacePreviewTab` swaps it in place with a
  **fresh** tab id. A dirty preview is never replaced.
- **Unread dot** (`tab.attention`, persisted): set by `markUnread` (any kind, even the active tab)
  and by terminal attention on a tab that is not the active tab of the active project. Cleared on the
  activation **edge** (`setActive` to a different tab) and by `clearTabAttention` (a keystroke or
  paste into the pane, or a dirtying edit). A project's Projects panel counter is the number of its dotted
  tabs, derived — no counter state exists.
- **Cross-project.** `moveTabToProject(from, tabId, to)` and `openDocInProject(from, tabId, to)`
  (a copy: new id, clean) both hydrate the target first, then change both projects in **one atomic
  `set()`** (a remove-then-add would let the reaper kill the live PTY). Tab id and `termId` are
  unchanged. The arriving tab goes to the end of the target strip, attention-marked, without stealing
  the target's focus (it becomes active, unmarked, only when the target had none). Docs dedupe by
  path: a clean arrival reuses the target's tab; a dirty arrival replaces a clean copy in its slot;
  two dirty copies are both kept. The source's active tab hands focus to its right neighbour.
- **`retargetPaths(old, new)`** rewrites every affected doc tab in **every** project after an in-app
  move or rename (exact path, or folder prefix): `path` and title change, buffer and dirty state are
  kept, a version tab's snapshot source follows.
- On hydrate, a doc tab with an absolute path that no longer stats is dropped silently.
- `dropProject(id)` clears the project's maps in two steps (tabs and reopen stack while still
  hydrated, then the hydration flag) so the snapshot forgetter fires.

## `terminals-store`

Actions: `newTerminal(project, { afterTabId? })`, `newCommandTerminal(projectId, { cwd, command?, title? })`,
`startAgent(project, agent, resumeSessionId?, { cwd?, mode?, prompt? }) → Id`,
`startAgentWithContext(project, agent, { instruction, typeText? })`, `relaunch`, `stopAllTerminals`,
`exitAllAgents`, `confirmBulkClose`, `cancelBulkClose`, `reconcile`, `reviveProject`, `reopenClosedTab`, and the event handlers
`handlePtyExit`, `handleAgentExit`, `handleAgentStart`, `handleSessionId`, `handleSessionUnbound`,
`handleSubmit`, `bindSessionManually`, `silenceUnbound`, `handleCwd`, `handleExec`,
`handleAttention`. Pure export `isRunTerm(termId)` (a term created this run).

- **Bulk close confirm.** `stopAllTerminals(projectId)` / `exitAllAgents(projectId)` first look for
  busy targets: a live plain terminal whose pty reports `busy` (`pty.list()`), a live agent whose
  `agent-live-store` state is `working` or `needs-you`. With none they act at once (kill + close /
  `/exit` + reap after 1.2 s) and toast. With some they only set `bulkClose: { action:
  'stop-terminals' | 'exit-agents', projectId, busyTitles }` (rendered by `BulkCloseConfirm` over the
  pane host while its project is active); `confirmBulkClose()` clears it and acts on the project's
  tabs as they are then, `cancelBulkClose()` clears it and closes nothing.
- **PTY reaper** (a `useTabsStore.subscribe`): a PTY is killed exactly when no tab references its
  `termId` any more (tab closed, or `termId` swapped by relaunch or revive). Panes never kill.
- **Store-owned subscriptions**: per `termId` appearing in `tabsByProject`, the store subscribes
  `pty.onAgentExit`, `onAgentStart`, `onSessionId`, `onSessionUnbound`, `onExec`, `onCwd`,
  `onAttention`, and disposes them when the `termId` leaves. Each handler re-resolves the tab's
  current `{ projectId, tabId }` at fire time and owns its guards (kind, status, bind phase).
- **Upgrade / downgrade.** `handleAgentStart` turns a live plain terminal into an agent tab
  (`agentId`, `lastCommand`, `cwdAtLaunch`, `launchedAt`, resume id from `--resume` / `resume`
  args, title unless `renamed`). `handleAgentExit` turns it back into a terminal and clears the agent
  facts (`agentId`, `lastCommand`, `resumeSessionId`, `cwdAtLaunch`, `bindState`, `launchedAt`,
  `appTitled`, `unnamed`) — `lastExec` stays.
- **Restore.** `reconcile` marks a restored tab whose PTY is gone and whose persisted status is
  `live` as pending revive (runtime-only set; payload untouched); `reviveProject` runs on project
  open ([ipc-terminal](./ipc-terminal.md) §"Revive and scrollback"). Only tabs restored from a
  previous run can show the dead pane; terms created this run are exempt from the liveness check.
- **Snapshot forgetter**: `pty.forgetSnapshot(tabId)` when a terminal/agent tab id leaves the union
  of open tabs and reopen-stack entries **of a still-hydrated project**; a wholesale cache drop
  (workspace switch) forgets nothing.

## Other shared stores

| Store | Shape |
|---|---|
| `mounts-store` | `{ mountsByProject, collapsedByProject, hydratedProjects, hydrateProject, addMount(projectId, path, outside, inScope?) → Id \| null, removeMount, renameMount(projectId, mountId, name \| undefined), setMountInScope(projectId, mountId, inScope), setRootCollapsed(projectId, rootId, collapsed), dropProject }`; pure `validateMountPath(raw, ctx)`. App hydrates every project's mounts at start, with its tabs: in-scope mounts decide the scope marks of every pane |
| `side-panel-store` | `{ selectedByProject, hydratedProjects, hydrateProject, select(projectId, key), dropProject }` |
| `workspace-ui-store` | `{ collapsedGroups, lastActiveProjectId, overlayPositions, hydrated, hydrate() → WorkspaceUiState, isCollapsed, toggleGroupCollapsed, setLastActiveProject, setOverlayPosition(appId, pos) }` — each save a partial patch of the field it owns |
| `app-settings-store` | `AppSettings` + `hydrated`, `hydrate()`, one setter per setting (optimistic, then `app.setSettings`); `setProjectsPanelWidth` / `setFileTreeWidth` are live-only (clamped to `LAYOUT_LIMITS`) until `persistLayout()`; collapse toggles persist at once. Hydrated at start and again after a workspace pick or switch (`WorkspacePicker`, `workspace-store.changeWorkspace`): settings live in the workspace, and one without them gets the defaults |
| `apps-store` | `{ apps: HostedApp[], loaded, hydrate, refresh }`; `applyBadge(badge)` sets strip marks, `appsWithStaleBadges(prev, next)` names apps whose badges go |
| `marks-store` | `marks: target → source → Mark`, `setMark`, `clearSource` ([events-and-notices](./events-and-notices.md)) |
| `notices-store` | notices and notice toasts ([events-and-notices](./events-and-notices.md)) |
| `agent-live-store` | `{ states: Record<termId, 'working' \| 'needs-you' \| 'idle'>, set }` from `pty.onAgentState` |
| `jump-store` | `{ request: { tabId, line, nonce } \| null, jumpTo(tabId, line), take(tabId) }` — a one-time navigation intent, never a tab field |
| `reveal-store` | `{ request: { path, projectId, expand, nonce } \| null, reveal(path, projectId, opts?: { expand? }) }` — the file tree of the active project performs it in the first root section that shows `path` (the project root, else a mount; a collapsed section opens; a path no root shows is ignored). `path` is a tree path: workspace-relative, or absolute under a mount outside the workspace; `expand` also opens a revealed folder (`files.reveal`) |
| `new-project-store` | `{ request: { rootPath, nonce } \| null, startFromFolder(rootPath) }` |
| `unbound-store` | `{ silenced: Record<tabId, true>, silence, unsilence }` — the ⚠️ mark silenced for one unbound session |
| `pty-tab-refs` | `startPtyTabRefs()` — reports each term's tab to main (`pty.setTab`) |
| `stray-press-guard` | `startStrayPressGuard()` — drops the second press of a double-click that lands on a tab opened by the first press |

## Module stores

| Store | Shape |
|---|---|
| `modules/git/git-state-store` | `{ snapshot: GitSnapshot, index: GitTreeIndex, loaded }`; subscribes `git.onState` on first use, never polls; `loadGitState()` = the first snapshot |
| `modules/git/git-ui-store` | `{ diff: DiffTarget \| null, deleted: string \| null, openDiff, closeDiff, openDeleted, closeDeleted }`; `DiffTarget { path, tabId, title, repo, mode: 'saved-vs-unsaved' \| DiffMode }` |
| `modules/git/panel/git-panel-store` | session-only Git panel view state (drill-down, toggles, History / Not pushed pages keyed by a branch stamp); `revealRequest: { projectId, root, nonce } \| null` with `revealRepo(projectId, root)` (a drill into another repo goes back to the list) and `consumeReveal(nonce)` — the panel of `projectId`, once shown, scrolls the repo's row into view (`RepoList`), or drops the request when a repo view already shows the repo or the list lacks it (`git.reveal`) |
| `modules/git/ops/git-ops-store` | `{ running, failures, dialog, composer, draftsNonce }`; `runGitOp`, `runDirect`, `openDialog`; failure marks under `git:<root>` |
| `modules/git/ops/git-runs-store` | `{ runs, jobsEpoch }`; `startGitRuns()`, `seeRuns(root)`; marks under `git-run:<root>` |
| `modules/git/branches/branches-store` | In progress per repo; `load(repo)`, `backgroundFetch(repo)` (at most every 5 min) |
| `modules/git/history/doc-history-store` | `{ open: Record<tabId, true>, toggle, show, hide }` |
| `modules/apps/overlay-store` | the one open overlay ([host-api-frames](./host-api-frames.md) §"Overlays") |
| `modules/side-panels/app-panel-routes` | `{ routes: Record<stripKey, string>, setRoute(key, route) }` — the route `panel.show` gave each app panel, runtime only ([host-api-frames](./host-api-frames.md) §"Delegated calls") |
| `modules/settings/settings-store` | `{ open, sectionId, openSettings(sectionId?), closeSettings, setSection }` |

Tickets: E-004, E-011, E-016, E-022, E-026, E-029, T-097, T-103, T-107, T-117, T-118, T-149, T-151, T-156, T-157, T-170, T-189.
