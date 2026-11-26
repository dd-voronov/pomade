---
doc: docs/HOST-API.md
audience: app developers and Pomade engineers
holds: the Host API contract between Pomade and the apps it hosts — manifest, install, transport, methods and events, hosting behavior, release
kind: reference
---

# Pomade Host API

The contract between Pomade (the host) and every app it hosts. Pomade owns this protocol and
implements its host side. `pomade-kit` carries its code form — the message
types, the client apps call, and a fake host for standalone runs — so apps never import platform
code ([[PLATFORM]] rule 3). An app talks to Pomade only through this API.

**Version: 0.** Until the first app is installed into the stable Pomade, any part of this
document may change; Pomade, the kit and the apps move together. Then it is frozen as v1 and
changes become additive ([[PLATFORM]] rule 3).

The protocol runs over two channels: `postMessage` for an app's UI frames, and a local socket for
its backend and commands (§3 "Socket").

---

## 1. Manifest

Every app ships `manifest.json` at the root of its build folder.

```jsonc
{
  "id": "pomade-planner",        // ^[a-z][a-z0-9-]{1,63}$ — also the pomade-app:// host
  "name": "Planner",              // shown in Pomade's UI
  "version": "0.1.0",             // semver
  "hostApi": 0,                   // the Host API version the app speaks
  "entry": "index.html",          // optional; default "index.html"
  "icon": "icon.svg",             // optional; path inside the build folder
  "capabilities": ["project.read", "files.read"],  // methods the app may call (§4)
  "symlinks": ["Projects/*/links"],  // optional; folders where it may create / remove symlinks (§4 files.symlink)
  "strip": [                      // optional; icons in Pomade's icon strip, in this order
    { "id": "planner", "title": "Planner", "icon": "planner.svg", "action": "panel" },
    { "id": "board", "title": "Board", "icon": "board.svg", "action": "both",
      "route": "board", "panelRoute": "needs-you" }
  ],
  "tabKinds": {                    // optional; kinds of keyed tabs the app opens (§4 "Own tab")
    "output": { "title": "Output", "icon": "output.svg" }
  },
  "startOnLaunch": true,           // optional; load the first panel/both icon's panel hidden at launch
  "shortcuts": [                   // optional; Pomade-wide shortcuts
    { "id": "today", "title": "Open Today", "key": "Cmd+Shift+Y", "action": "tab", "route": "today" }
  ],
  "skills": ["skills/pomade-planner-tasks"],  // optional; agent skills the app ships (§2)
  "events": {                      // optional; the event bus (§4 events)
    "publish": ["summary.posted"],                       // the app's own events
    "subscribe": ["pomade.ready", "project.renamed", "pomade-runner:run.finished"]
  },
  "backend": { "entry": "backend/main.js", "mode": "with-pomade" },  // optional; §2 "Backends"
  "api": ["today"],                // optional; methods it offers other apps (§4 `apps`)
  "calls": ["pomade-agents"],      // optional; apps whose APIs it calls (§4 `apps`)
  "commands": [{ "name": "pomade-planner", "entry": "cli/main.js", "title": "Today as JSON" }],  // optional; §2 "Commands"
  "outsideWorkspace": ["~/.claude/", "~/.zshrc"]  // optional; paths outside the workspace it uses
}
```

**Strip icons** (`strip`, each an object):

| Key | Type | |
|---|---|---|
| `id` | `^[a-z][a-z0-9-]{0,31}$` | unique within the app; names the icon in `welcome` and `strip.setBadge` |
| `title` | non-empty string | tooltip, panel header, and the title of the tab it opens |
| `icon` | path inside the build folder, optional | falls back to the app's `icon`; see "Icon images" below |
| `action` | `"panel"` \| `"tab"` \| `"both"` | fill the side panel · open (or focus) a tab · both at once |
| `route` | string, optional, default `""` | what the opened surface(s) render; `""` = the app's default view |
| `panelRoute` | string, optional, `both` only | the panel's route when it differs from the tab's |

**Icon images** (the app's `icon`, each strip icon's and each tab kind's): an SVG drawn in `currentColor` on a
transparent background, 18×18 viewBox, 1.3px strokes — the language of Pomade's own icons.
Pomade draws such an icon in its own colours, as it draws Files and Git: muted idle, darker on
hover and when selected, the tab strip's text colour in a tab. An SVG in one fixed colour is
treated the same (the colour is replaced). Any other image — a raster, or an SVG with several
colours, a gradient or an embedded image — is shown as it is and does not follow the state.

A tab opened from an icon is one per icon per project: a second click focuses it. Its title is
the icon's `title` (the app's `name` for a tab from the new-tab menu) and follows the manifest:
a reinstall that renames the icon retitles the open tab, unless the user renamed it or the app
titled it (`tabs.setTitle`). An invalid
icon makes the manifest invalid (the error names it, e.g. `"strip[1].action"`); keys inside an
icon beyond these are ignored.

**App tab kinds** (`tabKinds`, an object of kinds by id): the kinds of keyed tabs the app opens
(`tabs.openApp` `kind`, §4 "Own tab") — Runner's run output.

| Key | Type | |
|---|---|---|
| id (the key) | `^[a-z][a-z0-9-]{0,31}$` | what `tabs.openApp` `kind` names |
| `title` | non-empty string | the title of a tab of this kind when the app gives none |
| `icon` | path inside the build folder, optional | the tab's icon; falls back to the app's `icon`; see "Icon images" |

An invalid kind makes the manifest invalid, the error naming it (`"tabKinds.output.icon"`); keys
inside a kind beyond these are ignored. A kind's title follows the manifest like a strip icon's: a
reinstall that renames it retitles the open tabs of that kind that carry no title of the app's or
the user's. A reinstall that removes the kind keeps its tabs open, with the app's icon and name.
The install summary lists the kinds (`Tab kinds:     Output`).

**Shortcuts** (`shortcuts`, each an object) — Pomade-wide: they work whatever has focus, a
terminal, an editor, Pomade's own UI or any app frame:

| Key | Type | |
|---|---|---|
| `id` | `^[a-z][a-z0-9-]{0,31}$` | unique within the app |
| `title` | non-empty string | what it does, for people (install summary) |
| `key` | chord | `Cmd`, then any of `Ctrl`, `Alt`, `Shift`, then one letter or digit, joined by `+` (`Cmd+Shift+Y`); case-insensitive, unique within the app; matched on the physical key, so it works under any keyboard layout |
| `action` | `"tab"` \| `"overlay"` | `tab`: open or focus the app's tab at `route` in the active project — exactly `tabs.openApp({ route })` (§4). `overlay`: open the app's **overlay** frame at `route` (§5) |
| `route` | string, optional, default `""` | the route the opened surface renders |

An invalid shortcut makes the manifest invalid (`"shortcuts[0].key"`); a repeated id or chord is
reported on the later one. A valid chord that **Pomade itself uses** (its menus, its window
shortcuts, its editors — Cmd+W, Cmd+S, Cmd+B, …) is a conflict: Pomade wins, the shortcut does
nothing, and the install summary lists it under "Shortcut conflicts". Between two apps declaring
the same chord, the app whose id sorts first wins; the other's shortcut does nothing.

**Skills** (`skills`, an array of folder paths inside the build): agent skills the app ships.
Each folder holds a `SKILL.md`; its last segment is the skill's name (`^[a-z0-9][a-z0-9._-]{0,63}$`,
unique within the app). A skill's master copy lives in the app's repo, versioned with the format
it describes, and ships in the build. An invalid entry makes the manifest invalid (`"skills[1]"`);
a folder without `SKILL.md` makes install refuse the app. Pomade reports where they are — in the
install output (§2) and to the app itself in `host.info` (§4 `host`) — and never links them;
giving a skill to an agent is the user's step. The app says it to the user: once, in a first-run
notice it remembers dismissing (`state`), and always in its About view (`pomade-kit`'s
`examples/hello` is the pattern).

**Events** (`events`, an object; both lists optional): `publish` lists the app's own event names
— dot-separated lowerCamel words (`run.started`, `session.statusChanged`; `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$`,
at most 64 characters) — and `subscribe` the events it listens to: platform events (§4 `events`)
and apps' events as `<appId>:<event>` — other apps' and the app's own (its backend publishes, its
frames hear it). Each list is unique. An invalid entry makes the
manifest invalid (`"events.subscribe[1]"`). The install summary lists both.

**Start on launch** (`startOnLaunch`, boolean, default `false`): Pomade loads the app's **launch
panel** — the panel of its first strip icon with action `panel` or `both` — hidden when it starts
(and when the app appears while Pomade runs), so the app can badge its icon before the user opens
it. The frame is welcomed like any panel frame (`surface: "panel"`, that icon, its panel route)
and is the very frame the icon later shows. `true` without such an icon is invalid
(`"startOnLaunch"`). The install summary says which panel starts.

**Backend** (`backend`, an object): the app's background process (§2 "Backends").

| Key | Type | |
|---|---|---|
| `entry` | path inside the build folder ending in `.js`, `.mjs` or `.cjs` | the Node program |
| `mode` | `"with-pomade"` \| `"always-on"` | runs while Pomade runs · a login item that keeps running when Pomade quits |
| `restartOnUpdate` | boolean, optional, default `false`, `always-on` only | an app update restarts the running backend |

An invalid key makes the manifest invalid (`"backend.mode"`); keys beyond these are ignored. The
install summary says which mode it runs in.

**API and calls** (`api`, `calls`; §4 `apps`): `api` lists the method names the app
serves to other apps — each matching `^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$`, at most 64
characters, unique (`"api[1]"`). `calls` lists the ids of the apps whose APIs it calls — never the
app itself (an app always reaches its own API), unique (`"calls[0]"`). They are declarations of
dependency ([[PLATFORM]] rule 4): the install summary lists both, and install warns about a call
cycle among the hosted apps that includes the app.

**Commands** (`commands`, each an object; §2 "Commands"):

