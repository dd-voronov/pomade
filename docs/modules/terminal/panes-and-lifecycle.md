---
doc: docs/modules/terminal/panes-and-lifecycle.md
audience: engineers, product
holds: terminal and agent tabs — PTYs in the main process, opening, hidden panes, restore and revive after a restart, scrollback persistence, close guards (per tab and for the bulk actions), agent/terminal transitions, dead panes, attention; how it is built
kind: reference
---

# Terminal panes & lifecycle — PTYs that outlive the UI

**Module:** `terminal` · **UI:** the tab-strip "+" launcher (`tab-add`), the bulk-actions ⋯ menu
(`bulk-actions`), the dead-tab pane (`Relaunch` / `Resume session`), the quit dialog's "Sessions
still running" stage · **Code:** `src/main/pty-manager.ts`, `src/renderer/stores/terminals-store.ts`,
`src/renderer/modules/terminal/TerminalPane.tsx`, `TerminalActions.tsx`, `BulkCloseConfirm.tsx`
(mounted by `src/renderer/layout/PaneHost.tsx`), `useXtermSession.ts`,
`src/renderer/layout/QuitConfirm.tsx` · **e2e:** `terminals.spec.ts`, `revive.spec.ts`,
`terminal-last-exec.spec.ts`, `terminal-scrollback.spec.ts`, `terminal-scrollback-command.spec.ts`,
`scrollback-orphan-gc.spec.ts`, `bulk-close-confirm.spec.ts`, `attention.spec.ts`,
`reopen-closed-tab.spec.ts`

## What it does

Every terminal or agent tab is backed by a real PTY (`zsh -il`) living in the **main process**,
keyed by a `termId`. The PTY survives anything the UI does short of closing the tab: switching
projects, hiding the tab, resizing columns — a running build or agent session never dies because you
looked away. Processes still die with the app, but a tab that was **alive at quit comes back
alive**: opening its project relaunches it in place (an agent re-enters its conversation, a terminal
reopens where you left it). Only tabs that were already dead, and agents whose session id was never
captured, show the dead pane with **Relaunch** / **Resume session**.

## Opening terminals and agents

- **"+" menu** (tab strip, tooltip `New tab (Cmd+T)`): **New doc**, **New terminal**, one item per
  agent visible in this project, then one item per installed hosted app. The roster is re-read each
  time the menu opens ([agent-roster](../agents/agent-roster.md)). **Cmd+T** (File ▸ New Terminal Tab) opens a new terminal
  directly, inserted right of the active tab. **Cmd+W** (File ▸ Close Tab) closes the active tab
  through its close guard. **Cmd+Shift+T** (File ▸ Reopen Closed Tab) reopens the project's
  most-recently closed tab.
- A plain terminal opens at the **project root**, titled `zsh N` (N = the project's terminal-tab
  count + 1). An agent tab runs the roster command, titled with the agent's name. The command is
  *typed into* the interactive shell once it has drawn its first output — so aliases and functions
  from `~/.zshrc` are loaded and the agent runs exactly as if you had typed it.
- Other launch paths: an app opens a terminal with `tabs.openTerminal` (a folder, an optional command
  typed and run, a title; the tab is titled with the title, else the command, else `zsh N`, and
  Relaunch re-runs the command); the Git panel's branch pane opens a terminal in a worktree folder;
  a document's context menu starts an agent with the file as context ([agent-roster](../agents/agent-roster.md) "Launch and
  in-shell detection"); apps launch and resume agent tabs through `agentTabs.*` ([agent-tabs](../agents/agent-tabs.md)).
