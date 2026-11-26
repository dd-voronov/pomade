---
doc: docs/modules/agents/session-attribution.md
audience: engineers, product
holds: how a tab learns which agent session it holds — prompt-gated, tab-owned session-id capture, the per-tab state machine, disambiguation, resume hardening, the Unbound UI
kind: reference
---

# Session attribution — prompt-gated, tab-owned session-id capture

**Module:** `agents` · **Code:** `src/main/session-watcher.ts` (the confirmer), `src/main/claude-transcript.ts` +
`src/main/codex-rollout.ts` (what a transcript says about its origin),
`src/main/pty-manager.ts` (launch signal + IPC), `src/renderer/stores/terminals-store.ts` (the
(re)bind cycle), `src/renderer/modules/terminal/useXtermSession.ts` (keystroke signals —
`attachGenuineInput`), `src/renderer/modules/terminal/UnboundPopover.tsx` +
`src/renderer/layout/TabStrip.tsx` (⚠️ UI) · **e2e:** `session-capture.spec.ts` (clear, `/branch`, claude `/fork`),
`session-capture-sticky-resume.spec.ts`, `session-bind-no-pane.spec.ts`, `revive.spec.ts`,
`session-unbound-ui.spec.ts`

## The principle

Pomade never *infers* which tab a session id belongs to from timing — it drives attribution from
signals it **owns**: every keystroke is routed to a specific tab's PTY, so Pomade knows which tab the
user prompted, `/clear`ed, or exited. The provider's on-disk store only *fills in the id value* for a
tab a user action already identified. When it is ambiguous, Pomade **refuses to bind and marks the
tab ⚠️ Unbound — never guesses** (a wrong bind feeds a wrong `--resume`, which appends the user's
input to another session's transcript: real corruption). PTY output plays no part in attribution —
TUIs stream constantly.

## Per-tab state machine (agent tabs)

- **Spawned** — agent CLI launched in the tab's PTY (button OR typed command; both flow through the
  zsh shim's exec marker). No id, nothing watching.
- **AwaitingId** — the user submitted a **first prompt** → a bounded, **bidirectional** ±window
  (`SESSION_BIND_WINDOW_MS`, 30 s each way, the one named tunable in `shared/types.ts`) opens on this
  tab's expected store.
- **Bound(id)** — a qualifying transcript was uniquely attributed → `resumeSessionId` +
  `bindState: 'bound'` persist immediately.
- **Unbound** — the window closed with nothing uniquely attributable (nothing appeared, or a true
  sub-second submit tie forced a refusal). The tab keeps working and shows the clickable ⚠️ mark; the
  only consequence is no auto-resume after a restart. Any later submit while the tab has no trusted
  id re-enters AwaitingId; `/clear`, exit-and-restart and manual entry also recover.
- **Resuming** — a relaunch or revive whose command carries `--resume <id>` (or `codex resume <id>`)
  **claims** that id at the exec marker (deterministic, windowless) and lands Bound.
- **→ plain Terminal** — the agent's foreground process returns to the shell (`/exit`, crash,
  Ctrl-C/D — the exec→prompt marker pair): the tab reverts to a terminal and its whole agent triple
  is cleared.

## The signals (all owned; none vendor-flag-dependent)

1. **Launch** — the exec marker names the agent (roster first-word match) and its **cwd-at-launch**
   (canonicalized with `realpath`, because the shim reports zsh's LOGICAL `$PWD` while CLIs key their
   stores on the physical `process.cwd()`). A `--resume <id>` / `codex resume <id>` argument claims
   the id on the spot.
2. **First-prompt submit** — detected on the genuine-input path only: `xterm.onKey` plus the
   capture-phase DOM `paste` listener; **never** `onData` (terminal auto-replies, mode-1003 mouse
   reports) and never PTY output. Best-effort line tracking: printable keys and pasted text append,
   Backspace trims, Esc/Ctrl+C/Ctrl+U discard, Shift/Alt-Enter is a newline; submit = plain Enter on
   a non-empty line. Imperfect detection degrades gracefully: a false window is harmless, a missed
   one resolves to Unbound. A launch prompt Pomade types for an app (`agentTabs.launch`) arms the
   window the same way.
3. **Session commands** — the per-agent vocabulary (`AGENT_SESSION_COMMANDS` in `shared/types.ts`,
   data not code), read off the submitted line by `agent-commands.ts#matchSessionCommand`: a line
   is a command when it equals it or is `<command> <argument>`. Claude and folder agents: clear =
   `/clear` · `/reset` · `/new`, fork = `/branch`, resume = `/resume`. Codex: clear = `/clear` ·
   `/new`, fork = `/fork`, resume = `/resume`. A clear or a fork re-enters AwaitingId at the *next*
   submit expecting a **new** transcript (the typed command is what the tab's session-change cause
   reports — [agent-tabs](./agent-tabs.md) "How the cause is derived"); in-session `/resume` is its
   own mode — it **adopts an existing** transcript (an explicit `<id>` argument validated on disk at
   that very submit, or the existing file that starts *growing* at the next submit). The last-known
   id is **kept** until a rebind succeeds (a restart in the gap resumes the pre-clear session — the
   best-known state). Claude's own `/fork` is not in the vocabulary: it copies the conversation into
   a background session and the tab keeps its session (see "Disambiguation").
