---
doc: docs/modules/core/workspace-data-api.md
audience: engineers, product
holds: the workspace data API — files, frontmatter, projects, git state and its Git-panel reveal, tabs and pickers a hosted app reaches through the Host API; safety rails; how it is built
kind: reference
---

# Workspace data API — files, frontmatter and projects for hosted apps

**Module:** `core` · **Code:** `src/main/host-api-data.ts`, `src/main/host-api-data-core.ts`,
`src/main/host-api-fs.ts`, `src/main/host-api.ts` (watches), `src/main/watch-scope.ts`, `src/shared/settle.ts`, `src/main/atomic-write.ts`,
`src/renderer/modules/apps/delegated-calls.ts`, `src/renderer/modules/apps/git-calls.ts`,
`src/renderer/modules/apps/app-git.ts`, `src/renderer/modules/apps/project-list.ts`, `src/renderer/stores/reveal-store.ts`,
`src/renderer/modules/git/panel/git-panel-store.ts` (`revealRepo`), `src/renderer/modules/git/panel/RepoList.tsx` · **unit:**
`host-api-data-core.unit.test.ts`, `host-api-data-git.unit.test.ts`, `host-api-pomade-folder.unit.test.ts`, `app-git.unit.test.ts`,
`project-list.unit.test.ts`, `git-panel-store.unit.test.ts` · **e2e:** `app-workspace-data.spec.ts`, `app-files-delete.spec.ts`,
`app-open-terminal.spec.ts`, `app-git-state.spec.ts`, `app-files-reveal.spec.ts`, `app-git-reveal.spec.ts`, `app-project-activate.spec.ts` ·
**Contract:** [HOST-API](../../HOST-API.md) §4 · **Internal surface:** [contracts/host-api-frames](../../contracts/host-api-frames.md) "Workspace data methods", "Delegated calls"

## What it does

Hosted apps (Board, Planner, Runner, Agents) read and change the workspace through the Host API
instead of touching the disk themselves. Pomade is the one door: every call is checked in the
main process against the app's manifest capabilities and the workspace-path rule before any
file is touched.

## Reading and writing files

- **Read.** `files.readFile` returns a file's text and its mtime — and, when asked, a Markdown
  file's frontmatter record, the same one a folder listing gives; `files.readFolder` lists a
  folder with each Markdown file's frontmatter; `files.watch` reports changes from Pomade's one
  platform watcher, batched per watch every 120 ms, with the workspace's ignored items applied
  below the watched path; a batch holding one deleted path and one created folder is that folder's
  `rename`. A watch never misses a change: macOS's file events can drop one (a change
  made just as the watch opens, the second of two quick writes to a file), so Pomade re-reads the
  watched folder right after the watch opens and again after each burst of changes (300 ms, then
  1.2 s later; a re-read that finds something restarts the sequence), and reports whatever the
  events missed. Nothing is re-read while the folder is quiet. A watch over more than 5000 entries
  re-reads only the paths of its last batch. Watches end with the frame or socket session that took
  them and with the workspace.
- **Change one frontmatter field.** `files.setField` / `files.removeField` rewrite only that key's
  lines and leave every other byte — comments, quoting, key order, blank lines, the body, CRLF
  line endings — identical. They run the same `pomade-kit` code as the editor's properties panel,
  so a Board drag and a properties-panel edit produce the same bytes. A block Pomade cannot read
  safely (invalid YAML, an unclosed `---`) is refused, never rewritten.
- **Write a mapping.** `files.setKeyLines` writes one key as its own YAML lines — a Planner
  item's `repeat:` rule, any nested value `setField` does not take — replacing just that key's
  lines (or adding them at the end of the block); every other byte stays.
- **Write only if nothing changed since the read.** Every overwrite (`files.write`, `setBody`,
  `setField`, `removeField`, `setKeyLines`) takes `ifMtime`, the mtime the app read. When an agent
  or another app rewrote the file in between, the call fails with `changed-on-disk` and the file
  is left as it is, so a Board drag never lands on a ticket an agent just rewrote. The check runs
  right before the atomic rename (HOST-API §4 "Conditional writes"), and app writes to one file
  run one at a time, so concurrent field writes never lose each other's change.
- **Replace the body.** `files.setBody` keeps the frontmatter block byte for byte and replaces the
  rest.
- **Create, overwrite, move, rename.** `files.create` refuses a taken path and makes missing
  folders; `files.write` replaces an existing file; `files.move` moves or renames a file or folder
  and refuses a taken target.
- **Delete.** `files.delete` moves a list of files to the macOS Trash, so the user can put them
  back from Finder — the Planner's bulk delete after its own confirmation. Each path is reported
  on its own: a missing file, a folder or a path inside `.pomade` fails only its own entry, the
  others still go. A deleted file open in an editor shows "This file no longer exists on disk"
  and keeps its buffer; saving recreates it.
