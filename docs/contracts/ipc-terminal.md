---
doc: docs/contracts/ipc-terminal.md
audience: engineers
holds: the pty, agents and attached IPC namespaces — terminal processes, the zsh shim markers, busy/cwd/exec/attention events, agent detection and live state, session attribution, revive and scrollback snapshots, the roster, agent-tab Host API methods, attached terminals
kind: reference
---

# IPC: pty, agents, attached

Main (`pty-manager.ts`) owns every pty for the app's life. A pty is killed only by the renderer's
tab-lifecycle reaper (no tab references its `termId` any more), a workspace switch
(`ptyManager.disposeAll()`), a project deletion, or quit (`killAll(true)`). Panes are views: a pane
never kills a pty from an effect cleanup. Store-side rules (reaper, revive, guards) are in
[stores](./stores.md) §"terminals-store".

## `pty` — invoke channels

```ts
create(opts: {
  cwd: string; tabId: string; projectId: string
  command?: string          // submitted once the shell is up
  presetInput?: string      // typed WITHOUT a CR at the first prompt marker; dropped when `command` is set
  snapshotKey?: string      // the TAB id: opts the term into scrollback persistence
  replaySnapshot?: boolean  // load that key's saved scrollback for the attach paint (revive only)
}): Promise<{ termId: string }>
write(termId, data) · resize(termId, cols, rows) · kill(termId)
sendExit(termId)                       // types '/exit\r'
list(): Promise<{ termId; alive; busy; cwd }[]>
buffer(termId): Promise<string>        // this pty's own ring buffer (RING_MAX 200 KB)
replay(termId): Promise<string>        // the attach paint; '' for an unknown term
forgetSnapshot(key): Promise<void>     // delete one tab's scrollback; idempotent
cwd(termId): Promise<string>           // shell's current dir (absolute); '' before the first prompt
armSessionWindow(termId, opts: { mode: 'await-new' | 'adopt-existing'; submitAt: number; resumeId?: string }): Promise<void>
claimSession(termId, sessionId): Promise<void>
setTab(termId, tab: PtyTabRef): Promise<void>
```

- **Shell.** Every pty is an interactive login `zsh -il` with `ZDOTDIR` pointing at a generated shim
  (`userData/zsh-integration/`) that sources the user's real startup files and adds two hooks
  printing invisible OSC 7879 markers: precmd → `pomade:prompt;<$PWD>`, preexec →
  `pomade:exec;<cmdline>` (capped at `EXEC_MARKER_CAP` bytes). Markers are parsed chunk-split-safe
  and never reach the terminal as text. An older shim's payloads (no `$PWD`, 160-byte cap) are still
  accepted.
- **cwd.** Every candidate is existence-checked; a stale absolute cwd falls back to the workspace
  root, then home, so `create` never fails on a deleted folder. `TerminalTab.cwd` may be
  workspace-relative (never `cd`-ed) or absolute; every reader handles both.
