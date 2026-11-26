---
doc: docs/contracts/git-state-and-history.md
audience: engineers
holds: the read side of the git namespace — repo discovery and status (GitSnapshot), the deleted-file view, diffs, commit history, file history, revision reads, pomade-git run summaries and Runner's scheduled jobs
kind: reference
---

# Git: state and history (read side)

Every `git.*` read takes `repo` as a **workspace-relative repo root that the git-state service
discovered** (`''` = the workspace root); anything else rejects "Not a repository in this
workspace.". Every path in and out is workspace-relative POSIX unless stated. Reads run with
`GIT_READ_ENV` (`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`), `--no-optional-locks`, a 30 s
timeout and a 64 MB buffer (`runGit` / `runGitBuffer`, `git-core/repo-state.ts`). The write side is
[git-operations](./git-operations.md).

## Repo state — `git.state`, `git:state`

```ts
git.state(): Promise<GitSnapshot>                     // resolves after the first discovery + status pass
git.onState(cb: (s: GitSnapshot) => void): () => void // EV 'git:state', the full snapshot after every run

interface GitSnapshot { repos: RepoState[] }          // sorted by root
interface RepoState {
  root: string; name: string /* folder name; the workspace repo is named after the workspace folder */
  absPath: string
  remoteUrl: string | null      // pickRemoteUrl: the upstream's remote, else origin, else the first; null = local only
  branch: string | null; head: string | null /* full oid; null before the first commit */
  upstream: string | null; ahead: number; behind: number   // 0 without an upstream
  hasCommits: boolean
  changes: GitFileChange[]; ignored: { path: string; dir?: boolean }[]
  ignoredHolders: string[]      // ignored folders holding a nested repo (kept out of `ignored`)
  operation?: 'rebase' | 'merge' | 'cherry-pick' | 'revert'   // stopped half-way
  error?: string                // status failed; other fields empty
}
interface GitFileChange {
  path: string
  status: 'modified' | 'new' | 'conflict' | 'renamed' | 'deleted'
  from?: string                 // renamed: old path
  dir?: true                    // an untracked folder reported as one entry
  staged?: 'all' | 'part'       // index = disk / staged then edited; absent = nothing staged
}
```

- **Producer** (`main/git-state.ts`, `GitStateService`; discovery and status in
  `git-core/repo-state.ts`): started by the first `git.state()`, stopped and restarted with the
  workspace. Discovery walks `DISCOVERY_MAX_DEPTH` = 3 levels, recording every folder holding a
  `.git` entry and continuing below it; it skips `INDEX_IGNORE_NAMES`, every dot-folder and
  symlinked folders. Status: one `git status --porcelain=v2 -z --branch --renames
  --untracked-files=normal --ignored=matching` per repo, 4 repos at a time. Remotes:
  `git config -z --get-regexp '^remote\..*\.url$'`, cached per repo, re-read on discovery and when
  that repo's `.git/config` changes.
- **Nearest repo wins**: a repo's entries at or inside a nested repo are dropped; an ignored folder
  holding a nested repo becomes an `ignoredHolders` entry; an untracked folder holding a nested repo
  is re-listed file by file.
- **Freshness** — no watcher of its own. `tapWorkspaceChanges` (a working-file change refreshes its
  nearest repo; changes in folders git ignores are skipped; renaming a repo root or an ancestor
  re-runs discovery) and `tapGitMetaChanges` (`.git` itself and `.git/{index, HEAD, packed-refs,
  MERGE_HEAD, config, refs/…}`, lock files skipped: a `.git` appearing or vanishing re-runs
  discovery, metadata refreshes that repo). Coverage = the entries the tree or an app holds. Window
  focus → full re-discovery, at most every 3 s. Refreshes coalesce in 250 ms, never overlap; a
  change during a run schedules one follow-up.
