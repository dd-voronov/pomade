---
doc: docs/contracts/types.md
audience: engineers
holds: the cross-process types in src/shared/types.ts — workspace config, project state, every tab kind, app settings, file and path types, app-hosting payloads
kind: reference
---

# Shared types (`src/shared/types.ts`)

Every type that crosses the process boundary lives in `src/shared/types.ts`, or in a pure
`src/shared/<area>.ts` module named in the area's own contract (git models in
[git-state-and-history](./git-state-and-history.md) and [git-operations](./git-operations.md), recovery and history models in [documents](./documents.md)). Host API
protocol types (`ProjectRef`, `SessionRef`, `StripIcon`, `JsonValue`, …) come from
`pomade-kit/protocol` and are re-used, never copied. `WORKSPACE_PROJECT_ID` (`'__workspace__'`) is
re-exported from the kit: the Workspace project, never stored in `workspace.json`.

An optional field is **absent, not `false`/`''`**, when it does not apply, so state written before a
field existed loads unchanged.

## Workspace config — `.pomade/workspace.json` (git-tracked)

```ts
type Id = string // nanoid
interface WorkspaceConfig {
  groups: Group[]; projects: Project[]
  fileTree: FileTreeSettings          // required; defaulted on read when missing
  identity?: WorkspaceIdentity        // the workspace's own icon
  ungroupedOrder?: number             // Ungrouped's slot among top-level groups; absent = last
}
interface Group {
  id: Id; name: string; description?: string; image?: string; icon?: string
  parentId?: Id        // absent = top level; tree max depth 4
  order: number        // among siblings (same parent)
  highlighted?: boolean; color?: TabColor
}
interface Project {
  id: Id; name: string; groupId?: Id
  rootPath: string     // workspace-relative, '' = workspace root; never a leading slash
  area?: string; description?: string; image?: string; icon?: string
  visibleAgents: string[]  // agent ids; ['*'] = all, [] = none
  order: number; highlighted?: boolean; color?: TabColor
  appSettings?: Record<string, Record<string, JsonValue>>  // hosted apps' per-project settings, by app id
}
interface WorkspaceIdentity { icon?: string; image?: string }   // mutually exclusive
interface FileTreeSettings {
  ignore: string[]      // DEFAULT_TREE_IGNORE = ['.git','node_modules','.DS_Store']
  unwatched: string[]   // unwatched folders: workspace-relative, skipped by path (default [])
}
interface AgentOverrides { commands: Record<string, string>; hidden: string[] }  // .pomade/agents.json
```

- `config-store.getWorkspace()` builds the config field by field: an unknown key in the file is
  ignored and dropped on the next save; `fileTree` defaults field by field to
  `DEFAULT_FILETREE_SETTINGS` (`unwatched` keeps only its string entries; a listed folder that no
  longer exists stays). Entries are tidied by `normalizeUnwatchedFolder` (`shared/skipped-paths.ts`).
  `EMPTY_WORKSPACE_CONFIG` is the no-workspace value.
  A project record that holds the old key `coverImage` is read through
  `main/project-upgrade.ts#upgradeProject`: its value becomes `image` unless `image` is already set,
  and the next save writes `image` only.
- Icons: `icon` holds an emoji glyph or a library id prefixed `lib:` (`lib:si-youtube`). Render
  precedence: `icon` → uploaded `image` (a workspace-relative path, usually a
  copy under `.pomade/assets/<16 hex>.<ext>`) → default glyph.
- The group tree is derived from `parentId` over the flat array. `normalizeGroupTree`
  (`modules/projects-panel/reorder.ts`, run on hydrate and workspace switch) repairs a dangling parent, a
  cycle or an over-deep chain and writes the result back via `workspace.saveConfig`.
