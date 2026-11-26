---
doc: docs/user-guide/apps.md
audience: users
holds: how to use apps in Pomade — installing, linking and removing them (the pomade command), opening an app's tab, side panels and the icon strip, the overlay, badges and notices, background services, app commands on the PATH, shortcuts
kind: reference
---

# Apps

Apps are separate programs that run inside Pomade and work on your workspace: Planner (tasks and
notes), Board (a kanban board), Runner (scheduled jobs and services), Agents (your coding-agent
roster and session history). Each is built and updated on its own, shows up in Pomade like a built-in
feature — a tab, a side panel, an icon — and can only do what it declared it needs. A packaged
Pomade comes with Planner, Board and Runner.

## What you have

- The **+** menu at the right end of the tab strip lists every installed app, with its icon, below
  your agents.
- The **icon strip** has one or more icons per app, after Files, Git and Notices.
- In a terminal, `pomade apps list` prints the installed apps and dev links with their versions.

An app that cannot start (a broken update, a missing file, a dev server that is not running) is still
listed — greyed out in the **+** menu with the reason on hover — and wherever it should appear
you see the **App unavailable** card: the reason, the app's id, where it is installed or linked from,
and a **Retry** button that checks again. Nothing else in Pomade is affected. Open tabs of the app
come back by themselves when it does.

## Install, link and remove an app

All three are done with the `pomade` command in a terminal. They take effect at once — no restart.
Open tabs and panels of an updated app reload on the new build.

```
pomade apps install <build-folder>
pomade apps remove <id>
pomade apps link <build-folder | http://localhost:PORT>
pomade apps unlink <id>
pomade apps list
```

- **Install** (`pomade apps install ~/apps/runner/dist`) checks the app's `manifest.json`, prints a
  summary of what the app declares, copies the build into Pomade's user data and starts using it.
  Installing again **updates** the app. The summary lists the permissions (`Capabilities`), the strip
  icons, the shortcuts, the background service, the commands and the `Outside the workspace` paths — read
  it, it is the whole list of what the app may do. A manifest with a problem is refused with one line
  per problem, naming the field.
- **Link** (`pomade apps link ~/code/my-app/dist`, or `pomade apps link http://localhost:5173` for a dev
  server) is for building an app: Pomade serves it from where it is and a change shows when its frames
  reload. A link wins over an installed copy of the same app until you `unlink` it. A dev-server link
  has no background service, commands or skills.
- **Remove** deletes the installed app, its commands and its key. The data the app saved in its own
  state folder stays. A bundled app (Planner, Board, Runner) you remove is **not put back** by Pomade's
  updates until a release carries a newer version of it; installing it again by hand brings it back.
- **Skills.** An app may ship agent skills. Install prints one line per skill —
  `Skill <name> is at <folder>. To give it to an agent, copy or link this folder into the agent's skills
  folder.` Pomade gives skills to no agent itself.
- A warning `call cycle a → b → a` means two apps are set up to call each other.

**Which Pomade, and where the command runs.** `pomade` acts on the dev Pomade by default; add `--stable`
to act on the installed one (`pomade apps install <folder> --stable`) — do that only on purpose. The
command is available in the terminals of a Pomade started from its source checkout (`bin/pomade`, Node
22.18 or newer); a packaged Pomade ships `pomade-git` but not `pomade`, so run `bin/pomade … --stable`
from the checkout to manage the packaged one.

## Open an app

- **From the strip.** Click one of the app's icons. What happens depends on the icon — hover to see:

  | Icon tooltip | Click does |
  |---|---|
  | its title only | fills the side panel with the app (and expands a collapsed column); the icon stays highlighted |
  | its title and `Opens in a tab` | opens the app's tab in the current project, or focuses it if it is already open; the column stays as it is |
  | its title and `Opens a tab and the panel` | both: the tab on one view and the panel on another |

- **From the + menu.** Pick the app's name: it opens the app's own tab (its default view) in the current
  project, or focuses it if the project already has one.

An app tab belongs to the project it was opened in, like any tab. Its title is the icon's title (the app's
name for a tab from the **+** menu) and follows the app when it updates; right-click the tab ▸
**Rename tab** to give it your own name, after which it keeps that name. Switching tabs or projects does
not reload an app — it keeps its state and keeps receiving updates while hidden. Pomade remembers
which view a tab was on across restarts, including a view the app moved to by itself: clicking the app's
icon in the strip again only brings the tab forward and leaves it on that view.