- A field, body or key-lines edit whose result equals the file's current bytes writes nothing (and,
  with `ifMtime`, a stale one is refused all the same).
- `files.delete` takes at most 1000 paths per call.

## Choosing a folder

An app in an `<iframe>` has no file dialog that returns real paths, so `files.pickFolder` opens
Pomade's native folder dialog for it (only a frame can ask; a backend or a command cannot) — Runner's "Folder" field for a service, the Planner's
first-run tasks folder. The dialog starts in the project's folder (or where the app asks, inside
it) and the answer is a workspace-relative path. The macOS dialog cannot be locked to a folder:
when the user picks something outside the project, the dialog says so and opens again at the
project's folder; Cancel answers "no folder". Needs `files.read`.

`files.pickFile` is the same for a file — the Planner's daily-note template. The dialog starts in
`under` (a folder; default the workspace) and offers only the given extensions; a file outside
`under`, of another extension or inside Pomade's own `.pomade` folder is refused in the dialog's
own message and the dialog opens again. Needs `files.read`; only an app's own frame can ask, not a
backend or a command.

## Opening tabs

An app can open a file in an editor tab (`tabs.openFile`) or a terminal in a folder that runs a
command (`tabs.openTerminal` — e.g. Runner's "open the service's folder" or a planner note's
"Open"). The tab lands right of the active tab of the chosen project (default: the active one for a frame,
the Workspace project for a backend or a command), and Pomade switches to that project so the user sees
it; a project id that names none is `not-found`. A file already open is focused, not
opened twice. An app-titled terminal keeps its title; Relaunch re-runs its command. `tabs.openAttached` opens a
terminal tab attached to one of an app's keeper sessions ([attached terminals](../terminal/attached-terminals.md)),
placed the same way. Needs the `tabs.open` capability. A tab for a file outside its project carries the editor tab's orange ⚠
mark ([scope marks](../tabs/scope-marks.md)); the app avoids it by naming the project that holds the file.

## Revealing a path in the Files panel

`files.reveal({ path, projectId? })` shows a file or folder in Pomade's Files panel — an app's "show
me where it is" for a job's output folder or a note. Pomade brings the panel forward (expanding a
collapsed side panel, switching away from Git or Notices), expands the tree down to the path, selects
it and scrolls it into view: the file tree's "Reveal in tree", and a revealed folder is also expanded
itself. `path` may be `""` (the workspace root: it only opens the panel). `projectId` names the project
whose panel shows it (default the active project for a frame, the Workspace project for a backend or a
command); a path outside that project's folder goes to the Workspace project's panel, which is rooted
at the workspace; Pomade switches to the project that shows it. A missing path is `not-found`, one at
or inside `.pomade` `capability-denied` (main checks both before the window is asked). A path inside an ignored folder is not
listed by the tree, so nothing is selected and the call still succeeds. Needs `files.read`. The
window serves it (`delegated-calls.ts`, `revealProject`): the project's own side-panel selection loads
first so it cannot overwrite Files afterwards, then `reveal-store` takes the request with `expand`.

## Projects

- **The active project.** `project.getActive` and the `project.changed` event — fired when the user
  or an app (`project.activate`) switches to another project or the Workspace project, and when the
  active project is renamed or moved. The Workspace project is a project of its own kind (`kind: "workspace"`, root `""`), so an app
  can offer a whole-workspace view.
- **Bringing a project to the front.** `project.activate({ projectId })` makes a project the active
  one, as a click on its row in the Projects panel does: its own active tab shows, and no tab is
  opened, focused or reordered (to focus a tab an app uses `agentTabs.focus` or `tabs.openApp`). An
  app uses it to take the person to a project before something else, or instead of opening a tab. The
  project already in front answers `{}` and changes nothing; `"__workspace__"` is the Workspace
  project; an unknown id is `not-found`, a missing or non-string one `invalid-params`. The Projects
  panel unfolds the groups around the project's row and scrolls it into view, as for any switch
  Pomade makes on its own. Needs `tabs.open` — the capability of every call that changes the project in
  front, not `project.write`, which is for what a project stores. It answers a frame and the socket
  alike (`projectId` has no default). Main checks that `projectId` is a string and delegates; the
  window (`delegated-calls.ts`, `showProject`) resolves it with `targetProject`, hydrates the
  project's tabs and sets it active.
- **The tree.** `project.list` returns the Projects panel's groups and projects in Projects panel order, each
  project with its group path ("Building tools › Tools") for two-level pickers.
- **Stable ids.** A project keeps its id through renames, moves and regrouping; an app stores ids
  and looks names and roots up when it needs them.
