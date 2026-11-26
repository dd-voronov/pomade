---
doc: docs/modules/core/app-backends.md
audience: engineers, product
holds: the Host API socket — app backends (with Pomade, always on), app commands on PATH, the broker, app keys, the pomade command's runtime side; how it is built
kind: reference
---

# App backends and commands — the Host API socket

**Module:** `core` · **UI:** the backend line and warning dot on an app's strip icons; Settings ▸ General ▸ Commands · **Code:**
`src/main/host-socket.ts`, `src/main/app-keys.ts`, `src/main/app-backends.ts`, `src/main/app-broker.ts`, `src/main/app-commands.ts`, `src/main/app-commands-core.ts`, `src/main/app-launchd.ts`, `src/main/app-launchd-core.ts`, `src/main/shell-path-line.ts`, `src/main/host-api.ts`
(sessions), `src/cli/pomade.ts` (`pomade path`, `pomade projects`), `src/cli/projects.ts`, `src/renderer/modules/apps/socket-bridge.ts`, `src/renderer/modules/apps/backend-status.ts`, `src/renderer/modules/settings/CommandsPathRow.tsx` ·
**unit:** `src/main/app-keys.unit.test.ts`, `src/main/app-commands-core.unit.test.ts`, `src/main/app-launchd-core.unit.test.ts`, `src/main/shell-path-line.unit.test.ts`, `src/renderer/modules/apps/backend-status.unit.test.ts`, `src/cli/projects.unit.test.ts` (`pomade projects`), `src/cli/pomade-path.unit.test.ts` ·
**e2e:** `app-socket.spec.ts`, `app-backends.spec.ts`, `app-backend-tooltip.spec.ts`, `app-broker.spec.ts`, `app-commands.spec.ts`, `app-always-on.spec.ts` ·
**Contract:** [HOST-API](../../HOST-API.md) §3 "Socket" · internal surface: [contracts/host-api-socket](../../contracts/host-api-socket.md)

## What it does

An app's UI talks to Pomade over `postMessage` from its frame. Its other parts — a backend
process, the commands it ships — talk to Pomade over a local socket instead, with the very same
protocol: the same handshake, the same methods under the same manifest capabilities, the same
events and error codes. The kit's `pomade-kit/node` gives them the same typed client a frame gets.

## The socket

Pomade listens on `<userData>/run/pomade.sock` while it runs — the stable Pomade in
`~/Library/Application Support/Pomade/`, a dev Pomade in its own `pomade-dev/` folder, so the two
never meet. The folder is private to the user (0700) and so is the socket (0600). macOS limits a
socket path to 103 bytes; Pomade checks its path at start and, if it does not fit, runs without
the socket (apps' UIs keep working; backends and commands find "Pomade not running"). When Pomade
quits, every connection ends and the socket file is removed; a clean start also removes a file a
crash left behind.

## Who is calling

A frame is known by the frame itself; a socket client has to say who it is. Every hosted app has a
key — a random secret in `<userData>/app-keys/<id>`, readable only by the user — issued when the
app is installed or linked, and removed with the app. The client sends its app id, the key and its
role (`backend` or `command`) in `hello`; anything else is refused as `unauthorized`. A backend's identity is accepted only for an app that declares a backend, a command's only for an
app that ships commands. A client that connects while Pomade is still starting is answered once
Pomade knows its apps (the socket listens before the first scan); one that says no `hello` within 5 s
is dropped. A welcomed client is a session like a frame's: its calls go through the same capability gate, its watches end
with its connection. Pomade's own commands (`pomade-git`) connect the same way as the platform
client, `pomade`, with the platform key — and only as role `command`.

What this protects, honestly: the folder keeps other local users out, and the key makes each
client's identity explicit, so every app works under its own manifest. It does not protect against
the user's own processes — anything running as the user can read the key files. On a single-user
Mac that is the right trade: manifests are for visibility, not a sandbox.

## Calls that need the window

Some methods work on state the window owns — tabs, groups and projects, the git snapshot. For a
frame, the frame's bridge serves them; for a socket client, main hands the validated call to the
window over IPC and relays the answer. The window also reports the active project on every change,
so `project.getActive` answers a socket client like a frame; `project.changed` reaches it through
the event bus when it subscribes, as does `theme.changed` (its `welcome` carries both). A tab a
socket client opens (`tabs.openFile`, `tabs.openTerminal`, `tabs.openApp`, with or without a `key`) and the Files panel a
`files.reveal` shows go to the project they
name, else the Workspace project — a backend is in no project. A call waits up to 10 s for the window
(start-up, a reload) and answers `not-ready` if it never answers. Methods that only make sense for
a frame — the folder and file pickers, git watches, the overlay's, and a tab frame's own-tab methods
(`tabs.setRoute`, `tabs.setTitle`, `tabs.close`) — are refused over the socket (`capability-denied`);
a method the kit knows and this Pomade does not serve is `unknown-method`.

## Backends that run with Pomade

An app can ship a backend: a Node program in its build, for work a page cannot do — reading stores
outside the workspace, writing config files, keeping watch while no frame is open. A backend in
`with-pomade` mode runs exactly while Pomade runs. Pomade starts it at launch and whenever the app
appears, restarts it when the app is updated or the workspace is switched, and stops it when the
app is removed and when Pomade quits. If it crashes, Pomade starts it again after a short pause that
grows with each crash in a row (1 s, 2 s, 4 s … at most 30 s). A backend left behind by a Pomade
that crashed is stopped the next time Pomade starts.

Pomade runs the backend with its own runtime — its Electron binary in Node mode — so the Mac needs
no Node installation. The backend runs in the app's build folder and gets a clean environment: who it is on the socket
(`POMADE_APP_ID`, `POMADE_APP_KEY_FILE`, `POMADE_CLIENT`), where the socket is (`POMADE_SOCKET`),
the workspace root (`POMADE_WORKSPACE`), the socket where its keeper binds
(`POMADE_KEEPER_SOCKET`, [attached terminals](../terminal/attached-terminals.md)), its own state
folder (`POMADE_APP_STATE`, `<userData>/app-state/<id>/`, which Pomade creates — where it keeps run
history, captured output and caches), and the user's basics (`HOME`, `USER`, `LOGNAME`, `SHELL`,
`PATH`, `LANG`, `LC_*`, `TMPDIR`, `TZ`). What it prints goes to
`<userData>/app-logs/<id>/backend.log`, rotated to `backend.log.1` past 2 MiB. Its process id is
recorded in `<userData>/run/backend-<id>.pid`, which is how a backend a crashed Pomade left behind
is found and stopped (only when that process still runs that entry). Stopping is SIGTERM, then
SIGKILL after 3 s. A dev-server link has no local folder, so no backend: its icons say "stopped — a
dev-server link has no local backend".

