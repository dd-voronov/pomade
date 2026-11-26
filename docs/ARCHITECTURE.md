---
doc: docs/ARCHITECTURE.md
audience: engineers
holds: the map of Pomade — what it is, the stack, the process model, the repo layout, git-core, the platform and apps, the data model and persistence, key flows, the design language
kind: reference
---

# Pomade — Architecture

**Pomade** (Project Management + Agentic Development Environment) is a personal macOS desktop app
and a **platform for separately built apps** for one user. It is the cockpit for running AI agents
(Claude Code, Codex, and specialized instances) across many projects inside one workspace, with
first-class project switching, persistent terminals, a doc editor and git.

Not a general IDE. No extension marketplace, no LSP, no debugger, no Windows/mobile. Terminals and
agents are *hosted*, not re-implemented.

This page is the map. Interfaces are in [CONTRACTS](./CONTRACTS.md), the index of the sub-docs in `docs/contracts/`; how each
feature behaves and is built is in `docs/modules/`; what apps code against is [HOST-API](./HOST-API.md).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron 44** | First-class `node-pty`; persistent PTYs are the core feature |
| Build | **electron-vite 5** (Vite 5 + TS 5.9) | Main / preload / renderer split, fast HMR |
| UI | **React 18 + TypeScript (strict)** | |
| State | **Zustand 5** | Simple per-slice stores |
| Terminal | **node-pty** (main) + **@xterm/xterm 5.5** (renderer) | What VS Code uses |
| Raw editor | **CodeMirror 6** | Any text format, highlighting by extension |
| Rendered MD editor | **Milkdown 7** (ProseMirror) | Markdown-native WYSIWYG; canonicalizes on save |
| Live MD editor | **CodeMirror 6** decorations (`cm-live.ts`) | Rendered-looking editing over the raw source; only typed bytes change the file |
| Git | system `git` via `execFile` | Zero deps, always the user's git |
| Shared logic | **pomade-kit** (git dependency pinned to a tag, bundled) | Host API protocol and manifest rules, event-bus core, frontmatter, terminal scanners, the keeper and its client — one implementation shared with the apps |
| Tests | **Vitest 4** (unit) · **Playwright** (`_electron`, e2e) | Pure logic in unit tests; acceptance against the real app |
| Packaging | **electron-builder** (mac dmg/zip) | The stable Pomade installs from the dmg; development runs from source with its own user data |

## Process model

```
┌─ Main process ──────────────────────────────────────────────┐
│ windows · config-store (.pomade JSON + app.json, atomic,    │
│   debounced) · the app menu and main-taken shortcuts        │
│ pty-manager (node-pty, keyed by termId — lives for the app's│
│   life; killed only by its tab closing, a workspace switch, │
│   a project deletion, or quit) · session-watcher            │
│ fs-service (tree, read/write, the outside-workspace doors,  │
│   native recursive fs.watch — one descriptor per root) ·    │
│   name index · frontmatter index · doc-watch (open docs)    │
│ agent-service (roster, session scan) · agents-live ·        │
│   agent-sessions (the agents app's sessions, via the broker)│
│ git: git-state (discovery + status) · git-service (diffs,   │
│   deleted files) · git-history · git-ops (preview → run) ·  │
│   git-operator · git-branches · git-runs — logic in         │
│   src/git-core/ (no Electron, shared with pomade-git)       │
│ recovery-store (unsaved edits, drafts) · local-history      │
│ app-registry · host-api (+ host-api-data: the gate, every   │
│   method) · host-socket (unix socket) · app-broker ·        │
│   app-backends · app-launchd · app-commands · bundled-apps  │
│ event-bus · notice-queue · attached-terminals · theme       │
└──────── typed IPC: window.pomade (contextBridge) ───────────┘
┌─ Renderer (React) ──────────────────────────────────────────┐
│ Projects panel (workspace → groups → projects) · icon strip + side │
│   panel (Files, Git, Notices, app panels) · TabStrip ·      │
│   PaneHost                                                  │
│ Panes: EditorPane (raw | live | rendered | table) ·         │
│   TerminalPane (xterm) · AttachedTerminalPane · AppPane     │
│   (iframe on pomade-app://<id>/, frame bridge) · CommitPane │
│   · ComparePane · ConflictPane · BranchPane                 │
│ Overlays: quick peek, deleted-file view, app overlay,       │
│   modals (project, group, settings, agent mapping, Session history) │
└─────────────────────────────────────────────────────────────┘
```

