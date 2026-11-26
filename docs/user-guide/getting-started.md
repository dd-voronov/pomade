---
doc: docs/user-guide/getting-started.md
audience: users
holds: first run and choosing a workspace, the window layout (Projects panel, icon strip, tab strip, panes), how projects, tabs and panels fit together, quitting and what is restored, window shortcuts
kind: reference
---

# Getting started

Pomade is one window for working on a folder of projects: documents, terminals and coding agents side by
side, with your files, git state and notices a click away. This page takes you from the first launch to a
working layout, and explains what comes back when you reopen the app.

## First run: choose a workspace

The first time Pomade starts it shows **Welcome to Pomade** and one button, **Choose workspace folder**.
Pick the folder that holds your projects, apps and agents — your **workspace**. Pomade remembers it and
opens it automatically next time. A workspace is one folder tree; Pomade works in one workspace at a time.

Pomade stores three things in your workspace:

- in a hidden `.pomade/` folder, the shareable set-up — your projects, groups, the ignored-files and unwatched-folders lists — and your preferences (fonts, editor options; see [settings.md](./settings.md)), which you can commit to git;
- machine-local state in `.pomade/state/` (open tabs, window layout and so on), which Pomade keeps out of git by itself;
- in `Apps/Pomade/local-history/`, the earlier versions of your files ([git.md](./git.md#local-versions)); a development build of Pomade uses `Apps/Pomade/dev/local-history/`. Pomade keeps this folder out of git too.

Because preferences live in the workspace, they follow it to another Mac and are shared by every Pomade opened on it.

### The workspace and the Workspace project

Two things share the word, and they are not the same:

- The **workspace** is the folder itself — everything Pomade works with lives in it: your projects,
  apps, agents and the `.pomade/` set-up. You choose it with **Choose workspace folder** and change it
  with **File ▸ Change Workspace…**.
- The **Workspace project** is that same folder opened as a project — the **Workspace** row at the top
  of the Projects panel. It is always first, it can't be removed, and it owns everything that belongs
  to no other project: files outside your projects, and tabs or notices that name no project.

### Switching to another workspace

Choose **File ▸ Change Workspace…** (or **Settings ▸ General ▸ Change workspace…**), pick a folder, done.
Switching **closes every terminal and agent session** — they belong to the workspace — and reopens the new
workspace's own projects and tabs. Open documents come back; running processes do not. Switching back
restores that workspace's projects and tabs. If you would like a prompt each time Pomade opens,
turn on **Settings ▸ General ▸ Confirm workspace on startup**: Pomade then asks "Continue in this
workspace?" with **Continue** and **Change workspace…**.

## The window

```
┌────────────┬───┬──────────────┬──────────────────────────────────────┐
│  Projects  │ ▢ │  side panel  │  tab strip           ⏲  ⋯  +         │
│   panel    │ ▢ │  (Files,     ├──────────────────────────────────────┤
│            │ ▢ │   Git, …)    │                                      │
│            │   │              │   panes: the active tab's content    │
│  Settings  │   │              │                                      │
└────────────┴───┴──────────────┴──────────────────────────────────────┘
        icon strip ─┘
```

**Projects panel.** Lists your projects. The first row, **Workspace**, is always there: it is the
Workspace project, the whole workspace folder as a project, the place for files that belong to no
project ([the workspace and the Workspace project](#the-workspace-and-the-workspace-project)). Below it are your
groups and projects. Click a project to switch to it. The header has **Collapse Projects panel** («), **New group**
(⊞) and **New project** (+); at the bottom are **Settings** and the app version.
Collapsed, the Projects panel becomes a narrow rail of project icons with **Expand Projects panel** at the top.

**Icon strip and side panel.** The icon strip next to the Projects panel chooses what the side panel beside it shows: **Files**
(the project's file tree), **Git**, **Notices** (the bell), then one icon for each installed app that provides a panel.
A number on an icon is a count — unread notices, a failed git operation, whatever an app reports. Click an
icon to show its panel. **Collapse side panel** («) hides the panel and leaves only the strip; **Expand
side panel** (») brings it back. Each project remembers which panel it was showing.

**Tab strip.** The open tabs of the active project, plus three buttons on the right:

- **Session history** (clock) — earlier agent sessions, to look through or resume;
- **Bulk actions** (⋯) — `Reopen closed tab`, `Stop all terminals`, `Exit all agents`, `Close all docs`,
  `Close saved docs`;
- **New tab** (+) — `New doc`, `New terminal`, then your coding agents, then your apps.

**Panes.** The big area under the strip shows the active tab: a document editor, a terminal, an agent, an
app, a commit, a comparison and so on. Switching tabs or projects never restarts anything — terminals and
documents you are not looking at keep running in the background.

## How projects, tabs and panels fit together

- A **project** is a folder inside the workspace with its own set of tabs and its own file tree. Create one
  with **New project** (+) in the Projects panel: give it a **Name**, an optional **Group**, and either **From
  existing folder** (root it at a folder already in the workspace) or **New from template** (copy a
  template folder). Groups can nest up to four levels; drag projects and groups to reorder.
- **Tabs belong to a project.** Switching projects switches the whole tab strip and pane area, and Pomade
  remembers each project's tabs separately. Move a tab to another project with the tab's right-click
  menu (`Move to another project`, `Copy to another project`) or drag it onto a project in the Projects panel.
- **Panels follow the Projects panel.** The Files panel shows the active project's tree; the Git panel covers the
  repositories of the project you selected (the Workspace project covers them all); Notices lists notices from
  every project, each naming the project it belongs to.
- A project row (or its rail icon) shows a number when some of its tabs are unread — a terminal or
  agent that finished or asked something, or a tab you marked unread.
- On a tab, a small dot marks **unsaved** changes, and a red dot marks an **unread** tab.
  A tab title in *italics* is a preview tab (see **Single click opens a preview tab** in
  [settings.md](./settings.md)).

Right-click a tab for `Close`, `Close others`, `Close to the right`, `Mark unread`, `Rename tab` /
`Rename document`, `Change color`, and `Show tab details`. Right-click empty space in the tab strip for
the bulk actions.

## Resizing and hiding

Drag the thin dividers to resize the Projects panel and the side panel; with a divider focused, `←` and `→`
resize in small steps. Pomade keeps the working area from shrinking below a usable width. Sizes and the
collapsed or expanded state of both columns are remembered across restarts.

## Quitting, and what comes back

Quitting always asks first, whichever way you do it — Cmd+Q, the app menu's Quit, the red window button or
**File ▸ Close Window**. Closing the window quits the whole app.

1. **Quit Pomade?** — `Cancel` keeps every tab and session exactly as it is; `Quit` continues.
2. **Sessions still running** — shown when terminals or agents are alive, with the real count ("2 agents
   and 3 terminals are still running."). `Quit anyway` ends them and loses their context.
3. **Unsaved documents** — shown when any document in any project has unsaved changes:
   `Save all docs`, `Discard all changes` or `Cancel`. If a document cannot be saved automatically (it is
   untitled, or changed on disk meanwhile), Pomade names it under **Couldn't save some documents** and
   does not quit. Discarded changes are kept for 7 days as discarded drafts in the document's Document history.

Esc, `Cancel` or clicking outside at any step stops the quit.

**When you reopen Pomade**, it opens your last workspace and the project you were in, and brings back:

| Comes back | How |
|---|---|
| Your projects, groups and which are collapsed | as they were |
| Each project's open tabs, order, active tab, colors and names | as they were; documents reopen where you were reading |
| Recently closed tabs | `Reopen closed tab` still works after a restart (up to 10 per project) |
| Terminals | a fresh shell in the folder you were last in, with your earlier output above a "session restored" line and the last command typed back (not run) |
| Coding agents | the conversation is resumed; if it cannot be, the pane offers **Resume session** |
| Side panel shown per project, mounted folders, column sizes and collapse state | as they were |
| Muted notice sources, settings | as they were |

Not restored: running processes (a build, a dev server — start them again), and the notices list (it
starts empty). A terminal or agent tab belonging to a project you have not opened since launching comes to
life when you open that project.

## Window shortcuts

| Keys | Action |
|---|---|
| Cmd+T | new terminal tab, next to the active tab |
| Cmd+W | close the active tab (asks first if a document has unsaved changes) |
| Cmd+Shift+T | reopen the most recently closed tab |
| Cmd+F | find in the active document |
| Cmd+B | show or hide the Projects panel |
| Cmd+Shift+B | show or hide the side panel |
| Cmd+, | open Settings |
| Cmd+Shift+W | close the window (asks to quit) |
| Cmd+Q | quit (asks first) |

These work whatever has focus, including inside a terminal — a terminal never receives them. Apps can add
their own shortcuts; those work everywhere in the window too.