**Status.** The app's strip icons tell how the backend is doing: the tooltip has a plain line —
"Background: running", "starting", "stopped" or "crashed — restarting", with "(with Pomade)" or
"(always on)" — and under it, muted, the detail: "pid 4182", "exited with code 1 · crash 2",
"connected to Pomade", or why it is stopped. A small amber dot sits on the icon's corner while the
backend is "stopped" or "crashed — restarting". An always-on backend reads "installing the login
item" while it starts, then "connected to Pomade" or "not connected to Pomade".

## Apps calling apps — the broker

Apps never talk to each other directly; Pomade carries every call. An app lists in its manifest
the methods it offers (`api`) and the apps it calls (`calls`). When its backend — or one of its
frames — starts serving (`api.serve`), other apps can call those methods: the call goes to Pomade,
Pomade passes it to the serving app, and the answer comes back the same way. A call is checked
before it is routed: the caller's `calls` must name the app (an app always reaches its own API),
and the method must be in the target's `api`. When the app has a backend and a frame both serving,
the backend serves; among frames the latest to register does. A call that waits longer than its
timeout, or whose server goes away meanwhile, fails. If the app is not
installed, nothing serves it right now, or it does not answer in time, the caller gets an answer
that says so — "absent" or "not responding" — and falls back to whatever it can do on its own.
Pomade's own surfaces read apps the same way — the Git panel asks Runner which jobs target a repo,
the agent roster and session reads come from the Agents app, and the Git panel hears when Runner
starts or stops serving; the app's absence simply means the extra element is not shown or Pomade's
built-in fallback is used.

Pomade does not watch for call cycles while running; the manifests declare who calls whom, and
installing an app that closes a cycle prints a warning.

## Commands on PATH

