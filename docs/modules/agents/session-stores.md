---
doc: docs/modules/agents/session-stores.md
audience: engineers, product
holds: per-provider reference for agent session stores — file layout, when a transcript appears, what the id does across a clear, a fork and a resume (the session commands per provider, the fork evidence each transcript carries), pairing a file with a PTY; probe evidence; what the capture design takes from it
kind: reference
---

# Agent session stores — layout, file timing, id lifecycle

**Module:** `agents` · **Consumers:** `src/main/agent-service.ts` (session scan and session validation
— see [session-history](./session-history.md)), `src/main/session-watcher.ts` (live session-id capture —
[session-attribution](./session-attribution.md)), `src/main/codex-rollout.ts` (a rollout's identity and parent), `src/main/claude-transcript.ts` (a transcript's parent and background mark) · **Probe scripts:**
scratch only (not kept; the method is reproduced at the bottom)

Pomade never asks an agent for its session id — it reads the agent's **own on-disk store**. This
doc is the per-provider reference for *what that store does and when*: when the file appears,
what the id does across a clear, a fork and a resume, whether a resume redraw raises attention, and how to
pair a file with the pty that owns it. **Adding a session-store-backed provider is not done until
it has a filled-in section here.**

**Marking convention.** Every claim below is either:

- ✅ **probe-verified 2026-08-18** — real CLI in a pty under Pomade's `childEnv()`
  (`TERM_PROGRAM=Apple_Terminal`, `POMADE=1`, IDE/parent-session vars stripped), fresh scratch
  cwd, real API turns. Versions: **claude 2.1.234**, **codex-cli 0.147.0**, macOS 25.5.
- 📖 **command list** — read from the agent binary's own command list, not probed against a real
  session: which commands exist and what the agent says they do. The transcript shapes the code
  reads for a fork (`forkedFrom`, `sessionKind`, `forked_from_id`) are of this kind unless a row says
  otherwise.
- ⚠️ **inferred** — not probed; reasoning given.

---

## Provider: Claude Code (`kind: 'claude'`, and folder agents)

| Field | Value |
| --- | --- |
| Store root | `<configDir>/projects/<encoded-cwd>/` — `configDir` = `~/.claude` (built-in) or `Agents/<name>/` (folder agent, via `CLAUDE_CONFIG_DIR`) |
| `<encoded-cwd>` | the cwd's absolute path with every non-alphanumeric char → `-` ✅ |
| Transcript file | `<sessionId>.jsonl` — **the basename IS the session id** ✅ |
| Id format | UUIDv4 (random — carries no timestamp) ✅ |
| Also in that dir | `memory/`, and (in long-lived real config dirs) per-session `<sessionId>/` **directories** — a watcher MUST filter to `isFile() && .jsonl` ✅ |
| Message lines | `user` / `assistant` lines carry a `uuid`; the lines before the first message (`mode`, `session-owner`, `file-history-snapshot`, `queue-operation`) do not. The first message line is where a transcript says where it came from (below) |

### File-creation timing ✅

- **Nothing is written at launch.** Neither the `projects/<encoded-cwd>/` **directory** nor any
  `.jsonl` exists while the session sits at an idle prompt: 20 s idle after the trust prompt →
  directory still absent (probe p12: absent 12 s after trust; probe p3: no file through 20 s of
  idle). A watcher therefore cannot assume the directory exists — poll, or watch the parent
  `projects/` for the child dir.
- **The file (and its directory) appear on the first user submission** — measured **+0.6 s to
  +0.9 s** after Enter, before the answer streams back. First write is a small `mode` line
  (~83 B), immediately followed by a large `file-history-snapshot` (~28 KB in a scratch cwd), then
  the `user` line, then `assistant`.
- **A slash command counts as a submission**: submitting `/clear` as the very first input creates
  the file with only the `/clear` markers in it (probe p2).
- **The file also grows at `/exit`** (a `last-prompt` + `file-history-snapshot` flush) with **no
  user turn involved** — growth ≠ turn (probe p9).

**Consequence for capture:** an agent tab that was launched but never talked to has **no id in
existence anywhere** — not late, *nonexistent*. The "agent tab with no captured id → dead pane" case
([panes-and-lifecycle](../terminal/panes-and-lifecycle.md) "Restore & revive") is therefore the normal state of an
untouched agent tab, not a capture failure.

### Id lifecycle ✅

