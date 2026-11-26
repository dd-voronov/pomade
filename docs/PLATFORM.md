---
doc: docs/PLATFORM.md
audience: everyone designing or placing work; app repos
holds: platform vs apps, the platform rules, how an app lives inside Pomade, the registry of shared building blocks
kind: rules + reference
---

# Pomade — Platform

Pomade is a **platform**: the shell that organizes projects and hosts the work surfaces its user
spends the day in. Pomade itself owns the core surfaces — projects, file tree, tabs, editor,
terminal, git. Larger capabilities are **separate apps**, each in its own repo with its own build
and lifecycle; they open inside Pomade as tabs and side panels and talk to it only through the
**Host API**. Shared pure logic lives in one library, **`pomade-kit`**. This doc is the map: what
the platform owns, which apps exist, how an app lives inside Pomade, the rules every piece
follows, and the registry of shared building blocks. It is binding for this repo and for every
`pomade-<app>` repo.

## Platform vs apps

**The platform (this repo) owns:**

- workspace, groups and projects — the project-management shell
- file tree, tabs and the pane host
- the editor — raw / live / rendered markdown, CSV
- terminals and PTYs; launching agents; agent tabs (which session runs in which tab, tab titles,
  live state); terminal tabs attached to sessions an app owns
- the icon strip and side panels (Files, Git, and panels apps contribute)
- git — status in the tree, repo views and history, comparison tabs, document history,
  unsaved-document recovery, all git operations with their safety rails, and the `pomade-git`
  command. *When* git operations run on a schedule belongs to `pomade-runner`.
