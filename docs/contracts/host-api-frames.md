---
doc: docs/contracts/host-api-frames.md
audience: engineers
holds: Pomade's host side of the Host API for app frames — the apps IPC namespace, frame sessions and the capability gate, serving and discovery, installs and bundled apps, icon strip and badges, app state, routes, overlays, shortcuts, the workspace data methods, delegated calls, pickers, git state for apps
kind: reference
---

# Host API — host side, frames

The contract apps code against is `docs/HOST-API.md`; protocol types and pure logic come from
`pomade-kit/protocol` (`HOST_API_VERSION`, `METHOD_CAPABILITY`, `parseAppMessage`, the
workspace-path rule, `parseManifest`, `resolveFrameTarget`, `readFrontmatter`, …) and Pomade keeps
no copies. This page pins Pomade's internal surface for it. The socket channel (backends,
commands, the broker) is [host-api-socket](./host-api-socket.md); events and notices are
[events-and-notices](./events-and-notices.md).

## `apps` IPC (frame side)

```ts
list(): Promise<HostedApp[]>              // installed + dev-linked; unavailable ones with a reason
refresh(): Promise<HostedApp[]>           // rescan now (re-fetches dev-server manifests)
openFrame(frameId, appId, appHostApi: unknown, request: AppFrameRequest): Promise<AppFrameOpen>
closeFrame(frameId): Promise<void>        // end the session, drop its watches
call(frameId, method: unknown, params: unknown, ctx: AppCallContext): Promise<AppCallResult>   // never rejects
pickFolder(frameId, root: string, initial: string | undefined): Promise<AppCallOutcome>
setRoute(frameId, route: string): Promise<void>
onChanged(cb)       // EV 'apps:changed'        HostedApp[]
onFilesChanged(cb)  // EV 'apps:files-changed'  AppFilesChanged   (to the frame's webContents)
onBadge(cb)         // EV 'apps:badge'          AppBadge
onStateChanged(cb)  // EV 'apps:state-changed'  AppStateChanged
onEvent(cb)         // EV 'apps:event'          AppBusEvent
```

`frameId` is renderer-minted, one per handshake. Frame events from main are dispatched by `frameId`
through one shared IPC listener per event (`perFrame` in `frame-bridge.ts`). The socket-side
members of `apps` (`setActiveProject`, `delegatedResult`, `onServeDelegated`, `apiResponse`,
`onApiRequest`) are in [host-api-socket](./host-api-socket.md).

## Frame sessions and the gate

- **Identity by frame.** One `FrameBridge` per `<iframe>` (`modules/apps/frame-bridge.ts`) accepts
  messages only from the frame it created and passes main the app id of the **tab** that owns the
  frame, never a message field. Every `hello` is a new handshake (new `frameId`; the old session and
  its watches are dropped).
- **Every call answered once.** The bridge keeps the calls it has not answered; each gets one
  `result`, unless the bridge is disposed (the frame is gone: nothing is posted). When a new
  handshake's `openFrame` returns, the calls still pending from the old session are answered
  `not-ready` ("The frame started a new handshake before this call was answered") before the
  `welcome` (or `reject`) goes out, so a late answer never meets an id of a reloaded document. A
  delegated call whose session ended before its work began is answered `not-ready`, not served; a
  failure inside the bridge (IPC, `serveDelegated` throwing) is answered `io-error`. A handshake that
  throws is logged and leaves the frame sessionless (`not-ready`); later handshakes and calls still run.
- **Main enforces** (`host-api.ts`): capability check against the manifest, params validation
  (unknown keys dropped), the path rule plus the `ws-path` escape guard, and every method runs in
  main. The renderer supplies only state it owns: `ctx.activeProject` (the Workspace project =
  `{ id: '__workspace__', kind: 'workspace', name: 'Workspace', root: '' }`).