- **Child environment.** Inherited env minus `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`,
  `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE`, `ORIGINAL_XDG_CURRENT_DESKTOP`,
  `CHROME_DESKTOP`, `CLAUDECODE`, `CLAUDE_EFFORT`, `AI_AGENT`, `__CFBundleIdentifier`,
  `USER_ZDOTDIR`, `COPILOT_DEBUG_NONCE`, `TERM_SESSION_ID`, `POMADE_TAB_ID`, `POMADE_PROJECT_ID`,
  every `VSCODE_*` / `CLAUDE_CODE_*`, a VS Code `GIT_ASKPASS` / `ZDOTDIR`, and `GIT_EDITOR=true`.
  Then `TERM=xterm-256color`, `TERM_PROGRAM=Apple_Terminal`, `TERM_PROGRAM_VERSION=453`
  (the masquerade under which agent CLIs bell at turn end without flags), `POMADE=1`, `LANG`
  defaulted, the command-folder PATH and `POMADE_*` terminal vars
  ([host-api-socket](./host-api-socket.md) §"Commands"), and per pty `POMADE_TAB_ID` = `tabId`,
  `POMADE_PROJECT_ID` = `projectId` (`__workspace__` for the Workspace project). `ANTHROPIC_*`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COLORTERM` pass through. Pomade injects no agent flags.
- `replay(termId)` = restored scrollback + the restore divider + the ring buffer, in one reply
  (just the ring when nothing was restored). `buffer` stays "what this pty emitted".
- `setTab` is sent on every change of the tab a term runs in (creation, hydration, relaunch,
  cross-project move); main uses it to name the tab in `agentTab.exited`.

## `pty` — events (per terminal unless noted)

| Event | Payload | Subscription | Meaning |
|---|---|---|---|
| `pty:data` | `{ termId, data }` | `onData(termId, cb)` | output; appended to the ring before broadcast |
| `pty:exit` | `{ termId, exitCode }` | `onExit(termId, cb)` | the pty process ended |
| `pty:busy` | `{ termId, busy }` | `onBusy(termId, cb)` | a foreground command started (exec marker) / ended (next prompt) |
| `pty:cwd` | `{ termId, cwd }` | `onCwd(termId, cb)` | the prompt reported a **different** directory |
| `pty:exec` | `{ termId, command, agentLaunch }` | `onExec(termId, cb)` | a command ran; `agentLaunch` = it matched the roster (the same match as `pty:agent-start`) |
| `pty:agent-start` | `{ termId, agentId, agentName, command, cwd }` | `onAgentStart(termId, cb)` | a roster agent started at the shell; `cwd` = the realpath of the launch dir |
| `pty:agent-exit` | `{ termId }` | `onAgentExit(termId, cb)` | the agent ended, the shell lives on (prompt after a matched exec) |
| `pty:agent-state` | `PtyAgentState` | `onAgentState(cb)` (global) | the agent's live state changed |
| `pty:attention` | `{ termId }` | `onAttention(termId, cb)` | the terminal wants the user |
| `pty:session-id` | `{ termId, sessionId, forkedFrom? }` | `onSessionId(termId, cb)` — `cb(sessionId, forkedFrom \| null)` | a bind window resolved, or an explicit adopt; `forkedFrom` = the parent a new transcript records |
| `pty:session-unbound` | `{ termId }` | `onSessionUnbound(termId, cb)` | a bind window closed with no uniquely attributable id |

- **Agent detection.** An exec whose first word matches the visible roster
  (`agent-service.matchAgentCommand`) starts an agent; the prompt that follows ends it. Repeatable.
  The typed launch of an agent pty also raises `pty:agent-start`.
- **Live state.** At the agent start main builds the kit's `AgentStateScanner` (provider codex for a
  codex entry, else claude) at the term's size, broadcasts `idle`, then every change: `working`;
  `waiting` → `needs-you`; `idle` / `unknown` → `idle`. Disposed when the agent ends.
- **Attention** (`pty:attention`) is raised by a second scanner (`AttentionScanner`, from
  `pomade-kit/scanners`) on a standalone BEL outside any OSC, an OSC 9 / 99 / 777 notification
  (never an OSC 0/1/2 title or a 7879 marker), a **natural** pty exit (a requested kill never raises
  it), and the end of a foreground command that ran ≥ 2 s (`LONG_COMMAND_ATTENTION_MS`). The raw BEL
  still reaches xterm.
- The renderer subscribes the state-transition events (`onAgentExit`, `onAgentStart`,
  `onSessionId`, `onSessionUnbound`, `onExec`, `onCwd`, `onAttention`) in `terminals-store`, keyed by
  termId, so a transition lands whether or not the pane is mounted. Panes subscribe only
  xterm-facing events (`onData`, `onExit`, `onBusy`, their own `onCwd`).

## Session attribution

Main `session-watcher.ts` is a per-tab **confirmer**, never a guesser. It reads provider stores
read-only:

- claude family (built-in `claude` and folder agents): `<configDir>/projects/<encodeCwd(cwd)>/<id>.jsonl`;
- codex: `<configDir>/sessions/**.jsonl` (bounded walk), id and cwd from line 0's `session_meta`.

Store routing is by roster `kind` (`codex` ⇒ codex, else claude). The built-in entries honour
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` before `~/.claude` / `~/.codex`.

- A **first-prompt submit** in an agent tab (genuine keystrokes only — `xterm.onKey` and the DOM
  `paste` listener, never `onData` or output) calls `armSessionWindow(termId, { mode, submitAt })`,
  opening a bidirectional ±`SESSION_BIND_WINDOW_MS` (30 s) window on that tab's store.
  `await-new` (fresh session, a clear, a fork): a new transcript born inside the window.
  `adopt-existing` (in-session `/resume`): an existing transcript growing in the window, or the
  explicit `resumeId` validated on disk and adopted at once. Command vocabulary:
  `AGENT_SESSION_COMMANDS` ([types](./types.md)), read by `agent-commands.ts#matchSessionCommand`.
- An `await-new` bind reports the parent the new transcript records as `forkedFrom`: claude — the
  first message line's `forkedFrom.sessionId` (`claude-transcript.ts#readClaudeHead`, a `/branch`
  copy); codex — line 0's `session_meta.forked_from_id` (`codex-rollout.ts`). A claude transcript
  whose first message carries a `sessionKind` (a background session — the copy claude's `/fork`
  starts) is never an `await-new` candidate. Decided heads are cached per file.
- Disambiguation: an ownership registry keyed by (store dir, id) — an owned id is never a candidate;
  retired ids (released this run) are never `await-new` candidates but stay adoptable; submit order
  pairs waiting tabs with transcripts per store. The only refusals: submits closer than
  `SUBMIT_TIE_MS` (750 ms) and a window expiring empty → `pty:session-unbound`.
- `claimSession` seeds ownership for a manual bind (the renderer validates the id first). A resume
  command at the exec marker (`--resume <id>` / `<cmd> resume <id>`) is claimed too.
- **`resumeSessionId` writers** (and nothing else): a window bind (`handleSessionId`), the launch
  resume extraction (`handleAgentStart`), the validated manual bind (`bindSessionManually`), and the
  `/exit` downgrade (clears it). A restored, never-revived tab round-trips the field unchanged.

## Revive and scrollback

- **Sticky payloads.** A project that is never opened round-trips `.pomade/state/<projectId>.json`
  and its scrollback files byte-identical across app runs. Only a live pty signal in a tab may
  overwrite its payload; a revive swaps `termId`, confirms `status`, and (agents) records the resume
  command it launched.
- **Revive on project open** (`terminals-store.reviveProject`): a tab restored with persisted
  `status: 'live'` whose pty is gone gets a fresh pty — an agent with `resumeSessionId` (validated
  on disk against `cwdAtLaunch`) runs `buildAgentCommand(agent, id)`; an agent without one, whose
  roster entry is gone or whose id the disk cannot back becomes `status: 'dead'` (id kept); a
  terminal gets a plain shell at its cwd with `presetInput: lastExec` (never re-running
  `lastCommand`). Persisted `dead` stays dead. Revive raises no attention.
- **`lastExec`** is never pre-typed when its byte length equals any of `EXEC_MARKER_CAPS` (possibly
  cut) or it contains CR/LF.
- **Snapshots** — `<workspace>/.pomade/state/scrollback/<tabId>`, raw bytes, atomic writes,
  `pty-manager` owns the contents. A key that is not `^[A-Za-z0-9_-]{1,128}$` is refused (the term
  does not snapshot). A keyed term snapshots only while no agent runs in it (a launch `command`
  starts it non-snapshotting until that command's roster match resolves: no agent ⇒ it snapshots
  from then on, ring included; an agent start stops it and deletes the file; the `/exit` downgrade
  resumes it). `forgetSnapshot` drops the term's key, so nothing turns snapshotting back on. Persisted content = restored base + this run's ring, trimmed to `RING_MAX`; the
  divider (`\r\n` + dim `──── session restored ────` + `\r\n`, SGR only) is added at replay, never
  written. Cadence: 2 s idle (`SNAPSHOT_IDLE_MS`), at most 12 s after the first unsaved byte; a
  natural exit flushes at once; a requested kill writes nothing; quit and workspace teardown flush
  synchronously first. `gcSnapshots()` (boot and workspace ready) deletes every snapshot whose key
  is no tab id (`openTabs` ∪ `reopenStack`) in any state file.
- **Attach paint.** A pane calls `replay`, queues live `pty:data` until the paint is parsed (trimming
  the overlap), suppresses its `onData → pty.write` forward while xterm parses the paint (replies to
  recorded queries never reach the shell), then resets input modes in xterm only and leaves an
  alternate screen it was stranded in.

## `agents`

```ts
roster(): Promise<AgentInfo[]>
setCommand(agentId: string, command: string): Promise<AgentInfo>
sessions(agentId: string, cwdAbs: string): Promise<SessionRecord[]>
validateSession(agentId: string, cwdAbs: string, sessionId: string): Promise<boolean>
```

- `roster` — when the agents app (`pomade-agents`) is serving, its `roster.list` (1500 ms,
  validated whole by `checkRosterList`) is the roster and is remembered; otherwise the folder scan
  (built-in `claude`, `codex`, and `<workspace>/Agents/<name>/` folder agents with
  `configDir = Agents/<name>/`). An app entry maps to `kind: 'codex'` for provider codex, `'claude'`
  for id `claude`, else `'custom'`; `modes` default to `providerModes(provider)`.
  `.pomade/agents.json` overrides (`commands`, `hidden`) apply to either source. `resolved` comes
  from an interactive login-zsh `whence` of the command's first word. The pty data path uses the
  remembered roster and never waits on an app.
- `sessions` — session scan (for Session history), read-only. `validateSession` — the transcript exists for that cwd
  (claude: one stat; codex: bounded walk matching id + cwd).

## Agent tabs on the Host API

`agentTabs.list · setTitle · focus · launch · resume` (capabilities `agentTabs.read`,
`agentTabs.write`, `tabs.open`; app-facing contract: `docs/HOST-API.md` §4 `agentTabs`). Main
(`host-api-data.ts#callAgentTabs`) parses with the kit's `parseAgentTabsParams`, checks a launch or
resume `cwd` is a folder, and delegates; the renderer (`modules/agents/agent-tab-calls.ts`) serves:

- `list` — every agent tab, the Workspace project first, then Projects panel order (`agentTabInfo`: `exited` for a dead
  tab or a term from an earlier run; `sessionId` null while `unbound`; title source `user` /
  `app` / `default`). Unknown project → `not-found`.
- `setTitle` — `null` = the roster name in italics (`unnamed: true`), a string = `appTitled: true`;
  either clears `renamed`.
- `focus` — shows the project and activates the tab.
- `launch` — `startAgent(project, agent, undefined, { cwd, mode, prompt })`; unknown agent or
  unresolved command → `not-found`, unknown mode → `invalid-params`.
- `resume` — a live tab already bound to that agent and session is focused and returned; else the
  session is validated and resumed in a new tab.

`agentTab.changed` is published from the renderer (`events.platform`) for every change of the tab
set, a session, title, state or project ([events-and-notices](./events-and-notices.md)). A
`session` change carries `session: { cause, previousSessionId }` (`modules/agents/session-cause.ts`):
the terminals store notes the cause for the session it is about to bind — `bindCause(trigger,
forkedFrom, hadSession)` for a window bind, where the trigger is what armed the window (`launch`,
the typed `clear` / `fork` / `resume` command, or a `retry`); `resume` for a resume launch's
claim; none for a manual bind — and the diff takes it when that session reaches the list
(`unknown` when none was noted for it, and always when the session becomes `null`).

## `attached` — tabs on sessions an app's keeper holds

```ts
open(tabId: Id, session: SessionRef, cols, rows): Promise<void>   // follow; a followed tab is re-attached (fresh snapshot)
close(tabId): Promise<void>                    // detach; the session runs on
input(tabId, data) · paste(tabId, text) · resize(tabId, cols, rows)
stop(tabId): Promise<void>                     // the keeper ends it as stopped-by-you; rejects when not connected
action(session: SessionRef, action: string, projectId: Id): Promise<void>   // attachedTab.action to the owning app only
onEvent(tabId, cb: (e: AttachedEvent) => void): () => void                 // EV 'attached:event' (AttachedEventPayload)
```

- Main `attached-terminals.ts`: one kit `followSession` per tab (`app: 'pomade'`, role `viewer`) on
  `<userData>/run/keepers/<appId>.sock` (folder created 0700), reconnecting after keeper updates and
  restarts. Every keeper message is broadcast as `attached:event`. Live output and deltas run
  through an `AttentionScanner`; a live exit with reason `exited`, `crashed`, `time-limit` or
  `lost-in-keeper-crash` is attention too, never the exit of a session that ended before the attach.
- `input` carries only what the user caused (keystrokes, mouse, focus) — the keeper answers the
  program's terminal queries. `paste` is bracketed by the keeper when the program asked.
- `tabs.openAttached` (Host API data method, capability `tabs.open`, delegated): an open tab on the
  same reference in the target project is focused (a given title replaces its title, `renamed:
  true`), else a new tab opens right of the active one.
- With-Pomade and always-on backends get `POMADE_KEEPER_SOCKET` in their environment; commands do not.

Tickets: E-005, E-011, E-020, E-022, E-025, E-033, E-034, P-018, T-044, T-113, T-114, T-115, T-116, T-123, T-128.