| Key | Type | |
|---|---|---|
| `name` | `^[a-z][a-z0-9-]{0,63}$`, the app id or `<app id>-…` | what the user types; never `pomade` or `pomade-git` (Pomade's own) |
| `entry` | path inside the build folder ending in `.js`, `.mjs` or `.cjs` | the Node program |
| `title` | string, optional | what it does, for the install summary |

A name is unique within the app; an invalid command is reported by index (`"commands[0].name"`).

**Outside the workspace** (`outsideWorkspace`, an array of paths): the files and folders outside
the workspace the app reads or writes — agents' session stores, shell startup files. Each entry is
absolute (`/etc/hosts`) or starts with `~/` (the user's home); a trailing `/` marks a folder; no
`.` or `..` segment, no empty segment, no backslash, at most 1024 characters; unique. Entries are
kept as written; an invalid one makes the manifest invalid (`"outsideWorkspace[0]"`). Pomade shows
them once, at install: `pomade apps install` (and `link`) prints them in the summary
(`Outside the workspace: ~/.claude/, ~/.zshrc`), and a bundled app's install posts a notice
"Outside the workspace" naming the app and its paths — an update of a bundled app, only the paths
the installed build did not declare. They are for people to see; Pomade enforces nothing.

- A missing or invalid required field makes the manifest invalid: install refuses it with a
  readable message for every invalid field, naming the field and the value received; an
  already-installed app with an invalid manifest shows
  the "unavailable" state.
- Top-level keys this Pomade does not know yet (`dashboard`, …) are
  accepted and listed in the install summary as "not supported by this Pomade yet". This lets
  an app declare surfaces before Pomade ships them.
- The id `pomade` is reserved for Pomade itself (its own commands on the socket, §3 "Socket").
- `capabilities` values are the method groups of §4 (`project.read`, `project.write`,
  `files.read`, `files.write`, `files.symlink`, `tabs.open`, `git.read`, `agentTabs.read`,
  `agentTabs.write`). An unknown capability is a validation error.
- `symlinks` (optional) lists workspace-relative folder patterns where the app may create and
  remove symlinks; a segment that is exactly `*` matches any one folder name. A pattern that is
  absolute, empty, contains `.`/`..` segments, a backslash, or a `*` inside a name is invalid
  (`"symlinks[1]"`). Pomade lists them in the install summary.

## 2. Install, dev link, discovery

**Installed apps** live in `<userData>/apps/<id>/` — a full copy of the app's build folder,
manifest included. Pomade discovers them at launch and watches `<userData>/apps/`: an install,
update or removal while Pomade runs takes effect without a restart (open frames of that app
reload; a removed app's frames show "unavailable").

- **Build folders.** Each install copies the build into a fresh `<userData>/apps/.builds/<id>-<stamp>/`,
  and `<userData>/apps/<id>` is a link to it, swapped in one step: a watching Pomade sees the old build
  or the new one, never a half-copied folder. A process started from a build resolves its files there
  (Node follows the link), so an update or a removal never pulls them from under it — an app's keeper
  keeps spawning with its own node-pty and `spawn-helper` until the app's backend upgrades it. A build
  that is no longer current is deleted once no process has a file, a mapped library or its working
  folder in it (checked with `lsof` at Pomade's start and after each `pomade apps install` / `remove`).
- **Removals** are recorded in `<userData>/app-removals.json` (`{ "<id>": "<version removed>" }`), so a
  bundled app (§8) the user removed is not put back by the same build; installing it again clears the
  record.

**The `pomade` command** (shipped in the Pomade repo as `bin/pomade`; a Pomade run from a source
checkout puts it in its command folder, "Commands" below, aimed at its own user data and home):

| Command | Effect |
|---|---|
| `pomade apps install <build-folder>` | validate the manifest, print the install summary, copy into a new build folder and point `<userData>/apps/<id>` at it (replacing an existing install), say where each shipped skill is |
| `pomade apps remove <id>` | remove `<userData>/apps/<id>` and record the removal |
| `pomade apps link <build-folder \| http://localhost:PORT>` | register a dev link (the manifest is read from the folder, or fetched from `<url>/manifest.json`) |
| `pomade apps unlink <id>` | remove a dev link |
| `pomade apps list` | installed apps and dev links, with versions |
| `pomade projects [--json]` | the open workspace's projects — stable id, name, folder — read from `<workspace>/.pomade/workspace.json`, with Pomade running or closed. The workspace is `POMADE_WORKSPACE`, else the home's `workspace` pointer, else the one recorded in `<userData>/app.json`. `--json`: `{ workspace, projects: [{ id, name, root, path }] }` (`root` workspace-relative, `""` = the workspace root; `path` absolute), by name |

**Which Pomade.** The command targets the **dev** Pomade's user data (`pomade-dev`) by default.
`--stable` targets the stable Pomade and is used only on the Owner's explicit word (the app release
ritual, §8). `POMADE_USER_DATA` overrides both (tests).

**Skills.** Pomade links an app's skills nowhere. Install (and `link` for a build folder) refuses
a skill folder without `SKILL.md`, lists the skills in the summary (`Skills: <name> (<path>)`), and
prints one line per skill with its folder's absolute path in the installed build — or in the linked
build folder for a dev link:

```
Skill pomade-runner-jobs is at <userData>/apps/pomade-runner/skills/pomade-runner-jobs. To give it to an agent, copy or link this folder into the agent's skills folder.
```

A dev link to a dev-server URL lists the skills in the summary only (there is no local folder).

**Backends.** An app's `backend` (§1) is a Node program Pomade runs with its own Electron binary
in Node mode (`ELECTRON_RUN_AS_NODE=1` — no system Node needed), in the app's build folder
(installed copy or folder dev link; a dev-server link has no backend), with this environment:
`POMADE_APP_ID`, `POMADE_APP_KEY_FILE`, `POMADE_CLIENT=backend`, `POMADE_SOCKET`,
`POMADE_KEEPER_SOCKET` (where the app's keeper binds, below), `POMADE_APP_STATE` (the app's state
folder, below), `POMADE_WORKSPACE` (when a workspace is open), and the user's `HOME`, `USER`, `LOGNAME`, `SHELL`,
`PATH`, `LANG`, `LC_*`, `TMPDIR`, `TZ` — nothing else of Pomade's. Its stdout and stderr go to
`<userData>/app-logs/<id>/backend.log` (rotated to `backend.log.1` past 2 MiB). It talks to Pomade
over the socket (§3 "Socket"), as `pomade-kit/node`'s `stayConnected()` does.

- **`with-pomade`** — started when Pomade starts and when the app appears (install, dev link);
  restarted when the app is updated and when the workspace is switched; stopped (SIGTERM, then
  SIGKILL after 3 s) when the app is removed or unlinked and when Pomade quits. When it exits on its
  own it is restarted after a back-off — 1 s, doubling to at most 30 s; a run of 30 s or more resets
  it. A backend left running by a Pomade that crashed is stopped when Pomade next starts.
- **`always-on`** — a per-user launchd agent (a login item): `~/Library/LaunchAgents/<label>.plist`,
  label `io.github.dd-voronov.pomade.app.<id>` (a dev Pomade: `…pomade-dev.app.<id>`). It runs the
  entry from the app's build folder with Pomade's runtime and the environment above — without
  `POMADE_WORKSPACE` (the backend reads the workspace pointer, §2 "Commands", which follows switches)
  and with `POMADE_HOME` — starts at login (`RunAtLoad`), is restarted by launchd when it exits with
  an error (`KeepAlive` `SuccessfulExit: false`, at most every 10 s), and keeps running when Pomade
  quits. Pomade writes and loads it when the app appears. An app update rewrites the plist but
  leaves the running backend alone — unless the manifest says `restartOnUpdate`, then the job is
  reloaded. When the app is removed (while Pomade runs, or at its next start), the job is booted out
  and its plist removed. The backend reaches Pomade over the socket when it runs, and can start it:
  `pomade-kit/node`'s `launchPomade()` runs the launch Pomade records in `host.json` and waits for
  the handshake.
- **The app's state folder.** `POMADE_APP_STATE` is `<userData>/app-state/<id>/` (absolute): the
  app's machine-local state — run history, captured output, caches, a control socket its backend
  and its commands share ([[PLATFORM]] "Locations"). Pomade creates it before it starts the backend
  or writes the command's shim, and gives the same path to the backend (the login item too) and to
  every command of the app; `pomade-kit/node`'s `appStateDir()` reads it. Pomade's own `state`
  store (§4 `state`) is `state.json` in it; the kit's keeper keeps its records in `keeper/` in it.
- **The keeper socket.** `POMADE_KEEPER_SOCKET` is
  `<userData>/run/keepers/<appId>.sock` (the folder is 0700; Pomade creates it): where the app's keeper
  — `pomade-kit/keeper`, the process that holds the app's terminal sessions so they outlive Pomade —
  binds. The backend starts it (`pomade-kit/node`'s `startKeeper`); Pomade connects there directly to
  attach tabs (§4 `tabs.openAttached`), never through the app. The protocol is `pomade-kit`'s attach
  protocol (its README "Attached terminals"); macOS caps the path at 103 bytes, and the keeper refuses a
  longer one with a message saying so.
- **Status** shows on the app's strip icons: the tooltip has a "Background: …" line (running, starting,
  stopped, crashed — restarting; with Pomade or always on) with a muted detail under it, and an amber
  dot marks a backend that is down.

**Commands.** Each Pomade has a home folder: `~/.pomade` for the stable Pomade, `~/.pomade-dev` for a
dev one (so a dev Pomade never shadows the stable one's commands), `POMADE_HOME` for tests. In it:

| Path | What |
|---|---|
| `bin/` | the command folder: one shim per command of every hosted app with a local build folder, plus `pomade` from a source checkout |
| `workspace` | the current workspace root (one absolute path), rewritten on every workspace switch |
| `host.json` | `{ socket, launch: { argv, env } }` — the socket, and how to start this Pomade (§2 "Backends", always-on) |

- A shim runs the command's `entry` with Pomade's runtime (`ELECTRON_RUN_AS_NODE=1`) and sets
  `POMADE_HOME`, `POMADE_APP_ID`, `POMADE_APP_KEY_FILE`, `POMADE_CLIENT=command`,
  `POMADE_APP_STATE` (the app's state folder, "Backends" above); the user's arguments follow. The
  `pomade` shim sets `POMADE_HOME` and `POMADE_USER_DATA` to its own Pomade's. Shims are rewritten whenever the hosted apps change and removed with their app;
  Pomade replaces or removes only files carrying its shim marker line. When two apps name the same
  command, the app whose id sorts first has it.
- **On `PATH`.** Pomade's own terminals get `<home>/bin` first on `PATH`, plus `POMADE_HOME` and
  `POMADE_WORKSPACE`, `POMADE_TAB_ID` — the id of the tab the terminal runs in (a plain terminal's
  or an agent's), so a command run there can find its own tab, and through `agentTabs.list` its
  session — and `POMADE_PROJECT_ID`, the stable id of the project the tab was opened in
  (`__workspace__` for the Workspace project), so an agent writing project-bound app data (a Runner
  job's `project:`) knows the id without asking Pomade. Both are set when the shell starts: a tab
  moved to another project keeps the old project id in its running shell until it is relaunched or
  revived. Outside Pomade's terminals, and with Pomade closed, `pomade projects` lists the ids. Other shells get it from one line in `${ZDOTDIR:-$HOME}/.zprofile` (login
  shells), marked `# Pomade: its commands on PATH — delete this line to remove them`; the line steps
  aside where `POMADE_HOME` is already set (Pomade's terminals). **Pomade never writes the file on
  its own:** the line is added or removed only by an explicit action — Settings ▸ General ▸ Commands
  (Add line / Remove line), or `pomade path install` / `remove` / `status` (`--stable` for
  `~/.pomade`; the default is the dev home, and `POMADE_HOME` — set in Pomade's terminals — wins).
  There is at most one Pomade line: adding from another Pomade repoints it.
- **With Pomade closed** a command still runs. `pomade-kit/node`'s `connectSocket()` then answers
  `not-running`, and `resolveWorkspace()` finds the workspace from `POMADE_WORKSPACE`, else the
  `workspace` pointer.

**Dev links** are stored in `<userData>/app-links.json`. A linked app is served from its build
folder through `pomade-app://<id>/` exactly like an installed one, or loaded from its dev-server
URL. A dev link wins over an installed copy with the same id.

**Testing hooks.** `POMADE_DEV_APPS=<path-or-url>[;<path-or-url>…]` adds dev links for one run
without touching `app-links.json` — an app's e2e launches Pomade against a fixture workspace
(`POMADE_WORKSPACE`, `POMADE_USER_DATA`) with the app dev-linked. `POMADE_BUNDLED_APPS=<folder>`
names a folder of bundled builds (§8) for a Pomade that is not packaged.

## 3. Transport and handshake

An app's UI runs in an `<iframe>` whose origin is `pomade-app://<id>` (or the dev-server origin for
a URL dev link). It talks to its parent window with `postMessage`. Every protocol message is an
object with `channel: "pomade"`; anything else is ignored by both sides. Pomade accepts messages
only from the frame it created for that app, and identifies the app by that frame — never by a
field in the message.

```ts
// app → host, first message
{ channel: "pomade", type: "hello", hostApi: 0 }

// host → app, success
{ channel: "pomade", type: "welcome", hostApi: 0, pomadeVersion: "0.3.0",
  appId: "pomade-planner", surface: "panel", icon: "board", route: "needs-you",
  project: ProjectRef, theme: "light" }

// host → app, refusal (the app shows a "needs a newer Pomade" / "needs an update" state;
// `unauthorized` only over the socket, §3 "Socket")
{ channel: "pomade", type: "reject", reason: "needs-newer-pomade" | "app-too-old" | "unauthorized",
  hostApi: 0 /* what this Pomade speaks */ }
```

- A **keyed tab**'s frame (§4 "Own tab") also carries `key` and, when it was opened with one,
  `kind`; every other frame carries neither:
  `{ …, surface: "tab", route: "output/r42", key: "output:r42", kind: "output", … }`.
- `surface` is where the frame lives: `"tab"` (main area), `"panel"` (the side panel) or
  `"overlay"` (the app's overlay, §5) — or, over the socket, `"backend"` / `"command"`. `icon` is
  the strip icon the frame was opened for — absent for a tab opened from the new-tab menu.
  `route` is what to render: the icon's `route` on a tab, its `panelRoute` (else `route`) on a
  panel, `""` without an icon — or the route an icon-less tab was opened or navigated at
  (`tabs.openApp`, §4). One bundle serves every surface and picks its view from these; a tab
  navigated later gets `route.changed`.
- `project` is the project the frame belongs to. A **tab** frame's is the project its tab lives in
  (§5), at first open, after a restart that restores tabs of several projects, and on every
  reload — whichever project is in front; a tab moved to another project is welcomed with the
  new one at its next handshake. A **panel** or **overlay** frame belongs to no project: its
  `project` is the active one (the Workspace project when none), kept current by `project.changed`.
  A backend or command's is the active one too (§3 "Socket").
- `theme` is Pomade's theme, `"light" | "dark"` — the one Pomade's own window shows, never the
  Mac's appearance. Pomade has its light theme only, so `theme` is `"light"`. Every frame gets
  `theme.changed` when it changes (§4 `events`); a backend or command gets it when it subscribes.
  How an app follows it: §5 "Theme and design tokens".
- Version 0 requires an exact match: an app speaking a newer version than the host gets
  `needs-newer-pomade`, an older one `app-too-old`. A `hello` whose `hostApi` is not an integer
  is ignored.
- The host answers every `hello`; each one starts a new handshake for that frame and drops the
  frame's watches.
- The app may resend `hello` until it gets an answer. With no answer within **1500 ms** the app is
  standalone (opened in a browser) and shows its "no Pomade host" state.
- Calls before `welcome` are answered with error `not-ready`.
- A reload of the frame starts a new handshake; Pomade drops the old frame's watches.

**Calls** — request/response, matched by `id` (unique per frame, chosen by the app). `params`
may be omitted for methods without parameters; unknown keys in `params` are ignored:

```ts
{ channel: "pomade", type: "call", id: "7", method: "files.readFolder", params: {...} }
{ channel: "pomade", type: "result", id: "7", ok: true, value: ... }
{ channel: "pomade", type: "result", id: "7", ok: false, error: { code: ErrorCode, message: string } }
```

**Events** — host → app, after `welcome`:

```ts
{ channel: "pomade", type: "event", name: "project.changed", payload: ProjectRef }
```

**Keys** — app → host. Pomade's own shortcuts must keep working while an app frame has focus.
The app forwards every `keydown` it did not handle (`defaultPrevented === false`) made with Cmd
or Ctrl held — the modifier keys pressed alone are not forwarded. An **overlay** frame also
forwards an unhandled plain Escape (no modifier), which closes it:

```ts
{ channel: "pomade", type: "key", key: "w", code: "KeyW",
  metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
```

Pomade dispatches it to its shortcut handling as if pressed in Pomade — Pomade's own shortcuts
and every app's manifest shortcuts (§1) alike, from a tab, a panel or an overlay frame. A chord of
Pomade's menu reaches the menu straight from the frame, so its forwarded copy is ignored: every
chord runs once. The kit's
client installs this forwarder automatically.

**Error codes**

| Code | Meaning |
|---|---|
| `not-ready` | call before `welcome`, or a call the frame's new handshake overtook (§5) |
| `unknown-method` | no such method in this Host API version, or a method the pomade-kit knows that this Pomade does not serve |
| `capability-denied` | the manifest does not declare the method's capability, or a path is in the workspace's `.pomade` folder (§4) |
| `invalid-params` | params missing or malformed |
| `outside-workspace` | a path resolves outside the workspace root |
| `not-found` | the path does not exist |
| `io-error` | the filesystem call failed (message carries the OS reason) |
| `already-exists` | the target path of a create or move is taken |
| `unreadable-frontmatter` | a field or body write meets a frontmatter block that is not a valid YAML mapping, or a first `---` line that never closes; nothing is written |
| `unsupported-key` | a field write names a key that has no line of its own (e.g. a key with a colon); nothing is written |
| `changed-on-disk` | a conditional write (`ifMtime`) found the file changed since the app read it; nothing is written |
| `app-absent` | `apps.call`: the target app is not installed, or nothing serves its API now |
| `app-not-responding` | `apps.call`: the target did not answer in time, or went away before answering |
| `app-error` | `apps.call`: the target's handler failed (not with a protocol error), or answered with a value that is not plain JSON |

### Socket

An app's backend and its commands talk to Pomade over a unix socket,
`<userData>/run/pomade.sock`, with the same messages: one JSON object per line (UTF-8, `\n`), at
most 16 MiB per line. The handshake, the calls, the results, the events and the error codes are the
ones above; what differs:

- **Identity in `hello`.** Pomade cannot see a frame here, so the client says who it is:

  ```ts
  { channel: "pomade", type: "hello", hostApi: 0,
    client: { appId: "pomade-agents", key: "<the app's key>", role: "backend" | "command" } }
  ```

  The key is the content of the file Pomade issued for the app — `<userData>/app-keys/<id>`, mode
  0600 in a 0700 folder — issued by `pomade apps install` / `link` (and by Pomade for every app it
  hosts) and deleted by `pomade apps remove`. A backend or command Pomade starts gets its path in
  `POMADE_APP_KEY_FILE` (§2 "Backends", "Commands"). An unknown app, a wrong key or a missing
  `client` is refused with `reject` reason `unauthorized`; a version mismatch as for a frame.
- **`welcome`** carries `surface: "backend" | "command"` (the role), `route: ""`, no `icon`, and the
  active project; `host.info` answers the same. Unlike a frame, a socket client gets no event it
  did not subscribe to: `project.changed` too comes through `events.subscribe`, declared in its
  manifest's `events.subscribe` (§4 `events`). Its subscriptions end with its connection.
- **Notices.** `notices.post` works as for a frame (the same checks; the source is the app).
  `pomade-kit/node`'s `postNotice()` sends it over the socket while Pomade runs and falls back to
  the closed-Pomade queue otherwise (§4 `notices`).
- **Frame-only methods** — `files.pickFolder`, `files.pickFile`, `git.watch` / `git.unwatch`, `overlay.open`, `overlay.resize`, `overlay.close`, `panel.show`, `tabs.setRoute`, `tabs.setTitle` and `tabs.close` need
  an app frame: over the socket they are `capability-denied`. Everything else answers exactly as for
  the app's frames, under the same manifest capabilities.
- **No project of its own.** A backend or a command is in no project ([[PLATFORM]] rule 9): where
  a call's project is optional — `files.reveal`, `git.reveal`, `tabs.openFile` / `openTerminal` / `openAttached` / `openApp`,
  `agentTabs.launch` / `resume`, a notice and its action — the default is the Workspace project
  (`"__workspace__"`), not the project in front. `project.getActive` and `welcome.project` still
  report the project in front; to act there, pass its id.
- **Lifetime.** Every connection is its own session: its watches end when it closes. A client that
  says nothing within 5 s is disconnected. When Pomade quits, every connection closes and the
  socket file is removed; the client sees its channel end (`onClose`) and reconnects when Pomade is
  back (`pomade-kit/node` `stayConnected`).
- **Pomade's own commands** (`pomade-git`) connect as the platform client: `appId: "pomade"`, role
  `command`, with the platform key `<userData>/app-keys/pomade`. No app may use the id `pomade`. The
  platform client may call `host.info`, `apps.call` (any app — rule 7 reads), `notices.post` (with
  a `source` field naming the command, e.g. `pomade-git`; any action allowed) and the platform-only
  method below; anything else is `capability-denied`.

  | Method | Params | Result |
  |---|---|---|
  | `agents.liveIn` | `{ folder: string }` — absolute | `{ live: boolean, agents: LiveAgentEntry[] }` |

  The agents running now in Pomade's terminals whose launch directory (physical path) is `folder`
  or below it, joined with what `pomade-agents` answers to `sessions.liveIn` (§4 `apps`, Platform
  reads of app APIs) when it is installed and answering — what `pomade-git` asks before committing. Its capability is `platform`, which no
  manifest can declare: for an app it is `capability-denied`.

  ```ts
  interface LiveAgentEntry {          // pomade-kit/protocol
    agentId: string;
    cwd: string;                      // its folder at launch (physical path)
    state?: "working" | "needs-you" | "idle";   // LiveAgentState; absent = not known, counts as working
    terminalPids?: number[];          // the shells of the Pomade terminals it runs in; absent for none
  }
  ```

  One entry per agent and folder. `state` is the app's for its sessions, Pomade's own reading of its
  terminal (the agent scanner: `idle` only at the agent's empty prompt; nothing before the first
  reading) for its terminals; where both describe the same agent and folder the busier wins —
  working, not known, needs-you, idle — and a tab the app gives no state for takes Pomade's reading.
  A Runner run is never `idle`. `pomade-git` skips a repo for an entry that is not `idle`, and for an
  agent process (`claude` / `codex`) in the repo unless it descends from a `terminalPids` shell of an
  `idle` entry. The Git panel counts every entry, idle or not.
- **Notices posted while Pomade is closed** go into the notice queue, which Pomade
  drains at launch: `postNotice()` chooses the socket or the queue, so callers never choose.
- **Threat model.** The socket is for one user's own Mac. The folder's mode keeps other local users
  out; the key makes the caller's identity explicit, so each client gets its own manifest's
  capabilities. Any process running as the same user can read the key files and connect as any
  app: the socket is not a security boundary against the user's own processes, and does not
  pretend to be one (§1: manifests are for visibility, not a sandbox).
- `pomade-kit/node`'s `connectSocket()` is the client: the same typed client a frame gets from
  `connect()`.

## 4. Methods and events

Paths are **workspace-relative** POSIX strings (`Projects/Pomade/docs/roadmap`); `""` is the
workspace root. An app joins `ProjectRef.root` with its own relative path. `..` escapes and
absolute paths are rejected with `outside-workspace`.

**The workspace's `.pomade` folder is Pomade's own** (workspace config, per-project state;
[[PLATFORM]] rule 3). Every path a method takes — a read, a listing, a watch, a write, both ends of
a move, a symlink's location and its target, a folder to open a terminal in, a file to open, a
picker's starting folder — is refused with `capability-denied` when it is `.pomade` or lies inside
it (the name compared case-insensitively; only the folder at the workspace root). The check runs on
the path as given and on its real path, so a symlink into `.pomade` is refused too. Listings leave
`.pomade` and links into it out, watch events for paths inside it are never delivered, and the
folder picker refuses a choice inside it like one outside its root. `pomade-kit`'s
`isPomadeFolderPath` is the rule.

```ts
interface ProjectRef {
  id: string;              // stable: survives project renames and moves
  kind: "project" | "workspace";
  name: string;            // "Workspace" for the Workspace project
  root: string;            // workspace-relative; "" for the Workspace project
}
```

### `host` (no capability)

| Method | Params | Result |
|---|---|---|
| `host.info` | — | `{ pomadeVersion, hostApi, appId, surface, icon?, route, key?, kind?, skills }` — the `welcome` values, and `skills: { name, path: string \| null }[]`: each manifest skill's name and the absolute path of its folder in the installed (or folder-linked) build; `null` for a dev-server link |

### `strip` (no capability)

| Method | Params | Result |
|---|---|---|
| `strip.setBadge` | `{ icon: string, count: integer ≥ 0, urgent?: boolean }` | `{}` |

- Sets the badge on one of the app's own strip icons; any frame of the app may set any of its
  icons. `count: 0` clears it; `urgent: true` paints it red. An icon the manifest does not
  declare is `invalid-params`.
- Badges live while the app runs: when its frames reload (update, relink) or it becomes
  unavailable, its badges clear, and the app sets them again.

### `project.read`

| Method | Params | Result |
|---|---|---|
| `project.getActive` | — | `ProjectRef` — the Workspace project when no project is active |
| `project.list` | — | `{ workspace: ProjectRef, groups: GroupInfo[], projects: ProjectInfo[] }` |
| `project.getSettings` | `{ projectId }` | `{ settings: Record<string, JsonValue> }` |
| `project.getAgents` | `{ projectId }` | `{ visibleAgents: string[] }` |
| `project.getScopeFolders` | `{ projectId }` | `{ paths: string[] }` — the calling app's scope folders, in the order added |

| Event | Payload | When |
|---|---|---|
| `project.changed` | `ProjectRef` | the user or an app (`project.activate`, §4) switches project (the Workspace project included), or the active project is renamed or moved; delivered to hidden frames too. It reports the *active* project to every frame, a tab frame included — a tab that shows its own project's data keeps the `welcome` project and ignores it |
| `project.updated` | `{ project: ProjectInfo, changes: ProjectChange[] }` | a project's group, visible agents or the app's own settings for it changed (§4 `events`: subscribe to it) |

```ts
interface GroupInfo {
  id: string;                 // stable
  name: string;
  parentId: string | null;    // groups nest; null = top level
  path: string[];             // names from the top level down: ["Building tools", "Tools"]
}
interface ProjectInfo extends ProjectRef {
  kind: "project";
  groupId: string | null;     // null = ungrouped
  groupPath: string[];        // the group's path; [] when ungrouped
}
```

- `project.list` is the Projects panel's tree in Projects panel order: each group, then its projects, then its
  sub-groups; ungrouped projects at Ungrouped's place among the top-level groups. `workspace` is
  the Workspace project (the Projects panel's Workspace row).
- **Stable ids.** A project's `id` never changes — a rename, a move to another folder, a regroup
  keep it — so an app stores project ids and resolves name and root through `project.list` or
  `project.getActive`.
- **Per-project app settings** (e.g. a Board's backlog folder) are the calling app's own: each app
  reads and writes only its entry, identified by its frame. They are plain JSON (`JsonValue`:
  strings, finite numbers, booleans, null, arrays, objects; at most 32 levels deep) and live
  with the project in the workspace config — git-synced, kept through renames and moves, removed
  with the project. A project without settings answers `{ settings: {} }`.
- **Visible agents** are the agents the project's "+" menu offers: roster ids, or `["*"]` for
  every agent. The Workspace project offers every agent (`["*"]`).
- An unknown `projectId` is `not-found`. The Workspace project (`"__workspace__"`) has no settings
  (`invalid-params`).

### `project.write`

| Method | Params | Result |
|---|---|---|
| `project.setSettings` | `{ projectId, settings: Record<string, JsonValue> }` | `{ settings }` — the app's settings after the merge |
| `project.setAgents` | `{ projectId, visibleAgents: string[] }` | `{}` |
| `project.addScopeFolder` | `{ projectId, path }` | `{ path }` — the path as stored |
| `project.removeScopeFolder` | `{ projectId, path }` | `{}` |

- `setSettings` merges `settings` into the app's settings for the project; a `null` value removes
  its key. Non-JSON values are `invalid-params`, and so is a result over **64 KiB** as UTF-8
  JSON (nothing is written).
- `setAgents` replaces the visible-agents list: non-empty ids without `/`, `\` or line breaks,
  trimmed and de-duplicated in order; `["*"]` alone means every agent, `[]` means none (mixing `"*"` with ids is
  `invalid-params`). The Workspace project's list cannot be set (`invalid-params`).
- **App scope folders.** `addScopeFolder` puts a folder in
  the project's scope: its files count as the project's — no `Outside this project` mark, the
  editor header's short path. `path` is workspace-relative or absolute, inside or outside the
  workspace, existing or not (the app may create it later); it is stored workspace-relative when it
  lies inside the workspace, absolute otherwise (`pomade-kit/protocol`'s `scopeFolderPath`). The
  workspace root, `/`, a relative path climbing out of the workspace and a `~` path are
  `invalid-params`, the workspace's `.pomade` folder `capability-denied`. Adding a folder the app has
  is a no-op; removing one it does not have too. At most 64 per app per project
  (`SCOPE_FOLDERS_MAX`; one more is `invalid-params`). Each app sees and changes only its own. The
  Workspace project has none (`invalid-params`).
- Pomade keeps scope folders per project and machine (with the project's state, not in the
  workspace config: an absolute path means nothing on another machine), never shows them in the file
  tree, and applies them only while their app is hosted (installed or dev-linked) and available: an
  app that is missing or unavailable (a broken update, a dev server down) keeps its folders, unapplied,
  and they apply again when it is back. Removing the app (`pomade apps remove`, at once or at the next
  start) deletes them; unlinking a dev link does not. Removing the project removes them with it.

### `project.activate` (`tabs.open`)

| Method | Params | Result |
|---|---|---|
| `project.activate` | `{ projectId: string }` | `{}` |

- Brings a project to the front: it becomes the active project, exactly as a click on its row in the
  Projects panel does — its own active tab shows, and no tab is opened, focused or reordered (to
  focus a tab, `agentTabs.focus` or `tabs.openApp`). `"__workspace__"` is the Workspace project. The
  project already active answers `{}` and changes nothing. An unknown `projectId` is `not-found`; a
  missing or non-string one is `invalid-params`. `project.changed` reaches the app's frames as for any
  switch.
- The switch is one Pomade makes on its own: the Projects panel unfolds the groups around the project's
  row and scrolls it into view, as for `tabs.openFile` or `agentTabs.focus`.
- The capability is `tabs.open`, the one every other call that switches the project in front needs
  (`tabs.openFile`, `agentTabs.focus`); `project.write` is for what a project stores, not for
  where the person is. It answers a frame and the socket alike (`projectId` has no default there).

### `files.read`

| Method | Params | Result |
|---|---|---|
| `files.readFolder` | `{ path, recursive?: boolean, frontmatter?: boolean }` | `{ entries: FileEntry[] }` |
| `files.watch` | `{ path, recursive?: boolean }` | `{ watchId: string }` |
| `files.unwatch` | `{ watchId }` | `{}` |
| `files.reveal` | `{ path, projectId?: string }` | `{}` |

```ts
interface FileEntry {
  path: string;                 // workspace-relative
  name: string;
  kind: "file" | "dir";
  size: number;                 // bytes; 0 for dirs
  mtimeMs: number;
  // only when frontmatter: true, only for Markdown files:
  frontmatter?: Record<string, unknown> | null;   // null = the file has no frontmatter block
  frontmatterError?: string;    // the block is not valid YAML, not a mapping, or never closes — the entry is still returned
}
```

- `recursive` includes sub-folders (`done/`). The workspace's ignored items (`.git`,
  `node_modules`, …) apply to every listing and to watch events. Unreadable files are reported
  (`frontmatterError`), never dropped. `readFolder` on a file is an `io-error`.
- Frontmatter is the leading `---` YAML block (the same block detection as Pomade's editor),
  parsed with js-yaml's `JSON_SCHEMA`: values are plain JSON — `created: 2026-11-09` stays the
  string `"2026-11-09"`, never a `Date` — so the same values cross `postMessage` and, later, the
  socket unchanged. A top-level block that is not a mapping (including `null` / `~`) is a
  `frontmatterError`; a block with no keys (blank or comments only) is `{}`; `---` directly
  followed by `---` is not a block, as in the editor. A first `---` line with no closing `---`
  line (including `---` directly followed by `---`, and a closing `---` at the very end of the
  file without a newline after it) is a `frontmatterError` ("the leading --- block is not closed"),
  the same files a field or body write refuses. Non-finite numbers (`.inf`,
  `.nan`) arrive as their source text, e.g. `".inf"`. CRLF files parse like LF files.

| Event | Payload | When |
|---|---|---|
| `files.changed` | `{ watchId, changes: FileChange[] }` | something under a watched path changed |

```ts
interface FileChange {
  kind: "create" | "change" | "delete" | "rename";
  path: string;                 // workspace-relative; the new path for a rename
  oldPath?: string;             // rename only
}
```

- `files.watch` on a missing path is `not-found`; watching a single file is allowed;
  `files.unwatch` with an unknown id returns `{}`. A folder rename is one `rename` change.
- `files.reveal` shows a file or folder in Pomade's Files panel: the panel opens (an expanded side
  panel showing Files), the tree expands down to `path`, selects it and scrolls it into view —
  the same reveal as the file tree's "Reveal in tree". A folder is also expanded itself. `path` is
  workspace-relative and may be `""` (the workspace root, which only opens the panel). `projectId`
  names the project whose panel shows it — default the active project for a frame, the Workspace
  project for a backend or a command (§3 "Socket"); `"__workspace__"` is its id; an unknown id is
  `not-found`. A path outside that project's folder (but inside the workspace) is shown in the
  Workspace project's panel instead. Pomade switches to the project that shows it. A missing path is
  `not-found`, a path escaping the workspace `outside-workspace`, one at or inside `.pomade`
  `capability-denied`. A path inside an ignored folder (`node_modules`, …) is not listed by the tree,
  so nothing is selected; the call still succeeds.
- Served from Pomade's single platform watcher — apps never start their own. Changes reach the
  app within ~1 s; bursts arrive batched. A watcher that cannot tell a rename from a
  delete + create reports the pair.
- Every change after `files.watch` returns is reported, including one made milliseconds after it
  and the second of two quick writes to one file: Pomade re-reads the watched scope right after
  registering and after each batch until a re-read finds nothing new, and reports what the
  native watcher missed like any other change (it can arrive up to ~1.5 s after it happened). An
  app does not need to re-read the folder after registering, beyond its first read. In a scope of
  more than 5000 entries only the paths of the latest batch are re-read.

| Method | Params | Result |
|---|---|---|
| `files.readFile` | `{ path, frontmatter?: boolean }` | `{ content: string, size: number, mtimeMs: number, frontmatter?, frontmatterError? }` |
| `files.pickFolder` | `{ root?: string, initial?: string }` | `{ path: string \| null }` |
| `files.pickFile` | `{ under?: string, extensions?: string[] }` | `{ path: string \| null }` |

- `readFile`: the file's text decoded as UTF-8; `size` in bytes. `content`, `size` and `mtimeMs`
  come from one open file, so `mtimeMs` is the read text's — the value a conditional write takes
  as `ifMtime`. With `frontmatter: true` a Markdown file's result also carries its frontmatter
  record exactly as `readFolder` reports it (`frontmatter` or `frontmatterError`, same parsing),
  from the same text; another file gets neither. A folder is `io-error`; `path` must name an
  entry below the root (`""` is `invalid-params`).
- `pickFolder` asks the user for a folder with the native folder dialog (a new folder can be
  made in it) and answers its workspace-relative path, or `null` when the user cancels. `root` is
  a project id whose folder bounds the choice — absent or `"__workspace__"` for the whole
  workspace; an unknown id is `not-found`. The dialog opens at `initial` when it is a folder
  inside the root, else at the root. The dialog cannot be fenced in, so a folder outside the root
  (by its real path) is refused in the dialog's own message and the dialog opens again at the
  root, until the user picks a folder inside it or cancels. The answer is the folder's real path.
- `pickFile` asks the user for a file with the native file dialog and answers its workspace-relative
  path, or `null` when the user cancels. `under` is a workspace-relative folder that bounds the
  choice and where the dialog opens — absent or `""` for the whole workspace; a missing folder or a
  file is `not-found`, a path at or inside `.pomade` is `capability-denied`. `extensions` are the
  kinds of file the dialog offers, without the dot and case-insensitive (`["md", "txt"]`; a
  non-empty list of letters and digits, else `invalid-params`); absent = any file. The dialog cannot
  be fenced in, so a file outside `under`, of another extension (by its real path) or inside
  Pomade's own `.pomade` folder is refused in the dialog's own message and the dialog opens again at
  `under`, until the user picks a fitting file or cancels. The answer is the file's real path.

### `files.write`

| Method | Params | Result |
|---|---|---|
| `files.create` | `{ path, content?: string }` | `{}` |
| `files.write` | `{ path, content: string, ifMtime?: number }` | `{}` |
| `files.setField` | `{ path, key: string, value: FrontmatterValue, ifMtime?: number }` | `{ changed: boolean }` |
| `files.removeField` | `{ path, key: string, ifMtime?: number }` | `{ changed: boolean }` |
| `files.setKeyLines` | `{ path, key: string, text: string, ifMtime?: number }` | `{ changed: boolean }` |
| `files.setBody` | `{ path, body: string, ifMtime?: number }` | `{ changed: boolean }` |
| `files.move` | `{ from, to }` | `{}` |
| `files.delete` | `{ paths: string[] }` | `{ results: { path, ok, error? }[] }` |

```ts
type FrontmatterValue = string | number | boolean | null | string[];   // null writes `key:`
```

- **Field-only frontmatter writes.** `setField` and `removeField` run `pomade-kit`'s
  `setField` / `removeField` — the code Pomade's editor runs: only the key's own lines change;
  every other byte of the file (other keys, their quoting, comments, blank lines, key order, the
  body, CRLF line endings) stays identical. A missing key is appended at the end of the block (a
  file without frontmatter gets a block). A string is written plain when it reads back as the
  same string, else double-quoted; a list keeps its flow or block style. A refusal is
  `unreadable-frontmatter`, `unsupported-key`, or `invalid-params` (empty key, a key with a line
  break, a non-finite number).
- **A key as its own YAML lines.** `setKeyLines` writes one frontmatter key whose value
  `setField` does not take — a mapping (a Planner item's `repeat:` rule), a list of mappings, a
  block scalar. `text` is the key's lines verbatim: `key:` at column 0, then indented lines (for
  example `pomade-kit/schedule`'s `formatSchedule("repeat", schedule)`); CRLF or one trailing line
  break is fine, and the lines are written with the file's own line endings. It runs
  `pomade-kit`'s `setKeyLines`: the key's existing lines are replaced in place, or the lines are
  appended at the end of the block (a file without frontmatter gets a block); every other byte of
  the file stays, as with `setField`. `text` that does not start with `key:`, holds a blank or
  column-0 line after it, holds another key, or is not valid YAML is `invalid-params`;
  `unreadable-frontmatter` and `unsupported-key` as for `setField`.
- **Body writes.** `setBody` replaces everything after the frontmatter block and the blank lines
  that follow it, keeping the block's bytes; `body` is written as given. Without a block it
  replaces the whole text; a first `---` line that never closes is `unreadable-frontmatter`.
- `changed: false` means the bytes were already identical: nothing is written, the mtime stays,
  no watch event fires.
- **Conditional writes.** `write`, `setBody`, `setField`, `removeField` and `setKeyLines` take
  `ifMtime`, the `mtimeMs` the app read (`readFile`, a `readFolder` entry). The write happens only
  while the file's mtime is exactly that value; otherwise the call fails with `changed-on-disk`
  and the file is untouched — a stale `ifMtime` is refused even when the write would change
  nothing. `ifMtime` that is not a finite number is `invalid-params`. The guarantee: Pomade
  runs app writes to one file one at a time, does the slow work first (read, edit, write the new
  text to a temporary file beside it), then checks the mtime with a `stat` issued synchronously
  right before the synchronous `rename` that puts the new text in place. No other write of
  Pomade's — another app's, the editor's save — can run between the check and the rename.
  Another process (an agent, git, an editor) can still land a write between those two
  consecutive system calls, microseconds apart; POSIX has no compare-and-rename, so that is the
  smallest gap the filesystem allows. APFS keeps mtimes to the nanosecond and `mtimeMs` carries
  them to a fraction of a microsecond, so two writes in a row never share an mtime. A writer that
  restores a file's old mtime (`touch -r`) is not seen.
- App writes to one file run one at a time, in the order they arrive, so concurrent field writes
  to one file — from one app or several — never lose each other's change.
- `create` makes a new file and any missing parent folders; `content` defaults to `""`; a taken
  path is `already-exists`. `write` replaces an existing file's whole text (`not-found` when it
  does not exist, `io-error` for a folder). `move` moves or renames a file or folder, creating
  missing parent folders; a symlink moves as the link itself. A taken `to` is `already-exists`; a
  folder moved into itself is `invalid-params`; `from` equal to `to` is a no-op.
- `delete` moves files to the macOS Trash (Finder can put them back). Each path is checked and
  deleted on its own, in the order given, and reported as `{ path, ok, error? }` with `path` as
  passed: the path rule above (`.pomade` → `capability-denied`, an escape → `outside-workspace`), a
  missing file → `not-found`, a folder or the root → `invalid-params`, a failed move to the Trash →
  `io-error` — for that entry only; the other paths still go. A symlink goes as the link itself,
  never its target (a link to a folder counts as a folder; a link into `.pomade` is refused). The
  call itself fails only when `paths` is not a list of strings or holds more than 1000
  (`FILES_DELETE_MAX_PATHS`) — `invalid-params`. `[]` answers `{ results: [] }`.
- Every write is atomic: a reader sees the old file or the new one, never a partial write. A
  replaced file keeps its permission bits; a symlinked file is written at its target, and the link
  stays a link. Paths follow the rule above and must name an entry below the root; a write that
  would land outside the workspace through a symlinked file or folder is `outside-workspace`.
- **Disk is truth** ([[PLATFORM]] rule 8). An app's write is an external write for Pomade's
  editor: a doc open with unsaved edits shows *"File changed since your edits"* and neither the
  buffer nor the file changes on its own; a doc without unsaved edits shows the changed-on-disk
  notice; a deleted doc shows *"This file no longer exists on disk"* and keeps its buffer — saving
recreates the file. Watches (`files.watch`) report the app's own writes and deletes like any
other.

### `files.symlink`

| Method | Params | Result |
|---|---|---|
| `files.symlink` | `{ path, target }` | `{}` |
| `files.removeSymlink` | `{ path }` | `{}` |

- For example `files.symlink({ path: "Projects/alpha/links/spec", target: "Knowledge/specs/alpha" })`
  with `"symlinks": ["Projects/*/links"]`.
- `path` must sit directly in a folder one of the manifest's `symlinks` patterns matches, reached
  without passing through a symlinked folder; otherwise `capability-denied` — so a link lands
  exactly where the manifest says. Missing folders on the way are created.
- `symlink` writes a **relative** link to `target`, an existing workspace path (`not-found`
  otherwise); a taken `path` — a file, a folder or another link — is `already-exists`.
- `removeSymlink` removes the link itself and never what it points to; anything at `path` that
  is not a symlink is `invalid-params` and stays.
- Listings report a link as what it points to (`files.readFolder`).

### `tabs.open`

| Method | Params | Result |
|---|---|---|
| `tabs.openFile` | `{ path, projectId?: string }` | `{}` |
| `tabs.openTerminal` | `{ cwd, command?: string, title?: string, projectId?: string }` | `{}` |
| `tabs.openAttached` | `{ session: { app, session }, title?: string, projectId?: string }` | `{}` |

- The tab opens in `projectId`'s tab strip — default the active project for a frame, the
  Workspace project for a backend or a command (§3 "Socket"); `"__workspace__"` is its id; an unknown id is `not-found` — right of that project's active tab, becomes its active
  tab, and Pomade switches to that project.
- `openFile` opens the file in an editor tab, or focuses the tab already showing it. `path` must
  be a file (`not-found` / `io-error` for a folder). A tab whose file lies outside the project it
  is in carries Pomade's orange ⚠ mark, tooltip "Outside this project" (red, "Outside the
  workspace", for an absolute path; "2+ copies open across projects" when the same file is open in
  another project too). To open a file without the mark, name the project that holds it as
  `projectId`, or `"__workspace__"` for a file outside every project.
- `openTerminal` opens a terminal (Pomade's interactive login shell) in the folder `cwd` (`""` =
  the workspace root; a file is `io-error`). `command`, one non-empty line, is typed and run once
  the shell is ready; the tab's Relaunch runs it again. `title` (trimmed, non-empty) names the
  tab; default the command, else the shell's own numbered title.
- `openAttached` opens — or focuses, one per session per project — a terminal tab attached
  to a session an app's keeper holds (§2 "Backends", the keeper socket). `session.app` is the owning
  app's id, `session.session` the session's id in its keeper (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`). Any
  app may open any app's session by reference; the owner is not asked. The tab shows the session's
  earlier and live output, takes input, and closing it only detaches. `title` (trimmed, non-empty)
  replaces the session's own title; the tab always shows the owner's name after it ("Coda web ·
  Runner"). The session need not exist yet, nor the keeper run: the tab says so and attaches when it
  appears. A malformed reference is `invalid-params`.
### `agentTabs`

The agent tabs Pomade runs: which session each one is bound to, its title, what the agent is doing
— and the calls that focus one, launch an agent or resume a session in a tab.

| Method | Capability | Params | Result |
|---|---|---|---|
| `agentTabs.list` | `agentTabs.read` | `{ projectId?: string }` | `{ tabs: AgentTabInfo[] }` |
| `agentTabs.setTitle` | `agentTabs.write` | `{ tabId, title: string \| null }` | `{}` |
| `agentTabs.focus` | `tabs.open` | `{ tabId }` | `{}` |
| `agentTabs.launch` | `tabs.open` | `{ agentId, projectId?, cwd?, mode?, prompt? }` | `{ tabId }` |
| `agentTabs.resume` | `tabs.open` | `{ agentId, sessionId, projectId?, cwd? }` | `{ tabId }` |

```ts
interface AgentTabInfo {
  tabId: string;
  projectId: string;           // "__workspace__" for the Workspace project
  agentId: string;             // the roster id
  cwd: string | null;          // the folder the agent was launched in: absolute, symlinks resolved — the key of
                               // the agent's own session store; null until the launch has been seen
  launchedAt: string | null;   // ISO 8601; null until the launch has been seen
  sessionId: string | null;    // the bound session; null when none is bound (not prompted yet, or unsure)
  title: string;
  titleSource: "default" | "user" | "app";
  unnamed: boolean;            // an app marked the session unnamed
  state: "working" | "needs-you" | "idle" | "exited";
}
```

- **`list`** — every agent tab, also the ones with no session yet (launched, not prompted), in
  Projects panel order (the Workspace project first), each project's in tab order; with `projectId`, that
  project's only (`not-found` for an unknown id). A tab is an agent tab while an agent runs in it,
  or ran in it and the tab was not handed back: when the agent quits and its shell takes over, the
  tab is a terminal again and leaves the list.
- **Bindings over time.** `sessionId` follows the tab: the session a fresh agent starts, the one a
  resume names, a new one after a clear (claude `/clear`, `/reset`, `/new`; codex `/clear`, `/new`)
  or a fork (claude `/branch`, codex `/fork`), the one an in-session `/resume` adopts. Claude's
  `/fork` starts a copy in the background and keeps the tab on its own session, so the binding stays.
  Pomade binds a session only when it knows which tab started it; when it cannot tell (two tabs
  prompted at once in one folder), `sessionId` is `null` rather than a guess. Each change of
  `sessionId` is an `agentTab.changed` that says why (`AgentTabSessionChange`, §4 `events`): the
  cause comes from what Pomade saw — the agent's launch, the command typed in the tab, the new
  transcript's own record of its parent — never from a guess.
- **State** is read from the agent's own output: `working` on a turn; `needs-you` at a permission
  or folder-trust prompt; `idle` waiting for the next prompt, and until the output says otherwise;
  `exited` when no agent process runs in the tab — it ended under a dead tab, or the tab was
  restored from an earlier run and has not been revived yet.
- **`setTitle`** names the tab (`titleSource: "app"`). `title` is trimmed, one line, 1–200
  characters. `null` marks the session **unnamed**: the tab shows its default title (the agent's
  name) in italics with an "unnamed" dot. Any later title — the app's, or the user renaming the tab
  (`titleSource: "user"`) — ends the mark, and so does the agent quitting. An unknown tab is
  `not-found`.
- **`focus`** — the tab's project becomes active and the tab its active tab.
- **`launch`** starts a roster agent (§4 "Platform reads of app APIs") in a new tab, right of the
  project's active tab, and switches to it. The project of `launch` and `resume` is `projectId`,
  default as for `tabs.open` (the active project for a frame, the Workspace project for a backend or a command). `cwd` (workspace-relative, path rule; default the
  project's folder) must be a folder. `mode` (default `"normal"`) is one of the agent's modes: its
  `args` follow the command. `prompt` (non-empty, at most 16384 characters) is submitted as the
  first prompt once the agent is ready — a multi-line prompt as one paste — and starts the tab's
  session like a prompt the user types. An agent not in the roster, or whose command is not found,
  is `not-found`; an unknown mode is `invalid-params`.
- **`resume`** opens the session in a new tab (the agent's own resume command, normal mode) and
  switches to it. When a live tab is already bound to that session, that tab is focused and its id
  returned instead — two agents on one transcript would interleave it. The session must exist in
  the agent's store for `cwd` (default the project's folder): else `not-found`.
- A `tabId` is a tab's lasting id: it survives restarts, revives and moves between projects, and
  is the `POMADE_TAB_ID` of its terminal (§2 "Commands").

| Event | Payload | When |
|---|---|---|
| `agentTab.changed` | `{ tab: AgentTabInfo, changes: AgentTabChange[], session?: AgentTabSessionChange }` | §4 `events` |

### `state` (no capability)

The app's machine-local state: one key → value store per app at `<userData>/app-state/<id>/`
([[PLATFORM]] "Locations"), shared by all of the app's frames — tab, panel, overlay.

| Method | Params | Result |
|---|---|---|
| `state.get` | `{ key: string }` | `{ value: JsonValue \| null }` — `null` when the key is not set |
| `state.set` | `{ key: string, value: JsonValue }` | `{}` — `value: null` removes the key |

| Event | Payload | When |
|---|---|---|
| `state.changed` | `{ key, value: JsonValue \| null }` | another frame of the same app set `key`; the setting frame gets no event |

- A key is a non-empty string of at most 200 characters. A value is plain JSON — null, booleans,
  finite numbers, strings, arrays and plain objects, nested at most 64 deep — of at most 1 MiB as
  JSON (UTF-8). Anything else is `invalid-params`.
- `state.set` resolves once the value is written atomically; a frame that reads after that sees
  it. A change is observable in the app's other frames both ways: by `state.changed` (pushed to
  hidden frames too) and by re-reading.
- Values are stored as JSON; an app reads back an equal value, never the same object.
- The store outlives app updates and Pomade restarts; removing the app leaves it in place.

### Own tab: `tabs.openApp` (no capability)

| Method | Params | Result |
|---|---|---|
| `tabs.openApp` | `{ route?: string, projectId?: string, key?: string, title?: string, kind?: string }` | `{}` |
| `tabs.setRoute` | `{ route: string }` | `{}` — the calling tab frame's own tab records the route the app navigated to |
| `tabs.setTitle` | `{ title: string }` | `{}` — the calling tab frame's own tab is retitled (unless the user renamed it) |
| `tabs.close` | — | `{}` — then the calling tab frame's own tab closes |

| Event | Payload | When |
|---|---|---|
| `route.changed` | `{ route }` | Pomade navigated this frame's tab to a new route |

- Opens or focuses **the calling app's own tab** at `route` (default `""`) in `projectId` (a
  `ProjectRef.id`, the Workspace project included; default the active project for a frame, the
  Workspace project for a backend or a command) and brings the user
  there — like `tabs.openFile`, but needing no capability: an app may always open itself — that project becomes active and the tab is focused. An unknown project id is
  `not-found`.
- A route that a strip icon's tab renders (an icon with action `tab` or `both` whose `route`
  equals it) is that icon's tab — one per icon per project, as when the icon is clicked. Any other
  route is the app's **icon-less tab** (one per project, the one the new-tab menu opens), opened
  at that route or navigated to it.
- Navigating an open tab to a route that differs from the one Pomade records for it sends its
  frame `route.changed`; the frame stays loaded. The recorded route is the one Pomade last sent,
  or the one the app last reported (`tabs.setRoute`). `host.info` answers the current route, a reload opens at it, and the tab
  keeps it across Pomade restarts. `welcome.route` is always the route the frame was opened at.
- The same target — app, route, optional project — is what a notice's click action names
  and an app shortcut with action `tab` opens: Pomade
  opens it the same way. Neither carries `key`, `title` or `kind`: they always reach the icon-less
  tab or an icon's tab, never a keyed tab.
- **Keyed tabs.** With `key` (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`), the call opens a **keyed tab**:
  one per (app, key, project), whatever its route — an app opens as many as it needs ("Scraper ·
  output" and "Deploy · output" beside its own tab). Not open → a new tab at `route`, right of the
  active tab, focused, its project made active. Open → focused; navigated to `route` when it differs
  (`route.changed` to its frame, as for the icon-less tab); retitled when `title` is given. A route
  never makes a keyed tab an icon's tab, and a call without `key` never reaches a keyed tab.
- `title` (trimmed, non-empty) is the tab's title exactly as given — Pomade adds nothing. Default:
  the kind's `title`, else the app's `name`. A title the app gave — even one equal to what the tab shows — stays until the app gives
  another; a tab the user renamed keeps the user's name. `kind` names one of the manifest's `tabKinds` (§1):
  the tab shows its icon, else the app's icon. `title` or `kind` without `key`, a malformed key, a
  blank title and a kind the manifest does not declare are `invalid-params`.
- A keyed tab's frame is welcomed with its `key` and `kind` (§3); `host.info` answers them.
- Keyed tabs persist: key, kind, route and title (and whether the app gave it) come back after a
  restart. A manifest update that removes the kind keeps the tab, with the app's icon (and, unless
  the app or the user titled it, the app's name).
- `tabs.setRoute` (no capability): a tab frame tells Pomade the route it navigated to by itself (a
  card closed). Pomade records it for its own tab — the icon-less tab, a keyed tab or an icon's tab
  alike — and sends no `route.changed` back; from then on `host.info`, a reload and a restart use
  it, and a later `tabs.openApp`, notice click or app shortcut to any other route — the one Pomade
  last sent included — navigates the tab. An icon's tab clicked from its strip icon is only focused:
  it stays where the app is. `route` must be a string (`""` = the default view).
- `tabs.setTitle` (no capability): a tab frame retitles its own tab — any of the app's tabs, keyed
  or not — unless the user renamed it (then it answers `{}` and changes nothing); `title` trimmed,
  non-empty. Such a title no longer follows the manifest, whether or not it differs from the
  tab's current one.
- `tabs.close` (no capability): a tab frame closes its own tab — any of the app's tabs — as the
  user's close does; the answer arrives first. For a restored keyed tab whose subject is gone (a run
  Runner pruned).
- `tabs.setRoute`, `tabs.setTitle` and `tabs.close` are for a tab frame (`surface: "tab"`): from a panel or an overlay frame they are
  `invalid-params`; from a backend or a command `capability-denied` (frame-only, §3 "Socket").

### `overlay` (no capability)

| Method | Params | Result |
|---|---|---|
| `overlay.open` | `{ route?: string, height?: number, anchor?: "center" \| "panel" }` | `{}` — the app's overlay opens at `route` (default `""`), `height` px tall (default 220), at `anchor` (default `"center"`) |
| `overlay.resize` | `{ height: number }` | `{}` — the overlay frame's new height |
| `overlay.close` | — | `{}` — then the overlay closes and focus returns where it was |

- `overlay.open` opens the calling app's overlay frame exactly as its overlay shortcut does (§5):
  same card, scrim, focus and closing rules, at `route` — the app needs no overlay shortcut. Only
  from the app's tab or panel frame while it is shown (the active tab of the active project, the
  panel shown in an expanded column): a hidden frame's call, and an overlay frame's, are
  `invalid-params`; over the socket it is `capability-denied` (frame-only). One overlay at a time:
  every call opens a fresh frame at its route, replacing whatever overlay is open (this app's or
  another's). When it closes, focus returns to **the frame that called `overlay.open`** (a replaced
  overlay keeps the first call's frame); for a shortcut it returns to what had focus before. Focus
  moving into the overlay clears the calling frame's own focused element; `pomade-kit`'s
  `host.overlay.open` puts it back on the element that had it (the button) when the frame gets focus
  again.
- `height` and `overlay.resize` size the frame (width is always 420). A height is a positive number;
  Pomade rounds it to whole pixels and clamps it between 120 and 60% of the height of the window
  below its title bar (never so tall that the card loses its 16 px margins) — the frame's
  `window.innerHeight` is what the app got. `overlay.resize` is only for an overlay frame
  (`surface: "overlay"`), else `invalid-params`; the card grows downward from where it is, shifting
  up only to stay whole inside the window. A bad `height` (not a positive finite number) or `anchor`
  is `invalid-params`.
- `anchor` says whether the open names a place. `"panel"` does: the card opens beside the side
  panel — in the pane area's top corner next to it — while the side panel is expanded, and in the
  middle of the pane area while it is collapsed, every time, whatever place the user left that
  app's overlay at (§5); such an open leaves that remembered place as it is. `"center"` (the
  default) names none: the card opens at the remembered place, else in the middle of the pane area.
- `overlay.close`: only an overlay frame (`surface: "overlay"`) may call it; from a tab or a panel it is
  `invalid-params`. The result arrives before the frame goes away.

### `panel` (no capability)

| Method | Params | Result |
|---|---|---|
| `panel.show` | `{ icon?: string, route?: string }` | `{}` — the app's own side panel is in front, at `route` when given |

- Brings **the calling app's own** side panel forward, as a click on that strip icon does: the side
  panel expands when collapsed and shows the panel of `icon` in the active project — but never opens
  a tab, even for an icon with action `both`. `icon` names one of the app's strip icons with action
  `panel` or `both`; default the app's first such icon (§1). The app has none, or `icon` names none
  of them (an unknown id, a `tab` icon) → `not-found`. A non-string `icon` or `route` →
  `invalid-params`. A refused call changes nothing.
- `route`: the panel frame is at that route afterwards. A mounted panel frame gets `route.changed`
  (`host.info` answers the new route); a frame this call creates is welcomed at it. The route stays
  the panel's for the rest of the run — a reload of the frame opens at it; after a restart the panel
  opens at its icon's `panelRoute` (else `route`) again. Absent: the panel's route is left as it is.
  Pomade compares with the route it last gave the frame: the same route sends no `route.changed`.
- From any of the app's frames — its tab, its overlay, its panel frames — shown or hidden (a hidden
  launch panel included); over the socket it is `capability-denied` (frame-only, §3 "Socket"). An app
  acts only on its own panel: it needs no capability.
- **Keyboard focus stays where it is.** An open overlay keeps the keyboard and stays open; a call
  from a tab leaves focus in the tab. The panel only comes into view.
- Already shown at the same route (or with no route) → `{}`, nothing changes.

### `git.read`

| Method | Params | Result |
|---|---|---|
| `git.getState` | `{ projectId?: string }` | `{ repos: GitRepoState[] }` |
| `git.watch` | `{ projectId?: string }` | `{ watchId: string }` |
| `git.unwatch` | `{ watchId }` | `{}` |
| `git.reveal` | `{ path, projectId?: string }` | `{}` |

```ts
interface GitRepoState {
  name: string;               // the folder name the Git panel shows and pomade-git accepts; the workspace-root repo: the workspace folder's name
  root: string;               // workspace-relative; "" = the workspace root
  absPath: string;            // the working-tree root, absolute
  remoteUrl: string | null;   // the upstream's remote, else "origin", else the first remote; null = local only (no remote)
  branch: string | null;      // null when detached
  upstream: string | null;    // "origin/main"; null when the branch tracks nothing
  ahead: number;              // commits not on the upstream; 0 without one
  behind: number;             // upstream commits not on the branch, as of the last fetch; 0 without one
  hasCommits: boolean;        // false until the first commit
  changes: GitFileChange[];   // uncommitted entries
  error?: string;             // the repo's status could not be read; the other fields are empty
}
interface GitFileChange {
  path: string;               // workspace-relative
  status: "modified" | "new" | "conflict" | "renamed" | "deleted";
  from?: string;              // renamed only: the old path
  dir?: true;                 // an untracked folder as one entry: everything inside is new
}
```

- The repos are the ones Pomade's file tree shows: discovered up to 3 folder levels below the
  workspace root, nested repos included, sorted by `root`. A file belongs to its nearest repo
  only. `new` covers untracked and newly added files; staged and unstaged edits are both
  `modified`.
- Pomade serves its own git snapshot: a call runs no git command, and the answer matches what the
  tree and the Projects panel show.
- **Scope.** Without `projectId` (or with `"__workspace__"`): every repo. With a project id: the
  repos at or below the project's folder plus the nearest repo that holds the folder. An unknown
  id is `not-found`.

| Event | Payload | When |
|---|---|---|
| `git.changed` | `{ watchId, repos: GitRepoState[] }` | the watched scope's repos changed |

- A watch delivers its scope's full repo list each time it differs from what the watch last
  delivered (the first baseline is the state when `git.watch` answered). A project-scoped watch
  follows the project when it is moved; a deleted project's watch delivers `[]`.
- `git.unwatch` with an unknown id returns `{}`. Watches end with the frame's handshake, like
  `files.watch`.
- `git.reveal` takes the person to a repo in Pomade's Git panel: Pomade switches to the project,
  expands a collapsed side panel, brings Git forward and scrolls the repo's row into view (a panel
  drilled into another repo goes back to the list; a project whose panel shows just this repo shows
  its view). `path` is the repo's working-tree root, absolute — `GitRepoState.absPath` or a
  `pomade-git` run's `GitRunResult.path`; symlinks are resolved, so either spelling of the same
  folder works. No repo with that root among Pomade's repos — a missing path, a folder that is not a
  repo root, a path outside the workspace — is `not-found`; a relative path is `invalid-params`.
  `projectId` names the project whose Git panel shows it, as for `files.reveal`: default the active
  project for a frame, the Workspace project for a backend or a command (§3 "Socket");
  `"__workspace__"` is its id; an unknown id is `not-found`. A repo outside that project's scope
  (the **Scope** rule above) is shown in the Workspace project's panel instead. It answers a frame
  and the socket alike.

### `events` (no capability — the manifest's `events` lists are the gate)

The event bus: Pomade and apps publish, apps subscribe, and a publisher can ask whether
anyone listens. A publisher never knows its subscribers, so events are not dependencies
([[PLATFORM]] rule 4).

| Method | Params | Result |
|---|---|---|
| `events.subscribe` | `{ name }` | `{}` |
| `events.unsubscribe` | `{ name }` | `{}` |
| `events.publish` | `{ name, payload?: JsonValue }` | `{}` |
| `events.hasSubscribers` | `{ name }` | `{ subscribed: boolean }` |

- `subscribe` takes a platform event or `<appId>:<event>`, declared in the manifest's
  `events.subscribe` — another app's event or the app's own (its backend publishes, its frames
  hear it; one frame publishes, its other frames hear it); subscribing twice is one subscription. `unsubscribe` takes any name (one not
  subscribed is a no-op).
- `publish` and `hasSubscribers` take one of the app's own event names, declared in
  `events.publish`, unqualified. `payload` is plain JSON of at most **64 KiB** (default `null`).
  The event reaches every frame subscribed to `<appId>:<name>` — of any app, hidden frames
  included — except the frame that published it.
- `hasSubscribers` is true while any frame, of any app, subscribes to the event.
- An undeclared name is `capability-denied`; a malformed name or payload is `invalid-params`.
- Subscriptions belong to the frame's handshake: a reload or a closed frame ends them (§3).
- Events are not replayed, except `pomade.ready`: a subscription made after Pomade was ready gets
  it at once, right after the `subscribe` result.

| Event | Payload | When |
|---|---|---|
| `pomade.ready` | `{}` | Pomade restored the workspace's tabs (at launch, and after a workspace switch) |
| `project.created` | `ProjectRef` | a project was added to the workspace |
| `project.renamed` | `{ project: ProjectRef, previous: ProjectRef }` | a project's name or folder changed; its id stays |
| `project.removed` | `ProjectRef` — the project as it was | a project left the workspace (the user removed it); its id is never used again. When it was the active project, `project.changed` to the Workspace project follows |
| `project.opened` | `ProjectRef` | a project — or the Workspace project — became active for the first time since the workspace loaded; the one active at launch counts as opened right after `pomade.ready` |
| `project.changed` | `ProjectRef` | (§4 `project.read`) every frame gets it without subscribing |
| `theme.changed` | `{ theme: "light" \| "dark" }` | Pomade's theme changed (§3 `welcome.theme`); every frame gets it without subscribing |
| `project.updated` | `{ project: ProjectInfo, changes: ProjectChange[] }` | a project's group or group path, its visible agents, or the app's own settings for it changed; a `settings` change is delivered **only to the app whose settings changed** |
| `agentTab.exited` | `AgentTabExited` | an agent process in a Pomade tab ended, whatever ended it |
| `agentTab.changed` | `{ tab: AgentTabInfo, changes: AgentTabChange[], session?: AgentTabSessionChange }` | an agent tab joined or left the list, or its session, title, state or project changed (§4 `agentTabs`) |
| `attachedTab.action` | `{ session: { app, session }, action, projectId }` | a person clicked a header action the app contributed on an attached tab; delivered **only to the app that owns the session** |
| `<appId>:<event>` | the publisher's `payload` | an app published it (another app, or this app's backend or another of its frames) |
| `events.subscribersChanged` | `{ name, subscribed: boolean }` | one of the app's own events gained its first subscriber or lost its last; to every frame of the publishing app, unsubscribed |

```ts
type ProjectChange =
  | "group"      // moved to another group (or out of one), or its group's path changed (a group renamed or moved)
  | "agents"     // its visible agents changed
  | "settings";  // the receiving app's own settings for it changed

interface ProjectUpdated {
  project: ProjectInfo;        // the project as it is now (§4 `project.read`)
  changes: ProjectChange[];    // at least one, each once, in this order: group, agents, settings
}
```

- `project.updated` follows a change from anywhere — Pomade's Projects panel and project dialog, another
  app's `project.setAgents`, a synced workspace config — and an app's own writes too, so its frames
  stay in step. A group or agents change is one event to every subscriber; each app whose settings
  changed gets its own `settings` event. A write that changes nothing sends nothing. A new project
  is `project.created`, a rename or folder move `project.renamed`, a removal `project.removed`;
  none of them is `project.updated`.

```ts
interface AgentTabExited {
  tabId: string;
  projectId: string;            // the tab's project; "__workspace__" for the Workspace project
  agentId: string;              // the agent's roster id
  sessionId: string | null;     // the session bound to the tab at that moment; null when none yet
  reason: "exit" | "crash" | "tab-closed" | "quit";
}
```

- `agentTab.exited` fires once for every end of an agent process in a tab: `exit` — the agent quit
  on its own with status 0 or was interrupted (Ctrl+C, 130); `crash` — it ended with any other
  status, or the tab's shell died under it; `tab-closed` — the tab was closed (by the user, or by a
  bulk action that closes it); `quit` — Pomade quit or closed the workspace, and revives the tab and
  resumes the session at its next launch (so `quit` is a pause, while `exit` ends the session for
  good). A bulk "exit all
  agents" sends each agent `/exit`, so each reports `exit` (or `tab-closed` if it had to be killed).
  The tab stays an ordinary terminal after the agent hands its shell back; a later agent in it
  fires again when it ends.
- `agentTab.changed` names what changed: `opened` (the tab joined the list — a launch, a resume,
  a shell that started an agent), `closed` (it left the list — closed, or its agent handed the shell
  back; `tab.state` is then `exited`), `session`, `title` (the title, its source or the unnamed
  mark), `state`, `project` (moved to another project). Several at once are one event. Events start
  once the workspace's tabs are restored: the tabs present at `pomade.ready` are not `opened` — an
  app lists them then (`agentTabs.list`).
- An `agentTab.changed` whose `changes` include `session` also carries `session` — why the tab's
  session changed and what it held before; the field is absent otherwise. A fork names its parent
  in `previousSessionId`, so an app can name it after it ("G4 grill (fork)").

```ts
interface AgentTabSessionChange {
  cause:
    | "first"    // the first session of an agent launched in the tab (no resume)
    | "clear"    // a new, empty session: claude /clear (/reset, /new), codex /clear, /new
    | "fork"     // a copy of the session: claude /branch, codex /fork, or any new transcript
                 // that records its parent (claude forkedFrom, codex forked_from_id)
    | "resume"   // an existing session taken up: a resume launch, an in-session /resume
    | "unknown"; // Pomade cannot tell: the binding went to null, a session bound by hand, a
                 // retry bind after the tab already had a session
  previousSessionId: string | null; // the session the tab was bound to just before; null when none
}
```
- `attachedTab.action`: an app declares header actions per session in its keeper (`spawn` /
  `update` `actions: [{ id, title }]`, at most four); Pomade shows them on attached tabs and, on a
  click, publishes this event to the owning app's subscribed frames and backend only — whichever app
  opened the tab. The owner acts on its own (Restart = stop, then start the same session id; the
  attached tab follows the new session).

### `notices` (no capability; an action that opens a file or a terminal needs `tabs.open`)

| Method | Params | Result |
|---|---|---|
| `notices.post` | `NoticeParams` | `{}` |

```ts
interface NoticeParams {
  title: string;                // one line, trimmed, 1–200 characters; the notice toast and the panel row show up to two lines of it
  body?: string;                // plain text, at most 2000 characters
  action?: NoticeAction;        // what a click does; none = the notice is only read
}
type NoticeAction =
  | { kind: "openApp"; route?: string; projectId?: string }        // the posting app's own tab — exactly tabs.openApp
  | { kind: "openFile"; path: string; projectId?: string }         // exactly tabs.openFile
  | { kind: "openTerminal"; cwd: string; command?: string; title?: string; projectId?: string };  // exactly tabs.openTerminal
```

- Pomade shows the notice as a notice toast (source, title, body) and keeps it in its Notices panel for the
  rest of the run. A burst from one app is one notice toast showing the newest ("4 more from Runner"); the
  user can mute an app — its notices then show no notice toast, only reach the panel and count in grey on its icon. Neither is visible to the app. Clicking either runs the action the way the named call does — the target
  project becomes active; an unknown project or an app that is gone is reported to the user, not to
  the app.
- **An action's project defaults to where the notice was posted, not to where the user is when
  clicking.** An action without `projectId` belongs to the posting frame's project: a tab frame's
  tab's project (even while another project is in front), a panel or overlay frame's active
  project at post time. A backend or a command has no project of its own: its notice belongs to the
  Workspace project ([[PLATFORM]] rule 9), over the socket and from the queue alike. Pomade records that
  project with the notice; the notice toast and the Notices panel row both switch to it. An app whose
  notice is about a specific project names it (`projectId`). Pomade shows that project's name
  on the notice toast and on the Notices panel row, and "N more from <app>" opens the Notices panel in the
  burst's project when all of it belongs to one.
- Paths follow the path rule (`outside-workspace`; `.pomade` is `capability-denied`); an
  `openFile` / `openTerminal` action without the `tabs.open` capability is `capability-denied`; a
  malformed notice is `invalid-params`.
- **From a backend or a command**, with Pomade open or closed: `pomade-kit/node`'s
  `postNotice(notice, { source })` writes the notice into Pomade's queue,
  `<userData>/notices/queue/<epoch-ms>-<nonce>.json` (`QueuedNotice`: the notice plus `source` — the
  app's id or the command's name — and `postedAt`), as a dot-file renamed into place. Pomade drains
  the folder at launch, in name order, and watches it while running; it removes each file once shown
  and renames an invalid one `.invalid`. A queued `openApp` action opens the `source` app's tab. The
  dev and the stable Pomade have separate queues (§2 "Which Pomade"; `POMADE_USER_DATA` overrides).

### `apps` — the broker (no capability)

| Method | Params | Result |
|---|---|---|
| `apps.call` | `{ app: string, method: string, params?: JsonValue, timeoutMs?: integer }` | the method's value (`JsonValue`) |
| `api.serve` | — | `{ methods: string[] }` — the manifest's `api` |

Pomade is the broker ([[PLATFORM]] "Transport and broker"): an app offers the methods in its
manifest's `api`; any of its clients — its backend over the socket, or a frame — becomes a
**server** by calling `api.serve`. `apps.call` carries a call to the target app's server and its
answer back. Pomade's own surfaces read app APIs the same way ([[PLATFORM]] rule 7), as the caller
`pomade`.

- **Checks, in order:** the caller's `calls` names the target (or the target is the caller's own
  app), else `capability-denied`; the target is hosted, else `app-absent`; the method is in its
  `api`, else `unknown-method`; something serves it now, else `app-absent`. `params` defaults to
  `{}` and must be plain JSON; `timeoutMs` is 100–60000, default 5000 (else `invalid-params`).
- **Which server:** the app's backend when it serves, else the frame that called `api.serve`
  last. `api.serve` from an app whose manifest declares no `api` is `capability-denied`. A server's
  session ending (frame reload, backend exit) withdraws it.
- **Request and response** — Pomade → server, then server → Pomade, on the server's own channel
  (postMessage or socket):

  ```ts
  { channel: "pomade", type: "request", id: "q7", from: "pomade-runner", method: "sessions.last", params: {...} }
  { channel: "pomade", type: "response", id: "q7", ok: true, value: ... }
  { channel: "pomade", type: "response", id: "q7", ok: false, error: { code: ErrorCode, message: string } }
  ```

  `from` is the calling app's id, `"pomade"` for Pomade itself. Only the server a request went to
  may answer it.
- **The caller's answer:** the server's value; its error as given; `app-not-responding` when no
  response arrives within `timeoutMs` or the server goes away first; `app-error` for a value that
  is not plain JSON. `app-absent` and `app-not-responding` are the caller's cue to fall back.
- **Cycles** are not detected at runtime: `calls` declares them and install reports them (rule 4).

**Platform reads of app APIs** ([[PLATFORM]] rule 7). Pomade asks these as the caller `pomade`;
an absent app, or one that does not answer in time or answers badly, leaves Pomade with its own
behavior.

- **The roster — `pomade-agents`' `roster.list`**, asked each time the "+" menu opens
  (1500 ms) and for every `agentTabs.launch` / `resume`. Params `{}`; the answer:

  ```ts
  { agents: RosterAgent[] }
  interface RosterAgent {
    id: string;                    // the roster id: no "/", "\" or line breaks; unique
    name: string;                  // what the "+" menu and the tab show
    command: string;               // one line: what the shell runs (an alias or a command on PATH)
    provider: "claude" | "codex";  // which CLI: its session store, resume command and output
    configDir?: string;            // absolute; default the provider's ($CLAUDE_CONFIG_DIR or ~/.claude,
                                   // $CODEX_HOME or ~/.codex)
    modes?: { id: string; name: string; args: string[] }[];  // "normal" first; default Normal and
                                   // Full autonomy (--dangerously-skip-permissions /
                                   // --dangerously-bypass-approvals-and-sandbox)
  }
  ```

  A malformed answer is refused whole. Pomade's own roster is the fallback: the built-ins claude
  and codex, plus one agent per `Agents/<name>/` folder with a `CLAUDE.md`. The command overrides
  and hidden agents Pomade keeps for a workspace apply to either. The project's visible agents
  (§4 `project.read`) filter the menu as before.
- **Jobs that target a repo — `pomade-runner`'s `jobs.forRepo`**, asked by each repo row of the Git
  panel when it shows, when the window regains focus, and when Runner starts or stops serving or publishes its
  `jobs.changed` or `runs.changed` event (1500 ms). Runner declares the method in its manifest's
  `api`. Params and answer:

  ```ts
  { repo: { name: string; path: string } }   // the Git panel's name (what pomade-git accepts) and the real path
  { jobs: RepoJob[] }                        // [] when no job targets the repo
  interface RepoJob {
    id: string;
    name: string;                            // "Knowledge twice daily"
    operation: "commit-push" | "pull" | "push" | "fetch";
    schedule: string;                        // when it runs, in words: "13:00, 20:00"
    nextRun: string | null;                  // ISO 8601
    lastResult: { status: "done" | "skipped" | "failed"; at: string } | null;
    route: string;                           // Runner's tab route that opens the job
  }
  ```

  The row shows *Scheduled: Commit & push · 13:00, 20:00 — edit in Runner* per job; the link opens Runner's tab
  at `route` (`tabs.openApp` semantics, in the active project). A malformed job is dropped; a malformed answer, an
  absent Runner or one not answering in time → no line. The contract (`REPO_JOBS_APP_ID`, `REPO_JOBS_METHOD`,
  `RepoJob`, `checkRepoJobs`, and `GitRunOutput` — what `pomade-git --json` prints) is in `pomade-kit/protocol`.
- **Agent sessions — `pomade-agents`' `sessions.forRepo` and `sessions.liveIn`** (the app's ARCHITECTURE §5).
  The app declares both in its manifest's `api`; the contract is in `pomade-kit/protocol` (`SESSIONS_APP_ID`,
  `SESSIONS_FOR_REPO_METHOD`, `SESSIONS_LIVE_IN_METHOD`, `checkRepoSessions`, `checkLiveIn`). Folders are absolute
  with symlinks resolved. 1500 ms each; an app that let a call time out is not asked again for 10 s.

  ```ts
  // sessions.forRepo — asked for each local In progress row whenever the list is read: a worktree by its
  // folder; a branch (not in a worktree) by the repository's folder and its name.
  { folder: string; branch?: string }
  { sessions: RepoSession[] }                // start folder at or below `folder` (and on `branch`), newest first
  interface RepoSession {
    id: string;                              // the provider's session id
    agent: string;                           // roster id
    name: string | null;                     // null = unnamed
    status: "active" | "on-hold" | "done" | "done-skip";
    live: "working" | "needs-you" | "idle" | "closed";
    cwd: string;                             // the start folder
    branch: string | null;                   // recorded at start; null when the provider records none
    project: string | null;                  // stable project id; null = the Workspace project
    startedAt: string; lastActiveAt: string; // ISO 8601
  }
  // sessions.liveIn — "is an agent live here?", asked by merge / rebase / remove, the In progress rows and
  // `pomade-git` (through `agents.liveIn`).
  { folder: string }
  { live: boolean; sessions: LiveSession[] } // live === (sessions.length > 0)
  interface LiveSession {
    sessionId: string | null;                // null: an agent tab not prompted yet
    agent: string;
    cwd: string;
    source: "tab" | "run";                   // a Pomade agent tab, or an unattended Runner run
    job: string | null;                      // the Runner job of a run; null for a tab
    state?: "working" | "needs-you" | "idle"; // what it is doing, when the app knows; a run is never idle
  }
  ```

  The row links the live session, else the latest (`pickBranchSession`): *agent name · session name* (*unnamed
  session* in italics); the link resumes it in a new agent tab — or goes to the live tab already on it — in the
  session's project; in the Workspace project when it names none or that project is gone ([[PLATFORM]] rule 9). A malformed session is dropped; a malformed `forRepo` answer, an absent app or
  one not answering → no link. "Agent live here?" joins the app's answer with Pomade's own terminals; a malformed
  `liveIn` answer, an absent app or one not answering leaves Pomade's terminals alone. A session's `state`
  is optional; any other value refuses the answer whole. Pomade takes no `idle` from a run, and a tab with no
  `state` takes Pomade's own reading of its terminal (`agents.liveIn` above).
- **Sessions — `pomade-agents`' tab at route `sessions`.** The Session history button in the tab strip opens
  it (`tabs.openApp` semantics, in the active project) when the app is installed and available;
  otherwise Pomade's own Session history.

## 5. Hosting behavior (what an app can rely on)

- An app tab is an `<iframe>` on `pomade-app://<id>/<entry>`, served with
  `cache-control: no-store`. Like every Pomade pane it is **hidden, never unmounted**: switching
  tabs or projects keeps the app's JS state; events still arrive while hidden.
- An app tab belongs to the project it was opened in, like any tab, and its `welcome.project` is
  that project (§3). Each frame gets its own handshake; two frames of one app share nothing except what Pomade stores for them.
- A missing, removed, or invalid app shows an in-tab "App unavailable" page with the reason.
  Pomade itself is never affected by an app's failure.
- A side panel is the same `<iframe>` on the `panel` surface, under a header with the icon's
  title. It is created the first time its icon is shown and then hidden, never unmounted —
  across panel switches, project switches and a collapsed column. Panels follow the active
  project (`project.changed`); there is one panel frame per icon, not one per project. A click on
  the icon, or the app's own `panel.show` (§4 `panel`), brings it forward; `panel.show` may also
  move it to a route.
- **Overlay** (a shortcut with action `overlay`, or the app's own `overlay.open`, §4): a small frame of the app, 420 wide and 220 high until the app
  asks for another height (§4 `overlay`), under a drag handle, centred over
  the active tab's area (or placed by `anchor`) under a dimming scrim, on `surface: "overlay"` at the shortcut's `route`
  (no icon; `overlay.open`'s route) — whatever the active tab is, and whether or not the app was ever opened. It takes
  keyboard focus. It closes on a plain Escape (the app forwards an unhandled one, §3 "Keys"; Pomade
  closes on it, and on Escape pressed in Pomade's own UI), a click on the scrim, or `overlay.close`;
  focus then returns exactly where it was — a terminal, an editor caret, another app's frame. One
  overlay at a time: the same shortcut again refocuses it, another app's replaces it. Each open is
  a fresh frame (a new handshake); what it must remember goes to `state` (§4). The scrim dims the pane
  area only; the card stacks above everything else in the window. The user drags the card by its handle
  anywhere in the window below the title bar — over the pane area, the tab strip, the side panel, the
  strip and the Projects panel — and Pomade keeps it whole inside the window with a 16 px margin. Pomade
  remembers where it was left, per app and machine, and that app's next overlay that names no place — its
  shortcut, or `overlay.open` without an anchor or with `"center"` — opens there, clamped into the window
  as it is then (a smaller window, another display); `overlay.open` with `anchor: "panel"` opens beside
  the side panel instead (§4 `overlay`).
- App frames may submit forms (`<form>` submits on Enter); their sandbox is `allow-scripts
  allow-same-origin allow-forms`.
- Every app frame — tab, side panel, overlay — may write text to the clipboard:
  `navigator.clipboard.writeText(text)` in a click (or any user gesture) handler puts it on the
  system clipboard. Reading is refused: `navigator.clipboard.readText()` rejects. Nothing else
  of the browser's powerful features (camera, microphone, location, notifications) is available.
- A `startOnLaunch` app's launch panel frame exists from launch on, hidden (§1); a frame cannot
  tell whether it was started at launch or opened by the user.
- **A call always settles.** Pomade answers every call a live frame makes, exactly once — a
  frame just shown again, hidden, or in the middle of a new handshake alike. A call still in flight
  when the frame sends `hello` again is answered before that handshake's `welcome`: with its result
  when it has one by then, else with `not-ready` (a call whose work Pomade had not begun is then
  not done). A frame that is closed — its tab or panel gone, its app updated — is answered nothing.
- An app frame runs in its own process. Once Pomade shows it (a panel's icon pressed, its tab
  brought back), it takes pointer input only after the window has drawn it — 2 of Pomade's
  animation frames for a tab, up to 5 for a panel, tens of milliseconds; a click sent earlier is
  dropped, not queued. A person never meets this. Automated tests that click right after showing a
  frame wait 5 animation frames first.
- Opening an app: its strip icons (§1), or the new-tab menu, which lists every installed and
  dev-linked app and opens its default view (no icon, route `""`).

**Theme and design tokens.** An app looks like Pomade by using Pomade's design tokens and
Pomade's theme — not the Mac's appearance (`prefers-color-scheme`), which can be dark while Pomade
is light.
- `pomade-kit/tokens.css` is Pomade's design tokens — colors, type, spacing, radii, elevation,
  sizes — as CSS custom properties (`--bg`, `--text`, `--accent`, `--border`, `--space-2`, …) on
  `:root`, with `color-scheme`. It is generated from Pomade's own tokens (`src/renderer/tokens.css`,
  by `scripts/kit-tokens.mjs`), never copied by hand; Pomade's unit tests fail while the pinned
  kit's copy differs. Each theme is keyed by `data-theme` on the root element; Pomade has its light
  theme only, the `:root` rule.
- `pomade-kit/sdk` `followTheme(host)` puts `welcome.theme` on the frame's root (`<html
  data-theme="light">`) and follows each `theme.changed`; `applyTheme("light")` does it once (an
  app outside Pomade). `host.theme.get()` / `host.theme.onChange(cb)` give the theme itself.

## 6. Standalone and the fake host

Opened outside Pomade (a browser, a test), an app finds no host and shows its "no Pomade host"
state; it never throws. For development and tests, `pomade-kit`'s fake host implements this whole
document in memory — files with frontmatter and every file write (the same field-only code),
symlinks within the manifest's folders, groups and projects with their settings, visible
agents and the app's scope folders, the active project, the app's own tabs (`tabs.openApp` opens, focuses or moves one to a new
route, as in Pomade; keyed tabs with their titles and kinds, `tabs.setRoute`, `tabs.setTitle`, `tabs.close`, and the
user renaming or closing a tab), scripted folder- and file-picker answers, scripted write failures (a
permission, I/O or already-exists failure on the next write to a path, answered with Pomade's error
codes), silent file changes (the bytes and mtime change with no watch event, so a changed-on-disk
check can be tested),
scripted git repos (`git.getState`, `git.changed`), the event bus (Pomade ready, platform and other apps'
events raised by the test, other apps subscribing to the app's own events), agent tabs (seeded,
launched, resumed, renamed by the user, updated by the test, each change heard as
`agentTab.changed`), frames opened as a tab or a panel for a strip icon (hidden or shown), the overlay the app
opens (mounted as a frame at its route, sized by `overlay.resize`, closed by Esc, `overlay.close` or a click
outside, focus back to the opener), the side panel the app brings forward (`panel.show`, recorded in
`fake.panelShows`: a mounted panel frame of that icon is shown and gets the route change, the app's
other panel frames are hidden, a panel frame attached later opens at the route), file deletes (heard by watches), badges, the app state, Pomade's theme (`theme`
option, `setTheme` → `theme.changed`) — speaking the same
messages, so the same app code runs against Pomade and against the fake host.

Its socket side (`pomade-kit/fake-host/node`) serves the same in-memory host on a Unix socket with
Pomade's layout (`<userData>/run/pomade.sock`, `<userData>/app-keys/<id>`), so an app's backend and
commands connect to it as to Pomade: the handshake (version, then identity and role), the broker
(`api.serve`), events, `project.*`, `agentTabs.*` and `tabs.openApp`. A test reads the env a backend
or command gets from it and drives the UI ↔ broker ↔ backend round trip without Pomade.

## 7. Using it from an app

Through `pomade-kit` (`github:dd-voronov/pomade-kit#vX.Y.Z`): `connect()` performs the
handshake and returns a typed client (`host.project.getActive()`, `host.files.readFolder(…)`,
`host.files.watch(…, onChange)`, `host.files.readFile(…)`, `host.files.setField(…)` and the other
`files.write` methods, `host.files.symlink(…)`, `host.files.pickFolder(…)` / `pickFile(…)`, `host.project.list()`,
`host.project.getSettings(…)` / `getAgents(…)` and their setters, `host.project.getScopeFolders(…)` / `addScopeFolder(…)` / `removeScopeFolder(…)`, `host.project.activate(projectId)`, `host.project.onChange(…)`,
`host.tabs.openFile(…)` / `openTerminal(…)` / `openAttached(…)`, `host.strip.setBadge(…)`,
`host.state.get(key)` / `.set(key, value)` / `.onChange(…)`, `host.tabs.openApp(…)` /
`.setRoute(route)` / `.setTitle(title)` / `.close()`,
`host.onRouteChange(…)`, `host.overlay.close()`, `host.git.getState(…)`,
`host.git.watch(…, onChange)`, `host.events.subscribe(name, handler)` / `.publish(name, payload)` /
`.hasSubscribers(name)` / `.onSubscribersChange(…)`, `host.notices.post(…)`,
`host.agentTabs.list(…)` / `.setTitle(tabId, title)` / `.focus(tabId)` / `.launch(…)` / `.resume(…)`; the
`welcome` target as `host.welcome.surface` / `.icon` / `.route` / `.key` / `.kind`) or reports "no host". The kit's
README is the usage reference; this document is the protocol.

## 8. App release ritual

- Dev Pomade uses dev links and dev installs (`pomade apps …`, the default target).
- Installing an app build into the **stable** Pomade (`pomade apps install --stable`) happens only
  on the Owner's explicit word, like Pomade's own releases. The first such install freezes the Host
  API as v1.

### Bundled apps

A Pomade release carries chosen apps and the stable Pomade installs them at start.

- **The pin.** `bundled-apps.json` in the Pomade repo lists repos, each with a git URL, a tag and the
  app folders its build produces: `{ "repos": [{ "repo", "tag", "apps": { "<id>": "<folder>" } }] }`.
  One repo may build several apps (`pomade-planner` builds `pomade-planner` and `pomade-board`). An
  app repo's tag must build with `npm ci && npm run build`, and each named folder must hold an
  installable build whose manifest id is the key.
- **Packaging.** `npm run dist:mac` runs `scripts/bundle-apps.mjs`: it clones each repo at its tag,
  runs its build, checks each folder's manifest, and copies it to `bundled/<id>/`; electron-builder
  ships that as `Contents/Resources/bundled-apps/<id>/`, outside the asar. A missing tag, a failed
  build or a wrong manifest fails the packaging.
- **At start** (a packaged Pomade, before the app registry's first scan), per bundled app:
  absent → installed; installed at an older version, or with no valid manifest → updated; installed at
  the same or a newer version (an install by hand) → kept; removed by the user at this build's version
  or a newer one (`app-removals.json`, §2) → not put back — a later release with a newer build installs
  it again. An install is the same as `pomade apps install`: the app's key, then the registry links its
  commands, starts its backend and loads its launch panel. Apps not in the bundle are left alone.
- **One notice** (source `pomade`, shown as "Pomade") lists what was installed or updated, only when
  something was — e.g. "An app installed with Pomade" / "Installed: Planner 0.1.0".
- A dev Pomade installs no bundled apps.
