---
doc: docs/modules/git/pomade-git.md
audience: engineers, product
holds: the pomade-git command (operations, rails, result, exit codes), its run log and how Pomade shows runs and scheduled jobs; the git-core module layout
kind: reference
---

# `pomade-git` — git operations as a command, and scheduled jobs in the Git panel

**Module:** `git` · **UI:** the [Git panel](./git-panel.md)'s repo rows (last run, Scheduled line, badge) and History (automatic-commit wording) · **Code:** `src/git-core/` (the command and the git logic the
main process shares), `src/shared/git-runs.ts`, `src/main/git-runs.ts`, `src/renderer/modules/git/ops/git-runs-store.ts`,
`src/renderer/modules/git/panel/RepoList.tsx`, `bin/pomade-git` · **e2e:** `pomade-git.spec.ts` · **Unit:**
`src/git-core/*.unit.test.ts`, `src/shared/git-runs.unit.test.ts` · **Contract:** [contracts/git-operations](../../contracts/git-operations.md) "git-core and the pomade-git command", [contracts/git-state-and-history](../../contracts/git-state-and-history.md) "pomade-git runs and Runner's jobs", [HOST-API](../../HOST-API.md) §4
"Platform reads of app APIs"

## What it does

Git operations run headless — from `pomade-runner`'s Git jobs, a terminal or an agent, with Pomade open or
closed — on the same rails as the Git panel, and report a structured result. Runner owns *when*; git owns
*what*. Pomade shows each repo's last run on its row, marks a failed one until the user looks, words the
automatic commits in History, and — when Runner is installed and answers — shows which jobs target the repo.

## The command

```
pomade-git <commit-push | pull | push | fetch> <repo…> [--json] [--job <name>] [--message <text>]
           [--wait <seconds>] [--stable]
```

- **Repo** — its name as the Git panel shows it (the folder name: `Knowledge`, `Pomade`; the workspace-root repo
  is the workspace folder's name), resolved by the same discovery the panel uses against the workspace Pomade
  recorded in its home (`<home>/workspace`, or `POMADE_WORKSPACE`); or a path (absolute, `./…`, `~/…`, or one that
  exists from the current folder). A name two repos share is refused with both paths; an argument that does not resolve is a **failed** result with the
reason and an empty `path` (it is not written to the run log).
- **Where it is.** A Pomade writes `pomade-git` into its command folder at start (`~/.pomade/bin`, a dev Pomade's
  `~/.pomade-dev/bin`): a shim that runs the built `out/main/pomade-git.js` with Pomade's own runtime
  (`ELECTRON_RUN_AS_NODE`), with that Pomade's home and user data. It works with Pomade closed. A source checkout
  also has `bin/pomade-git` (Node; needs `npm run build`), which targets the dev Pomade unless `--stable`.
- **Options.** `--json` prints the structured result; `--job "<name>"` (Runner passes it; one line, 1–100
  characters) words the automatic commit and adds a `Pomade-Job: <name>` trailer; `--message` (`-m`) replaces the
  default message (commit-push only); `--wait` is how long a busy repo is waited for (default 30 s, `0` = not at
  all); `--stable` picks the stable Pomade's workspace and user data instead of the dev Pomade's (only the source
  checkout's `bin/pomade-git` defaults to the dev one). `-h` / `--help` prints the usage and exits 0.

| Operation | Steps, in order |
|---|---|
| **commit-push** | agents → commit (if anything changed) → pull (fetch + rebase onto the upstream; skipped when the branch is not on the remote yet) → push |
| **pull** | agents → pull (fetch + rebase); only on a repository with nothing uncommitted |
| **push** | push this branch's commits (`-u` to its own name when it is not on the remote yet) |
| **fetch** | fetch the branch's remote (else `origin`, else the only remote) |

commit-push, pull and push refuse a repo with a rebase, merge, cherry-pick or revert in progress and one on a
detached HEAD (**failed**, with what to do); commit-push also refuses a conflicted file, and commit-push and pull a
missing git identity when they would commit or replay commits.

**The automatic commit.** `Committed automatically · job "Knowledge twice daily" · 2026-11-09 13:00`, blank line,
`Pomade-Job: Knowledge twice daily`. Without `--job`: `Committed automatically · 2026-11-09 13:00`. It commits
every change the repo's state lists — nested repos' files stay theirs, as in the panel.

## Rails

The panel's rails (`git-core/rails.ts`): no prompt can ever wait (`GIT_TERMINAL_PROMPT=0`, ssh in BatchMode, every
step bounded, stdin closed), never `--force`, `reset --hard`, `clean` or stash. On top:

- **One operation per repo** — the lock in the repo's git directory (`pomade-operation.lock`, `git-core/lock.ts`),
  shared with the Git panel's operations across processes. A busy repo is waited for, then **skipped** as busy. A
  holder whose process is gone, or a lock older than any operation can run, blocks nobody. The Git panel's
  background fetch is asked to give way and does (at most 5 s, whatever `--wait` says).
- **Agent live here?** commit-push and pull ask (push and fetch touch no file): Pomade over its socket
  (`agents.liveIn` — the agents in its terminals and, when `pomade-agents` answers, its agent tabs and Runner runs,
  each with its `state` when known and the shells of the Pomade terminals it runs in, `terminalPids`)
  **and** the `claude` / `codex` processes on this Mac whose
  working directory is in the repo (`ps` + `lsof`, `git-core/agent-processes.ts`, each with its ancestors' pids) —
  an agent started in another terminal app counts too. The repo is **skipped**, reason `agent working`, for an
  agent that works or waits for the person: an entry whose `state` is `working` or `needs-you`, or has none
  (not known counts as working), and an agent process unless it runs under the terminal shell of an entry Pomade
  reports `idle`. An `idle` agent and the process in its own terminal do not hold the repo; the step is done
  and names them (`no agent working here — idle: claude in <cwd> (per Pomade)`). Pomade closed → only the
  processes answer, and every one holds the repo. The Git panel's own checks (In progress, Merge / Rebase /
  Remove) count every live agent, idle or not ([branches and worktrees](./branches-and-worktrees.md) "Agent live here?").
- **Nothing changes unless their changes can come in.** commit-push fetches first; a fetch that fails (network,
  auth) commits nothing. A rebase that conflicts is aborted, the commit this run made is taken back
  (`reset --soft` to the commit before + the index file restored byte for byte) and the repository is checked
  against the state before the run (HEAD, branch, index, full status): **failed**, *"Their changes conflict with
  yours in notes.md. Nothing was changed — the repository is exactly as before, and nothing was pushed."* — or, when
  the check finds a difference, it says so and what differs.
- **A push that fails keeps the commit** (and the changes that came in): the reason starts *"Committed a1b2c3d, but
  it was not pushed: …"*; the next run pushes it.

## The result

`--json` prints `GitRunOutput { op, job, at, results: GitRunResult[] }` (the type and its check `isGitRunOutput` are in
`pomade-kit/protocol`, for Runner), one result per repo argument:

```ts
interface GitRunResult {
  repo: string                    // the panel name
  path: string                    // absolute (real path); '' when the argument did not resolve
  op: 'commit-push' | 'pull' | 'push' | 'fetch'
  status: 'done' | 'skipped' | 'failed'
  reason: string | null           // null when done; 'agent working', 'busy — …', or the failure in words
  steps: GitRunStep[]             // { step: 'agents' | 'commit' | 'pull' | 'push' | 'fetch'; outcome: 'done' | 'skipped' | 'failed'; detail: string; commits?: number }
  commit: string | null           // the full hash of the commit this run made and kept
}
```

A `GitRunStep` is `{ step, outcome, detail, commits? }`: `commits` (a non-negative integer) is set only on a `pull`
step that is `done` — in a `pull` run and in a `commit-push` run — and counts the commits got from the remote,
`0` when up to date; `detail` keeps the sentence (*got 2 commits from origin/main*). Every other step has no
`commits` key.

Without `--json`, one block per repo: `Knowledge · Commit & push · done`, then a line per step.

**Exit codes:** `0` every repo done or skipped · `1` a repo failed · `2` the command line was wrong (nothing ran).

## In Pomade

- **The run log.** Every repo's result is appended to `<userData>/git/runs.jsonl` (machine-local; rotated to
  `runs.1.jsonl` past 1 MB), with Pomade open or closed. Pomade watches it.