| Event | Effect on the store |
| --- | --- |
| First user submission | new `<newId>.jsonl` created, id minted then |
| Further turns | appended to the same file, same id |
| **`/clear`** | **NEW file + NEW session id**, created ~0.6 s after the `/clear` submit (83 B `mode` line, then the `/clear` command markers). The old file is **frozen** (mtime stops) and stays on disk, resumable. Every later turn lands in the new file. |
| **`claude --resume <id>`** | **SAME file, SAME id — appended.** No new file, no new id. Nothing at all is written at resume launch; the first write comes with the first turn of the resumed session (probe p8: `eea1d9f0…` 30 834 B → 34 157 B, new `user`/`assistant` lines carrying the *same* `sessionId`). |
| **in-session `/resume`** | The live session **switches, in the same pty, to the selected session's existing file and id** — the picker's highlighted entry became live, its old file resumed growing, and the previously-live file went quiet. **No new file is created.** So a tab's id can change mid-session without any process restart. |
| **`/branch`** | 📖 **NEW file + NEW session id, written at once** (no prompt needed), copying the conversation so far; the tab moves to the new session and the old file stays on disk. Every copied message line carries `forkedFrom: { sessionId: <parent>, messageUuid }`. Pomade reads `forkedFrom.sessionId` off the first message line; the shape is from the agent binary — no real `/branch` transcript has been captured. |
| **`/fork`** | 📖 Copies the conversation into a **background session** (a new transcript in the same store) and the tab **stays in its own session** — no rebind. The copy's message lines carry `sessionKind` (`"bg"` in the stand-in specs; Pomade treats any non-empty value as background). Daemon sessions are marked the same way. Pomade never binds such a transcript to a tab. |
| **`claude --session-id <uuid>`** | Forces that id: the transcript is `<uuid>.jsonl` — still created only at the first submission, not at launch. |
| **`claude --session-id <uuid>` with a uuid that already has a file** | **Hard refusal at launch**: prints `Error: Session ID <uuid> is already in use.` and exits **code 1** within ~0.3 s. The check is against the on-disk transcript, not process liveness — a *dead* session's uuid is equally unusable. |

`/clear`'s own help text corroborates the probe: *"Start a new session with empty context;
previous session stays on disk (resumable with /resume)"* ✅ (read off the live picker).

### Session commands (what Pomade reads off the typed line) 📖

`AGENT_SESSION_COMMANDS` (`src/shared/types.ts`) holds, per store family, the commands that move a
tab's session; a line matches one exactly or as `<command> <argument>`
(`agent-commands.ts#matchSessionCommand`). Claude and folder agents: clear = `/clear` · `/reset` ·
`/new`, fork = `/branch`, resume = `/resume`. Claude's `/fork` is deliberately absent: it does not move
the tab.

### Folder-agent parity ⚠️ inferred (probe blocked)

Same binary, and `CLAUDE_CONFIG_DIR` only relocates the store root, so timing and id lifecycle
should be identical. **Structural half is verified read-only:** real folder-agent config dirs
(`git-base/Agents/claude-libra/`, `claude-coder/`, `claude-pm/`) contain
`projects/<encoded-cwd>/<uuid>.jsonl` exactly like `~/.claude` ✅. The timing half could not be
probed: a **fresh** `CLAUDE_CONFIG_DIR` is unauthenticated and drops into an OAuth device flow
(probe p11), and probing an authenticated *real* agent dir would write into the user's config.

---

## Provider: Codex CLI (`kind: 'codex'`)

| Field | Value |
| --- | --- |
| Store root | `~/.codex/sessions/<YYYY>/<MM>/<DD>/` (not keyed by cwd) ✅ |
| Transcript file | `rollout-<local-ISO-launch-time>-<sessionId>.jsonl`, e.g. `rollout-2026-08-18T21-07-36-01a01645-9f25-7a42-98de-a8ab957b036b.jsonl` ✅ |
| Id format | **UUIDv7** — time-ordered, encodes the session's creation instant ✅ |
| The file's own id | line 0 `session_meta.payload.id` — equals the id in the filename ✅ |
| cwd binding | line 0 `session_meta.payload.cwd` (absolute) ✅ |
| Branch | line 0 `session_meta.payload.git.branch` (with `commit_hash`, `repository_url`), when the cwd is in a git repo ✅ |

### File-creation timing ✅

- **Nothing at launch**: 16 s idle at the prompt (after the trust prompt, MCP servers settled) →
  no rollout file anywhere under `~/.codex/sessions` (probe p10).
- **Created on the first user submission**, ~+0.9 s after Enter, and **line 0 is `session_meta`**,
  written at creation — so **cwd + id are available the instant the file exists** (no partial
  window to guard against).
- Two different clocks live in that first line, and the difference matters:
  - `session_meta.timestamp` = **19:07:52.552Z** — when the line was *written* (first submit);
  - `session_meta.payload.timestamp` = **19:07:36.616Z** — when the session was *created*
    (process launch), which is also what the **filename's timestamp** and the **UUIDv7 id**
    encode (local-time `21-07-36` = UTC `19:07:36`, machine at UTC+2).
  So codex, unlike claude, lets you match a file to a **launch time** even though the file itself
  was born later.
