---
doc: docs/contracts/host-api-socket.md
audience: engineers
holds: the Host API socket — listening, handshake and keys, socket sessions, the window's half of delegated calls, with-Pomade and always-on backends, the app-to-app broker, app commands and the Pomade home, the PATH line, platform commands
kind: reference
---

# Host API — host side, socket, backends, commands

App backends and command-line commands reach Pomade over a unix socket that carries the same Host
API as frames, through the same `host-api.ts#call`. App-facing contract: `docs/HOST-API.md` §2–§3.
Protocol from `pomade-kit/protocol` (`socket.ts`: `PLATFORM_CLIENT_ID` = `'pomade'`,
`SOCKET_PATH_MAX_BYTES` 103, `encodeLine` / `createLineDecoder`, `FRAME_ONLY_METHODS`,
`POMADE_ENV`, `HOME_FILES`, `HostRecord`); the client side is `pomade-kit/node`.

## The socket (`main/host-socket.ts`)

- `startHostSocket(userData)` in `whenReady`, before `reapLeftoverBackends()` and the registry's
  first scan: `<userData>/run/pomade.sock` (folder 0700, socket 0600). A path over 103 bytes, a live
  socket already there (another Pomade with the same user data, probed by connecting) or a listen
  error → logged, socket off, Pomade runs on. A stale file is removed first. `stopHostSocket()` in
  `will-quit`: destroys every connection, closes the server, removes the file synchronously.
- **Connection.** One JSON message per line (a line over 16 MiB destroys the connection), each
  parsed with `parseAppMessage`, handled in order. No welcoming `hello` within 5 s → closed.
- **Handshake.** `negotiate(hostApi)` (mismatch → `reject` with the version reason), then
  `authenticate(client: { appId, key, role })`: the app must be hosted (after
  `app-registry.appsScanned()`) or be the platform client (role `command` only); role `backend` only
  for an app declaring a backend, role `command` only for an app declaring commands; the key must
  equal `<userData>/app-keys/<id>` (constant-time compare) — else `reject` `unauthorized`. A welcomed
  app client becomes a `host-api.ts` session `socket:<n>` with target `{ surface: role, route: '' }`;
  a second `hello` ends the first session. `welcome = { hostApi, pomadeVersion, appId, surface:
  role, route: '', project: <active project> }`.
- **Calls.** Before `welcome`: `not-ready`. Platform client: `host.info`, `apps.call`,
  `agents.liveIn`, `notices.post`; anything else `capability-denied`. App client:
  `FRAME_ONLY_METHODS` → `capability-denied`; else the frame path with
  `{ activeProject }`. `key` messages are ignored.
- **Sink.** `files.changed`, `state.changed`, bus events and broker `request`s are written as protocol
  messages; a backend's `strip.setBadge` goes to every window as `apps:badge`.
- Seams: `sendEventToSession(sessionId, event)`, `socketSessionsOf(appId)`,
  `currentActiveProject()`, `hostSocketPath()`.

## Sessions (`host-api.ts`)

`Session { appId, target, sink: SessionSink, owner: WebContents | null, watches, bus }` — a frame
(`owner` = its window) or a socket client (`owner` null). `SessionSink { alive(), filesChanged,
stateChanged, badge, event, request }`. Exported for the socket: `call`, `openSession`,
`closeSession`. Each session opens one bus connection; a frame subscribes `project.changed` and
`theme.changed` at the handshake, a socket client only what it subscribes.

## The window's half (IPC)

```ts
apps.setActiveProject(ref: ProjectRef): Promise<void>   // every change; the first marks the window ready
apps.delegatedResult(requestId: string, outcome: AppCallOutcome): Promise<void>
apps.onServeDelegated(cb)   // EV 'apps:serve-delegated'  AppDelegatedServe { requestId, call }
apps.apiResponse(frameId, requestId, outcome): Promise<void>
apps.onApiRequest(cb)       // EV 'apps:api-request'      AppApiRequest
```