An app can also open its own tab for you — a panel's "Open in full tab", a chooser that jumps to a
project's board — and a notice's click can open an app at a view (below). Pomade switches to the right
project when that happens. An app can also take you to a project without opening anything in it; you see
that project's own active tab, and the Projects panel scrolls to its row.

**More tabs from one app.** An app can open several tabs of its own, one per thing it shows — Runner's
output of each run, say — next to its main tab. Each has its own title and icon from the app, never an
icon in the strip, and opening the same thing again brings its tab forward (and moves it to the view the
app asks for). The app can retitle such a tab and close it when what it showed is gone. Your **Rename
tab** name always wins over the app's title. These tabs come back after a restart; the **+** menu never
creates them, and a notice or app shortcut opens the app's main tab, not one of these.

## The icon strip and the side panel

The strip is always visible. The panel beside it shows one icon's content at a time, and each project
remembers which. Files, Git and Notices come first; an app's icons follow, in the order the app lists
them. The strip scrolls when there are many icons.

- **Collapse side panel** (`«` in the panel header) or **Cmd+Shift+B** hides the panel and leaves only the
  strip; **Expand side panel** (`»` at the bottom of the strip) or the same shortcut brings it back.
- Clicking a panel icon while the column is collapsed expands it.
- An app's panel starts the first time you show it and then keeps running when you switch to another
  panel, another project or collapse the column. Some apps start their panel when Pomade starts, hidden,
  so their icon can show a number before you open it.
- An app can bring its own panel forward itself — a button in its tab or overlay that says "show this in
  the panel". The side panel expands if it was collapsed and shows that app's panel, sometimes at a
  particular view; no tab opens, and the keyboard stays where it was (an open overlay stays open).
- **A number on an icon** is a count the app reports — jobs that need you, due tasks. It is red when the app
  marks it urgent, and reads `99+` past 99. It clears when the app clears it, and resets when the app
  reloads.
- **An amber dot** on an icon's corner means the app's background service is stopped or crashed (below).

## The overlay

An app can have a quick form — add a task, jot a note — that opens over whatever you are doing, even
inside a terminal or an editor, without opening the app. It appears centred over the work area under a
dimmed backdrop (the backdrop dims the work area only), with a thin handle on top, and you can type at once.

- **Open it** with the app's shortcut (the install summary lists them under `Shortcuts`), or with a button
  inside the app, such as the **+** in Planner's panel.
- **Close it** with **Esc**, by clicking the dimmed area, or when the app finishes (after saving). The
  keyboard goes back exactly where it was — the terminal prompt, the editor caret.
- **Move it** by dragging the handle. You can drag it anywhere in the window below the title bar — over
  the tab strip, the icon strip, the side panel and the Projects panel too — and Pomade keeps the whole card
  inside the window. The next time that app's overlay opens from its shortcut, it opens where you left it,
  until you move it again. This is remembered per app and per workspace, on this machine. A button inside
  an app can open the overlay beside the side panel instead, wherever you left it last time.
- It grows with its content, up to 60% of the window's height below the title bar. Only one overlay is open at a time:
  pressing the same shortcut again just puts the cursor back in it; another app's shortcut replaces it.

## App shortcuts

An app can declare shortcuts, always **Cmd** plus an optional Ctrl, Alt and Shift and one letter or
digit. They work anywhere in the window — a terminal, an editor, Pomade's own screens, inside any app —
and the keystroke goes to the app, never to the terminal or editor in front. A shortcut either opens the
app's tab at a view or opens its overlay.

Pomade's own shortcuts win. When an app asks for a chord Pomade uses (Cmd+W, Cmd+S, …), that shortcut does
nothing; the install summary lists it under `Shortcut conflicts`. When two apps ask for the same chord,
the app whose id comes first alphabetically keeps it. Other keys you press inside an app that the app
does not handle — the Cmd chords you know — reach Pomade as usual, once.

## Notices from apps

An app, or its background service, can post a **notice**: it pops up as a notice toast in the bottom-right corner with the
app's name and the project it belongs to, and a click action — often "open this view". Every notice stays
in the **Notices** panel (the bell in the strip), and the bell counts the unread ones. The bell-slash on a
notice toast mutes that app; muted apps still list their notices. Notices posted while Pomade is closed wait
and show at the next start. Details, muting and deleting: see [Settings](settings.md) "Notices".

When Pomade installs or updates a bundled app at start, it posts a notice from **Pomade** — `2 apps
installed with Pomade`, with `Installed: Planner 0.1.0, Board 0.1.0` under it. If the app touches paths outside your workspace, a second notice, `Outside the workspace`,
names them (`Agents uses ~/.claude/, ~/.codex/, ~/.zshrc`), once — an update names only the paths it adds.

