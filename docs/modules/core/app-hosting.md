---
doc: docs/modules/core/app-hosting.md
audience: engineers, product
holds: how Pomade hosts apps — where apps come from (installed, bundled, dev-linked), the pomade command, app frames, state, routes, shortcuts, the overlay, theme; how it is built
kind: reference
---

# App hosting — app frames, their state, routes, shortcuts and the overlay

**Module:** `core` · **UI:** app tabs, app side panels, the app overlay, the "App unavailable" card · **Code:**
`src/main/host-api.ts`, `src/main/host-api-core.ts`, `src/main/app-registry.ts`,
`src/main/app-install-core.ts`, `src/main/bundled-apps.ts`, `src/main/bundled-apps-core.ts`,
`src/main/app-state.ts`, `src/main/theme.ts`, `src/main/app-icon-tint.ts`, `src/shared/app-manifest.ts`, `src/cli/`,
`bin/pomade`, `scripts/bundle-apps.mjs`, `src/renderer/modules/apps/` (`delegated-calls.ts` serves the calls that need the window), `src/renderer/modules/side-panels/app-panel-routes.ts`, `src/renderer/stores/apps-store.ts` ·
**unit:** `src/shared/app-manifest.unit.test.ts`, `src/main/host-api-core.unit.test.ts`, `src/main/app-install-core.unit.test.ts`, `src/main/bundled-apps-core.unit.test.ts` (the plan and the outside-the-workspace notice),
`src/main/app-icon-tint.unit.test.ts`, `src/cli/app-skills.unit.test.ts` (skills: the summary lines; install links nothing), `src/cli/pomade-path.unit.test.ts`, `src/cli/projects.unit.test.ts`,
`src/renderer/modules/apps/overlay-geometry.unit.test.ts` (the overlay's sizes, clamp and placement), `open-app.unit.test.ts`, `app-shortcuts.unit.test.ts`, `frame-bridge.unit.test.ts` ·
**e2e:** `app-hosting.spec.ts`, `app-bundled.spec.ts`, `app-kit-hello.spec.ts`, `app-state.spec.ts`, `app-routes.spec.ts`, `app-tab-project.spec.ts`,
`app-start-on-launch.spec.ts`, `app-shortcuts.spec.ts`, `app-frame-keys.spec.ts`, `app-overlay.spec.ts`, `app-overlay-open.spec.ts`, `app-overlay-geometry.spec.ts`,
`app-keyed-tabs.spec.ts`, `app-tab-set-route.spec.ts`, `app-panel-show.spec.ts`, `app-call-answered.spec.ts`, `app-clipboard.spec.ts` ·
**Contract:** [HOST-API](../../HOST-API.md) §1, §2, §4 "Own tab", §4 `panel`, §4 `overlay`, §5, §8 · internal surface: [contracts/host-api-frames](../../contracts/host-api-frames.md)

## What it does

Pomade hosts separately built apps ([PLATFORM](../../PLATFORM.md)). Each app runs in
`<iframe>` frames served from `pomade-app://<id>/` and talks to Pomade only through the Host
API. One app bundle serves every frame it gets; a frame learns where it lives from its
`welcome` — the **surface** (`tab`, `panel`, `overlay`), the strip icon it was opened for, the
**route** to render, and its **project**: a tab's own project (at first open, after a restart
and on a reload, whichever project is in front), the active project for a panel or overlay. A
keyed tab's frame also learns its **key** and **kind** ("Opening an app at a route"). A
frame's sandbox is `allow-scripts allow-same-origin allow-forms`; the app's own origin
(`pomade-app://<id>`) is what keeps it from Pomade's window and DOM. The `<iframe>` carries
`allow="clipboard-write"`: any app frame (tab, panel, overlay) may put text on the system clipboard
(`navigator.clipboard.writeText` in a user gesture); reading is denied, and no other powerful
feature is delegated. Like every pane a frame is hidden, never unmounted; it is replaced only when
the app's files change (below).