- `normalizeWorkspaceRelPath(input)` (`shared/paths.ts`) is the one normalizer for a hand-typed
  workspace-relative path: trims, treats `\` as `/`, collapses repeated slashes, drops leading and
  trailing slashes (`''` = the workspace root).

## Per-project state — `.pomade/state/<projectId>.json` (gitignored, machine-local)

```ts
interface ProjectState {
  openTabs: Tab[]; activeTabId?: Id
  reopenStack?: ClosedTabEntry[]        // LIFO, most recent LAST, cap REOPEN_STACK_CAP = 10
  propertiesPanelExpanded?: boolean     // absent = expanded
  mounts?: Mount[]; collapsedRoots?: string[]  // extra tree roots; collapsed root ids
  sidePanel?: string                    // 'files' | 'git' | 'notices' | 'app:<appId>/<iconId>'; absent = Files
  appScopeFolders?: AppScopeFolder[]    // folders apps put in the project's scope, in the order added
}
interface ClosedTabEntry { tab: Tab; index: number }
interface AppScopeFolder { appId: string; path: string }   // path in the Mount form
interface Mount { id: Id; path: string; outside?: boolean; name?: string; inScope?: true }
const PROJECT_ROOT_ID = '__project_root__'   // collapsedRoots' id for the pinned project root
```

- `state.save` takes a `Partial<ProjectState>`; main merges it over the last-known state, so the
  stores that own disjoint fields (tabs-store, mounts-store, side-panel-store — see
  [stores](./stores.md)) never clobber each other. `state.load` answers main's cached state while a
  save waits for its debounce (it is newer than the file). The cache is dropped on a workspace switch.
- `appScopeFolders` is main's (`main/app-scope-folders.ts`, through `configStore.updateState`): the
  Host API's `project.addScopeFolder` / `removeScopeFolder` change it, an app the user removed (a
  `<userData>/app-removals.json` record, the app not hosted) loses its folders — at start, on every
  app-registry change, on a workspace switch — and each change goes to the window as
  `EV.appScopeFolders` (`state:app-scope-folders`, `AppScopeFoldersChanged { projectId, folders }`;
  preload `state.onAppScopeFolders`). No renderer store saves it.
- `Mount.path` is workspace-relative for a folder inside the workspace and absolute for one outside
  (`outside: true`). `Mount.name` is a display name only; Copy path copies `path`. `Mount.inScope`
  puts the folder in the project's scope (absent = not in scope).
- `.pomade/state/scrollback/<tabId>` holds a plain terminal's scrollback snapshot (raw bytes); see
  [ipc-terminal](./ipc-terminal.md).

## Workspace UI state — `.pomade/state/workspace-ui.json`

```ts
interface WorkspaceUiState {
  lastActiveProjectId: Id | null     // reopened on boot
  collapsedGroups: Id[]              // collapsed Projects panel groups and sub-groups
  overlayPositions: Record<string, OverlayPosition>  // by app id
}
interface OverlayPosition { left: number; top: number }  // card's top-left in window coordinates, px
```

Workspace-scoped and machine-local (not in `workspace.json`). Saved as a partial patch merged in
main; on load main keeps only finite overlay positions.

## Tabs

```ts
type TabKind = 'doc' | 'terminal' | 'agent' | 'app' | 'commit' | 'compare' | 'attached' | 'conflict' | 'branch'
interface TabBase { id: Id; projectId: Id; kind: TabKind; title: string }
type Tab = DocTab | TerminalTab | AppTab | CommitTab | CompareTab | AttachedTab | ConflictTab | BranchTab
type TabColor = 'red' | 'amber' | 'green' | 'teal' | 'blue' | 'purple'   // TAB_COLORS; a palette key, not a hex
```

Every kind carries `color?: TabColor` (user tint) and `attention?: boolean` (the red unread dot).
Tabs persist in `ProjectState.openTabs`; a kind that shows external data (commit, compare,
conflict, branch, app, attached) persists only the reference and re-reads on mount, so a target
that is gone restores to a notice.

| Kind | Fields beyond `TabBase` |
|---|---|
| `DocTab` (`doc`) | `path` (workspace-relative, or **absolute = outside the workspace**); `mode: 'raw' \| 'rendered' \| 'live'`; `richView?: 'live' \| 'rendered'` (this doc's rich-view target; absent = the app setting); `dirty`; `symlink?`; `viewport?: DocViewport` (reading position); `version?: DocVersion` (a version tab — see [documents](./documents.md)) |
| `TerminalTab` (`terminal` \| `agent`) | `termId`; `agentId?`; `cwd` (live last-known directory); `status: 'live' \| 'dead'`; `lastCommand?` (re-run on Relaunch); `resumeSessionId?`; `lastExec?` (last command the shell ran; pre-typed, never run, on revive); `renamed?`; `cwdAtLaunch?` (the agent CLI's launch directory, realpath); `bindState?: 'bound' \| 'unbound'`; `launchedAt?` (ISO); `appTitled?`; `unnamed?` |
| `AppTab` (`app`) | `appId`; `icon?` (strip icon id it was opened for); `route?` (the route the tab renders: set by Pomade's navigation or the app's `tabs.setRoute`; absent = `""` for the icon-less tab, the icon's route for an icon tab); `renamed?`; T-268: `key?` (a keyed tab: one per app, key, project), `tabKind?` (its app tab kind, kept when the manifest drops it), `appTitled?` (the title came from the app: `title`, `tabs.setTitle`) |
| `CommitTab` (`commit`) | `repo` (ws-relative root); `hash` (full) |
| `CompareTab` (`compare`) | `left`, `right: CompareSource` |
| `AttachedTab` (`attached`) | `session: SessionRef`; `renamed?` |
| `ConflictTab` (`conflict`) | `repo` |
| `BranchTab` (`branch`) | `repo`; `branch` (`feature` or `origin/feature`) |

```ts
interface DocViewport { key: string; offset: number; fraction: number }  // = the renderer's CaretAnchor
```

- `resumeSessionId` writers are listed in [ipc-terminal](./ipc-terminal.md) §"Session
  attribution"; nothing else may set it.
- **Tab details validator.** `TAB_FIELD_TYPES: Record<TabKind, Record<string, 'string' | 'boolean' | 'object'>>`
  maps every persisted field of every kind (terminal and agent share `TerminalTab`'s map), declared
  with `satisfies Record<keyof XTab, TabFieldType>` so a field added to an interface but not to its
  map fails typecheck. `TAB_FIELD_ALLOWLIST` is derived from it; `TAB_IMMUTABLE_FIELDS = ['id','kind']`.
- Constants: `EXEC_MARKER_CAP = 500` (the shim's preexec payload cap), `EXEC_MARKER_CAPS = [160, 500]`
  (every cap a shim has emitted — a payload whose byte length equals one is never pre-typed),
  `SESSION_BIND_WINDOW_MS = 30_000`, `AGENT_SESSION_COMMANDS` (per store family: claude
  `{clear: ['/clear','/reset','/new'], fork: ['/branch'], resume: '/resume'}`, codex
  `{clear: ['/clear','/new'], fork: ['/fork'], resume: '/resume'}`; a line matches a command exactly
  or as `<cmd> <arg>`).

## Scope of a path

```ts
type Scope = 'in-project' | 'outside-project' | 'outside-workspace'
classifyScope(path, projectRoot, scopeFolders = []): Scope              // shared/paths.ts
scopeRelativePath(path, projectRoot, scopeFolders, wsRoot): string | null
scopeFolderOf(path, scopeFolders): string | null; isUnderFolder(path, folder): boolean
```

*Project scope* = the project root plus its in-scope folders (`scopeFolders`, workspace-relative or
absolute; the renderer's `useProjectScopeFolders(projectId)` in `stores/project-scope.ts` gives the
in-scope mounts' paths plus `appliedAppScopePaths(folders, apps)` — the app scope folders whose app is
hosted and available (`HostedApp.unavailable === null`)). A path under the root or an in-scope folder is `in-project`; otherwise a
leading `/` is `outside-workspace`, anything else `outside-project`. `projectRoot === ''` (the
Workspace project) makes every relative path `in-project`; a folder `''` (the workspace root) covers
every relative path. `classifyScope` is the single source for the tab, header and root-diamond scope
marks; `scopeRelativePath` gives the header's short path — from the root, or `<folder name>/…` from
the deepest in-scope folder — and `null` outside the scope.

## Files and paths

```ts
interface FileNode {
  name: string; path: string /* ws-relative; absolute under an outside mount */
  kind: 'file' | 'dir'      // the link TARGET's kind for a symlink
  children?: FileNode[]
  ignored?: boolean         // only with fs.tree({ includeIgnored: true })
  symlink?: boolean; broken?: boolean   // broken only alongside symlink
  unwatched?: true          // a folder listed in fileTree.unwatched (not on its descendants)
}
interface FsChange { path: string /* ws-relative; absolute under an outside mount */; exists: boolean /* lstat when the batch closed */ }
interface FsChangedEvent { root: string; changes: FsChange[] | null /* null = paths unknown: re-read everything under root */ }
interface FileStat { size: number; mtimeMs: number; isFile: boolean /* target */; isSymbolicLink: boolean /* the path */ }
interface LinkTarget { targetAbs: string; targetRel: string | null; exists: boolean }
interface PathProbe { abs: string /* realpath */; wsRel: string | null; isFile: boolean; isSymbolicLink: boolean /* raw path, one lstat */ }
interface FrontmatterIndex { keys: Record<string, number>; values: Record<string, Record<string, number>> }
interface SessionRecord { sessionId: string; agentId: string; startedAt: string; preview: string; cwd: string }
```

## Agents

```ts
interface AgentInfo {
  id: string                 // 'claude' | 'codex' | folder name
  name: string; command: string; kind: 'claude' | 'codex' | 'custom'
  configDir?: string         // absolute; the session store root
  resolved: boolean          // false only when the login zsh said "not found" for the first word
  modes: RosterMode[]        // launch modes; `args` follow the command
}
```

## App settings — `.pomade/settings.json` + `.pomade/state/view.json`

```ts
interface AppSettings {
  markdownDefaultMode: 'rendered' | 'raw'   // 'rendered'
  markdownFormatting: 'keep' | 'adjust'     // 'keep' = Live is the rich view, 'adjust' = Rendered
  confirmWorkspaceOnStartup: boolean        // false
  layout: LayoutSettings
  previewTabMode: boolean                   // true
  terminalAutoCopy: boolean                 // true
  editorHeaderShowPath: boolean             // false
  terminalFont: string; editorRawFont: string   // font ids, 'sf-mono' (renderer font-catalog.ts)
  emDashReplace: boolean                    // true
  showGitStatus: boolean                    // true
  mutedNoticeSources: string[]              // []
  docHistoryFolded: string[]                // [] — folded Document history group ids
  compareChangesOnly: boolean               // false — the comparison tab's Changes only switch, one for every comparison tab
  localHistoryAlways: string[]              // ['.md', '.txt'] — Always keep every change for (DEFAULT_LOCAL_HISTORY_ALWAYS)
  localHistoryNever: string[]               // ['.log', '.jsonl', '.ndjson'] — Never keep versions of (DEFAULT_LOCAL_HISTORY_NEVER)
  projectSwitchToast: boolean               // true — experimental: a toast with "Back to <previous>" when Pomade switches the project on its own
  localHistoryCapMb: number                 // 256 — Space for local versions (DEFAULT_LOCAL_HISTORY_CAP_MB; choices LOCAL_HISTORY_CAP_CHOICES_MB)
}
interface LayoutSettings { projectsPanelWidth: number; fileTreeWidth: number; projectsPanelCollapsed: boolean; fileTreeCollapsed: boolean }
// DEFAULT_LAYOUT_SETTINGS = 240 / 240 / false / false
// LAYOUT_LIMITS = { projectsPanelMin 160, projectsPanelMax 480, fileTreeMin 160, fileTreeMax 560, mainMin 320, railWidth 52, stripWidth 44 }
```

One object over IPC, kept in the active workspace in two files (`main/app-settings-files.ts`):

- **Preferences** (`AppPreferences`) — every key not in `APP_VIEW_STATE_KEYS` — in
  `.pomade/settings.json`, git-tracked: they travel with the workspace.
- **View state** (`AppViewState`) — `APP_VIEW_STATE_KEYS`: `layout`, `editorHeaderShowPath`,
  `docHistoryFolded`, `compareChangesOnly`, what changes while working — in `.pomade/state/view.json`,
  gitignored, so resizing or folding never makes a commit.

A missing file reads as the defaults; each file contributes only its own keys; unknown keys are
dropped. `mergeAppSettings` spreads defaults ← stored ← patch and deep-merges `layout` alone, so a
stored file picks up new defaults and a partial layout patch keeps sibling fields. The icon strip and
an expanded side panel take `stripWidth + fileTreeWidth`.

`<userData>/app.json` is `{ workspaceRoot }`; it is read only for that key, and any other key in it
is ignored. A stored layout with the old keys `sidebarWidth` / `sidebarCollapsed` goes through
`main/layout-settings.ts#upgradeLayout` on read: each value moves to `projectsPanelWidth` /
`projectsPanelCollapsed` unless that key is already set. `localHistoryAlways` / `localHistoryNever` hold normalized extensions
(`normalizeExtension`: leading dot, lower case); main's local history hears every `setAppSettings`
through `config-store.onAppSettingsChanged` and applies the lists at once. `localHistoryCapMb` is read
by `capBytesOf` (anything but a positive number is the default) and applied the same way; a lower cap
saved by the user prunes at once, the cap loaded with a workspace waits for the scheduled prune.