An app can ship command-line entries — `pomade-planner today`, `pomade-agents set-name` — named
after the app, so they never shadow a system command or another app's. Pomade keeps a command
folder in its home: `~/.pomade/bin` for the installed Pomade, `~/.pomade-dev/bin` for a dev one,
so a dev build never hides the real one's commands. A command's name is the app's id or `<app id>-…`, never `pomade` or `pomade-git`. Every hosted
app's commands appear there as small launchers (marked `# Pomade command shim`, rewritten whenever
the apps change) the moment the app is installed or linked, and disappear when it is removed; a
dev-server link has none. When two apps name one command, the app whose id sorts first has it. They
run with Pomade's own runtime and know which app they belong to and the app's state folder (the
same one its backend gets, so a command finds the backend's control socket and history there), so
they can reach their app's API through Pomade — or, with Pomade closed, do what they can on their
own: the home also holds the current workspace root (`workspace`, rewritten on every workspace switch)
and how to start this Pomade (`host.json`: the socket and a launch record), so `pomade-planner
today` reads the planner's files with Pomade closed and a backend can launch Pomade.

**Which project am I in?** Agents write project-bound app data — a Runner job file names its
project by its stable id. Every Pomade terminal has `POMADE_PROJECT_ID` (the project its tab was
opened in; `__workspace__` for the Workspace project) next to `POMADE_TAB_ID`. Elsewhere, and with
Pomade closed, `pomade projects` lists the open workspace's projects — id, name, folder (`.` for the
workspace root) — straight from `<workspace>/.pomade/workspace.json`, by name (`--json` for
scripts: `{ workspace, projects: [{ id, name, root, path }] }`). The workspace is `POMADE_WORKSPACE`
(set in Pomade's terminals), else the home's `workspace` pointer, else the one recorded in
`<userData>/app.json` (`workspaceRoot`). A terminal keeps the project id it started with: a tab moved to another
project keeps the old one in its running shell. The `pomade` command ([app hosting](./app-hosting.md)
"The pomade command") is in the command folder where Pomade runs from a source checkout; a packaged
Pomade has `pomade-git` only.

Pomade's own terminals have the folder first on PATH, with `POMADE_HOME` and `POMADE_WORKSPACE`. Other terminals get it only when you ask: Settings ▸
General ▸ Commands ▸ **Add line** (or `pomade path install`) puts one marked line in `~/.zprofile`,
and **Remove line** (`pomade path remove`) takes it out, leaving the rest of the file as it was.
Pomade never writes that file on its own. The setting says whether the line is there and which
Pomade's folder it names — a dev Pomade adding its line repoints the one line rather than adding a
second.

## Backends that are always on

Some work must go on when Pomade is closed — Runner's scheduled jobs. Such an app declares an
`always-on` backend, and Pomade installs it as a login item of the user's: macOS starts it at
login and restarts it if it crashes (not if it exits cleanly; at most every 10 s), and it keeps
running when Pomade quits. The plist is
`~/Library/LaunchAgents/io.github.dd-voronov.pomade.app.<id>.plist` (a dev Pomade:
`io.github.dd-voronov.pomade-dev.app.<id>`; Pomade manages only plists with its own prefix). It runs
from the app's build folder, a stable path, with the backend's environment minus `POMADE_WORKSPACE`
— the workspace changes while it runs, so it reads the home's `workspace` pointer — plus `POMADE_HOME`;
its output goes to the same `backend.log`. When the app is updated, the plist is rewritten and the running backend is not
interrupted (a scheduled job may be halfway through) — unless the manifest says `restartOnUpdate`,
then the job is reloaded. Removing the app removes the login item, also when it was removed while
Pomade was closed (at the next start); an app that is known but briefly unavailable keeps its item.
Always-on backends are off in a Pomade without a resolved launch-agents folder (a test run without
the hooks); the icon then reads "always-on backends are off in this Pomade".

The backend talks to Pomade whenever Pomade runs, and reconnects when it starts again. When it
needs Pomade — a job that opens a terminal tab — it can launch it and wait until it is ready.

## Pomade's own commands

The platform's own commands — `pomade-git` — are socket clients too, with a key of their own. The
`pomade-git` launcher is always in the command folder (the build ships it in the app bundle). While
Pomade runs they can ask it what only it knows (`agents.liveIn`: "is an agent working in this repo
right now?", answered from Pomade's terminals joined with the agents app's tabs and runs; each agent
comes with its `state` — working, needs-you or idle — when known, and the shells of the Pomade
terminals it runs in as `terminalPids`). They read app APIs through the broker (`apps.call`)
and post notices (`notices.post`, shown as `pomade` or the source they name); every other method is
`capability-denied`.

## Events and notices from backends and commands

A backend hears what happens in Pomade through the event bus, like a frame — but only what it
subscribes to (and declares in its manifest): a project renamed, another app's event. A backend
or command that has something to tell the user posts a notice; while Pomade runs it appears at
once, and while Pomade is closed it waits in the notice queue until Pomade next starts. The
kit's `postNotice` picks the way, so the app never has to ([notices](./notices.md)
"Notices while Pomade is closed"). A backend can badge its app's icons with `strip.setBadge` like a
frame; the badge goes to every window. Its session ends with its connection: its watches and
subscriptions go with it.