- **Bulk-actions ⋯ menu:** `Reopen closed tab` (disabled when the project's reopen stack is empty),
  `Stop all terminals` (kills + closes every plain terminal of the project, idle or dead ones too;
  toast `Stopped all terminals`), `Exit all agents` (types `/exit` into each live agent and closes
  its tab once the process ends — a leftover shell is killed after 1.2 s; toast `Sent /exit to all
  agents`), `Close all docs`, `Close saved docs`. The two terminal actions ask first when something
  busy would close ("Busy state and close guards"); the toast shows only once the action has run.

## Hidden but never unmounted

PaneHost keeps every pane mounted (`display: none` when hidden) — a hidden project's terminals keep
receiving output and attention events and keep reporting their working directory. On re-show the
pane re-fits its grid, repaints every row from the buffer and takes focus. Attaching an xterm (a pane
mount, or a termId swap by Relaunch or revive) paints the PTY's **ring buffer** — the last 200 KB of
output — so recent scrollback survives; the live xterm additionally holds 10 000 lines of
scrollback. After a restart that paint also carries the **saved** scrollback of the previous
session, above the restore rule (see "Scrollback that survives a restart"). A repaint never writes
back to the shell (same section).

Because every project is mounted, **revive is triggered by opening a project, not by mounting a
pane**. A pane mount only *notices* that a restored tab's PTY is gone; it records that as a pending
revive **in memory only** and touches nothing on disk. Until you open the project, its tabs sit in
that pending state — showing an empty pane rather than a dead one, so a tab about to come back live
never flashes Relaunch/Resume buttons. The marks are per-run: they are dropped on a workspace
switch, and a project never opened simply round-trips its restore state byte for byte, however many
times you restart.

## Restore & revive

After a restart, each restored tab is treated by **the status it had at quit**:

- **`live` + agent with a captured session id** → the id is **validated** against the agent's
  session store (`agents.validateSession`) before anything spawns; if the disk backs it, a fresh PTY
  runs the provider's resume command (`<command> --resume <id>` / `codex resume <id>`) at the tab's
  **cwd-at-launch** (the directory the session store is keyed on — a `cd` after launch does not move
  the resume). An id the disk cannot back, or an agent that has left the roster, becomes a dead pane
  with the id kept (**Resume session** is the retry). A stale id that still validates but fails in
  the CLI exits naturally → dead pane, id kept.
- **`live` + agent with no session id** (never prompted, or the tab stayed ⚠️ Unbound — see
  [session-attribution](../agents/session-attribution.md)) → dead pane. Auto-starting a fresh agent would look resumed while
  carrying empty context.
- **`live` + terminal** → a fresh plain shell at the tab's **last known working directory**, showing
  **the scrollback from before the restart** above a dim `── session restored ──` rule, with the
  **last command you ran pre-typed into the input, unsubmitted**. Nothing is re-run; the command
  waits at the prompt for you to press Enter, edit it, or discard it (Ctrl+C). A directory that has
  since been deleted falls back to the project root.
- **`dead`** → dead pane immediately, never revived: "dead at quit stays dead". A spawn failure
  also lands as a dead pane.

Everything else on the tab rides along untouched: session id, title, color, rename flag, unread dot.
Revive swaps the `termId`, confirms the status and, for an agent, records the resume command it
launched as `lastCommand`; nothing more. Revive raises **no attention** — it is a spawn you asked
for. A resume that *fails* exits naturally and does raise attention.

The **last known working directory** is tracked live: the zsh shim's prompt marker reports `$PWD`,
main broadcasts it whenever it changes, and the tab persists it. A `cd` during a session decides
where the tab reopens.

The **pre-typed command** works off the shim's `preexec` marker (see [shell-integration](./shell-integration.md)): every
command a *plain terminal* executes is remembered on the tab (`lastExec`), and the revived shell
gets it typed back — without an Enter — when its first prompt marker arrives. Only actually running
something replaces it, so reloading twice without touching the command keeps it waiting; because the
restored text is never executed, it never overwrites itself. Exceptions: **agent tabs** get no
pre-type (their input belongs to the CLI); the command that **launched an agent** is never recorded
as a terminal's last command; a command at the marker's 500-byte cap (or at the 160-byte cap of an
older shim) or spanning several lines is remembered but not typed back — half a command at a prompt
invites running something you did not mean. An agent that exits back to its shell (`/exit`) keeps
whatever the *shell* last ran from before the agent started.

Reopening a closed tab (Cmd+Shift+T, or the bulk menu item) runs the same machinery: the tab returns
at its original index with its original id, a terminal replays its scrollback and pre-types its last
command, an agent resumes through the roster, and a tab that was dead when closed returns dead.

## Scrollback that survives a restart

A plain terminal's (or a non-agent command terminal's, below) recent output (the same 200 KB ring the pane repaints from) is **saved to disk
while you work**: written 2 s after output stops, never later than 12 s after the first unsaved byte
(so a long build still lands), when the shell dies on its own, and in a synchronous flush at quit and
at a workspace switch. A crash costs at most the last seconds. The file is
`<workspace>/.pomade/state/scrollback/<tabId>` (raw bytes, gitignored with `state/`), named after
the **tab**, not the shell, so it survives relaunches, revives and a move to another project. A
snapshot key must be one path segment of `[A-Za-z0-9_-]` (≤ 128 chars); anything else is refused and
the terminal does not snapshot.

When the tab comes back, the pane shows **old output → a dim `── session restored ──` rule → the live
shell**, with the fresh prompt (and any pre-typed command) below the rule. Restoring is cumulative
but the rule never stacks: the restored text is saved on again, the rule is not, so there is one
boundary per restore and the total stays capped at 200 KB — a reload during which you touch nothing
keeps the history it just restored. The restored text is stripped of zsh's transient partial-line
markers (a reverse-video `%`/`#` padded with spaces to the capture width, then `\r ␠\r`): at a
different width the padding wraps and leaves a stray line above every restored prompt. The file on
disk stays a byte-exact recording; only the replay is sanitized.

