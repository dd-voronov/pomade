---
doc: docs/contracts/git-operations.md
audience: engineers
holds: the write side of git — the preview/run operation entry, every GitOpRequest, previews, results and failures, the safety rails and repo lock, conflicts, In progress and branch reads, worktrees, git-core and the pomade-git command
kind: reference
---

# Git: operations, rails, branches, conflicts

Every change to a repository goes through **one entry**: `git.preview` then `git.run`
(`main/git-ops.ts`, dispatching to `git-operator.ts` and `git-branches.ts`). The git logic lives in
`src/git-core/` (no Electron; lint rule `pomade/git-core-imports` refuses `electron`, `**/main/*`,
`@renderer/*`), shared by main and the `pomade-git` command. The read side is
[git-state-and-history](./git-state-and-history.md).

## Entry points

```ts
git.preview(repo: string, req: GitOpRequest): Promise<GitOpPreview>   // read-only; connect-remote asks the remote (ls-remote)
git.run(repo: string, req: GitOpRequest, opts: GitOpRun): Promise<GitOpResult>
git.folderInfo(rel: string): Promise<FolderGitInfo>   // 'missing' | repo { remoteUrl } | inside { repoName, remoteUrl } | 'none'
git.initRepo(rel: string, message: string): Promise<InitRepoResult>   // git init + first commit: { commit: string | null, failure? }
git.rebase(repo): Promise<RebaseState | null>          // the rebase or merge stopped there; read-only
git.conflictFile(repo, path): Promise<ConflictFile>    // rejects when `path` has no open conflict
git.inProgress(repo): Promise<InProgress>              // read-only
git.branch(repo, branch: string): Promise<BranchDetails>   // `feature` or `origin/feature`; rejects when gone

interface GitOpRun { token: string; message?: string; background?: boolean }
```