4. **Session end** — process lifecycle (exec→prompt pair), not the `/exit` keystroke: revert and
   clear the triple. The agent's farewell line stays in scrollback as the manual-entry copy source
   and survives a restart for every agent tab launched or upgraded in this run
   ([panes-and-lifecycle](../terminal/panes-and-lifecycle.md) "Scrollback that survives a restart").

## Disambiguation (one store, many tabs)

- **Ownership invariant.** An id bound or claimed to one term is never a candidate for another while
  the ownership stands. Cross-project tabs on the same cwd are covered: the registry is keyed on
  (store dir, id) in main, across all projects. `/resume <id>` of a transcript another live tab owns
  is refused — the resuming tab goes Unbound — rather than double-binding one id.
- **Retired ids.** An id whose ownership was *released* this run (a clear or a fork orphaned it, its PTY died)
  is never an `await-new` candidate again — it is a known previous session, not anybody's new one —
  but stays adoptable *explicitly* (in-session `/resume`, a launch claim, the manual bind).
- **Submit-order pairing.** The AwaitingId tabs of a store form a queue by submit time; a new
  transcript binds the earliest still-open eligible window (files are born at first submission, so
  creation order follows submit order). Later submitters keep waiting for their own file.
- **The only refusal:** two submits closer than `SUBMIT_TIE_MS` (750 ms) — pairwise alignment would
  be a coin flip — send every tied tab to Unbound. So does a window expiring empty.
- **Background sessions (Claude).** A Claude transcript whose first message line carries a
  `sessionKind` is a session Claude runs in the background — the copy its `/fork` starts, also daemon
  sessions. It is never an `await-new` candidate: the tab that typed `/fork` keeps its own session,
  and the copy never binds to it or to a neighbouring tab whose window it falls in. The first
  message line (the first with a `uuid`; `mode`, `session-owner` and snapshot lines before it are
  skipped) decides, read once it is complete and cached per file (`claude-transcript.ts`). A
  transcript with no message line yet is read as neither background nor a fork: it stays a candidate
  and, if bound then, reports no parent.
- **Fork evidence.** A bind from an `await-new` window also reports the parent the new transcript
  records (`forkedFrom`): Claude — the first message line's `forkedFrom.sessionId` (the copied lines
  of a `/branch` transcript); Codex — line 0's `session_meta.forked_from_id`
  ([session-stores](./session-stores.md)). It travels with the bind (`pty:session-id`,
  [ipc-terminal](../../contracts/ipc-terminal.md) "Session attribution") to the cause an app hears.
- **Codex sub-agents.** A codex sub-agent's rollout is born inside its parent's turn, in the same
  cwd; it is never a candidate (line 0 marks it — [session-stores](./session-stores.md)). A codex
  candidate must also carry the tab's cwd in its `session_meta`.
- **Nothing is missed on disk.** The watcher polls the store (readdir + stat, every 1 s) while a
  window is open — it does not rely on file events, so a change macOS's FSEvents would coalesce or
  drop is still seen on the next tick, until the window binds or expires. With no window open nothing
  is polled, and a transcript appearing then belongs to nobody Pomade can identify. The codex walk is
  bounded (4 levels, 5 000 files). A missing store directory is the normal pre-first-message state,
  never an error. The watcher only reads: it never writes, renames or deletes session files.

## The persisted triple

`{ agentId (kind), cwdAtLaunch, resumeSessionId, bindState }` on `TerminalTab`, in
`.pomade/state/<projectId>.json`. `cwdAtLaunch` — not the live `cwd`, which every later `cd` moves —
resolves the store to watch, the store to validate against, and the directory a resume spawns in.
All fields ride the sticky-payload invariant: an un-revived tab round-trips them byte for byte.

## Resume hardening

On revive, an agent tab's persisted id is **validated** (`agents.validateSession`) against the store
keyed by its cwd-at-launch *before* anything spawns; an id the disk cannot back becomes an honest dead
pane with the id kept (Resume = the user's retry). Claim-known-first holds by construction: revives
claim at spawn, and windows only ever open on user submits — nothing can capture while a project sits
unopened.

## The ⚠️ Unbound UI

A clickable warning mark on a live unbound agent tab (`tab-unbound-<tabId>`, tooltip "Session not
identified — click to fix"), opening a popover (`unbound-popover`, title "Session not identified"):
**manual session-id entry** (field `Session id`, **Bind**; validated against the tab's expected store
— a nonexistent id is refused inline with "No session with this id in this tab’s store.", never
bound), **Ignore** (silences the mark for THIS unbound session only — runtime state in
`unbound-store`, cleared on the next bind), **Cancel** (keep the mark). Escape also closes it. See
[tab-strip](../tabs/tab-strip.md) for where it renders.

## Accepted residue (all → Unbound, never a wrong bind)

Two genuinely simultaneous fresh submits in one store; a session launched but never prompted (nothing
exists to resume); an agent launched by a path the exec marker cannot name (indirect script exec).

Tickets: E-025, T-113, T-127, T-327.