Boundaries: **agent tabs never replay** (the agent controls its own restore through its resume
command), and **nothing is saved while an agent is running** in the shell. A tab that upgrades into
an agent (you type `claude`) drops its file on the spot and keeps the pre-agent history in memory; a
tab *launched* as an agent starts non-snapshotting. Typing `/exit` hands the shell back and saving
starts (again): the agent's farewell line and everything you do in the shell afterwards come back
after a restart.

**A terminal spawned with a launch command** (`tabs.openTerminal` with `command`, or Relaunch of
such a tab) starts with saving off too — the command might be an agent, and its roster match is
asynchronous, so a slow match must not let the writer persist an agent's opening frames. The
**first exec marker** of that shell is the launch command; its roster verdict decides. Not an agent
→ saving turns on and the output so far (the ring buffer) is saved with the next write, so the tab
behaves like a plain terminal from then on and comes back after a restart with its scrollback above
the rule. An agent → saving stays off until its `/exit`. A tab closed before the verdict arrives has
lost its snapshot key (`forgetSnapshot` deletes it), so the late verdict cannot switch saving back
on. The one case that never saves scrollback: an agent tab brought back by revive, **Relaunch** or
**Resume session** (it carries no snapshot key).

**Replaying a recording never types into your shell.** An agent's scrollback holds the questions its
TUI asked the terminal ("where is the cursor?", "what are you?") and the modes it switched on (focus
and mouse reporting). Repainting makes the terminal answer all of them again, so while a pane paints
restored scrollback nothing it emits is sent to the shell, and once the paint is parsed those modes
are switched off in the view ([rendering](./rendering.md) "Repainting a restored recording"). Cost: a keystroke
inside that window (well under a tenth of a second, before the pane is readable) is dropped.

**Closing a tab defers the forget.** Every explicit close pushes the tab onto its project's **reopen
stack** (cap 10; see [closing-tabs](../tabs/closing-tabs.md)), and its snapshot is what a reopen replays — so the file is
kept while the tab sits on any stack and deleted only when the entry leaves it (cap eviction, an
explicit clear). The forgetter's protected set is the union of every terminal/agent tab in `openTabs`
and every terminal/agent entry on a hydrated project's reopen stack; a snapshot is deleted the moment
its id leaves that union in a still-hydrated project (a workspace switch drops caches wholesale and
forgets nothing). At workspace start, snapshots whose tab id appears in no project state file — as an
open tab or a reopen-stack entry — are swept. **Relaunch** in a dead pane starts the scrollback over:
it restores across app restarts, not across "run this shell again".

## Busy state and close guards

The zsh shim (see [shell-integration](./shell-integration.md)) reports when a foreground command is running. Closing a tab
— × button, Cmd+W, or any batch close — confirms first when it would lose something:

- **Live agent tab** → always confirms: title `Close agent tab?`, text "“<title>” still has a
  running agent session. Closing it ends the session and loses its context."
- **Busy plain terminal** (a foreground command running) → confirms: title `Close running terminal?`,
  text "A command is still running in “<title>”. Closing it will stop the process."
- Idle terminals and dead tabs close silently. In a batch close, **Cancel keeps the tab and aborts the
  rest of the batch**. Attached tabs close without asking ([attached-terminals](./attached-terminals.md)).

**Bulk actions ask once for the whole batch.** `Stop all terminals` and `Exit all agents`
(`terminals-store.ts` `stopAllTerminals` / `exitAllAgents`) first collect the tabs they would close
that hold work in progress (`busyTargets`):

- **Stop all terminals** — live plain terminals with a foreground command running (the shim's busy
  flag, read from `pty.list()`, the same flag the per-tab guard uses).
- **Exit all agents** — live agent tabs that are mid-turn: `working`, or `needs-you` (waiting at a
  permission prompt), per `agent-live-store`. An agent idle at its prompt is not busy — `/exit` is the
  clean end the action asks for — and a tab with no known state is not busy.