- notices, unread dots and counters, and icon badges
- the event bus and the broker that connects apps
- the project dashboard (each project's home; apps contribute widgets)
- app hosting: installing, discovering and running apps; the Host API

**Apps** live in `Projects/pomade-<app>/`, one GitHub repo each. An app uses only the Host API and
other apps' published APIs, and is built, tested, updated and deleted without a new Pomade
build. Pomade works with zero apps installed.

## The family

| Piece | Kind | Owns |
|---|---|---|
| `pomade` (this repo) | platform | everything listed above |
| `pomade-planner` | app | **Planner** — to-dos, recurring tasks, daily notes, notes and thoughts, each one md file with frontmatter in a user-chosen tasks folder (project = sub-folder) |
| `pomade-board` | app, built from the `pomade-planner` repo | **Board** — kanban over each project's frontmatter backlog (Signals · Problems · Solutions), ticket creation and ID assignment; data in `<workspace>/Apps/pomade-board/` |
| `pomade-runner` | app, always-on background part | jobs of four kinds — Script · Agent · Git · Service — on schedules, hooks and chains; always-on services; missed-run policies; load control; run history and result cards; the sessions it runs, which Pomade tabs attach to |
| `pomade-agents` | app | the agent **roster** (profiles, modes, launch specs, skills, agent creation) and **session data** (sessions per project, names, statuses, notes, attribution, messages, stats, "agent live here?") |
| `pomade-kit` | library | the app SDK (Host API client, types, a fake host for standalone development and tests), shared pure logic (schedule format, date phrases, field-only frontmatter writes, agent output scanners) and the keeper library apps run for terminal sessions that outlive Pomade (with the attach protocol) |
| Whiteboards, media viewers | app ideas | open-source components wrapped as apps |

## Rules

1. **Placement check before implementing.** Before any new code, the ticket records *where it
   goes* — the platform, an existing app, `pomade-kit`, or a new app — and *which shared building
   blocks it touches* (its `seams:` field). Default: surfaces woven into the tree, tabs, editor
   or terminal stay in the platform; a capability with its own data and its own UI is an app;
   pure logic needed by two or more pieces goes to `pomade-kit`, and so does the keeper library
   (`pomade-kit/keeper`), the one runtime part apps run themselves.
2. **First user builds, second user generalizes.** A shared building block is built for the
   users that are known when it is built — the users recorded in the registry below — and no
   further. When a user that was not known arrives, it generalizes the block inside its own
   epic, not as a follow-up, and adds itself to the registry. Never generalize for an imagined
   user.
3. **The Host API is the only door.** Apps never import platform code or read Pomade's internal
   state. `<workspace>/.pomade/` is that state: every Host API file method refuses paths inside
   it, and an app that needs a piece of platform state gets a Host API method for it.
   An app's UI reaches files only through the Host API. An app's backend may read and write
   files directly; while Pomade runs it prefers the Host API's file methods for workspace
   files, and it stays out of `.pomade/` like every other part of an app.
   `pomade-kit` is a library, not platform code, and anyone may import it. The Host API is
   **v0** until the first app is installed into the stable Pomade: any change may break it,
   and Pomade, the kit and the apps move together. From **v1** on, changes are additive; a
   breaking change ships as a new Host API version, and the old one keeps working until no
   installed app needs it.
4. **One owner per kind of data, no call cycles.** Everyone else reads and writes that data
   through the owner's API. App-to-app calls form no cycles. Events don't count as
   dependencies: a publisher doesn't know its subscribers, so two apps that need to hear from
   each other use one call direction plus events the other way.
5. **Rules are inherited.** Every repo of the family follows this doc's rules. A repo may add
   local rules; one that contradicts a family rule says so explicitly.
6. **Platform-level conventions live in this repo.** Shared skills outside the Pomade
   repos are not modified for Pomade-specific process.
7. **The platform may show an app's data, never depend on it.** A platform surface can read an
   installed app's API to show something extra (a repo row's *"Scheduled: Commit & push ·
   13:00 — edit in Runner"*). When the app is absent or not responding, that element is simply
   not there, or the platform falls back to its own behavior (the "+" menu lists agents from its
   own folder scan). Apps depend on the platform; the platform never requires an app.
8. **The file on disk is the truth.** Any writer — Pomade's editor, an app, an agent, git,
   another editor, Finder — may change a file. When a file that is open with unsaved edits
   changes on disk, Pomade shows *"File changed since your edits · Compare"* and never
   overwrites either version silently.
9. **No project means the Workspace project.** Everything Pomade shows belongs to a project or to the
   Workspace project — the Projects panel's Workspace row: the whole workspace folder as a project, with its own tabs and
   panels (`"__workspace__"` in the Host API). When nothing names a project and Pomade cannot
   tell which one it is, it belongs to the Workspace project — never to whichever project happens to be
   in front. A notice or a tab opened by an app's backend or a command, and an agent session
   recorded without a project or with one since removed, go to the Workspace project. A surface that
   knows its project keeps it: an app tab's frame, a panel or overlay shown in the active
   project, a terminal or editor the user clicks in.
10. **Everything lives in the workspace.** Pomade and every app keep their files in three places:
    `<workspace>/.pomade/` (Pomade's own config and state), `<workspace>/Apps/<app>/` (an app's data,
    and Pomade's heavy data in `Apps/Pomade/`) and the Knowledge vault — so copying the workspace to
    another Mac carries every setting and every record. A file lives outside only when it is listed in
    "Storage outside the workspace" below with its reason: it is bound to this Mac (a socket, a key, a
    pid, a login item, a command on `PATH`), rebuilt from what the workspace holds, or of no use on
    another Mac (logs, crash recovery, caches). A new location outside is agreed with the Owner and
    added to the list before the code that writes it. Settings, and anything the Owner would miss on a
    new Mac, are never an exception.

**Storage outside the workspace.** Every place Pomade writes outside the workspace. `<userData>` is
`~/Library/Application Support/Pomade` (`pomade-dev` for an unpackaged Pomade); `<home>` is `~/.pomade`
(`~/.pomade-dev`). Layout in detail: [ARCHITECTURE](ARCHITECTURE.md) "Persistence layout".

| Where | What | Why outside |
|---|---|---|
| `<userData>/app.json` — `workspaceRoot` | which folder is the workspace | read before any workspace is known |
| `<userData>/recovery/` | unsaved-edit copies; discarded drafts (7 days) | crash recovery of this Mac's edits |
| `<userData>/git/runs.jsonl` | the `pomade-git` run log | this Mac's runs; grows while they run |
| `<userData>/apps/`, `app-links.json`, `app-removals.json` | installed app builds, dev links, removed bundled apps | this Mac's installs; rebuilt from bundled apps and `pomade apps install` |
| `<userData>/app-state/<id>/` | an app's machine-local state | "Locations" above |
| `<userData>/app-keys/` | per-app socket keys | secrets bound to this Mac; never synced |
| `<userData>/app-logs/` | backend logs | logs |
| `<userData>/run/` | sockets, pid files, always-on stamps | live processes; a socket path stays ≤ 104 bytes |
| `<userData>/notices/queue/` | notices posted while Pomade is closed | drained at the next start |
| `<userData>/zsh-integration/` | the zsh shim of Pomade's terminals | generated at start |
| `<userData>/` Chromium folders (`Cache`, `GPUCache`, `Local Storage`, …) | Electron's own caches | caches; Pomade keeps nothing in browser storage |
| `<home>/bin/`, `workspace`, `host.json` | the `pomade` and app commands, the workspace pointer, how to reach the running Pomade | commands on `PATH` and this Mac's running Pomade |
| `<home>/worktrees/` | git worktrees Pomade creates | working copies; their branches live in their repos |
| `~/.zprofile` (or `$ZDOTDIR/.zprofile`) | one `PATH` line for `<home>/bin` | the shell finds the commands |
| `~/Library/LaunchAgents/io.github.dd-voronov.pomade.app.*.plist` | always-on app backends | macOS login items |
| `~/Library/Preferences/io.github.dd-voronov.pomade.plist` | window and file-dialog defaults | written by macOS |
| the OS temp dir | merge and rebase scratch | removed after use |


**Working across repos.** Each repo numbers its own backlog IDs. References across repos are
written `<repo>:<ID>` — `pomade:E-030`, `pomade-kit:E-003`, `pomade-runner:E-002`. A repo's own
IDs are written bare inside that repo.

## How an app lives inside Pomade

An app has up to three parts:

| Part | What it is | Lifecycle |
|---|---|---|
| **UI** (required) | a web page in an `<iframe>` served from `pomade-app://<id>/`, talking to Pomade over `postMessage`; it also runs standalone in a browser, showing a "no Pomade host" state | lives in a tab or side panel; hidden, never unmounted, like every pane |
| **Backend** (optional) | a Node process the app ships, running with the user's rights — it can read stores outside the workspace and write config files | **with-Pomade**: started when Pomade starts, stopped on quit, restarted on crash · **always-on**: a login item at a stable path that survives Pomade quitting and can launch Pomade |
| **Commands** (optional) | command-line entries the app ships, linked into `~/.pomade/bin` (on `PATH`) at install, next to the platform's own `pomade-git` | run on demand, with or without Pomade |

**Transport and broker.** The Host API is one message protocol over two channels: `postMessage`
for UIs, and a local socket in Pomade's user-data folder for backends and commands. Pomade is
the broker: each app registers its API with Pomade, and app-to-app calls and platform → app
reads go through it. Anything that must work while Pomade is closed is a command
(`pomade-git`) or an always-on backend.

**Manifest.** Each app ships a `manifest.json`: id, name, version, the Host API version it
needs, icon, side-panel contributions, shortcuts, backend mode, commands, and the paths outside
the workspace it uses. Pomade shows these once at install. They exist for visibility, not as a
security sandbox; the iframe's isolation is for robustness — an app's failure never takes
Pomade down.

**Keyboard.** App frames forward keystrokes they don't handle to Pomade, so Pomade's shortcuts
keep working inside apps; apps register Pomade-wide shortcuts through the manifest or the Host
API.

**Locations.**

| What | Where |
|---|---|
| App source | `Projects/pomade-<app>/`, its own GitHub repo; one repo may build several apps (`pomade-planner` builds `pomade-planner` and `pomade-board`) |
| Installed build | `<userData>/apps/<id>/` — machine-local, a stable path for login items; a dev Pomade has its own user data, so dev and stable never share apps |
| App data | `<workspace>/Apps/pomade-<app>/` — the Owner's files and what the app records for them once it is settled; travels with a copy of the workspace and is readable by agents (job files, settings, agent profiles, session names, run history, a finished run's output, Needs-you items) |
| Machine-local app state | `<userData>/app-state/<id>/` — what describes this Mac's live processes, files that grow while a process runs, and caches (a live run's or a service's output, sockets, a keeper's state); Pomade creates it and names it to the app's backend and commands as `POMADE_APP_STATE` |

