---
doc: docs/modules/agents/agent-tabs.md
audience: engineers, product
holds: agent tabs as apps see and steer them — the list, bindings, live state, titles and the unnamed mark, focus/launch/resume, events, tab environment variables; how it is built
kind: reference
---

# Agent tabs — what apps see and steer

**Module:** `agents` · **UI:** the unnamed mark on an agent tab (italic default title + hollow dot,
`tab-unnamed-<tabId>`, tooltip "Unnamed session") · **Code:** `src/renderer/modules/agents/`
(`agent-tab-info.ts`, `agent-tabs.ts`, `agent-tab-calls.ts`, `session-cause.ts`),
`src/renderer/stores/agent-live-store.ts`, `src/main/pty-manager.ts` (live state, `agentTab.exited`,
`POMADE_TAB_ID`), `src/main/agent-service.ts` (the app's roster) · **Contract:**
[HOST-API](../../HOST-API.md) §4 `agentTabs`, `agentTab.changed`, `agentTab.exited` · **e2e:**
`app-agent-tabs.spec.ts`, `app-agent-tabs-absent.spec.ts`, `app-agent-tab-exited.spec.ts`

## What it does

Apps — the agents app first, then Runner and git — see Pomade's agent tabs and act on them through
the Host API:

- **The list.** Every agent tab, in every project (the Workspace project first, then projects in
  Projects panel order, each in tab order), also one launched but not prompted yet: its project, agent,
  launch folder (absolute — the agent's session-store key), launch time, the session bound to it (or
  none), its title and what the agent is doing.
- **Bindings over time.** The bound session is the one [session-attribution](./session-attribution.md) confirms for the tab
  — the first session, a new one after a clear (Claude `/clear` · `/reset` · `/new`, Codex `/clear` ·
  `/new`) or a fork (Claude `/branch`, Codex `/fork`), the one `/resume` adopts. Claude's `/fork`
  copies the conversation into a background session and the tab stays in its own, so its binding
  does not change. An unsure binding (`bindState: 'unbound'`) is reported as none, never a guess.
- **Why a session changed.** An `agentTab.changed` whose changes include `session` carries
  `session: { cause, previousSessionId }` (absent otherwise): `previousSessionId` is the session the
  tab held just before (or `null`); `cause` is `first` (an agent launched in the tab, no resume),
  `clear`, `fork`, `resume` (a resume launch, or an in-session `/resume`) or `unknown`. The cause
  comes from evidence Pomade saw, never a guess ([How the cause is derived](#how-the-cause-is-derived)).
- **Live state** — `working`, `needs-you` (a permission or folder-trust prompt is on screen),
  `idle`, `exited` — is read in main from the agent's output by the kit's `AgentStateScanner`, which
  replays the output into a headless terminal and reads the window title (Claude: a spinner glyph
  means working, `✳` idle; Codex: a braille spinner means working, an "Action Required" title means
  waiting) and the last rows (the permission and trust dialogs). It starts when the agent starts
  (idle) and ends with it; a tab whose agent is not running (dead, or restored and not revived yet)
  is `exited`. Idle is reported only after it has held briefly, so a title flash before a dialog
  never reads as idle.
- **Titles both ways.** An app names a tab (a session's name), or marks its session **unnamed**: the
  tab then shows the agent's name in italics with a hollow dot — the reminder to name it, e.g. right
  after `/clear`. The user renaming the tab ends the mark and the app hears it (`titleSource:
  "user"`). Title source is `user`, `app` or `default`. All three facts belong to the agent: when it
  quits and the shell takes the tab back, they are cleared.
- **Focus, launch, resume.** An app brings a tab to the front (its project becomes active), starts a
  roster agent in a project (a folder, a launch mode, a first prompt), or resumes a session in a new
  tab. A launch needs the agent in the roster with a resolved command and, when a mode is named, a
  mode the agent has. The first prompt is submitted once the agent has produced output and settled
  for 700 ms; a multi-line prompt goes as one bracketed paste so its line breaks do not submit it
  early. Resuming a session a live tab already holds focuses that tab: two agents on one transcript
  would interleave it. A resume needs the session to exist in the agent's store for that folder.
- **Events.** Every change is one `agentTab.changed` naming what changed (`opened`, `closed`,
  `session`, `title`, `state`, `project`), from the moment the workspace's tabs are restored; a
  workspace load takes a fresh baseline, so the tabs it brings are not "opened". A change in launch
  folder or launch time alone (a relaunch) is not an event. Every end of an agent process in a tab
  also publishes `agentTab.exited` from main: the tab, its project, the agent, the session bound at
  that moment and why — `exit` (the agent quit with status 0 or 130), `crash` (another status, or the
  shell died under it), `tab-closed`, `quit` (Pomade quitting or the workspace closing).
- **`POMADE_TAB_ID` and `POMADE_PROJECT_ID`.** Every Pomade terminal — a plain one or an agent's —
  has its tab's id and its project's stable id (`__workspace__` for the Workspace project) in its
  environment, so a command run inside an agent's session (an agent naming its own session) finds its
  tab and, through the list, its session, and an agent writing project-bound app data knows its
  project. Both are set when the shell starts; a tab moved to another project keeps the old project
  id until it is relaunched or revived.

## How the pieces fit

The tabs are the renderer's, so the list is built there from `tabsByProject` and the live states main
sends (`pty:agent-state`); main gates and checks each call and hands it over. The first prompt of a
launch is typed by Pomade into that tab, so it arms the tab's session binding exactly like a prompt
the user submits. `agentTab.changed` events are a diff of the list, published like the renderer's
other platform events; `agentTab.exited` is published by main when the PTY manager sees the agent end
(`pty.setTab` tells main which tab and project each PTY runs in).

## How the cause is derived

The cause is decided in the renderer when a session binding is written, from what armed the bind
window and what the new transcript says about itself (`session-cause.ts`,
`stores/terminals-store.ts`):

- **Trigger — what armed the window.** `launch` (an agent started in the tab with no resume id),
  `clear` or `fork` (the command the person typed in the tab, matched per provider by
  `agent-commands.ts#matchSessionCommand` — [session-attribution](./session-attribution.md) "The
  signals"), `resume` (an in-session `/resume`, with or without an id), or `retry` (a submit while the
  tab had no trusted session).
- **Evidence from the transcript.** Main reports a bind with `forkedFrom`, the parent session the new
  transcript records (`pty:session-id`, [ipc-terminal](../../contracts/ipc-terminal.md) "Session
  attribution"; what each provider writes: [session-stores](./session-stores.md)). A transcript that
  names a parent is a fork whatever opened the window.
- **The rule** (`bindCause(trigger, forkedFrom, hadSession)`): `resume` stays `resume` (an adopted
  session's own parent is history); else a named parent gives `fork`; else `launch` → `first`,
  `clear` → `clear`, `fork` → `fork`; a `retry` is `first` when the tab held no session before and
  `unknown` when it did.
- **Other bindings.** A resume launch (a revive, a relaunch, `agentTabs.resume`) notes `resume` for the
  session its command names. A session the user binds by hand has no noted cause (`unknown`), and a
  tab whose session becomes none is always `unknown`.
- **Hand-off to the event.** The store notes the cause just before it writes the binding;
  `agentTabEvents` takes it (`takeSessionCause`) when that session reaches the list. A note for a
  different session, or none, gives `unknown`. An agent leaving the tab drops its note.

A new session born from a command outside the vocabulary, whose transcript names no parent, binds as a
`retry` — `unknown` when the tab held a session before, never a guessed `fork`. e2e:
`app-agent-tabs.spec.ts` (a stand-in agent walks `first`, `clear`, `fork`, `resume` with their
previous ids).

## Without the agents app

Rule 7: nothing here depends on an app. With no agents app the "+" menu is Pomade's own roster scan
and the Session history button opens Pomade's own Session history ([agent-roster](./agent-roster.md)); the API serves any app
that asks. "Is an agent live in this folder?" (`agents.liveIn`, used by the Git panel and
`pomade-git`) joins the agents app's answer with Pomade's own terminals (an agent and its launch
folder) and answers from the terminals alone when the app is absent. Each entry carries `state` and
`terminalPids` ([HOST-API](../../HOST-API.md) §3 "Socket", `agents.liveIn`). The state of a terminal's agent is
the scanner's last reading (`pty-manager.ts#liveAgents`, `git-branches.ts#readAgentState`): `idle`
only when the scanner has seen the agent's empty prompt, and nothing before its first reading — the
tab's own dot starts idle, this reading does not, and an unknown state counts as working. Where the
app and the terminals describe the same agent and folder (`joinLiveAgents`), the busier state wins:
working, not known, needs-you, idle; a tab the app gives no state for takes the terminals' reading,
and a Runner run is never idle. `pomade-git` skips a repo for any entry that is not idle; the Git
panel counts every entry.

Tickets: E-033, E-031, E-043, T-323, T-327.