## App hosting payloads

| Type | Meaning |
|---|---|
| `HostedApp` | an app as the renderer sees it: `id`, `name`, `version`, `source: 'installed' \| 'dev-link'`, `location`, `entryUrl`, `iconUrl`, `iconTint` (one-colour SVG drawn as a mask), `revision` (bumped on any change — open frames reload), `unavailable` (reason or null), `strip: HostedStripIcon[]`, `tabKinds: Record<id, HostedTabKind>` (T-268; `{}` when none or unavailable), `launchPanel`, `shortcuts`, `shortcutConflicts`, `backend: AppBackendStatus \| null` |
| `AppBackendStatus` | `{ mode, state: 'starting'\|'running'\|'restarting'\|'stopped', detail, pid, connected }` |
| `HostedStripIcon` | kit `StripIcon` + `iconUrl`, `iconTint` |
| `HostedTabKind` | T-268 — kit `AppTabKind` (`title`, `icon?`) + `iconUrl` (the kind's image, else the app's icon), `iconTint` |
| `AppBadge` | `{ appId, icon, count /* 0 = none */, urgent }` |
| `AppFrameRequest` | `{ surface, icon?, route?, key?, kind?, project?: ProjectRef }` — `key`/`kind`: a keyed tab's (T-268), carried to its `welcome` |
| `AppFrameOpen` | `welcome { pomadeVersion, hostApi, target, theme }` \| `reject { reason, hostApi }` \| `unavailable { reason }` |
| `AppCallOutcome` | `{ ok: true; value } \| { ok: false; error: ErrorPayload }` |
| `AppDelegatedCall` | a gated, validated call whose work is renderer-owned state (`tabs.*`, `project.*`, `files.pickFolder`, `files.reveal`, `overlay.*`, `git.getState/watch/unwatch/reveal` (`git.reveal` also carries `root`, the workspace-relative repo root main resolved), `notices.post`, `agentTabs.*`); see [host-api-frames](./host-api-frames.md) |
| `AppCallResult` | `AppCallOutcome \| { delegate: AppDelegatedCall }` — never a rejected promise |
| `AppCallContext` | `{ activeProject: ProjectRef }` |
| `AppStateChanged` | `{ frameId, key, value /* null = removed */ }` |
| `AppDelegatedServe` | `{ requestId, call }` (a socket client's delegated call) |
| `AppApiRequest` | `{ frameId, requestId, from, method, params }` (a broker request to a frame) |
| `AppFilesChanged` | `{ frameId, watchId, changes: FileChange[] }` |
| `AppBusEvent` | `{ frameId, name, payload }` |
| `PathLineStatus` | `{ rcFile, binDir, lineTarget /* null = no line, '' = unrecognisable marked line */ }` |

## Terminal payloads

```ts
interface PtyAgentState { termId: string; state: Exclude<AgentTabState, 'exited'> }  // working · needs-you · idle
interface PtyTabRef { tabId: Id; projectId: Id }
type AttachedState = { kind: 'connecting' } | { kind: 'attached'; info: SessionInfo }
  | { kind: 'unreachable'; reason: string } | { kind: 'gone' } | { kind: 'rejected'; message: string }
type AttachedEvent = { type: 'state'; state } | { type: 'snapshot'; data; info; resync }
  | { type: 'delta'; data; info } | { type: 'output'; data } | { type: 'resized'; cols; rows }
  | { type: 'exit'; exit: SessionExit } | { type: 'info'; info } | { type: 'attention' }
interface AttachedEventPayload { tabId: Id; event: AttachedEvent }
```

Tickets: E-010, E-012, E-015, E-024, E-025, E-026, E-027, E-033, E-034, T-019, T-149, T-150, T-185, T-226.
