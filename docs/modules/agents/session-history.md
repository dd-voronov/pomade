---
doc: docs/modules/agents/session-history.md
audience: engineers, product
holds: the Session history dialog — browsing and resuming past agent sessions by scanning each agent's own session store; how it is built
kind: reference
---

# Session history — browse & resume past agent sessions

**Module:** `agents` · **UI:** the Session history button (a clock) in the tab-strip action cluster (`Session history`,
testid `session-history-open`) → the dialog `Session history — <project name>` (`session-history`) ·
**Code:** `src/main/agent-service.ts` (scanning, `validateSession`), `src/main/session-watcher.ts`
(live id capture), `src/main/codex-rollout.ts`,
`src/renderer/modules/terminal/SessionHistory.tsx` (dialog) · **e2e:** `agent-history.spec.ts`,
`session-capture.spec.ts`

## What it does

The Session history button opens this dialog when the agents app (`pomade-agents`) is not installed; with the app
installed it opens the app's Sessions view instead ([agent-roster](./agent-roster.md) "Launch and in-shell
detection").

For the **active project**, the dialog lists prior agent sessions — grouped by agent (group title =
the agent's name), newest first, each row showing a first-message preview, start time (month, day,
hour, minute) and the first 8 characters of the session id — with a **Resume** button that reopens
that conversation in a new agent tab (and closes the dialog). Pomade keeps **no database of its
own**: every open of the dialog is a live, read-only scan of each agent's **own on-disk session
storage**, so sessions started outside Pomade (a `claude` run in iTerm in the same folder) appear
too, and nothing needs syncing. While scanning it shows "Scanning agent storage…"; with nothing found,
"No past sessions found for this project’s agents."

**Store semantics** (when a session file is created, what `/clear` and resume do to its id, how to
pair a file with a live PTY) are probe-documented in [session-stores](./session-stores.md) — read that before writing
anything that *watches* these stores.

## How it works

**Which agents are scanned.** The project's visible agents (its `visibleAgents` filter over the
roster — [agent-roster](./agent-roster.md)). Agents with no sessions for this project are omitted from the dialog.

**Claude-style stores** (built-in claude AND specialised folder agents). Claude Code writes one JSONL
transcript per session under `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`, where `configDir`
is the roster agent's session folder (`~/.claude` or `$CLAUDE_CONFIG_DIR` for the built-in,
`Agents/<name>/` for a folder agent — they run with `CLAUDE_CONFIG_DIR` pointed there). The routing
test is structural — "does `<configDir>/projects/` exist?" — not the roster kind, which is what lets
custom folder agents surface their sessions exactly like the built-in. `<encoded-cwd>` is claude's own
scheme: the project's absolute path with every non-alphanumeric character replaced by `-` (verified
against real `~/.claude/projects` directories).

**Codex.** Codex writes session JSONLs under `<configDir>/sessions/` (`~/.codex` or `$CODEX_HOME`) in
nested date folders, not keyed by cwd — so Pomade walks the whole tree and keeps files whose line 0
(`session_meta`) records `cwd` equal to the project root. The session id is line 0's `payload.id`, and
a sub-agent's rollout is not listed — it is part of its parent's session ([session-stores](./session-stores.md)).

**Preview & timestamp.** The preview is the first *real* user message in the transcript (skipping
injected content — lines starting with `#`, `<`, or `Caveat:`, such as Pomade's own file-context
instruction), truncated to 160 characters, or `(no preview)`. The start time: claude-style — the
first `timestamp` in the file, else the file's modified time; codex — the rollout's creation time
(`payload.timestamp` on line 0), else the first `timestamp` in the file, else empty.

**Resume.** Launches a normal-mode agent tab whose command is the roster command plus the resume
args — `claude --resume <sessionId>` / `codex resume <sessionId>`
(`modules/terminal/agent-commands.buildAgentCommand`). The tab starts Bound to that session and
persists `resumeSessionId`, so a restored-then-relaunched tab resumes the same session rather than
starting a fresh one.

**Live capture.** `resumeSessionId` for a **fresh-started** agent is learned by the main-process
watcher (`src/main/session-watcher.ts`), which is **prompt-gated and tab-owned**: an id binds ONLY
inside a bounded ±window opened by a first-prompt submit in a specific tab (or via an explicit
resume/claim) — never by output recency, which mis-attributes ids whenever two agents share one cwd.
A clear (Claude `/clear`, `/reset`, `/new`; Codex `/clear`, `/new`), a fork (Claude `/branch`, Codex `/fork`) and
in-session `/resume` re-enter the bind cycle via keystroke detection; an
ambiguous case is REFUSED (the tab shows a clickable ⚠️ with a manual-entry popover). Same stores,
same encodings, same read-only rule as the scan above — the file layouts are in [session-stores](./session-stores.md),
the full attribution design in [session-attribution](./session-attribution.md).

## Boundaries worth knowing

- **Exact-cwd matching.** Sessions are keyed by the directory the agent ran in. Pomade launches
  agents at the project root, so those match; a session someone started in a *subfolder* of the
  project is stored under a different cwd and is not listed.
- **Scan cost.** Claude-style scans read one directory per project. The codex scan walks all of the
  codex sessions folder and reads every rollout in full; with a very large codex session store the
  "Scanning agent storage…" phase is the visible cost.
- **Every transcript is a session.** The scan lists each `.jsonl` of the store, so the background
  copy Claude's `/fork` starts shows up as a session of its own (its first message is the copied
  conversation's); the live-capture side never binds it to a tab
  ([session-attribution](./session-attribution.md) "Disambiguation").
- **Read-only.** Pomade never writes to, renames, or deletes agent session files.

Tickets: E-025, T-113.