- Pure helpers (`shared/git-state.ts`): `parseStatusV2`, `parseRemotes`, `pickRemoteUrl`,
  `scopeRepoChanges`, `buildGitTreeIndex` (statusOf / hasChangesInside / isIgnored / ghostsIn),
  `summarizeScope`, `repoOfPath(snapshot, path)` (the deepest repo holding a path),
  `reposInScope(snapshot, scopeRoot)` (null = all; a project = repos at or under its root plus the
  enclosing repo unless it ignores the project folder). Apps get the snapshot through `toAppRepo`,
  which copies only the documented fields (`staged`, `operation`, `head`, `ignoredHolders` stay
  Pomade's) — see [host-api-frames](./host-api-frames.md) §"Git state".
- `AppSettings.showGitStatus` turns the tree's git marks off; the service runs regardless.

## Deleted files and diffs

```ts
git.isRepo(rel: string): Promise<boolean>     // rel is inside a repo within the workspace
git.fileDiff(rel: string, mode: 'working-vs-head' | 'head-vs-prev'): Promise<FileDiff>   // { a, b, labelA, labelB }
git.committedFile(rel: string): Promise<CommittedFile>   // { kind: 'text', content, commit } | { kind: 'binary', size, commit }
git.restoreFile(rel: string): Promise<void>
```

`committedFile` = `git show HEAD:<path>` in the owning repo (a NUL in the first 8000 bytes ⇒
binary); rejects with no commits or when the path is not in HEAD. `restoreFile` rejects when
anything exists at the path (rule 8), else `git restore --source=HEAD --staged --worktree -- <path>`
and refreshes the repo.

## History

```ts
git.log(repo, opts: { all: boolean; skip: number }): Promise<LogPage>
git.unpushed(repo): Promise<LogPage>
git.mergeCommits(repo, hash): Promise<LogPage>
git.commit(repo, hash): Promise<CommitDetails>
git.fileLog(repo, path, opts: { all: boolean; skip: number; via?: string; candidates?: string[] }): Promise<FileLogPage>
git.fileAt(repo, rev, path): Promise<RevisionFile>     // RevisionFile: see documents.md

interface CommitSummary { hash; parents: string[]; author; authorEmail; date /* ms */; subject; job?: string }
interface LogPage { commits: CommitSummary[]; more: boolean }
interface CommitFile { path /* repo-relative */; status: 'added' | 'modified' | 'deleted' | 'renamed'; from?; added: number | null; removed: number | null /* null = binary */ }
interface CommitDetails extends CommitSummary { message; files: CommitFile[]; totalFiles?: number }
interface FileCommit extends CommitSummary { path /* ws-relative at that commit */ }
interface FileLogPage { commits: FileCommit[]; more: boolean; renamedFrom?: string }
```

- `log` — `LOG_PAGE_SIZE` = 50 per page, first-parent unless `all`. It starts from HEAD with no
  upstream, else from `merge-base --all HEAD @{upstream}`, so commits not pushed are left out (no
  merge base → empty). `unpushed` — `@{upstream}..HEAD`, every commit, capped at `UNPUSHED_LIMIT`
  (200); empty without an upstream. `mergeCommits` — what a merge brought in, capped at
  `MERGE_INNER_LIMIT` (200). `commit` — header, full message, and files against the first parent
  (`--root` for a root commit), capped at `COMMIT_FILES_LIMIT` (2000). Only a 7–64 hex hash is
  accepted.
- `fileLog` — `git log --follow --name-status` over `path`, 50 per page. `via` reads the history of
  that committed path instead (git's rename source, or an earlier page's `renamedFrom`). With no
  commits of its own on page one and `candidates` (files deleted in the working tree), the most
  similar HEAD version (`textSimilarity` ≥ `RENAME_SIMILARITY` 0.5, ≤ 50 candidates, ≤ 512 KB each)
  is followed and returned as `renamedFrom`.
- `fileAt` — `path` (inside `repo`) at `rev` (hash or `HEAD`): absent, binary (NUL in the first 8000
  bytes), over 2 MB (`COMPARE_MAX_BYTES`, answered from the size without reading) or an unknown
  revision come back as kinds, never as errors.
- `LOG_FORMAT`'s seventh field is the `Pomade-Job` trailer → `CommitSummary.job`.
- Pure helpers (`shared/git-history.ts`): `parseLog`, `parseCommitHeader`, `parseCommitFiles`,
  `parseFileLog`, `remoteLabel(url)` (`host/owner/name`, credentials dropped), `isMerge`,
  `relativeTime`, `commitDateLabel`, `textSimilarity`.

## pomade-git runs and Runner's jobs

```ts
git.runs(): Promise<Record<string, GitRunSummary>>    // by repo root; starts watching the run log
git.runSeen(repo): Promise<void>                      // the failed run is seen; its mark goes for good
git.scheduled(repo): Promise<RepoJob[] | null>
git.onRuns(cb): () => void                            // EV 'git:runs', the same record
git.onJobs(cb): () => void                            // EV 'git:jobs', no payload: ask `scheduled` again

interface GitRunSummary { at: number; job: string | null; result: GitRunResult; unseenFailure: boolean }
```

- Main `git-runs.ts` reads `pomade-git`'s run log (`<userData>/git/runs.jsonl`, rotated to
  `runs.1.jsonl` past 1 MB; entries `{ kind: 'run', at, job, result }` | `{ kind: 'seen', at, path }`),
  matching discovered repos by real path. `git:runs` fires on every log change and when the
  discovered repo set changes. `runSeen` appends a `seen` entry.
- `scheduled` asks `pomade-runner`'s `jobs.forRepo` (`callAppApi`, 1500 ms, validated by the kit's
  `checkRepoJobs`); `null` when Runner is absent or not answering (no Scheduled line).
  `git:jobs` fires when Runner starts or stops serving (`app-broker.onServingChange`) or publishes
  `pomade-runner:jobs.changed` or `pomade-runner:runs.changed` (a run ended; no payload is read) — one platform
  bus connection opened at the first `scheduled` subscribes to both, and either event moves the same `jobsEpoch`.
- Kit contract (`pomade-kit/protocol`): `GitRunOp`, `GitRunStatus`, `GitRunResult`, `GitRunOutput`,
  `REPO_JOBS_APP_ID` (`pomade-runner`), `REPO_JOBS_METHOD` (`jobs.forRepo`), `RepoJob`,
  `checkRepoJobs`. Pomade's own model: `shared/git-runs.ts` (`summarizeRuns`, `parseRunLogLine`,
  `JOB_TRAILER` = `Pomade-Job`, `autoCommitMessage`, exit codes 0 / 1 / 2).

Tickets: E-036, E-037, E-038, E-042, T-228.