## Where apps come from

The registry (`app-registry.ts`) lists every app Pomade can host, from three sources; an id found
in several takes the highest:

1. `POMADE_DEV_APPS` — `;`-separated build folders or `http://localhost:PORT` URLs, for one run
   (tests); each entry's id is its manifest's.
2. **Dev links** — `<userData>/app-links.json`, written by `pomade apps link`: a build folder, or a
   loopback dev server (`http://localhost:PORT` or `127.0.0.1`; nothing else is accepted).
3. **Installed apps** — `<userData>/apps/<id>`, written by `pomade apps install` and by the bundled
   install at start.

`<userData>/apps/` (recursively) and `app-links.json` are watched; a burst of file events becomes
one rescan 150 ms later. An install, update, removal or (un)link takes effect without a restart:
main pushes the new list to the window, and an app whose manifest text, origin, icon colours or
files changed gets a new `revision`, which replaces its open frames, so they reload on the new
build. A dev link to a folder serves from that folder and shows a change at the next frame load
(files are served `no-store`).

An app is **available** when its `manifest.json` parses and validates, its `id` matches the install
folder's name or the link's id, and its entry file exists (a dev-server link: its manifest is
fetched within 2 s). Otherwise it is listed with the reason — "The manifest's id … does not match
…", "The entry file … is missing", "The dev server at … is not reachable (…)", "Invalid manifest:
…" — and every surface it had shows the **App unavailable** card: the reason, the app id, where it
is installed or linked from, the hint "Pomade is unaffected. Reinstall with `pomade apps install`",
and **Retry**, which rescans at once. An unavailable app has no strip icons and no shortcuts; its
tabs stay and come back when it does; its entry in the new-tab menu is disabled with the reason on
hover. A dev-server link has no local folder, so it has no backend, no commands and no skill
paths.

`pomade-app://<id>/<path>` serves the app's build folder, traversal-guarded, with the file's MIME
type and `cache-control: no-store`; the scheme is `standard` and `secure`, so each app has a real
origin of its own, cross-origin to Pomade's renderer.

### Installed apps