### The one invariant that makes Pomade work

**Panes are hidden, never unmounted** — on project switch, tab switch and cross-project moves, app
frames included. `PaneHost` renders the panes of *all* projects keyed by tab id; only the active
project's active tab is visible (`display: none` for the rest), so xterm and editor instances and
their scrollback survive. PTYs live in main and are untouched by what the renderer shows: switching
projects is flipping `activeProjectId`.

**App restart.** PTY processes are gone; tab metadata is restored from `.pomade/state/`. When a
project is opened, its terminals that were live at quit are revived: a plain terminal gets a fresh
shell at its last directory with its scrollback replayed above a "session restored" divider and its
last command pre-typed (not run); an agent with a bound session id is resumed (`--resume <id>`). An
agent without a session, or one the disk cannot back, shows a dead pane with **Relaunch**. A project
never opened keeps its saved state byte-identical.

## Repo layout

```
src/
├── shared/                  # pure, cross-process (no Electron, no React)
│   ├── types.ts             # every cross-process type (contracts/types.md)
│   ├── ipc-api.ts           # CH / EV channel names, PomadeApi, ChannelMap
│   ├── app-manifest.ts      # Pomade's manifest wrapper over pomade-kit, user-data app layout, POMADE_SHORTCUTS
│   ├── paths.ts             # normalizeWorkspaceRelPath, classifyScope
│   ├── ignore-names.ts      # walk ignore lists (watcher, indexes, repo discovery)
│   ├── settle.ts            # a watch's settle: re-check after a trigger until nothing new
│   ├── change-batch.ts      # a watcher's batch of changed paths: quiet window with a maximum wait
│   ├── recovery.ts · local-history.ts · doc-history.ts · doc-version.ts · compare.ts · text-change.ts
│   │                        # document models: recovery, snapshots, Document history rows, version tabs, comparisons
│   └── git-state.ts · git-history.ts · git-ops.ts · git-conflict.ts · git-branches.ts · git-runs.ts · git-glossary.ts
│                            # git models: snapshot, history, operations, conflicts, branches, run log, wording
├── main/
│   ├── index.ts             # app entry: user data, menu, service registration, start-up, quit pipeline
│   ├── ipc.ts               # defineHandler (handlers typed from PomadeApi)
│   ├── windows.ts · window-shortcuts.ts   # broadcast helpers; chords taken before the page
│   ├── config-store.ts      # .pomade/{workspace,settings,agents}.json, state/*.json, app.json; workspace switch hooks
│   ├── app-settings-files.ts # app settings: preferences / view state split, the build flavor (pure)
│   ├── atomic-write.ts · ws-path.ts · test-tuning.ts   # atomic writer; the workspace-escape guard; tuned test intervals
│   ├── fs-service.ts        # fs.* IPC registration over the fs subsystem
│   ├── fs-shared.ts · fs-tree.ts · fs-ops.ts · fs-watch.ts · watch-scope.ts
│   │                        # path guards + bounded walk; tree walk; copy/move/trash + outside doors; watchers; a watch's scope reading
│   ├── doc-watch.ts         # the open-doc watcher (rule 8)
│   ├── name-index.ts · name-index-rank.ts · path-probe.ts · fm-index.ts
│   │                        # basename/stem index and its ranking; path probe; frontmatter index
│   ├── recovery-store.ts    # recovery copies and discarded drafts (user data)
│   ├── local-history.ts · local-history-store.ts · local-history-scheduler.ts   # file snapshots (Apps/Pomade/local-history)
│   ├── pty-manager.ts       # PTYs, zsh shim markers, busy/cwd/exec/attention, scrollback snapshots
│   ├── session-watcher.ts · codex-rollout.ts   # prompt-gated session attribution; a Codex rollout's identity
│   ├── agent-service.ts · agent-check-core.ts  # roster, session scan, command check
│   ├── agents-live.ts · agent-sessions.ts      # agents live in a folder; the agents app's sessions
│   ├── git-state.ts · git-service.ts · git-history.ts   # repo state; diffs and deleted files; history reads
│   ├── git-ops.ts · git-run.ts · git-operator.ts · git-branches.ts · git-runs.ts
│   │                        # the operation entry; rails; staging/sync/rebase/conflicts; branches/worktrees; pomade-git runs
│   ├── app-registry.ts · app-icon-tint.ts      # hostable apps, pomade-app:// scheme; icon tint check
│   ├── app-install-core.ts · bundled-apps.ts · bundled-apps-core.ts   # build folders, retired builds, removals; bundled installs
│   ├── host-api.ts · host-api-core.ts · host-api-data.ts · host-api-data-core.ts · host-api-fs.ts
│   │                        # Host API sessions, gate, methods; pure decisions; data methods; fs error mapping
│   ├── app-state.ts · theme.ts                 # apps' state files; the theme apps are told
│   ├── host-socket.ts · app-keys.ts · app-broker.ts   # the socket; per-app keys; app-to-app calls
│   ├── app-backends.ts · app-launchd.ts · app-launchd-core.ts   # with-Pomade and always-on backends
│   ├── app-commands.ts · app-commands-core.ts · shell-path-line.ts   # command folder, home, host record, PATH line
│   ├── owner-paths.ts       # the Owner's real places outside the workspace; a test run refuses them
│   ├── event-bus.ts · notice-queue.ts · notice-queue-core.ts   # the bus; the closed-Pomade notice queue
│   └── attached-terminals.ts   # attached tabs following keeper sessions
├── git-core/                # git logic with no Electron, shared by main and the pomade-git command:
│                            #   repo-state, rails, lock, commit, sync, agent-processes, run-log, command, pomade-git (entry)
├── cli/                     # run by bin/pomade under Node type stripping:
│   ├── pomade.ts            #   `pomade apps … / path … / projects`
│   ├── app-skills.ts        #   app-shipped skills: SKILL.md check, install summary lines
│   └── projects.ts          #   `pomade projects`, Pomade running or closed
├── preload/index.ts         # exposes window.pomade (invoke / makeEvent / makeTermEvent helpers)
└── renderer/
    ├── App.tsx · main.tsx · tokens.css · global.css   # shell, boot, design tokens
    ├── layout/              # PaneHost, TabStrip (+ tab and strip menus, tab details), ColumnDivider, QuitConfirm, WorkspacePicker
    ├── panes/registry.ts    # pane component per tab kind
    ├── components/          # shared primitives: ContextMenu, Popover, Modal, DialogShell, ConfirmDialog, CheckToggle, Tooltip, ScopeMark, fields
    ├── hooks/ · lib/ · dnd.ts · font-catalog.ts · dev/   # clamp hook, toasts, close guard; IPC error text; tab-drag marker; fonts
    ├── stores/              # shared zustand stores (contracts/stores.md)
    └── modules/
        ├── Projects panel/         # groups and projects, icons, rail, project/group modals
        ├── side-panels/     # icon strip + panel slot, strip model, built-in panels
        ├── filetree/        # the tree, mounts, file management, go-to-path, symlink popover
        ├── editor/          # EditorPane, raw / live / rendered / CSV engines, find, links, recovery, save pipeline
        ├── terminal/        # TerminalPane, attached panes, "+" menu, links, Session history, unbound popover
        ├── git/             # tree marks, Git panel, commit / compare / conflict / branch tabs, Document history, operations
        ├── apps/            # AppPane, frame bridge, delegated calls, overlays, shortcuts, platform events, socket bridge
        ├── agents/          # agent-tab info and Host API calls
        ├── notices/         # notices panel, notice toasts, actions
        └── settings/        # the Settings modal
bin/pomade · bin/pomade-git  # Node entry points (CLI; the built pomade-git command)
scripts/                     # smoke-scale, bundle-apps, kit-tokens and other build/check scripts
e2e/                         # Playwright specs (e2e/<feature>.spec.ts) + fixtures (workspace, apps, timing)
```