## Apps that keep running

Some apps do work a page cannot — read the agents' session stores, run scheduled jobs. They ship a
**background service**. Hover the app's strip icon: the tooltip adds a line, with a muted detail under it.

| Tooltip line | Meaning |
|---|---|
| `Background: running (with Pomade)` — `pid 4182` | the service runs while Pomade runs; it starts with Pomade and stops when you quit |
| `Background: running (always on)` — `connected to Pomade` or `not connected to Pomade` | a **login item** macOS starts when you log in and keeps running after you quit Pomade; it reconnects when Pomade is open |
| `Background: starting` | being started (an always-on service: `installing the login item`) |
| `Background: crashed — restarting` — `exited with code 1 · crash 2` | it exited; Pomade starts it again after a pause that grows to 30 s |
| `Background: stopped` — the reason | not running (a dev-server link has none) |

An amber dot on the icon shows while it is stopped or restarting. The service's output goes to
`app-logs/<app id>/backend.log` in Pomade's user data (`~/Library/Application Support/Pomade/` for the
installed Pomade, `pomade-dev/` beside it for a dev build), rotated at 2 MiB.

An always-on service is a macOS login item (`~/Library/LaunchAgents/io.github.dd-voronov.pomade.app.<id>.plist`).
Updating the app does not interrupt it, unless the app asks for that; removing the app removes the login item.
Quitting Pomade does not stop it.

## Commands apps provide

An app can ship command-line commands named after itself — `pomade-planner today`, `pomade-agents set-name`.
They appear the moment the app is installed or linked and disappear when it is removed.

- **In Pomade's terminals** they are always on the PATH.
- **In other terminals** (Terminal.app, iTerm) they are not, until you add Pomade's one line to your
  `~/.zprofile`: **Settings ▸ General ▸ Commands ▸ Add line** (or `pomade path install`). **Remove line**
  (or `pomade path remove`) takes it out and leaves the rest of the file as it was; `pomade path status`
  says whether it is there. Pomade never edits the file on its own. A new terminal picks the line up; an
  open one after `exec zsh -l`.
- **With Pomade closed** a command still works for what it can do on its own — `pomade-planner today`
  reads your planner's files directly. What needs Pomade says "Pomade not running".

Pomade's own terminals also tell programs where they are: `POMADE_PROJECT_ID` (the project the tab was
opened in; `__workspace__` for the Workspace project) and `POMADE_TAB_ID`, next to `POMADE_WORKSPACE`. An agent
writing a Runner job uses the project id.

## The pomade command

| Command | Does |
|---|---|
| `pomade apps install <folder>` | install or update an app |
| `pomade apps remove <id>` | remove an installed app |
| `pomade apps link <folder \| http://localhost:PORT>` | use an app from where it is built (a dev link) |
| `pomade apps unlink <id>` | drop a dev link |
| `pomade apps list` | installed apps and dev links, with versions |
| `pomade path install \| remove \| status` | add, remove or check the `~/.zprofile` PATH line |
| `pomade projects [--json]` | your workspace's projects — stable id, name, folder — with Pomade open or closed; `--json` for scripts |
| `pomade --help` | the list above |

`pomade projects` prints `Workspace: <path>`, then one row per project (`.` is the workspace folder).
`pomade-git`, the commit-and-push helper, is a separate command — see [Git](git.md).

## What an app can touch

An app can put text on your clipboard (a **Copy** button); it cannot read what you copied.

An app reads and writes files **inside your workspace** only, and only with the permissions in its
manifest (`Capabilities` in the install summary: reading files, writing files, opening tabs, git state,
project settings). It never sees Pomade's own `.pomade` folder. Files an app deletes go to the Trash, so
you can put them back from Finder. When an app changes a file that is open in an editor, the editor
tells you — **File changed since your edits** (with **Compare**) when you have unsaved changes,
**This file changed on disk outside Pomade.** (with **Reload** and **Dismiss**) when you do not; nothing
is overwritten without you.

Apps that read outside the workspace say so in the install summary and in a notice (above).
This is for you to see what an app touches: Pomade shows the permissions, it does not fence the
app in, and a program running as you can always do what you can do.

## Shortcuts

| Keys | Does |
|---|---|
| Cmd+Shift+B | show or hide the side panel |
| the app's chord (Cmd + …) | open the app's tab at a view, or its overlay, from anywhere |
| Esc | close an open overlay |