`pomade apps install` copies the build into a fresh `<userData>/apps/.builds/<id>-<stamp>/` and
swaps the link `<userData>/apps/<id>` to it in one rename, so a watching Pomade sees the old build
or the new one, never half of one. A process started from a build (a backend, the app's keeper)
keeps its files when the app is updated or removed. A build no longer current is retired and
deleted once no process has a file, a mapped library or a working directory in it (`lsof`, at
Pomade's start and after each install or removal; when `lsof` cannot be read nothing is deleted).
An install leaves the app's key and state in place; a removal deletes the key and records the
version removed in `<userData>/app-removals.json`.

### Bundled apps

A packaged Pomade carries app builds in `Contents/Resources/bundled-apps/<id>/` (outside the asar,
so backends and commands run from real files). `bundled-apps.json` pins the app repos and tags the
release carries; `npm run dist:mac` runs `scripts/bundle-apps.mjs`, which clones each, builds it,
checks each folder's manifest id and fails the packaging on any miss. At start, before the
registry's first scan, `installBundledApps` plans one step per bundled app
(`planBundledInstall`):

| State | Step |
|---|---|
| removed by the user at this build's version or a newer one | not put back |
| not installed | installed |
| installed older, or with no readable version | updated |
| installed at the same or a newer version (an install by hand) | kept |

An install is the one `pomade apps install` does (a fresh build folder, the app's key, the removal
record cleared); the registry then links the app's commands, starts its backend and loads its
launch panel like for any install. Apps outside the bundle are left alone. One notice from source
`pomade` lists what was installed or updated ("2 apps installed with Pomade"; body "Installed:
Planner 0.1.0, Board 0.1.0"), and only when something was. A failure is logged and start goes on.
A dev Pomade has no bundled apps (`POMADE_BUNDLED_APPS` names a folder for tests).

## The pomade command

`bin/pomade` runs `src/cli/pomade.ts` under the Mac's Node (type stripping; no build, no running
Pomade). It acts on files in the target Pomade's user data, which a running Pomade picks up through
its watchers; nothing in it talks to Pomade.

| Command | Does |
|---|---|
| `pomade apps install <build-folder>` | validates the manifest (every invalid field reported), requires the entry file and each skill's `SKILL.md`, prints the install summary, installs the build, issues the app's key, warns about a call cycle through the app, prints where each skill is and, when a dev link for the id exists, that it takes precedence |
| `pomade apps remove <id>` | removes the install, records the removal, revokes the key; "is not installed" otherwise |
| `pomade apps link <folder \| http://localhost:PORT>` | validates the manifest (read from the folder, or fetched from `<url>/manifest.json`), prints the summary, writes the link, issues the key |
| `pomade apps unlink <id>` | removes the dev link |
| `pomade apps list` | the user-data folder, installed apps (id, version, name; `[overridden by a dev link]`) and dev links |
| `pomade path install \| remove \| status` | the `~/.zprofile` PATH line ([app backends](./app-backends.md) "Commands on PATH") |
| `pomade projects [--json]` | the open workspace's projects, from `<workspace>/.pomade/workspace.json` ([app backends](./app-backends.md) "Commands on PATH") |

The install summary names what the manifest declares: Host API, entry, icon, capabilities, strip
icons with their action, tab kinds, symlink folders, the launch panel, shortcuts (and "Shortcut conflicts —
Pomade wins, these do nothing"), skills, events, backend mode, API offered, apps called, commands,
paths outside the workspace, and top-level keys this Pomade does not support yet.

The command targets the dev Pomade (user data `pomade-dev`, home `~/.pomade-dev`); `--stable`
targets the stable one and is used only on the owner's explicit word. `POMADE_USER_DATA` and
`POMADE_HOME` override both; a Pomade's terminals and its `pomade` launcher set them to that
Pomade's. A Pomade run from a source checkout puts the launcher in its command folder; a packaged
Pomade ships `pomade-git` there and no `pomade`.

## Theme and design tokens

An app looks like Pomade, not like the Mac's appearance. Its `welcome` carries Pomade's **theme**
(`"light"` — Pomade has its light theme only) and every frame, shown or hidden, hears
`theme.changed` when it changes. The theme has one source in Pomade, `src/main/theme.ts` (`pomadeTheme`, `setPomadeTheme`); a theme
setting would drive it, and under test `globalThis.__pomadeTheme` does. A socket client's `welcome`
carries it too. Apps get Pomade's design
tokens from `pomade-kit/tokens.css`, generated from `src/renderer/tokens.css` by
`scripts/kit-tokens.mjs` (a unit test fails while the pinned kit's copy differs), and the kit's
`followTheme(host)` puts the theme on the frame's root as `data-theme`, which the tokens key each
theme by. The kit's hello app uses both: on a dark Mac it stays light inside Pomade.

## App state

Every app has one machine-local key/value store, `<userData>/app-state/<id>/state.json`,
shared by all its frames. An app stores small things there that must outlive a frame — the
view selected per project, pins, the day of its last morning summary. `state.set` resolves once
the value is on disk; every other frame of the app then receives `state.changed` with the key
and the new value, so a panel follows what a tab stored without polling. Keys are strings of at most 200 characters; values are plain JSON
(at most 1 MiB and 64 levels deep each); `null` removes a key. Reads and writes of one app are
serialised, and writes are atomic (temp file and rename). A state file that is not a JSON object is
an error, never silently replaced. The store survives app updates, Pomade restarts
and removing the app; each app sees only its own.

## Opening an app at a route

An app can open its own tab: "Open in full tab" from its panel, a chooser that opens a
project's board. It names a route and, optionally, a project; Pomade switches to that project
and focuses the tab. If one of the app's strip icons opens a tab on exactly that route, that
icon's tab is used — the same tab a click on the icon gives. Any other route goes to the app's
one plain tab in the project (the tab the new-tab menu opens): it opens at the route, or, when
it is already open, it is navigated there in place — the app keeps running and is told the new
route (`route.changed`). Choosing the app from the new-tab menu focuses that plain tab when the
project has one, else opens it. A notice's click action (E-032) and an app shortcut with action
`tab` open an app at a route through the same path; neither carries a key, so they reach the plain
tab or an icon's tab, never a keyed one.

**The tab's route.** Every app tab records the route it renders (`AppTab.route`; absent = the
icon's route, or `""` for the plain tab) and keeps it across restarts. The recorded route moves when
Pomade navigates the tab and when the app reports that it navigated by itself (`tabs.setRoute`,
tab frames only): then Pomade records it, answers `host.info` with it and opens a reload there, and
sends no `route.changed` back. A later open at any other route — the one Pomade last sent included —
navigates the tab again. A click on an icon's strip icon, like the new-tab menu, names no route and
only focuses the open tab, wherever the app moved it.

**Keyed tabs.** `tabs.openApp` with a `key` opens a keyed tab: one per (app, key, project), whatever
its route, so an app opens as many as it needs (a run's output beside its own tab). A new one opens
right of the active tab; an open one is focused, navigated when its route differs and retitled when
a `title` is given. The tab has no strip icon and is never found by route or by icon. Its title is
the app's `title` as given, else its **kind's** title, else the app's name (`kind` names an entry of
the manifest's `tabKinds`, which also gives the tab its image, else the app's icon). The frame
learns `key` and `kind` in its `welcome` and from `host.info`, and may retitle (`tabs.setTitle`) or
close (`tabs.close`) its own tab; the answer to `tabs.close` is posted before the tab goes. A title
the user gave (**Rename tab**) always wins over the app's; a title the app gave no longer follows the
manifest. A title the app gives marks the tab app-titled even when it equals the title the tab already
shows (`tabs.setTitle`, or `tabs.openApp` on an open keyed tab with a `title`), so a later manifest change of
the kind's title leaves that tab alone, while a tab the app never titled follows the manifest. A manifest that drops a kind keeps its tabs, with the app's icon and (unless the app or the
user titled them) the app's name. Key, kind, route and title persist across restarts.

## Showing the app's own side panel

An app brings its own side panel forward with `panel.show { icon?, route? }`, from any of its frames
— tab, overlay or panel, shown or hidden — and from none other: a backend or a command is refused
(`capability-denied`), and it needs no capability. It does what a click on the app's strip icon does,
minus the tab: the active project's side-panel selection loads first (so it cannot overwrite this
one), the panel of that icon is selected, and a collapsed side panel expands. `icon` names one of the
app's strip icons with action `panel` or `both` (default the first such icon); main resolves it against
the app's manifest (`panelShowIcon`) and answers `not-found` when there is none, so the window only
gets a valid icon id. Keyboard focus is not moved: an open overlay keeps the keyboard and stays open,
a call from a tab leaves focus in the tab.

A `route` is the panel frame's route afterwards. It is recorded per strip key
(`app:<appId>/<icon>`; one panel frame per icon, not per project) in `useAppPanelRoutes`, before the
panel is selected: a frame the call mounts opens at it (`AppPane`'s request `route` overrides the
icon's `panelRoute`), a mounted one is navigated and hears `route.changed` when the route differs from
the one Pomade last sent it. The route lasts for the run; after a restart the panel opens at its icon's
`panelRoute` (else `route`). Without a `route` the panel's route is left as it is. Contract: [HOST-API](../../HOST-API.md)
§4 `panel`; [host-api-frames](../../contracts/host-api-frames.md) "Delegated calls". Spec:
`app-panel-show.spec.ts`.

## Calls are always answered

Every call a live frame makes is answered exactly once (`frame-bridge.ts`), however long main or
the window takes, whether the frame was just shown or hidden. A frame that sends `hello` again (a
reload) starts a new handshake; the calls still in flight from the old document are answered
`not-ready` before the new `welcome`, so a late answer never meets the id of a call the reloaded
document made, and a call whose renderer-side work had not begun is not done. A failure inside the
bridge is answered `io-error`; a handshake that throws is logged and leaves the frame without a
session (its calls answer `not-ready`) without stalling the ones after it. A frame that is gone
(its tab closed, its app updated) is answered nothing. Contract: [host-api-frames](../../contracts/host-api-frames.md) "Frame sessions and the gate".

## Start on launch

An app's panel normally loads the first time its icon is shown. An app that declares
`startOnLaunch` gets its launch panel — its first strip icon that fills the panel — loaded,
hidden, when Pomade starts (or as soon as the app is installed or linked). It can then compute
and set its badge, and do its first-run-of-the-day work, before the user opens it. Clicking the
icon shows that same running frame; nothing reloads. The install summary names the panel that
starts.

## Keys and app shortcuts

Pomade's shortcuts keep working while an app frame has focus, and each runs once. A menu
chord (Cmd+W, Cmd+B, …) the frame leaves unhandled goes straight to Pomade's menu; Cmd+Shift+B
never reaches the frame at all (Pomade takes it first). Every other Cmd/Ctrl chord the app did not
handle it forwards (never a modifier key alone, so an app cannot inject plain keystrokes), and
Pomade treats it as pressed in Pomade — the forwarded copy of a menu chord is dropped, so nothing
runs twice. An app can also declare
Pomade-wide shortcuts in its manifest — a chord of Cmd plus optional Ctrl, Alt, Shift and one
letter or digit. Such a shortcut works from anywhere: a terminal, an editor, Pomade's own UI, or
inside any app's frame; the keystroke goes to the app's action and never reaches the focused
pane; holding the chord does not repeat the action. A shortcut with action `tab` opens or focuses the app's tab at its route, like the app
opening its own tab; one with action `overlay` opens the app's overlay (below). Chords match the physical key, so they work with any keyboard layout.

Pomade's own chords win. A shortcut on a chord Pomade uses (Cmd+W, Cmd+S, the editor's
formatting keys, …) does nothing and is listed under "Shortcut conflicts" in the install summary;
when two apps declare the same chord, the app whose id sorts first keeps it.

## The overlay

An app's overlay shortcut — a quick-add form, say — opens a small frame of the app, 420 wide and
220 high to start, centred over whatever tab is active, under the same dimming scrim as Pomade's
in-pane dialogs. The scrim dims the pane area only; the tab strip, the Projects panel and the side
column stay undimmed, and the card is fixed in the window above all of them. In a narrow window the card is narrower than 420 (it keeps its 16 px margins). It works over a terminal, an editor or another app,
and the app does not need to have been opened. The frame takes the keyboard right away, so the user
can type at once; an input the app focused before its frame finished loading keeps focus (`focusAppFrame`
in `AppPane.tsx` re-focuses through the frame's window when the frame already has focus, which leaves
the app's focused element alone). Escape (pressed in Pomade, or forwarded by the frame), a click on the dimmed area, or the app itself (`overlay.close`, after saving) closes it,
and the keyboard goes back exactly where it was — the terminal prompt, the editor caret, the other
app's field. Pressing the shortcut again while it is open just puts the focus back in it; another app's overlay
shortcut, or an `overlay.open`, replaces the open overlay and keeps the first open's focus target.
An overlay whose app becomes unavailable closes. Each open
starts a fresh frame, so an overlay keeps what it must remember in the app state.

The user moves it. A thin handle with a grip sits above the frame; dragging it moves the card
anywhere in the window below the title bar — over the pane area, the tab strip, the side panel, the
icon strip and the Projects panel — and Pomade keeps the whole card inside that area with a 16 px
margin (`overlay-geometry.ts`; the title bar stays the window's drag region). Where the user left it
is where that app's next overlay opens, whether it comes from the shortcut or from `overlay.open`
without an anchor or with `"center"`, until it is moved again; an open with `anchor: "panel"` ignores
the spot (below). The spot is window coordinates (`OverlayPosition`), clamped into the window as it is
at that open (a smaller window, another display); it is kept per
app, per workspace, on this machine (`overlayPositions` in `.pomade/state/workspace-ui.json`, a gitignored workspace file), and across restarts. The
frame keeps the keyboard while the card is dragged, and lets the pointer through while the drag
lasts so a release over the frame is never lost.

The app sizes it. A form that grows with its text asks for a height — in `overlay.open`, or with
`overlay.resize` from the overlay frame — and Pomade gives it between 120 px and 60% of the height of
the window below the title bar (never so tall that the card leaves its margins); the width stays 420.
The card grows downward from where it is and moves up only as far as needed to stay whole inside the
window.

The app can also open the same overlay from its own tab or panel — the Planner panel's **+**
opens its quick-add form over the active tab (`overlay.open`, at a route the app names). Only a
frame the user can see may do it: a tab in the background or a panel that is not shown is
refused, so an app never pops a form over the user from behind. The call may name an anchor:
`"panel"` names a place — the card opens beside the side panel (the pane area's top corner next to it;
the middle of the pane area when the side panel is collapsed), every time, whatever spot the user left
the app's overlay at; `"center"` (the default) names none, so the card opens at the remembered spot,
else in the middle of the pane area. Closing returns the keyboard to the frame that called `overlay.open`,
even when the keyboard was in another frame of the same app (the Planner tab) when the call came,
and `pomade-kit` puts it back on the very button that was pressed.

## Agent skills an app ships

An app can ship agent skills — folders with a `SKILL.md`, kept in the app's repo next to the
format they describe (Runner's job format, Agents' session format) and shipped in its build.
Pomade does not give them to agents. Installing the app checks each skill folder has its
`SKILL.md` and reports where the skill is in the installed build, with one plain line on how to
use it: *"Skill pomade-runner-jobs is at …/apps/pomade-runner/skills/pomade-runner-jobs. To give
it to an agent, copy or link this folder into the agent's skills folder."* A dev link to a build
folder reports the same, at the linked folder. Assigning skills to agents belongs to the Agents
app.

## Paths outside the workspace

An app that reads or writes outside the workspace — Agents reads the agents' session stores and
writes shell aliases — says so in its manifest (`outsideWorkspace`: `~/.claude/`, `~/.codex/`,
`~/.zshrc`). Pomade shows the list once, when the app is installed: `pomade apps install` prints
"Outside the workspace: …" in its summary, and a bundled app installed at Pomade's start gets a
notice "Outside the workspace — Agents uses ~/.claude/, ~/.codex/, ~/.zshrc" next to the install
notice. A bundled update that adds paths shows only the new ones ("now also uses"). The list is for
people to see what an app touches; Pomade does not fence the app in.

## Boundaries worth knowing

- Installing, linking and removing apps is a command-line act (`pomade apps …`); Pomade's window has
  no screen for it. A packaged Pomade ships no `pomade` command, so there it runs only from a source
  checkout (aimed at that Pomade's user data with `--stable`). Tickets: T-254.
- Which apps a packaged Pomade has is its bundle plus what was installed by hand; a bundled app the
  user removed stays removed until a release carries a newer build.

Tickets: E-027, E-045, T-236, T-237, T-244, T-246, T-247, T-268, T-269, T-270, T-271, T-295, T-325, T-326.