Nothing is appended to continuously under the workspace: a file that grows while a process runs is
written machine-local and moved into app data when it is complete.

**Install and update.** An app repo's install script builds the app and runs
`pomade apps install <path>`; updating is the same step. No Pomade rebuild. In **dev link**
mode, Pomade loads an app straight from its repo's build output or dev server. A Pomade
**release** also carries chosen apps — pinned by repo and tag in `bundled-apps.json`, like the kit
pin — and the stable Pomade installs or updates them at start (HOST-API §8 "Bundled apps"): an
app reaches the stable Pomade without anyone running `pomade apps install --stable`. Every
install is its own build folder, so an update never pulls files from under a process still
running from the earlier build (an app's keeper).

**`pomade-kit`** is consumed as a semver git-tag dependency
(`github:dd-voronov/pomade-kit#vX.Y.Z`) — by every app and by Pomade itself.

## Shared building blocks

The registry. *Users* lists every known user; a ticket that touches a block names it in
`seams:`. *State*: `not built` · `minimal` (serves its first user) · `built` (serves every listed
user).

| Block (`seams:` slug) | What it is | Owner | Users | Work | State |
|---|---|---|---|---|---|
| `app-hosting` | UI hosting, manifest, install, bundled apps, dev link, Host API protocol and versioning, key forwarding, app shortcuts | platform | Board, Planner, Runner, Agents | pomade:E-027 | built |
| `app-backends` | with-Pomade and always-on backends, socket transport, broker, app commands on `PATH`, launching Pomade on request | platform | Agents, Runner, Planner (`today` command) | pomade:E-028 | built |
| `side-panels` | the icon strip, panel slot, icon actions (fill the panel · open a tab · both), icon badges, app contributions | platform | Files, Git, Board, Planner, Runner, Agents | pomade:E-029 | minimal |
| `workspace-data` | watched folder reads, frontmatter (a folder's or one file's), field-only writes (a mapping key included), writes only if unchanged since read, create/move/rename, open a file or a terminal-with-command in a tab, active project, groups → projects, stable project ids, per-project app settings, app scope folders (a folder an app puts in a project's scope), project ↔ agent connection, scoped symlink operations | platform | Board, Planner, Runner, Agents | pomade:E-030, pomade:E-047 | built |
| `event-bus` | platform events (Pomade ready, project created / renamed / removed / first opened, active project changed, theme changed, agent tab exited) and app-published events, subscription-aware | platform | Planner, Runner, Agents | pomade:E-031 | built |
| `notices` | notices with a click action, unread dots and counters, icon badges, a queue for notices posted while Pomade is closed | platform | terminal attention, Git, Planner, Runner, Agents | pomade:E-032 | built |
| `agent-tabs` | tab ↔ session bindings over time, titles both ways, live state, focus / launch / resume in a project, the "+" menu and Session history button reading from the installed agents app | platform | Agents, Runner, Git | pomade:E-033 | built |
| `attached-terminals` | the attach protocol and a terminal pane showing a session an app owns: live output, scrollback replay, input, resize, detach on close, exit and "stopped by you", owner header actions | platform (keeper library in `pomade-kit/keeper`, keeper process owned by the app's always-on backend) | Runner | pomade:E-034, pomade-kit:E-006 | built |
| `external-writes` | rule 8: disk is truth, the changed-on-disk banner, unsaved-edit recovery | platform | editor, every app | git slice 0 | built |
| `pomade-git` | git operations as a command, with Pomade closed, returning a structured result (done / skipped / failed + reason, steps, commit hash); the result and Runner's `jobs.forRepo` are contract in `pomade-kit/protocol` | platform | Runner | pomade:E-042 | built |
| `dashboard-widgets` | apps contributing widgets to a project's dashboard | platform | Git, Planner, Runner, Agents | later | not built |
| `sdk` | Host API client, types, fake host | `pomade-kit` | every app | pomade-kit:E-001 | built |
| `design-tokens` | Pomade's design tokens for apps (`pomade-kit/tokens.css`, generated from Pomade's `tokens.css`) and Pomade's theme on an app's root (`followTheme`) | `pomade-kit` (source: platform `tokens.css`) | every app | pomade:T-246, pomade-kit:E-001 | built |
| `frontmatter-write` | field-only frontmatter writes: every byte outside the edited key unchanged | `pomade-kit` | editor, Board, Planner | pomade-kit:E-002 | built |
| `schedule-format` | one agent-writable recurrence format and next-occurrence engine: fixed dates, intervals within hours, weekday filters, once-at, "N after completion", lead time | `pomade-kit` | Planner, Runner | pomade-kit:E-003 | built |
| `date-phrases` | `fri`, `tomorrow`, `+3d`, `nov 20`, `tonight 23:00` → a date | `pomade-kit` | Planner, editor, Runner | pomade-kit:E-004 | built |
| `agent-scanners` | detecting busy, waiting-for-you, attention and exit in agent terminal output | `pomade-kit` | platform terminals, Runner | pomade-kit:E-005 | built |
| `job-runner` | run a job on a time or event trigger, capture output, report the result | `pomade-runner` | Git jobs, agent jobs, hooks | pomade-runner backlog | not built |
| `roster` | agent profiles, modes, launch specs | `pomade-agents` (platform folder scan as fallback) | "+" menu, Runner | pomade-agents backlog | minimal (platform scan) |
| `session-data` | sessions, transcripts, last message, stats, attribution, "agent live here?" (`sessions.forRepo`, `sessions.liveIn` — contract in `pomade-kit/protocol`) | `pomade-agents` | Git (branch ↔ session link, merge blocking, `pomade-git`), Runner, platform history (fallback) | pomade-agents backlog; Git's reads pomade:E-043 | minimal (platform history; Pomade's own terminals answer "agent live here?") |
