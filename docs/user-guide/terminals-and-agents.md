---
doc: docs/user-guide/terminals-and-agents.md
audience: users
holds: how to work with terminals and coding agents in Pomade — opening them, the agents Pomade knows, unread tabs, copy/paste, links, session history and resuming, restart behavior, attached terminals, shortcuts
kind: reference
---

# Terminals and agents

Pomade gives every project real terminals and coding-agent tabs. A terminal is your own `zsh` login
shell — your aliases, functions and history are all there. An agent tab is the same shell with a
coding agent (Claude Code, Codex, or one of your own) started in it. Both live in the tab strip next
to your documents, keep running when you switch projects, and come back after you restart Pomade.

## Open a terminal or an agent

Click the **+** button at the right end of the tab strip (tooltip `New tab (Cmd+T)`). The menu lists:

- **New doc** — an untitled document.
- **New terminal** — a terminal in the project's folder, titled `zsh 1`, `zsh 2`, …
- One entry per **agent** shown in this project (see below). Picking one opens an agent tab in the
  project's folder and starts the agent.
- One entry per installed **app** (Planner, Runner, …), with its icon.

**Cmd+T** opens a new terminal right away, next to the tab you are on.

An agent whose command Pomade cannot find in your shell shows a **!** badge ("Command not found —
click to map"). Click it, type the command that actually starts the agent in the **Map "…"** dialog
and press **Save**; if the command works, the agent starts at once. The mapping is saved in the
workspace (`.pomade/agents.json`), so it travels with the repo.

**From a document.** Right-click inside a document ▸ **New agent chat with this file in context**
(or **New agent chat** when text is selected) ▸ pick an agent. The agent opens, is told to read the
file, and your selected text is typed into its input for you to edit and send.

**Bulk actions.** The **⋯** button next to the **Session history** button has:

- **Reopen closed tab**
- **Stop all terminals** — closes every plain terminal in the project (running commands included).
  If a command is still running somewhere, one dialog asks first (**Close running terminal?** /
  **Close running terminals?**, naming how many); **Cancel** closes nothing, **Close** closes all of
  them. Idle terminals alone close without asking.
- **Exit all agents** — types `/exit` into every running agent and closes its tab when it ends. If
  an agent is in the middle of a turn or waiting for your answer, one dialog asks first (**Close
  working agent?** / **Close working agents?**); agents idle at their prompt do not trigger it.
  **Cancel** exits none.
- **Close all docs**, **Close saved docs**

## Which agents Pomade knows

- **Claude** and **Codex** are always listed (they need the `claude` and `codex` commands to work in
  your shell).
- Every folder `Agents/<name>/` in your workspace that contains a `CLAUDE.md` is an agent named
  after the folder — a specialised Claude Code with its own configuration. Folders named `_shared`
  or containing `template` are skipped.
- If the Agents app is installed, its roster replaces this list (and its launch modes).

**Choose which agents a project shows:** open the project's Edit project dialog and use **Visible
agents** — tick **All agents**, or untick it and tick the ones you want. The "+" menu, the
document menu and the session history all follow this.

Agents offer two launch modes: **Normal**, and **Full autonomy** (Claude `--dangerously-skip-permissions`,
Codex `--dangerously-bypass-approvals-and-sandbox`). The "+" menu always starts Normal; apps can
start an agent in Full autonomy.

## Working in a tab

- **Type a command, get a tab.** If you type `claude`, `codex` or any listed agent's command into a
  plain terminal, the tab turns into an agent tab (named after the agent). When you quit the agent
  (`/exit`), it turns back into a terminal titled `zsh N`.
- **Rename:** double-click the tab (or right-click ▸ **Rename tab**). The tab's right-click menu also
  has **Change color**, **Move to another project** (the running process moves with it), **Reveal in
  Finder** (opens the terminal's folder) and **Mark unread**.
- **Close:** the tab's **×** or **Cmd+W**. Pomade asks first when closing would lose something:
  - An agent tab always asks: **Close agent tab?** — closing ends the session and loses its context.
  - A terminal with a command still running asks: **Close running terminal?**
  - An idle terminal or a finished tab closes silently.
- **Reopen a closed tab:** **Cmd+Shift+T**, or **⋯ ▸ Reopen closed tab**. A terminal comes back with
  its earlier output; an agent resumes its conversation.
- **Hidden is not stopped.** Switch to another project or tab: builds keep running and agents keep
  working. The Projects panel tells you when one wants you (next section).

A tab that shows **Agent session ended** or **Terminal closed** has no running process. **Relaunch**
starts it again in the same folder; for an agent with a known session, **Resume session** continues
that conversation.

## Know when a tab is unread

A tab turns on a **red dot** when:

- an agent finishes its turn or asks you something (Claude Code's bell comes about a minute after
  it finishes, if you have not come back; Codex signals when its pane is not in front),
- a command that ran for 2 seconds or longer finishes,
- the process ends by itself (not when you close the tab).

The project's row in the Projects panel shows a **red number** — how many of its tabs are unread (9+ when
more). Collapsed groups and the collapsed Projects panel show the total too.

The dot clears when you switch to the tab, or type or paste into it. Clicking or scrolling inside the
tab does not clear it. The tab you are looking at never gets a dot. **Mark unread** in the tab's
right-click menu puts the dot back by hand.

## Copy, paste and selection

- **Select with the mouse to copy.** Finishing a selection copies it and flashes `Copied N chars` in
  the corner. Turn this off in **Settings ▸ General ▸ Terminal ▸ Copy on select**.
- **Cmd+C** copies the selection. With nothing selected, the key goes to the program, so **Ctrl+C**
  still interrupts (with text selected, Ctrl+C copies instead).
- **Cmd+V** pastes into the shell or agent input.
- **Right-click** opens **Copy · Paste to input · Select all · Clear**. Right-clicking never changes
  your selection, so select output, right-click and choose **Paste to input** to send it to the prompt.
- **Option+click** on the command line moves the cursor to where you clicked. It does not work inside
  full-screen programs that take the mouse (vim, agent screens) — they get the click themselves.

## Open files and links from the output

Paths and web addresses in terminal output are clickable:

1. Hold **Cmd** and hover — links that point at something real are underlined.
2. **Cmd+click** opens it.

A plain click never opens anything, so you can still select and copy a path.

What opens where:

- A web address opens in your browser.
- A file opens as a document tab in the **current** project (Pomade never switches project for you);
  a file from another project carries an orange "outside this project" mark. Files outside the
  workspace open too, and ask before the first save.
- A folder in this project, or under a folder mounted in this project's tree, is shown in the file
  tree (a mounted one in its mount's section); a file under a mount is revealed there too. Any other
  folder, and images or binary files inside the workspace, are revealed in Finder.
- `path:42` or `path:42:7` (compiler errors, `grep -n`) opens the file at that line.
- A bare name like `VISION` or `me.md` finds the matching file in your workspace. When several files
  match, a list appears — pick one (Escape cancels). Matching ignores upper and lower case.
- Paths that wrap onto the next line, including the indented wrapped lines agents print, still work.

Relative paths are looked up from the terminal's current folder first, then the project folder, then
the workspace. Paths with spaces are not recognized. Build folders such as `node_modules`, `dist` and
`build` are not searched by bare name.

## Session history and resuming

Agents keep their own conversations on disk. Pomade reads them, so sessions started anywhere in the
same folder show up too.

- Click **Session history** (the clock icon) in the tab strip's action cluster. It lists the
  project's past sessions, grouped by agent, newest first — each with the first message, the start
  time and a short id. **Resume** opens a new agent tab that continues that conversation. (If the
  Agents app is installed, Session history opens its Sessions view instead.)
- Only sessions that ran in the project's own folder are listed — not ones started in a subfolder.
- **Resume after a restart is automatic** for agents Pomade could identify (next section).

**⚠ "Session not identified".** Pomade learns which session a tab holds when you send your first
message. If it cannot tell (for example two agents prompted within a second of each other in one folder), the tab
gets a ⚠ mark: the tab still works, it just will not resume by itself after a restart. Click the
mark, paste the session id (the agent prints "to resume, run … --resume <id>" when it quits) and
press **Bind**, or choose **Ignore** to hide the mark for this session. After a clear (`/clear`,
`/reset`, `/new` in Claude; `/clear`, `/new` in Codex) or a fork that moves the tab to a new session
(`/branch` in Claude, `/fork` in Codex), a new first message identifies the new session. Claude's
`/fork` starts a copy in the background and leaves the tab on its own session, so nothing changes in
the tab.

## After you restart Pomade

Closing Pomade stops the processes (a dialog counts the running agents and terminals first:
**Quit Pomade?**, then **Sessions still running** → **Quit anyway**), but the tabs come back when you
open each project:

- **Terminals** reopen in the folder you last used, with their earlier output above a dim `── session
  restored ──` line. The last command you ran is typed at the prompt but **not run** — press Enter to
  run it again, or edit or clear it.
- **Agents** resume their conversation, if Pomade knows the session. An agent you never talked to
  (nothing to resume) shows **Agent session ended** with **Relaunch**.
- Tabs that were already finished stay finished.

A terminal an app opened with a command (for example from Runner) keeps its earlier output across a
restart like any other terminal, as long as the command is not an agent — an agent keeps its own
conversation, not the screen.

## Attached terminals

Some apps run long-lived programs outside Pomade — for example Runner's services. Their terminals
live in a small background process, so they keep running when you quit Pomade. The app can open an
**attached terminal** — a tab that shows one of them, titled for example `Coda web · Runner`:

- The header shows the session's name, the app that owns it and a status: **Running**, **Exited**,
  **Crashed · code N**, **Stopped**, **Stopped by you**, **Lost · keeper crashed**, **Keeper not
  running** (retrying), **Session not found**.
- The tab shows what the session printed before and live, takes typing and pasting, and works with the
  same copy and link features. An ended session's screen stays, read-only.
- **Stop** (in the header, while it runs) ends the session; buttons such as **Restart** come from the
  app.
- **Closing the tab only disconnects** — nothing is stopped, and no confirmation is asked. Quit and
  reopen Pomade: the tab comes back with everything printed in the meantime.
- A red dot appears if the program rings the bell or the session ends on its own.

## Settings

**Settings ▸ General ▸ Terminal**:

- **Terminal font** — SF Mono (default), PT Mono, Monaco, JetBrains Mono, IBM Plex Mono. Applies to
  open terminals immediately.
- **Copy on select** — on by default.

## Shortcuts

| Keys | Does |
|---|---|
| Cmd+T | New terminal, next to the current tab |
| Cmd+W | Close the current tab (asks first when it would lose work) |
| Cmd+Shift+T | Reopen the last closed tab |
| Cmd+C | Copy the selection in a terminal (otherwise passes through) |
| Cmd+V | Paste into the terminal |
| Option+click | Move the cursor on the command line |
| Cmd+hover / Cmd+click | Underline / open a path or web address |
| Escape | Close the terminal's right-click menu or the file picker |
| Cmd+Q | Quit (with the running-sessions check) |

## If something looks wrong

- **The agent entry has a `!`** — its command is not found in an interactive `zsh`; map it as above.
  Check that `claude` or `codex` runs in a normal Terminal window.
- **A path is not underlined** — it does not exist from the terminal's folder, project or workspace;
  check the folder (`pwd`). A file created seconds ago may take a moment to underline on hover, but
  Cmd+click opens it at once.
- **A terminal did not restore its command** — only the last command that fit on one line and under
  500 characters is typed back.
- **Nothing in Session history** — only sessions run in the project's own folder are listed, for the
  agents the project shows.