`modules/apps/socket-bridge.ts#useSocketBridge()` (mounted once) reports the active project and
serves each delegated call with `serveDelegated(call, WORKSPACE_REF, '')` — a socket client is in
no project, so every optional `projectId` (`files.reveal`, `git.reveal`, tabs, agent tabs, notices) defaults to the Workspace project.
Main sends `project.changed` to subscribed socket clients when the active project changes, waits up
to 10 s for the window's first report before serving a delegated call, and answers `not-ready` when
the window does not answer within 10 s.

## Keys (`main/app-keys.ts`, also used by the CLI)

`<userData>/app-keys/<id>`: 32 random bytes hex, folder 0700, file 0600, exclusive create
(concurrent issuers agree; an empty file is re-issued). Issued by `pomade apps install` / `link`, by
Pomade for every hosted app after each registry change, and for `pomade` at socket start;
`pomade apps remove` deletes it.

## With-Pomade backends (`main/app-backends.ts`)

- Manifest `backend: { entry, mode: 'with-pomade' | 'always-on', restartOnUpdate }`.
- **Reconcile** (serialized, on every registry change; restart all on workspace ready): wanted =
  every available app with `mode === 'with-pomade'` and a local folder, keyed by entry path +
  revision. A backend whose app is gone, or whose entry or revision changed, is stopped (and started
  again when still wanted). `reapLeftoverBackends()` (once at start) SIGTERMs processes a crashed
  Pomade left (`<userData>/run/backend-<id>.pid`, matched against `ps`).
- **Spawn**: `process.execPath <entry>` in the app folder, `env = clientEnv(id, 'backend')`, stdout
  and stderr to `<userData>/app-logs/<id>/backend.log` (rotated to `.1` past 2 MiB at spawn).
  `clientEnv(appId, role)` = `HOME USER LOGNAME SHELL PATH LANG TMPDIR TZ LC_*` from Pomade's env +
  `ELECTRON_RUN_AS_NODE=1`, `POMADE_APP_ID`, `POMADE_APP_KEY_FILE`, `POMADE_CLIENT`,
  `POMADE_APP_STATE` (`<userData>/app-state/<id>`, created), `POMADE_SOCKET` (while listening),
  `POMADE_KEEPER_SOCKET` (backends), `POMADE_WORKSPACE` (when a root is set).
- An exit not asked for → restart after `min(1 s × 2^(crashes−1), 30 s)`; `crashes` resets when a run
  lasted ≥ 30 s. Stop = SIGTERM, SIGKILL after 3 s. `stopAllBackends()` joins the quit drain.