- Observed line types in a one-turn session: `session_meta` ×1, `turn_context`, `world_state`,
  `event_msg` ×n, `response_item` ×n ✅.

### Line 0 is the file's identity ✅ (read-only survey of real rollouts, codex-cli 0.136–0.153 and Codex Desktop)

- **Only line 0 names the file.** A file can hold more than one `session_meta` line:
  - a **sub-agent rollout** (`payload.source` is `{ "subagent": … }`, with `parent_thread_id`)
    repeats its **parent's** `session_meta` on line 1;
  - **Codex Desktop** (`payload.source: "vscode"`) writes the same-id `session_meta` again at
    later lines each time the session is resumed.
- **`payload.id` is the id; `payload.session_id` is not.** Older CLI and Desktop rollouts have no
  `session_id`, and a sub-agent's `session_id` is its parent's. `payload.id` equals the filename's
  id in every surveyed rollout.
- **Line 0 can be long** — tens of KB (it carries `base_instructions`); a reader reads up to its
  newline, not a fixed head.
- **Pomade's reading** (`src/main/codex-rollout.ts`): the session watcher, session validation and
  the session scan all take line 0's `payload.id` (`payload.session_id` only when `id` is missing) and `cwd`; a sub-agent rollout is part of its
  parent's session — never bound to a tab, never listed in Session history. The watcher also takes
  `payload.forked_from_id` as the fork's parent. The branch is not read.

### Id lifecycle ✅

| Event | Effect on the store |
| --- | --- |
| First user submission | rollout file created, `session_meta` (id + cwd) written as line 0 |
| **`codex resume <id>`** | **SAME file, SAME id — appended** (51 847 B → 61 621 B across the resumed turn). No new file, no new id, and **no second `session_meta` line** — the file still has exactly one, at line 0. |
| Resume in **Codex Desktop** | SAME file, SAME id — appended, with the same-id `session_meta` written again at the resume point (line 0 still names the file). |
| A **sub-agent** spawned in a turn | its own rollout, own id (line 0), `source.subagent`; line 1 repeats the parent's `session_meta`. |
| `/quit` | no visible id change |
| **`/fork`** | 📖 a rollout of its own whose line 0 `session_meta.payload.forked_from_id` names the parent session; the tab moves to it. Pomade reads `forked_from_id` (`codex-rollout.ts`, `forkedFrom`). |
| **`/clear`**, **`/new`** | 📖 start a new chat. What they write (a new rollout, its id and timing) was **not probed** ⚠️ — Pomade assumes a clear behaves like a first submission: a new rollout, `forked_from_id` absent. |

### Session commands 📖

codex: clear = `/clear` · `/new`, fork = `/fork`, resume = `/resume` (`AGENT_SESSION_COMMANDS`; matching as
for claude above).

---

## Resume redraw raises no attention ✅ (both providers)

Scanning **every byte** from launch to prompt-ready of a resumed session (the conversation
redraw), with Pomade's own detector semantics (standalone BEL, OSC 9 / 99 / 777):

| Provider | Bytes scanned | Standalone BEL | OSC 9 / 99 / 777 | Other |
| --- | --- | --- | --- | --- |
| `claude --resume <id>` | 4 470 | **0** | **0** | 1 × OSC 0/1/2 title |
| `codex resume <id>` | 7 251 | **0** | **0** | 11 × OSC 0/1/2 title |

`pty-manager`'s scanner deliberately ignores OSC 0/1/2 titles, so **auto-revive raises no
spurious attention**. (Fresh non-resume launches likewise emitted 0 BEL across every probe; the
OSC 8 hyperlink sequences seen in the OAuth screen are also not detected.) Unchanged by this
probe: claude's real bell is its **~60 s idle notification** (see [agent-providers](./agent-providers.md)) — a revived
session left unattended will still bell a minute later, which is honest "waiting for you".

---

## Correlation: pairing a file with the pty that owns it ✅

Probe p9 — two `claude` ptys in the **same** scratch cwd, deliberately launched in the opposite
order from the order they were used:

1. A launched, reached its prompt; B launched ~8 s later, reached its prompt. **No files existed.**
2. **B submitted first** → the first file to appear was **B's**, ~0.8 s after B's Enter.
3. A submitted → A's file appeared, ~0.8 s after A's Enter.
4. Only A submitted again → **only A's file grew** (30 816 → 34 584 B); B's mtime stayed frozen
   until B's own `/exit` flush.

**Verdict: launch-time proximity is NOT sufficient for claude.** A claude file is born at its
pty's **first submission**, an event whose ordering is entirely up to the user — a tab launched
first can be used last, and both files can be created minutes after both launches. Nothing in the
file's name, birth time, or content links it to a pty.

What *does* discriminate: **the appearance/growth must be attributed to a pty that was
demonstrably active just before it** (its own output stream moved / it just submitted). Growth
correlation is empirically reliable (step 4), with two caveats: the `/exit` flush grows a file
with no turn behind it, and a `/clear` or `/branch` creates a *second* file for the *same* pty.