- **One path parse** (`host-api-core.ts#workspacePath`): the kit's rule plus `invalid-params` for a
  non-string or NUL path, and `capability-denied` for any path whose first segment is `.pomade`
  (case-insensitive). Real-path checks in `host-api-fs.ts`: writes require the real path (or nearest
  existing ancestor's) under the workspace's real root (`outside-workspace`) and outside `.pomade`
  (`capability-denied`); reads and opens refuse an existing path whose real path is in `.pomade`.
  `files.readFolder` skips `.pomade` and symlinks into it; change events inside it are dropped.
- Errors: ENOENT / ENOTDIR → `not-found`, EEXIST → `already-exists`, else `io-error`.

## Serving, discovery, installs

- `pomade-app://<id>/…` (privileged standard + secure scheme, registered before `ready`) serves an
  installed or folder-linked app from disk, traversal-guarded, `cache-control: no-store`. A URL dev
  link frames `http://localhost:PORT/<entry>`. Renderer CSP: `frame-src` and `img-src` allow
  `pomade-app:`, `http://localhost:*`, `http://127.0.0.1:*`. Frames are sandboxed
  `allow-scripts allow-same-origin allow-forms`.
- `app-registry.ts` scans installs (`<userData>/apps/`), `app-links.json` (`{ links: [{ id, target }] }`)
  and `POMADE_DEV_APPS` (precedence low → high; a dev link wins over an install with the same id),
  watches `apps/` (one recursive descriptor) and `app-links.json`. A changed manifest or origin, or
  any file event under an installed app, bumps `revision`; `AppPane` keys the `<iframe>` on it.
  `onAppsChanged(fn)` notifies main-side listeners.
- `shared/app-manifest.ts` wraps the kit's `parseManifest`: every invalid field reported with its
  name and value; `entry` defaults to `index.html`, `capabilities` deduped, `strip` / `shortcuts` /
  `skills` / `symlinks` default to `[]`; unknown top-level keys come back as `unsupportedKeys`. It
  imports packages only (`bin/pomade` runs it directly).
- **Installs** (`main/app-install-core.ts`, also used by the CLI): a build is copied to
  `apps/.builds/<id>-<stamp>` and `apps/<id>` becomes a relative symlink to it;
  `collectRetiredBuilds` deletes `.builds/` entries no link targets and no open file lies in
  (`lsof`), never a `.staging-*` younger than 10 minutes. `<userData>/app-removals.json` records a
  removed app's version so a bundled install does not bring it back.
- **Bundled apps** (`bundled-apps.ts`, awaited before the registry's first scan): source
  `POMADE_BUNDLED_APPS`, else `<resourcesPath>/bundled-apps` when packaged. Per app: install,
  update, keep, or skip-removed (semver order); the notice is queued with source `pomade`.
- `bin/pomade apps install|remove|link|unlink|list [--stable]` — Node ≥ 22.18, no Pomade running;
  `pomade-dev` user data by default, `--stable` the packaged app, `POMADE_USER_DATA` overrides.
  App-shipped skills (`AppSkill { name, path }`) are checked for `SKILL.md` and reported as paths;
  nothing is linked anywhere.
- Theme: `main/theme.ts#pomadeTheme()` (`'light'`) feeds every `welcome.theme`; `setPomadeTheme`
  publishes `theme.changed`. `scripts/kit-tokens.mjs` generates the kit's `tokens.css` from
  `src/renderer/tokens.css`; a unit test fails while the pinned kit's copy differs.

## Strip, panels, badges, routes

- **Target.** Main resolves `openFrame`'s target with `resolveFrameTarget(strip, surface, icon)`: a
  tab takes the icon's `route`, a panel `panelRoute ?? route`; unknown or absent icon → route `''`;
  `request.route` overrides; `surface: 'overlay'` → `{ surface: 'overlay', route }`. The session
  keeps it and `host.info` answers it. `apps.setRoute` replaces it when a live frame is navigated
  (the bridge also posts `route.changed`).
- **Strip model** (`modules/side-panels/strip-model.ts`, pure): built-in panels (`BUILTIN_PANELS`:
  Files, Git, Notices) first, then each available app's icons in manifest order; keys `'files'`,
  `'git'`, `'notices'`, `app:<appId>/<iconId>`. `ProjectState.sidePanel` stores the selection; a stored key that no
  longer exists or is tab-only resolves to Files without rewriting it. App panels mount on first
  show (or at launch for `startOnLaunch`, `HostedApp.launchPanel`) and are then hidden, never
  unmounted.
- **Badges.** `strip.setBadge` needs no capability; main checks the icon is in the **calling** app's
  manifest (`invalid-params` otherwise) and sends `apps:badge`. A badge is a mark on
  `strip:<key>` from source `app:<appId>` ([stores](./stores.md) §"marks-store"), cleared when the
  app's revision changes, it goes unavailable or is removed.
- **`tabs.openApp`** — delegated: target project (`projectId` else active; unknown → `not-found`),
  then `open-app.ts#openAppRoute(app, route, projectId)`, the one way to open an app at a route: the
  first `tab`/`both` icon with that route, else the icon-less tab (an existing one is navigated via
  `updateTab({ route })`). The new-tab menu's `openAppTab(projectId, app, icon?)` keeps one tab per
  (app, icon) per project; both skip keyed tabs. An app tab's title follows the manifest
  (`appTabTitle`, `startAppTabTitles`) until the user renames it (`AppTab.renamed`) or the app titles
  it (`AppTab.appTitled`).
- **Keyed tabs** (T-268) — main checks `tabs.openApp` params with the kit's `checkOpenAppParams`
  against the calling app's `tabKinds` (`host-api-core.ts#parseOpenAppParams`; `title`/`kind` need
  `key`, unknown kind → `invalid-params`). With `key`, `openAppRoute(app, route, projectId, { key,
  title?, kind? })` → `openKeyedAppTab`: lookup `keyedAppTab(tabsFor(projectId), appId, key)`; new →
  `AppTab { key, tabKind?, route?, title, appTitled? }` right of the active tab; open → `updateTab`
  with `route` (the bridge posts `route.changed`) and, unless `renamed`, `title` + `appTitled`, then
  focus. `AppPane` passes `key`/`kind` in the `AppFrameRequest`; main's `openFrame` puts them on the
  session's `FrameTarget`, so `welcome` and `host.info` carry them. The tab strip's `AppIcon` takes
  `tabKind`: `HostedApp.tabKinds[kind].iconUrl` (the kind's image, else the app's), else the app's.
- **`tabs.setTitle` / `tabs.close`** (T-268) — main: only from a `tab` session (`invalid-params`
  otherwise), frame-only (socket → `capability-denied`); `setTitle`'s `title` trimmed, non-empty.
  Delegated to the calling frame's bridge, which passes its `tabId` (`CallerFrame.tabId`): `setTitle`
  → `updateTab({ title, appTitled: true })` unless `renamed`; `close` answers `{}` then
  `requestClose(projectId, tabId)` on the next task.
- **`tabs.setRoute`** (T-269) — main: the same surface rules (`invalid-params` off a `tab` session,
  frame-only); `route` checked with the kit's `checkTabRoute`; main sets the session's
  `target.route` (so `host.info` answers it) and delegates. The renderer finds the caller's tab,
  calls `CallerFrame.atRoute(route)` — the bridge's `atRoute` sets its frame request's route and its
  posted `route` — then `updateTab({ route })`; the bridge's `setRoute` from `AppPane` then finds the
  frame already there and posts no `route.changed`. `openAppTab(projectId, app, icon?, route?)`
  navigates an open icon-less or icon tab when `route` is given and differs from `recordedRoute`
  (its `AppTab.route`, else its icon's route, else `""`); a strip icon click and the new-tab menu
  pass no route (a plain focus). `openAppRoute` passes the route for an icon tab too. `AppPane`
  passes an icon tab's `route` in its `AppFrameRequest` when it has one; main's `openFrame` lets it
  override the icon's route.

## App state

`state.get` / `state.set` → `main/app-state.ts`: one JSON object per app at
`<userData>/app-state/<id>/state.json`, read once per run then served from memory, per-app FIFO
queue, atomic writes (a `set` resolves after the file is written). Keys: non-empty, ≤ 200 chars;
values: plain JSON ≤ 1 MiB, nesting ≤ 64; `null` removes. An unreadable file is `io-error`, never
overwritten. After a write main sends `apps:state-changed` to every **other** live frame session of
the app (hidden ones included). `pomade apps remove` leaves the folder.

## Overlays and shortcuts

- `overlay.open { route?, height?, anchor?: 'center' | 'panel' }` (not from an overlay session),
  `overlay.resize { height }` (only from an overlay session), `overlay.close` (only from an overlay
  session) — all delegated; frame-only (socket → `capability-denied`). The renderer refuses
  `overlay.open` from a frame that is not visible (`FrameBridge.isShown()`). `useOverlayStore`
  (runtime only) holds one overlay; a forwarded plain Escape closes it. Geometry
  (`overlay-geometry.ts`, window coordinates): width 420, height clamped to [120, 60 % of the window
  below the title bar], 16 px margin; the card (`position: fixed` inside the pane-scoped scrim) is kept
  whole inside the window below the title bar. The drop position is remembered per app in
  `WorkspaceUiState.overlayPositions` (window coordinates) and used by opens with anchor `'center'`
  (the shortcut, `overlay.open` without an anchor); anchor `'panel'` ignores it and never writes it.
- **`panel.show { icon?, route? }`** (no capability, frame-only: socket → `capability-denied`) — from
  any session of a frame (tab, panel, overlay; shown or hidden). Main parses the params
  (`checkShowPanelParams`) and resolves the icon against the calling app's manifest
  (`panelShowIcon`: the named icon with action `panel` / `both`, else the first such icon; none →
  `not-found`), then delegates `{ icon, route?, appId }` with the resolved icon id. The renderer:
  see "Delegated calls".
- **Shortcuts.** Manifest `shortcuts[]` (`AppShortcut { id, title, key, action: 'tab' | 'overlay', route }`).
  `POMADE_SHORTCUTS` (`shared/app-manifest.ts`) lists Pomade's own Cmd chords — `MAIN_SHORTCUTS`
  (menu accelerators and the chords main takes before the page) plus renderer window shortcuts and
  editor keymaps; keep it in sync when Pomade gains a chord. `resolveAppShortcuts`: Pomade always
  wins; among apps the first by id keeps a chord. One capture-phase `keydown` listener
  (`useAppShortcuts`) runs them. A key forwarded from a frame is re-dispatched as a synthetic
  `keydown` on the `<iframe>`; a forwarded `MAIN_SHORTCUTS` chord is dropped (the menu already ran
  it). No renderer handler binds a `MAIN_SHORTCUTS` chord.

## Workspace data methods (`host-api-data.ts`)

`host-api.ts` gates the capability and hands every data method to `callData(method, params)`
(`DATA_METHODS`, params parsed by `host-api-data-core.ts#parseDataParams`).

- **Files** (`files.read` / `files.write`): `readFile` (`frontmatter` parse optional; size and mtime
  from the same handle), `create` (`createFileAtomic`: tmp hard-linked into place, never partial),
  `write`, `setBody`, `setField`, `removeField`, `setKeyLines` (field edits via
  `pomade-kit/frontmatter`), `move` (refuses an existing destination), `delete { paths }`
  (≤ 1000 paths, each trashed independently: a folder → `invalid-params`; results per path, in
  order). Replacing writes use `writeFileAtomic(target, text, { mode, ifMtime })` on the real path,
  keeping permission bits; unchanged bytes write nothing.
- **Conditional writes.** `write` and every field/body edit run under a per-real-path lock
  (`withFileLock`), refuse a stale `ifMtime` up front, and the atomic write re-checks the mtime
  immediately before its rename (`ChangedOnDiskError` → `changed-on-disk`, target untouched).
- **Watches.** `files.watch` holds the platform watcher entry covering the path ([ipc-workspace-and-files](./ipc-workspace-and-files.md)
  §"watchers"); raw events arrive through `tapWorkspaceChanges`, batched per watch (120 ms),
  filtered by the workspace's ignored items, classified (delete / create / change; one deleted path plus one
  created folder in a batch = one `rename`). Each watch also **settles**: it keeps a reading of its
  scope (`watch-scope.ts`: folder presence, file size + mtime, ≤ 5000 entries), re-reads it at
  `SETTLE_DELAYS_MS` (300, 1200 ms) after registration and after every batch, and reports whatever
  the native watcher missed. A workspace switch drops every app watch.
- **Symlinks** (`files.symlink` capability): `files.symlink` / `files.removeSymlink` require the
  manifest's `symlinks` scopes to cover the link path and its folder to be real under the root;
  remove unlinks only a symbolic link, never following it.
- **`files.reveal { path, projectId? }`** (`files.read`) — `path` may be `""`; main checks it exists
  and is outside `.pomade` (by real path), then delegates (`requireExists`). A method the kit knows
  that `host-api.ts` neither handles nor lists in `DATA_METHODS` answers `unknown-method`.
- **`git.reveal { path, projectId? }`** (`git.read`) — `path` must be absolute (`invalid-params`
  otherwise); main resolves it and the workspace root with `fs.realpath` and takes the
  workspace-relative root (`host-api-data-core.ts#revealRepoRoot`) — a missing path or one outside the
  workspace is `not-found` — then delegates with `root` on the call.
- **Pickers.** `files.pickFolder` is delegated (the renderer resolves `root` from a project id) and
  comes back through `apps.pickFolder`, where main re-checks the session, the capability and both
  paths, then loops the native dialog until the real choice is a folder inside the root.
  `files.pickFile { under?, extensions? }` is served by main directly (frame-only), looping until the
  choice is a file inside `under`, outside `.pomade`, with an allowed extension. Cancel → `null`.
  `globalThis.__pomadePick` answers both under test ([test-hooks](./test-hooks.md)).

## Delegated calls

Main gates and validates, checks the disk (`tabs.openFile`: a file; `tabs.openTerminal`: a folder),
then answers `apps.call` with `{ delegate: AppDelegatedCall }`; the bridge serves it with
`modules/apps/delegated-calls.ts#serveDelegated` and posts the outcome. For `project.getSettings`,
`project.setSettings`, `tabs.openApp`, `overlay.open`, `panel.show` and `notices.post` main puts the **calling**
app's id on the call, never a param.

- `files.reveal` — the target project (below), or `__workspace__` when `path` lies outside the target
  project's folder (`revealProject`); the renderer hydrates and switches to it and hydrates its
  side-panel selection, expands a collapsed side panel, then `reveal-store.reveal(path, projectId,
  { expand: true })`: `SidePanel` brings Files forward and `FileTree.revealPath` expands the
  ancestors and the folder itself, selects and scrolls to the row.
- `panel.show` — in the active project: hydrates its side-panel selection, records `route` (when
  given) for the strip key `app:<appId>/<icon>` in `side-panels/app-panel-routes.ts#useAppPanelRoutes`
  (runtime only, per icon — one panel frame per icon), selects that key (`useSidePanelStore.select`)
  and expands a collapsed side panel — a strip-icon click minus its tab. `SidePanel`'s `AppPanel`
  passes the recorded route in its `AppFrameRequest`: a frame mounted by the call opens at it (main's
  `openFrame` lets `request.route` override the icon's panel route), a mounted one is navigated
  (`FrameBridge.setRoute` → `route.changed` when it differs from the route Pomade last sent). No
  focus moves: nothing is focused, and a hidden element never had it.
- `git.reveal` — the target project (below; unknown → `not-found`); `root` must be a repo of the
  git-state snapshot (`loadGitState()`), else `not-found`; the Workspace project shows it when the repo
  is not in the target project's `reposInScope` (`gitRevealProject`). The renderer hydrates and
  switches to that project and its side-panel selection, expands a collapsed side panel, selects
  `GIT_PANEL`, then `git-panel-store.revealRepo(projectId, root)`: `GitPanel` hands the request to the
  list's row, which scrolls into view (`block: 'nearest'`) and consumes it.
- Target project = `params.projectId ?? activeProject.id` (a store project or `__workspace__`, else
  `not-found`); the renderer hydrates and switches to it, then `tabs-store.openDocByPath` or
  `terminals-store.newCommandTerminal(projectId, { cwd, command?, title? })`.
- `project.activate` (`tabs.open`) — main validates `{ projectId }` only (a string) and delegates; the
  renderer resolves it with `targetProject` (a store project or `__workspace__`, else `not-found`) and
  calls `showProject`: hydrate the project's tabs, then `workspace-store.setActiveProject` unless it is
  active already. No tab store action, so the project's own active tab shows; the switch is not a
  user pick, so `useRevealActiveProject` reveals the row (T-311).
- `project.list` = `modules/apps/project-list.ts#buildProjectList` (the Projects panel walk).
- `project.getSettings` / `setSettings` — `Project.appSettings[appId]`, merged by the kit's
  `mergeProjectSettings`, capped at `PROJECT_SETTINGS_MAX_BYTES` (65536), written through
  `workspace-store.updateProject`; an emptied entry is dropped. `project.getAgents` / `setAgents` —
  `Project.visibleAgents` (`__workspace__` answers `['*']` for get, `invalid-params` for set).
- `project.getScopeFolders` / `addScopeFolder` / `removeScopeFolder` are **not** delegated: main serves
  them (`main/app-scope-folders.ts`) on `ProjectState.appScopeFolders` ([types](./types.md)), the
  caller's app id on each entry. The project must be in `workspace.json` (a save waiting for its
  debounce counts; `__workspace__` is `invalid-params`); the path goes through the kit's
  `scopeFolderPath(path, workspaceRoot)`; the list logic is `main/app-scope-folders-core.ts`.

## Git state for apps

`git.getState` / `git.watch` / `git.unwatch` (capability `git.read`) are delegated and served by
`modules/apps/git-calls.ts` from `git-state-store`: scope root `''` for an absent projectId or
`__workspace__`, else the project's `rootPath`; repos = `appRepos(snapshot, scopeRoot)` = the kit's
`gitReposInScope` (nearest enclosing repo always included) + `toAppRepo` (documented fields only).
Watches are per frame session (ids `g<n>`, dropped with the session) and post `git.changed` only
when the scope's repos differ from what they last delivered.

Tickets: E-027, E-029, E-030, T-236, T-241, T-243, T-244, T-245, T-246, T-320, T-324.