- `run` holds a per-repo lock: a second call gets `busy`, except over a `background` run (honoured
  for `fetch` only — the repo view's quiet Fetch), which gives way. Inside the lock it re-reads the
  repo and refuses with `changed` when the preview's `token` (`repoToken`) no longer matches. A
  failure is a result, never a rejection.
- `message` is needed by `commit-push` (only when something is to be committed), `commit-staged` and
  `merge-branch`.

## Requests

```ts
type GitOpRequest =
  | { op: 'commit-push'; push?: boolean }            // false = commit only
  | { op: 'sync-push' } | { op: 'undo-commit' }
  | { op: 'discard'; paths: string[] | null }        // ws-relative change paths; null = all
  | { op: 'connect-remote'; url: string }
  | { op: 'stage' | 'unstage'; paths: string[] }     // whole files
  | { op: 'commit-staged'; push?: boolean }          // the index only
  | { op: 'create-branch'; name: string }
  | { op: 'switch-branch'; branch: string }          // local, or remote/name; '' = only list
  | { op: 'fetch' } | { op: 'pull' } | { op: 'publish' }
  | { op: 'rebase'; onto: 'main' | 'upstream' }      // 'main' = local main else master; 'upstream' = @{u} as of the last fetch
  | { op: 'resolve-file'; path: string; resolution?: ConflictResolution }   // run needs `resolution`
  | { op: 'rebase-continue' } | { op: 'rebase-abort' }
  | { op: 'worktree-add'; branch: string }           // local, or remote/name
  | { op: 'merge-branch'; branch: string; mode: 'squash' | 'merge' }
  | { op: 'merge-continue' } | { op: 'merge-abort' }
  | { op: 'remove-landed'; branch: string }
  | { op: 'rebase-branch'; branch: string }
```

`GIT_OP_TITLE: Record<GitOp, string>`; `opTitle(req)` (`Commit`, `Commit staged & push`, else the
table).

## Previews and results

Every preview carries `{ op, repo, token, blocked: GitBlock | null }` (`GitBlock { message, copy? }`)
plus its own fields: `CommitPushPreview { files, branch, push: PushTarget | null, pushes, pushCommits, behind }`
· `SyncPreview { push, local }` · `UndoPreview { mode: 'undo' | 'revert', commit, merge, push }` ·
`DiscardPreview { items, skipped }` · `ConnectPreview { url, host, branches, name }` ·
`StagePreview { op, paths }` · `CommitStagedPreview { staged, others, branch, push, pushes, pushCommits }`
· `CreateBranchPreview { name, from, at, carried }` · `SwitchPreview { branch, branches: BranchChoice[],
local, carried, conflicts }` (blocked when the switch would replace uncommitted files) ·
`FetchPreview { remote, url, host }` · `PullPreview { push, local }` · `PublishPreview { push, commits }`
· `RebasePreview { onto, target, branch, theirs, mine }` · `ResolvePreview { path, others, stopped:
'rebase' | 'merge', pushes }` · `ContinuePreview { conflicts, commit, remaining, empty, pushes }` (`pushes`: where the
finished rebase is pushed — Get their changes, then push started it — else null) ·
`AbortPreview { branch, before, recorded }` · `WorktreeAddPreview { branch, local, path }` ·
`MergeBranchPreview { branch, mode, into, commits, subjects, files, worktree, agents }` ·
`MergeContinuePreview { branch, mode, conflicts }` · `MergeAbortPreview { branch, recorded }` ·
`RemoveLandedPreview { branch, worktree, landed: { by: 'reachable' } | { by: 'squash'; commit } | null,
remoteStays, remoteWhere }` · `RebaseBranchPreview { branch, target, theirs, mine, worktree }`.

```ts
interface PushTarget { remote; branch; url; host: RemoteHost; setUpstream: boolean }
interface RemoteHost { kind: 'github' | 'gitlab' | 'other' | 'local'; name; ssh; sshTarget }
type GitOpResult =
  | { ok: true; message: string; commit?: string
      paused?: { files: string[] }     // stopped on a conflict: the renderer opens the conflict tab
      landed?: { branch: string }      // a local branch landed: the renderer offers remove-landed
      worktree?: string }              // the folder made
  | { ok: false; failure: GitFailure }
interface GitFailure { kind; message; copy?; detail?; committed?; restored? }
// kinds: auth · not-found · remote-moved · remote-refused · network · timeout · conflict · busy · locked · changed · identity · blocked · other
```

Wording: `previewSentence(preview) → Seg[]` (`Seg = string | { term, text }`) and the glossary
(`shared/git-glossary.ts`, `GIT_GLOSSARY`) are the only source of git words in the UI.
`classifyGitError(text, { action, host, url })` turns git's output into a `GitFailure`.

## Rails (`git-core/rails.ts`, re-exported with `stateOf` and `withRepoLock` by `main/git-run.ts`)

- Every mutating git call: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
  `GIT_SSH_COMMAND=<the user's ssh command> -o BatchMode=yes`, `GIT_EDITOR` and
  `GIT_SEQUENCE_EDITOR=true`, stdin closed, time-bounded (`GIT_NET_TIMEOUT_MS` 60 s,
  `GIT_LOCAL_TIMEOUT_MS` 120 s; SIGTERM, SIGKILL after 2 s).
- **Never** `--force`, `reset --hard`, `branch -D`, `clean`, `stash`; `switch` without
  `--force` / `--merge`; an unmerged branch is never deleted.
- `discard` keeps every discarded file as a draft first (`git-discard`, and `git-discard-staged`
  when the staged version differed) — all or nothing (`recovery-store.keepDiscardedFiles`), limits
  `DISCARD_MAX_BYTES` 2 MB, `DISCARD_MAX_FILES` 500.
- Pull and Rebase need nothing uncommitted. Before a rebase starts, the repo's `fingerprint` is
  recorded (in memory, per repo) and `rebase-abort` is checked against it.
- A merge always starts `merge --no-ff --no-commit`; a squash finishes with `merge --quit` + `commit`.
  `remove-landed` only after a verified landing (tip reachable from main, or this session's squash
  record of exactly that tip): `worktree remove` without `--force`, then
  `update-ref -d refs/heads/<b> <tip>`. Merge, rebase and remove are blocked while an agent is live
  in the branch's checkout.
- **Repo lock** (`git-core/lock.ts`): `<gitDir>/pomade-operation.lock` (JSON `{ pid, title, at,
  background? }`), stale after `REPO_LOCK_STALE_MS`. A non-background caller asks a background
  holder to give way (`<gitDir>/pomade-operation.yield`) and waits up to 5 s; the holder's
  `yielded` signal aborts within 100 ms and stops its git like a timeout. The panel and the
  `pomade-git` command take the same lock.

## Conflicts (`shared/git-conflict.ts`)

```ts
type ConflictSide = { kind: 'text'; text } | { kind: 'absent' } | { kind: 'binary'; size } | { kind: 'too-big'; size }
type ConflictSegment = { kind: 'same'; text } | { kind: 'conflict'; theirs; base; yours }
interface ConflictFile { path; theirs: ConflictSide; base: ConflictSide; yours: ConflictSide; segments: ConflictSegment[] | null /* null = whole file */ }
interface RebaseState { repo; kind: 'rebase' | 'merge'; branch; onto; commit: { hash; subject } | null; step; total; conflicts: string[]; recorded }
type ConflictResolution = { kind: 'text'; content } | { kind: 'take'; side: 'theirs' | 'yours' }
```

**Theirs** = git's stage 2 (during a rebase, what the commits go on top of; in a merge, main);
**yours** = stage 3 (the commit being replayed; the branch landing). For a merge, `branch` = the
branch landing, `onto` = where it lands, `step`/`total` = 1; `resolve-file` on the last file commits
the merge. `CONFLICT_MARKER_SIZE` 31, `CONFLICT_MAX_BYTES` 2 MB.

## In progress and branches (`shared/git-branches.ts`)

```ts
interface InProgress { repo; main; rows: InProgressRow[] }    // local rows, then remote; each most recent first
interface InProgressRow { kind: 'worktree' | 'branch' | 'remote'; branch; tip; path; ahead; behind; activity; subject;
  uncommitted; current; agents: LiveAgent[]; upstream; pr: PullRequestLink | null; landed; session: BranchSession | null }
type LiveAgent = LiveAgentEntry   // kit: { agentId; cwd; state?: LiveAgentState; terminalPids?: number[] }
interface BranchSession { id; agentId; agentName; name: string | null; live: SessionLiveState; cwd; projectId: string | null }
interface BranchDetails { repo; branch; main; tip; base; commits: CommitSummary[]; more; files: CommitFile[] /* ws-relative */; totalFiles? }
```

- **Agents live** (`main/agents-live.ts#agentsLiveIn(folder)`): agents in Pomade's terminals whose
  launch folder is `folder` or inside it (real paths, `isAtOrBelow`), joined with the agents app's
  answer by `joinLiveAgents` (shared/git-branches.ts). The one source for In progress, the
  merge/rebase/remove blocks and the socket's `agents.liveIn`. A terminal's entry carries its shell's
  pid (`terminalPids`) and `readAgentState(scanner.state)` — `idle` only when the scanner reads idle,
  nothing while it reads `unknown` or has not read yet (the tab's dot starts idle; this does not). The
  join keeps one entry per agent and folder with the busiest state (working > not known > needs-you >
  idle), takes no `idle` from a run, and lets an app tab without `state` take the terminal's reading.
  In progress and the blocks count every entry regardless of `state`.
- **Agent sessions** (`main/agent-sessions.ts`): through the broker as the platform client (1500 ms,
  only while `pomade-agents` serves; `app-not-responding` silences the app for 10 s) —
  `sessions.liveIn` and `sessions.forRepo`, validated by the kit (`checkLiveIn`, `checkRepoSessions`);
  `pickBranchSession` prefers a live session, then the latest. Folders are sent real-pathed; remote
  rows get `session: null`.
- **Worktree folders**: `POMADE_WORKTREES_DIR`, else `<pomadeHome>/worktrees`, else (tests)
  `<userData>/worktrees` — a test run never uses the Owner's real home (`owner-paths.ts`); one folder per branch: `<root>/<repo>/<worktreeSlug(branch)>` (`-2`, `-3` when taken).
- `BRANCH_COMMITS_LIMIT` 200. `pullRequestUrl(remoteUrl, branch, base)` builds the GitHub / GitLab
  link.

## git-core and the `pomade-git` command

- Modules: `repo-state.ts` (discovery, status, remotes, `operationOf`), `rails.ts`, `lock.ts`,
  `commit.ts` (`commitAll`, `takeBackCommit`, index snapshot and restore), `sync.ts` (`catchUp`),
  `agent-processes.ts` (agent processes in a folder via `ps` + `lsof`, each with its ancestors' pids),
  `run-log.ts`,
  `command.ts` (`parseArgs`, `resolveRepos`, `runOne`, `main(argv, deps)`), `pomade-git.ts` (entry).
- Build: electron-vite's main build has two entries, `out/main/index.js` and `out/main/pomade-git.js`.
  `bin/pomade-git` runs the built entry under Node. The command folder's `pomade-git` shim sets
  `POMADE_HOME`, `POMADE_USER_DATA`, `ELECTRON_RUN_AS_NODE=1` and execs `process.execPath` on it
  ([host-api-socket](./host-api-socket.md) §"Commands").
- A result's `GitRunStep` has an optional `commits: number`, set only on a `pull` step whose outcome is
  `done` (`pullStep` in `command.ts`), in a `pull` run and in a `commit-push` run: the commits got from
  the remote, `0` when up to date. Every other step, and a pull that was skipped or failed, has no
  `commits` key; `detail` keeps its sentence ("got 2 commits from origin/main"). The kit's `isGitRunResult`
  accepts it absent or as a non-negative integer.
- The `agents` step (`agentCheck`; probe: `AgentProbe.pomade` = `agents.liveIn`'s entries, null with
  Pomade closed; `AgentProbe.processes` = `agentProcessesIn`) is skipped (`agent working: …`) for an
  entry whose `state` is not `idle` (absent included) and for an agent process unless it or an
  ancestor is a `terminalPids` shell of an `idle` entry. Done: `no agent working here`, with
  `— idle: <agent> in <cwd> (per Pomade)` naming idle entries. A needs-you entry reads
  `(per Pomade, waits for you)`.
- Each run appends to the run log ([git-state-and-history](./git-state-and-history.md)
  §"pomade-git runs"); its commits carry the `Pomade-Job` trailer.

Tickets: E-039, E-040, E-041, E-042, E-043, T-225.