Codex is easier ⚠️(inferred from the ✅ filename/UUIDv7 facts above): the filename and id encode
**launch** time, so a codex rollout can be paired to the pty whose launch instant matches (plus
the `session_meta.cwd` match Pomade already does).

---

## What the capture design takes from these facts

Capture is **prompt-gated and tab-owned** ([session-attribution](./session-attribution.md)): an id binds only inside a bounded
±window opened by a first-prompt submit in a specific tab, ownership is per-(store, id), and ambiguity
is refused, never guessed. The probe facts above shape it:

1. **The store may not exist yet.** For claude-style, the watcher polls `<configDir>/projects/` for
   `<encoded-cwd>/` and then its contents (filtering `isFile() && endsWith('.jsonl')` — `memory/` and
   per-session `<id>/` directories live there too). For codex it walks the date-nested tree (bounded)
   and matches `session_meta.cwd`.
2. **Capture is first-message-triggered, not launch-triggered.** No id can exist before the user's
   first submission. "No id yet" is not an error, and an untouched agent tab legitimately has nothing
   to resume.
3. **The live id can move without a process restart.** A clear or a fork (new file, new id) and
   in-session `/resume` (switch to another existing file/id) all re-arm the bind cycle; the last-known
   id is kept until a rebind succeeds.
4. **A new transcript says where it came from, and a background copy is not the tab's.** An
   `await-new` bind reports the parent the transcript records — claude `forkedFrom.sessionId` on the
   first message line, codex `forked_from_id` on line 0 — which is the fork evidence behind an app's
   session-change cause ([agent-tabs](./agent-tabs.md) "How the cause is derived"). A claude
   transcript whose first message carries `sessionKind` is a background session (claude's `/fork`
   copy) and is never an `await-new` candidate: it appears in the tab's store, inside its window, and
   must not take the tab.
5. **Launch-order pairing is unsound for claude.** A claude file is born at its PTY's first
   submission, so two tabs in one cwd cannot be paired by launch time or by output recency. Pairing
   follows **submit order** (a file is born at the first submission), and two submits closer than
   750 ms are refused. Growth after `/exit` (the flush) is never attributed: the watcher stops when
   the agent hands the shell back.
6. **`--session-id` injection is not used.** It forces the id at launch, but writes nothing until the
   first message, covers only Pomade-launched tabs, and a reused uuid is a hard launch failure
   (`Session ID … is already in use.`, exit 1). Resume always goes through `--resume <id>`.
7. **Revive is attention-safe** — no BEL/OSC 9·99·777 in a resume redraw, both providers ✅. No
   suppression window is needed for the redraw itself.
8. **The launch cwd is canonicalized.** The zsh shim reports the LOGICAL `$PWD` while the CLIs key
   their stores on the PHYSICAL `process.cwd()`, so main resolves the launch cwd with `realpath`
   before keying anything.

---

## How to reproduce (probe method)

Throwaway node scripts using the repo's `node-pty`, one **fresh scratch cwd per probe** so nothing
touches real project stores:

1. Rebuild Pomade's child env: apply `childEnv()`'s strip list (`TERM_PROGRAM*`, `CLAUDECODE`,
   `CLAUDE_CODE_*`, `CLAUDE_EFFORT`, `AI_AGENT`, `VSCODE_*`, `ELECTRON_RUN_AS_NODE`,
   `__CFBundleIdentifier`, `USER_ZDOTDIR`, …), **delete `ELECTRON_RENDERER_URL`**,
   then set `TERM_PROGRAM=Apple_Terminal`, `TERM_PROGRAM_VERSION=453`, `POMADE=1`,
   `TERM=xterm-256color`.
2. Spawn the real CLI in a 120×40 pty; append **every output byte** to a log file for later
   BEL/OSC scanning (strip CSI/OSC only for *matching*, never for scanning).
3. Answer the first-run folder-trust prompt programmatically — claude: *"Quick safety check … 1.
   Yes, I trust this folder"*; codex: *"Do you trust the contents of this directory?"* — both take
   a bare `\r` (option 1 is pre-selected). Note that the rendered text has its spaces eaten by
   cursor-positioning once CSI is stripped, so match on space-insensitive patterns.
4. Codex needs the message and the `\r` sent **separately** (~0.5 s apart); a single burst lands in
   the composer unsubmitted. Claude accepts `text\r` in one write, but the same split is safer.
5. Poll the store dirs every 200 ms (`readdir` + `stat`) and log every appear/grow with a
   timestamp; wait for output-quiet rather than fixed sleeps.
6. Keep prompts trivial (`Reply with exactly: OK`) and kill every pty at probe end.

Tickets: T-112, E-025, T-327.