- **Per-project app settings.** An app keeps small per-project settings (the Board's backlog
  folder, a lane layout) with the project itself (`project.getSettings` / `setSettings`). Each app
  sees only its own; they travel with the project's config (git-synced) and survive renames. A
  write merges into the stored settings, is size-limited, and an app's entry that becomes empty is
  dropped. The Workspace project has none (`invalid-params`).
- **Project ↔ agents.** `project.getAgents` / `setAgents` read and replace the project's visible
  agents — the same list as the project dialog's **Visible agents** and the "+" menu. The Workspace project
  scope reads as every agent (`["*"]`) and cannot be set.
- Reading needs `project.read`; changing settings or agents needs `project.write`; `project.activate` needs `tabs.open`.

## Git state

An app reads the workspace's repos with `git.getState` — the Runner's Git-job form listing repos to
pick from, a dashboard showing what is unpushed. Each repo carries its identity — the folder name
the Git panel shows (the name `pomade-git` accepts), its absolute path, its remote URL or *local
only* — and its branch, upstream, commits ahead and behind, and uncommitted files with their status. Without a project it answers every repo; with one, the repos inside the project's folder
plus the repo that holds it. `git.watch` keeps an app live: after each change it delivers the
scope's repos again — only when they differ from what the app last got — and it follows a project
that is moved. Pomade answers from the same git snapshot its file tree and Projects panel show, so a read
runs no git command and the app never sees a different picture from the user's. Needs the
`git.read` capability.

### Revealing a repo in the Git panel

`git.reveal({ path, projectId? })` takes the person to a repo in Pomade's Git panel — an app's "show
me this repo" for a Runner job's target or a `pomade-git` run's result. `path` is the repo's
working-tree root, absolute (`GitRepoState.absPath`, or a run's `GitRunResult.path`); symlinks are
resolved on both sides, so `/tmp/…` and `/private/tmp/…` name the same repo. Pomade switches to the
project, expands a collapsed side panel, brings Git forward and scrolls the repo's row into view; a
panel drilled into another repo goes back to the list, and a project whose panel shows only this repo
shows its view. `projectId` names the project whose panel shows it (default the active project for a
frame, the Workspace project for a backend or a command); a repo outside that project's scope
(`reposInScope`) is shown in the Workspace project's panel. A relative path is `invalid-params`; a
path that does not exist, lies outside the workspace or is not a repo root of the git snapshot is
`not-found`, and so is an unknown project. Needs `git.read`; it answers a frame and the socket alike.

Main resolves the path (`host-api-data.ts#revealRoot`, `host-api-data-core.ts#revealRepoRoot`) to a
workspace-relative root and delegates with it. The window (`delegated-calls.ts`, `gitRevealProject`)
checks the root against `loadGitState()`, hydrates and switches to the project, selects the Git
panel, then `git-panel-store.revealRepo` leaves a one-shot request: `GitPanel` hands it to the list's
row (`RepoList`), which scrolls with `block: 'nearest'` and consumes it, or drops it when a repo view
already shows the repo or the list lacks it.

## Scoped symlinks

An app creates and removes symlinks in the workspace with `files.symlink` and
`files.removeSymlink` — a project's `links/` folder pointing at shared specs, for example. Its
manifest declares where (`"symlinks": ["Projects/*/links"]`), the install summary shows it, and Pomade refuses anything else: a link outside those folders, a link
reached through a symlinked folder, removing anything that is not a symlink. Links are relative,
so they survive moving the workspace; removing a link never touches what it points to. Needs
the `files.symlink` capability.

## Safety rails

- **Inside the workspace only.** Paths are workspace-relative; `..` escapes and absolute paths are
  refused. A write that would leave the workspace through a symlinked file or folder is refused as
  well — the target's real path is checked, not only the path the app named.
- **Pomade's own folder is off limits.** The workspace's `.pomade` folder holds Pomade's config
  and per-project state; no app reads, lists, watches, writes, moves, links, opens or picks
  anything in it — whether it names the path directly or reaches it through a symlink. The answer
  is `capability-denied`, listings leave it out, and its changes are never reported.
- **Atomic.** A reader sees the old file or the new one, never half of a write. An overwritten
  file keeps its permission bits; a symlinked file is written at its target and stays a link.
- **Capabilities.** Reading needs `files.read`; every write needs `files.write`. An app without the
  capability gets `capability-denied` and nothing happens.

## Disk is truth

An app's write is an outside write for the editor ([PLATFORM](../../PLATFORM.md) rule 8). When
the file is open with unsaved edits, the editor shows *"File changed since your edits"* with
Compare (disk ↔ my edits in a [comparison tab](../git/comparison-tab.md)), and neither the buffer nor the file changes on its own. When the
file is open without edits, the editor shows *"This file changed on disk outside Pomade."* with
Reload / Dismiss. Details: [external changes](../editor/external-changes.md).

Tickets: T-275, T-320, T-324.