- **Status** → `HostedApp.backend` (`AppBackendStatus`, [types](./types.md)); every status change
  (spawn, exit, a backend's socket session opening or closing) re-sends `apps:changed`.

## Always-on backends (`main/app-launchd.ts`)

- launchd agents in `~/Library/LaunchAgents`, label prefix `io.github.dd-voronov.pomade.app.`
  (packaged) / `io.github.dd-voronov.pomade-dev.app.` (dev); overridable by `POMADE_LAUNCH_AGENTS`
  and `POMADE_LAUNCHD_PREFIX`, which are required under test ([test-hooks](./test-hooks.md)).
- Reconcile on every registry change: for each available app with `mode === 'always-on'` and a
  local folder, write the plist when changed (`RunAtLoad`, `KeepAlive { SuccessfulExit: false }`,
  `ThrottleInterval 10`, `LimitLoadToSessionType Aqua`; env = `clientEnv` minus `POMADE_WORKSPACE`
  plus `POMADE_HOME`; log as above). Not loaded → `launchctl bootstrap`; loaded with a changed build
  stamp (`<userData>/run/always-on-<id>.stamp`) and `restartOnUpdate` → `bootout` + `bootstrap`;
  else left running. A plist whose app id the registry does not know at all is booted out and
  deleted. Quitting Pomade touches nothing.

## Broker (`main/app-broker.ts`)

- Manifest `api: string[]` (methods the app serves) and `calls: string[]` (apps it calls);
  `callCycles(apps)` warns at install. Methods `api.serve` (a session offers its app's API — a
  backend is preferred over the latest registration) and `apps.call` (capability-free; the caller
  must list the target in `calls` unless it calls its own app or is the platform, and the method
  must be in the target's `api`). Errors `app-absent`, `app-not-responding`, `app-error`.
- `callFromApp`, `callFromPlatform`, and `callAppApi(app, method, params?, timeoutMs = 2000):
  Promise<JsonValue | null>` — main's own reads of app APIs (null = absent, not responding or error:
  show nothing or fall back). `respond` accepts only the session the request went to; a non-JSON
  value → `app-error`. `dropSession` withdraws a server and fails its pending requests.
  `onServingChange(listener)` hears an app's API become served or unserved.
- A request to a frame goes out as `apps:api-request` and comes back through `apps.apiResponse`; to a
  socket session as a `request` line answered by a `response` line.

## Commands and the Pomade home (`main/app-commands*.ts`, `shell-path-line.ts`, `owner-paths.ts`)

- **Home**: `POMADE_HOME`, else off under `NODE_ENV=test` (where the Owner's real home is refused —
  `owner-paths.ts`), else `~/.pomade` (packaged) /
  `~/.pomade-dev`. Refreshed (serialized) on every registry change, on workspace ready, and once at
  start: `<home>/workspace` (`<root>\n`), `<home>/host.json` (`HostRecord`, 0600: how to launch this
  Pomade — packaged `/usr/bin/open -a <bundle>`, else this process's argv and `POMADE_*` /
  `NODE_ENV` env, without `-r` / `--inspect` / `--remote-debugging-port`), and `<home>/bin/<name>`
  shims (0755, atomic, only when changed): every available app's commands by id order (first name
  wins; env `POMADE_HOME`, `POMADE_APP_ID`, `POMADE_APP_KEY_FILE`, `POMADE_CLIENT=command`,
  `POMADE_APP_STATE`), `pomade` → `<repo>/bin/pomade` (source checkout), `pomade-git` → the built
  `out/main/pomade-git.js` under `ELECTRON_RUN_AS_NODE=1`. A `bin/` file carrying the shim marker that
  is not wanted is removed; anything else is left alone. Command names: the app id or `<id>-…`;
  `pomade` and `pomade-git` are reserved.
- Manifest `outsideWorkspace: string[]` (absolute or `~/…` paths an app uses) is shown at install and
  as a notice when a bundled update adds paths.
- **Terminals** get `PATH=<home>/bin:…`, `POMADE_HOME` and `POMADE_WORKSPACE` (`commandTerminalEnv`).
- **PATH line** (explicit action only — refresh never touches the rc file):

  ```ts
  commands.pathLine(): Promise<PathLineStatus | null>          // null: no home or no rc file
  commands.setPathLine(on: boolean): Promise<PathLineStatus | null>   // add (repointing another Pomade's line) / remove
  ```

  rc file = `POMADE_SHELL_RC` (`owner-paths.ts#resolveShellRc`; under test never a real rc file), else off
  under test, else `${ZDOTDIR:-~}/.zprofile`. One marked line
  `[ -n "$POMADE_HOME" ] || export PATH='<bin>'":$PATH" # Pomade: …`; written only when changed.
  `pomade path install | remove | status [--stable]` uses the same functions.
- **`pomade projects [--json]`** (`src/cli/projects.ts`): workspace = `POMADE_WORKSPACE`, else
  `<home>/workspace`, else `app.json`'s `workspaceRoot`; lists `.pomade/workspace.json` projects
  (`{ id, name, root, path }`, by name then id). Works with Pomade closed.

## Platform commands on the socket

- `agents.liveIn { folder }` (capability `platform`, which no manifest can list): `folder` absolute,
  answered by `agentsLiveIn(folder)` ([git-operations](./git-operations.md) §"In progress") as
  `{ live, agents: LiveAgentEntry[] }` — each with `state?` and `terminalPids?` (kit `pomade-kit/protocol`).
- `notices.post` from the platform client: `checkNotice`, then served in the window with `appId` =
  the call's `source` (an app id or a platform command like `pomade-git`), else `pomade`.
- `host.info` answers `skills: []` for the platform client; for an app, `HostInfo.skills` =
  each manifest skill's folder (null for a dev-server link).

Tickets: E-027, E-028, E-031, E-032, E-034, E-042.