**`pomade-kit`** (`github:dd-voronov/pomade-kit#<tag>`, a devDependency) is bundled by
electron-vite — with its own dependencies (`js-yaml`, `@xterm/headless` and its addons) — into
main, preload and renderer, so the packaged app needs no `node_modules` for it:
`out/main/index.js` requires only `electron`, `node-pty` and Node built-ins; `bin/pomade` loads it
from `node_modules` under Node. It is the source of the Host API protocol (types,
`HOST_API_VERSION`, `METHOD_CAPABILITY`, `parseAppMessage`, `WORKSPACE_PROJECT_ID`, the
workspace-path rule, manifest validation, `resolveFrameTarget`, `readFrontmatter`), of the editor's
frontmatter logic (`splitFrontmatter` and the properties panel's block core), of the terminal output
scanners (`MarkerScanner`, `AttentionScanner`, `AgentStateScanner`), of the event-bus core, and of
the attach protocol and its client (`followSession`; the keeper itself, `pomade-kit/keeper`, runs in
apps' backends and the e2e test keeper, never in Pomade). Pomade imports `pomade-kit/protocol`,
`/frontmatter`, `/scanners` and `/node` directly and keeps no copies. Bumping the pin is a normal
change with the full gate.

## git-core and the `pomade-git` command

`src/git-core/` holds the git logic — discovery, a repo's state, the rails, the repo lock, commit,
catching up with the upstream — with no Electron dependency. Main uses it for the Git panel;
electron-vite also builds it into `out/main/pomade-git.js`, the `pomade-git` command, which runs
with Pomade closed (from Runner, a terminal, an agent). Both take the same per-repo lock (a file in
the repo's git directory). The command appends each result to a run log in Pomade's user data;
Pomade watches it for the repo rows and the badge. Details: `docs/modules/git/pomade-git.md`.

## Platform and apps

Pomade hosts apps built and released in their own repos (`pomade-planner`, `pomade-runner`,
`pomade-agents`). The platform/app split, the rules and the shared building blocks: [PLATFORM](./PLATFORM.md).
The contract apps code against: [HOST-API](./HOST-API.md).

- **UI.** An app's UI runs in an `<iframe>` served from `pomade-app://<id>/` — in a tab, a side
  panel or a small overlay — and talks to Pomade only through the Host API over `postMessage`.
- **One gate.** Main validates every call against the app's manifest capabilities and the
  workspace path rule; `<workspace>/.pomade/` is closed to apps. Calls on state the renderer owns
  (tabs, groups and projects, the git-state snapshot, notices, agent tabs) are validated in main and
  then served by the renderer.
- **Backends and commands.** An app may ship a backend — a Node process run on Pomade's own
  Electron binary — that lives with Pomade or stays on as a per-user launchd agent, and commands
  linked into Pomade's command folder. Both reach the same Host API over a unix socket in user data,
  identified by a per-app key.
- **Attached terminals.** An app's backend keeps terminal sessions in a keeper (`pomade-kit/keeper`)
  at a fixed per-app socket under user data. Attached tabs connect there and follow a session by
  reference `{ app, session }` — a serialized screen on attach, live output, input, resize — across
  Pomade restarts and keeper updates; the session runs on when the tab closes or Pomade quits.
- **Broker.** An app offers an API and calls other apps' APIs through Pomade, which answers
  "absent" or "not responding" when the target cannot serve. Pomade itself reads app APIs the same
  way (the roster, sessions, Runner's jobs) and shows nothing when an app does not answer.
- **Agent tabs.** Apps list the agent tabs (bound session, title, live state read from the agent's
  output), name or mark a session unnamed, and focus, launch or resume agents in tabs. The "+" menu's
  roster and the Session history button come from the agents app when it is installed, else from Pomade's own
  scan and Session history dialog. Every terminal knows its tab and project (`POMADE_TAB_ID`, `POMADE_PROJECT_ID`).
- **Events and notices.** Pomade publishes platform events (ready, projects, agent tabs changing and
  ending), apps publish their own, and every subscriber is a connection — a frame or a socket
  client. Apps post notices with a click action; notices posted while Pomade is closed wait in a
  queue folder.
- **Install.** `bin/pomade apps install` copies a build into its own build folder and points
  `<userData>/apps/<id>` at it (or dev-links it); the app appears without a restart. A release
  carries bundled apps (`bundled-apps.json`), which a packaged Pomade installs at start. Pomade works
  with zero apps.

## Data model

- **Workspace** — the folder picked on first launch, remembered in `app.json`; one at a time.
- **Group** — a visual bundle of projects, app-only (no folder); nests up to 4 deep (`parentId`).
  `{ id, name, description?, image?, icon?, parentId?, order, highlighted?, color? }`.
- **Project** — `{ id, name, groupId?, rootPath (workspace-relative), area?, description?, image?,
  icon?, visibleAgents, order, highlighted?, color?, appSettings? }`; `appSettings` holds hosted apps'
  per-project settings by app id. Deleting a project or group touches only `.pomade`, never files.
- **Workspace project** (`__workspace__`) — fixed at the top of the Projects panel, rooted at the
  workspace root, every agent visible; the project socket clients and the notice queue belong to.
- **Agent** — `{ id, name, command, kind: 'claude' | 'codex' | 'custom', configDir?, resolved, modes }`.
  Roster = the agents app's `roster.list` when it answers; else built-ins `claude` and `codex`
  (always) plus one agent per `<workspace>/Agents/<name>/` holding a `CLAUDE.md` (excluding
  `_shared` and any name containing "template"). Commands are checked in one interactive login zsh
  per roster build (first word, `whence`; only a definite "not found" is unresolved); an unresolved
  agent gets a warning badge and a mapping dialog whose override lands in `.pomade/agents.json`.
- **Tab** — per project: `doc` (path — absolute when outside the workspace —, mode raw | rendered |
  live, dirty; a version tab holds an earlier version) · `terminal` / `agent` (termId, cwd, status,
  agent and session facts) · `app` (app id, strip icon or route) · `commit` · `compare` · `conflict` ·
  `branch` · `attached` (a session reference). Full shapes: `docs/contracts/types.md`.

### Persistence layout

```
<workspace>/.pomade/
├── workspace.json        # groups, projects, file-tree settings, identity — git-synced
├── settings.json         # app settings: the preferences — git-synced
├── agents.json           # command overrides / hidden agents — git-synced
├── assets/<id>.<ext>     # images copied in from outside the workspace
├── state/                # GITIGNORED (machine-local)
│   ├── <projectId>.json  # open tabs, active tab, reopen stack, mounts, side panel
│   ├── workspace-ui.json # collapsed groups, last active project, overlay positions
│   ├── view.json         # app settings: the view state — column widths and collapses, folds, view switches
│   └── scrollback/<tabId>  # a plain terminal's scrollback snapshot
└── .gitignore            # written by Pomade: "state/"

<workspace>/Apps/Pomade/
├── local-history/        # file snapshots (blobs/ + paths/, 7 days, 256 MB cap; its own .gitignore "*";
│                         #   skipped by path by watchers, indexes and the tree — shown only with ignored items)
└── dev/local-history/    # the same, for a dev build
```

Writes are atomic (tmp + rename) and debounced 500 ms, flushed on quit and workspace switch;
`settings.json` and `view.json` are written at once, one file per change, never the other.
Activating a workspace creates `.pomade/` and the active build's local-history store folder (before
the tree and the watchers start). Switching workspace switches the settings and the local-history store; a workspace without
settings gets the defaults. Local-history records are keyed by workspace-relative path, so a copy of
the workspace at another path keeps its versions.

Machine-local state lives in Pomade's user data (`~/Library/Application Support/Pomade`; an
unpackaged Pomade uses `pomade-dev`, so dev and stable never share it):

```
<userData>/
├── app.json              # the workspace root
├── recovery/buffers/ · recovery/drafts/   # unsaved-edit copies; discarded drafts (7 days)
├── git/runs.jsonl        # the pomade-git run log
├── zsh-integration/      # the generated zsh shim
├── apps/<id>             # installed app → its current build in apps/.builds/
├── apps/.builds/         # build folders; an earlier one stays while a process runs from it
├── app-links.json        # dev links
├── app-removals.json     # apps the user removed (a bundled app is not put back)
├── app-state/<id>/       # each app's own state (its keeper's records too)
├── app-keys/<id>         # per-app socket key
├── app-logs/<id>/        # backend logs
├── run/pomade.sock       # the Host API socket
├── run/keepers/<id>.sock # each app's keeper
├── run/backend-<id>.pid · run/always-on-<id>.stamp   # backend bookkeeping
└── notices/queue/        # notices posted while Pomade was closed
```

Pomade's home — the command folder `bin/`, the `workspace` pointer and `host.json` — is `~/.pomade`
(`~/.pomade-dev` for an unpackaged Pomade); worktrees default to `<home>/worktrees`.

What may live outside the workspace, and why: [PLATFORM](PLATFORM.md) rule 10 and "Storage outside
the workspace".

## Key flows

- **"+" button** (tab strip): *New terminal* (interactive login zsh, cwd = project root) · one entry
  per **visible** agent of the project → a PTY whose shell submits the agent's command once it is up
  (aliases resolve because the shell is interactive login zsh) · hosted apps.
- **Bulk tab actions** (tab-strip menu, current project): close all docs · close saved docs · stop
  all plain terminals · exit all agents (sends `/exit`, then reaps the shell and closes the tab).
- **Session history**: per project and agent, the provider's own store — claude-family
  `<configDir>/projects/<encoded-cwd>/*.jsonl` (built-in claude: `CLAUDE_CONFIG_DIR`, else
  `~/.claude`), codex `<CODEX_HOME or ~/.codex>/sessions/**` filtered by cwd. **Resume** starts an
  agent tab with `--resume <id>` (codex `resume <id>`). Gone from disk ⇒ gone from the list.
- **Quick peek** (`Cmd+Shift+G`): side-by-side merge view — saved vs unsaved for any doc, plus HEAD
  vs working and previous commit vs HEAD inside a repo.
- **Document history** (editor header, tree *Show history*, `Cmd+Shift+H`): a panel in the doc pane
  listing the current version (unsaved edits and the saved file), discarded drafts and git discards,
  local versions and the commits that touched the file (renames followed). A row opens a comparison tab or a version
  tab; Restore puts a version in as one undoable edit.
- **Git panel** (strip): repos in scope with uncommitted / unpushed / behind and the remote;
  Changes with staging; Not pushed; In progress (worktrees and branches main lacks, with live agents
  and sessions); History; operations through preview → run with safety rails; conflicts in a
  conflict tab.
- **Disk is truth** (rule 8): open docs are watched in every project; a file changed on disk while
  it has unsaved edits shows *"File changed since your edits"* with Compare, and nothing is
  overwritten silently. Unsaved buffers are copied to user data ~2 s after typing stops and restored
  after a crash; discarded edits are kept 7 days.
- **Create project**: modal (name, group, area, description, icon) and an explicit choice between
  an existing folder and a template (a workspace folder copied under a parent folder, default
  `Projects` when it exists); optional "Track with git".

## Design language

VS Code-inspired ergonomics (Projects panel → icon strip → side panel → tabbed main area), **light theme, "diamond"
accent** — icy blue. Tokens are CSS variables with one source, `src/renderer/tokens.css` (the kit's
`tokens.css` is generated from it):

- `--accent: #4FB8D8` · `--accent-soft: #EAF6FA` · selection and badge tints from the accent
- Background `#FAFBFC`, panel `#F1F4F6`, borders `#E2E8EC`, text `#1F2933` / `#5A6B7A`
- Font: system SF Pro for UI; terminal and raw-editor fonts are user-configurable from a curated
  catalog (`font-catalog.ts`), default SF Mono. 13 px base, compact density.
- Light tokens only; apps are told the theme is `light`.