- **The repo row** (All repositories / a project's repos) shows the last run under the remote line:
  `Commit & push done 13:00 · committed a1b2c3d`, `… skipped 13:00 · agent working`, or the failure in red, its
  reason on up to two lines. Its hover lists the job, the reason and every step.
- **The badge.** A failed run marks the Git strip icon and the repo row — at once when Pomade is open, at
  the next launch when it was closed — until the repo is opened. Opening it writes a `seen` line into the log, so
  the badge does not come back.
- **History** shows a commit carrying `Pomade-Job:` as *Committed automatically · job "<name>" · 13:00* (its full
  subject on hover).
- **Scheduled line (rule 7).** When `pomade-runner` is installed and serving, each row asks it "which jobs target
  this repo" (`jobs.forRepo`, HOST-API §4) and shows one line per job: *Scheduled: Commit & push · 13:00, 20:00 —
  edit in Runner*; the hover gives the next and last run; **edit in Runner** opens Runner's tab at the job's
  route. Runner absent, not answering within 1.5 s, or answering something else → no line. Asked when the row
  shows, when the window regains focus, and when Runner starts or stops serving or publishes `jobs.changed`
  (its jobs changed) or `runs.changed` (a run ended, moving a job's next and last run) — the panel listens once
  for all rows.
- **Reveal.** A repo's `path` from a run result is what an app passes to `git.reveal` to bring that repo's row
  into view ([Git panel](./git-panel.md) "Reveal a repo").

## Module layout (git-core)

`src/git-core/` is the git logic with no Electron dependency (D4): the main process and the command use the same
code. Lint refuses an `electron`, main-process or renderer import there.

| File | What |
|---|---|
| `repo-state.ts` | discovery, a repo's state, remotes, read-only git calls (`main/git-state.ts` schedules and broadcasts them) |
| `rails.ts` | running git without prompts, steps, the token and fingerprint, push targets, explicit pushes (`main/git-run.ts` re-exports them and adds `stateOf` / `withRepoLock`) |
| `lock.ts` | the cross-process repo lock |
| `commit.ts` | commit every listed change; take a commit back |
| `sync.ts` | rebase onto the upstream, aborting and checking a failure (the command's pull) |
| `agent-processes.ts` | agent processes in a folder, each with its ancestors' pids (also `agents.liveIn`'s path test) |
| `run-log.ts` | the run log on disk |
| `command.ts` | the command: arguments, repo names, the operations, output |
| `pomade-git.ts` | the entry: environment, the socket probe; built to `out/main/pomade-git.js` |

Tickets: E-042, T-199, T-248, T-320, T-321, T-322, T-323.