With nothing busy the action runs at once. Otherwise `bulkClose` is set (action, project, the busy
tabs' titles) and nothing closes until the user answers in **one** dialog (`BulkCloseConfirm.tsx`,
test id `bulk-close-guard`, the per-tab guard's pane-scoped dialog with **Cancel** / **Close**).
Terminals: `Close running terminal?` (one busy, named) or `Close running terminals?` ("A command is
still running in N terminals. Closing them will stop the processes."). Agents: `Close working
agent?` ("“<title>” is in the middle of a turn. Closing it ends the session and stops that work.")
or `Close working agents?` ("N agents are in the middle of a turn…"). **Cancel** closes nothing;
**Close** runs the action over the project's tabs as they are at that moment — idle ones included.
The dialog shows only while its project is the active one; a pending ask waits while you look
elsewhere. The toasts (`Stopped all terminals`, `Sent /exit to all agents`) are raised by the action
itself, so a cancelled ask shows none.

Quitting with live sessions raises the app-level dialog `Quit Pomade?`, then `Sessions still running`
("N agents and M terminals are still running. Quitting ends them and loses their context.") with
**Quit anyway**; the tabs revive at the next start.

## Agent ⇄ terminal tab transitions

The tab kind follows what is actually running in the shell:

- Typing `/exit` in an agent CLI hands the shell back — the tab **downgrades** to a plain terminal
  (re-titled `zsh N` unless you renamed it; its stored command, resume id, launch cwd and bind state
  are cleared so a later Relaunch opens a shell, not the agent; an app-set title and the unnamed
  mark are cleared too). Detection is the process lifecycle — the exec→prompt marker pair — so a
  crash or Ctrl-C/D of the CLI lands the same way. The agent's end is reported to apps as
  `agentTab.exited` (`exit`; `crash` for a non-zero status other than 130 or a dying shell;
  `tab-closed`; `quit`), see [agent-tabs](../agents/agent-tabs.md).
- Typing a roster agent command (`claude`, `codex`, a folder agent) into any Pomade terminal
  **upgrades** the tab to an agent tab — name, agent id, a `--resume <id>` / `resume <id>` session id,
  and the launch cwd (`cwdAtLaunch`, canonicalized — the session-store key) are picked up from the
  command line and exec marker. The same marker event stamps `cwdAtLaunch` and `launchedAt` on a
  button-launched agent tab.

## Dead tabs, Relaunch, Resume

The dead pane is reachable **only** for a tab whose process genuinely exited, a tab that was already
dead at quit, or a restored agent tab that revive could not resume — never for a freshly created PTY.
It shows the title `Agent session ended` (agent) or `Terminal closed` (terminal), what was running
(the last command, or `zsh -il`) and:

- **Relaunch** — a fresh PTY in the same tab, same cwd, re-running the last command.
- **Resume session** (agent tabs with a known session id) — relaunches with the resume form of the
  roster command: `<command> --resume <id>` (claude-style) or `<command> resume <id>` (codex). With
  no roster agent or project to resolve, it relaunches as Relaunch does.

A natural exit (process died, or you typed `exit`) keeps the tab as a dead pane and raises an
attention event; a requested kill (closing the tab, bulk-stop, quit, workspace switch) does neither.

## Attention

A terminal that wants you back — an agent's turn-end bell, an OSC 9/99/777 notification, a natural
exit, or a foreground command that ran **≥ 2 s** finishing — puts a red dot on its tab and raises the
red counter on its project's Projects panel row (and on a collapsed group, and the Projects panel rail). The
counter is a **live count of the project's unread tabs**, capped at `9+`. The active tab of the
active project never dots. Opening a project does **not** reset the counter — it ticks down as you
read each unread tab, and the dots persist across a restart. A dot clears when you activate the tab,
type into it (a keystroke, a paste, or **Paste to input**); a bare click or scroll inside the active
pane does not clear its own dot, and neither do the terminal's auto-replies to the program's
queries. **Mark unread** in the tab's context menu sets the dot by hand; it clears on the next
activation. Per-provider signal details: [agent-providers](../agents/agent-providers.md).

## Boundaries worth knowing

- **PTYs die with the app** and on a **workspace switch** (the one sanctioned mass teardown). Quit
  waits (bounded, 2 s) for children to exit — no orphaned shells. Revive hides that across a restart;
  across a workspace switch the same rules apply when you switch back.
- **PTY reaping is owned by the tab lifecycle**, never by pane unmounts: a PTY is killed exactly when
  no tab references its termId (tab closed, or termId swapped by Relaunch or revive). Panes are
  views.
- **Pending revives are per-run.** Quitting with a project still unopened leaves its tabs to be
  revived by the next run.
- The busy flag is reliable because every Pomade terminal is a shimmed zsh; a nested non-zsh shell's
  foreground commands are invisible to it.
- `cwd` falls back when it vanishes: the PTY spawn resolves a stale directory to the workspace root,
  then the home folder, so a deleted folder never makes a tab unspawnable.

Tickets: E-022, E-024, E-025, E-030, T-023, T-024, T-044, T-056, T-116, T-128, T-147, T-149, T-151, T-299, T-300.
