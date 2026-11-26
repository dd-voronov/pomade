// Pomade — E-039: git operations that change a repository — the shared model. Main
// (main/git-ops.ts) runs them; the renderer (modules/git/ops/) previews and starts them. Pure: no
// I/O, no Electron, no React; pinned by git-ops.unit.test.ts.
//
//   Every operation is two calls: `preview` says exactly what will happen (or why it cannot), and
//   `run` does it — only if the repo is still as the preview saw it (`token`).
//
//   remoteHost(url)                    GitHub / GitLab / a host name / a local path, for wording
//   classifyGitError(text, ctx)        git's stderr → a plain-language GitFailure
//   identityBlock()                    "git doesn't know who you are" + what to run
//   previewSentence(preview)           the preview line, as text with glossary terms marked
//   discardLine(item)                  one file's line in a discard preview
//
// E-040 adds the operator layer: staging, Commit staged, branches (create, switch), Fetch, Pull,
// Publish branch, Rebase, and the conflict tab's Mark resolved, Continue and Abort.
// E-041 adds branches and worktrees: Check out to a worktree, Merge into main (squash or merge),
// the merge's Continue and Abort, Remove a landed branch and its worktree, Rebase a branch onto main.

import type { LandMode, LiveAgent } from './git-branches'
import type { ConflictResolution } from './git-conflict'
import { remoteLabel } from './git-history'
import type { GlossaryTerm } from './git-glossary'

// ── Requests ──────────────────────────────────────────────────────────────────

export type GitOpRequest =
  /** Commit every change, then push. `push: false` = commit only — nothing goes to the remote. */
  | { op: 'commit-push'; push?: boolean }
  | { op: 'sync-push' }
  | { op: 'undo-commit' }
  /** `paths`: ws-relative change paths from the snapshot; null = every change. */
  | { op: 'discard'; paths: string[] | null }
  | { op: 'connect-remote'; url: string }
  /** `paths`: ws-relative change paths, staged or unstaged whole. */
  | { op: 'stage'; paths: string[] }
  | { op: 'unstage'; paths: string[] }
  /** Commit what is staged, nothing else. `push: true` = then push; by default nothing is pushed. */
  | { op: 'commit-staged'; push?: boolean }
  /** Create `name` from HEAD and switch to it. */
  | { op: 'create-branch'; name: string }
  /** A local branch name, or a remote-only branch (`origin/feature`): a local one following it is
   *  made. `''` = not picked yet (the preview then only lists the branches). */
  | { op: 'switch-branch'; branch: string }
  | { op: 'fetch' }
  /** Get their commits and rebase onto them; a conflict stops in the conflict tab. */
  | { op: 'pull' }
  /** The first push of a branch, upstream set. */
  | { op: 'publish' }
  | { op: 'rebase'; onto: RebaseOnto }
  /** Mark one conflicted file resolved (the last one also continues the rebase). The preview needs
   *  no `resolution`; the run does. */
  | { op: 'resolve-file'; path: string; resolution?: ConflictResolution }
  | { op: 'rebase-continue' }
  | { op: 'rebase-abort' }
  /** A local branch, or a remote-only one (`origin/feature`), checked out in a new folder outside
   *  the repository; the repository's own checkout is untouched. */
  | { op: 'worktree-add'; branch: string }
  /** Land a local or remote branch on main from the repository's own checkout (which must be on
   *  main); run takes `message`. A conflict stops the merge for the conflict tab. */
  | { op: 'merge-branch'; branch: string; mode: LandMode }
  /** Finish the merge stopped on a conflict: commit it (one commit for a squash). */
  | { op: 'merge-continue' }
  | { op: 'merge-abort' }
  /** Remove a landed branch and its worktree folder. */
  | { op: 'remove-landed'; branch: string }
  /** Put a branch that is not the checked-out one on top of main, in its worktree (or a
   *  temporary one when it has none). */
  | { op: 'rebase-branch'; branch: string }

/** What Rebase puts the branch on top of: the local main branch (`main`, else `master`), or the
 *  branch's upstream as of the last fetch. */
export type RebaseOnto = 'main' | 'upstream'

export type GitOp = GitOpRequest['op']

/** What an operation is called in buttons, toasts, dialog titles and the "still running" refusal. */
export const GIT_OP_TITLE: Record<GitOp, string> = {
  'commit-push': 'Commit & push',
  'sync-push': 'Get their changes, then push',
  'undo-commit': 'Undo last commit',
  discard: 'Discard changes',
  'connect-remote': 'Connect remote',
  stage: 'Stage',
  unstage: 'Unstage',
  'commit-staged': 'Commit staged',
  'create-branch': 'New branch',
  'switch-branch': 'Switch branch',
  fetch: 'Fetch',
  pull: 'Pull',
  publish: 'Publish branch',
  rebase: 'Rebase',
  'resolve-file': 'Mark resolved',
  'rebase-continue': 'Continue the rebase',
  'rebase-abort': 'Abort, back to before',
  'worktree-add': 'Check out to a worktree',
  'merge-branch': 'Merge into main',
  'merge-continue': 'Finish the merge',
  'merge-abort': 'Abort the merge',
  'remove-landed': 'Remove branch and worktree',
  'rebase-branch': 'Rebase onto main'
}

/** What an operation is called for this request: a commit names whether it pushes ("Commit",
 *  "Commit staged & push"). */
export function opTitle(req: GitOpRequest): string {
  if (req.op === 'commit-push' && req.push === false) return 'Commit'
  if (req.op === 'commit-staged' && req.push === true) return 'Commit staged & push'
  return GIT_OP_TITLE[req.op]
}

/** What `run` takes besides the request: the preview's token, and the commit message.
 *  `background` (Fetch only — ignored for any other operation): the repo view's quiet fetch, which
 *  gives way to any operation the user asks for instead of making it wait or refusing it. */
export interface GitOpRun {
  token: string
  message?: string
  background?: boolean
}

// ── Previews ──────────────────────────────────────────────────────────────────

export type HostKind = 'github' | 'gitlab' | 'other' | 'local'

export interface RemoteHost {
  kind: HostKind
  /** `GitHub`, `GitLab`, a host name (`git.example.com`), or `the remote` for a local path. */
  name: string
  /** The remote reached over ssh (`git@…`, `ssh://…`). */
  ssh: boolean
  /** `git@github.com` — what `ssh -T` checks; null when not ssh. */
  sshTarget: string | null
}

/** Where a push goes. */
export interface PushTarget {
  /** The remote's name (`origin`). */
  remote: string
  /** The branch on the remote (`main`). */
  branch: string
  url: string
  host: RemoteHost
  /** The branch has no upstream yet: the push creates it there and sets it (`-u`). */
  setUpstream: boolean
}

/** Why an operation cannot run, in plain words; `copy` is what the copy button copies. */
export interface GitBlock {
  message: string
  copy?: string
}

interface PreviewBase {
  repo: string
  token: string
  /** Set when the operation cannot run now; the rest of the preview is then informational. */
  blocked: GitBlock | null
}

export interface CommitPushPreview extends PreviewBase {
  op: 'commit-push'
  /** Uncommitted files the commit takes (all of them). */
  files: number
  branch: string | null
  /** Where a push goes. Null = no remote: the commit stays on this Mac. */
  push: PushTarget | null
  /** This run pushes: asked to, and there is a remote. */
  pushes: boolean
  /** Commits a push sends, the new commit included. */
  pushCommits: number
  /** Commits the upstream has that this branch lacks, as of the last fetch: a push is turned down
   *  until they are got. */
  behind: number
}

export interface SyncPreview extends PreviewBase {
  op: 'sync-push'
  push: PushTarget | null
  /** This branch's commits not on the upstream. */
  local: number
}

export interface UndoPreview extends PreviewBase {
  op: 'undo-commit'
  /** `undo`: not pushed — the commit goes away, its changes back as uncommitted (`reset --soft`).
   *  `revert`: pushed — a new commit cancels it and is pushed. */
  mode: 'undo' | 'revert'
  commit: { hash: string; subject: string } | null
  merge: boolean
  push: PushTarget | null
}

export type DiscardAction = 'restore' | 'delete' | 'bring-back' | 'unrename'

export interface DiscardItem {
  /** ws-relative path of the file as it is now. */
  path: string
  action: DiscardAction
  /** `unrename`: the name it goes back to. */
  from?: string
  /** A staged version that differs from the file is kept too. */
  staged?: boolean
}

export type DiscardSkipReason = 'binary' | 'too-big' | 'not-utf8' | 'too-many'

export interface DiscardSkip {
  path: string
  reason: DiscardSkipReason
}

export interface DiscardPreview extends PreviewBase {
  op: 'discard'
  items: DiscardItem[]
  /** Files that stay as they are — Pomade could not keep a copy of them. */
  skipped: DiscardSkip[]
}

export interface ConnectPreview extends PreviewBase {
  op: 'connect-remote'
  url: string
  host: RemoteHost
  /** Branches the remote has (0 = an empty repository). */
  branches: number
  /** The name the remote is added under. */
  name: string
}

export interface StagePreview extends PreviewBase {
  op: 'stage' | 'unstage'
  /** ws-relative paths the run stages / unstages. */
  paths: string[]
}

export interface CommitStagedPreview extends PreviewBase {
  op: 'commit-staged'
  /** The staged files the commit takes (ws-relative). */
  staged: string[]
  /** Changes that stay uncommitted (unstaged files, and unstaged edits of staged ones). */
  others: number
  branch: string | null
  /** Where a push goes. Null = no remote. */
  push: PushTarget | null
  /** This run pushes after the commit: asked to, and there is a remote. */
  pushes: boolean
  /** Commits a push sends, the new commit included. */
  pushCommits: number
}

export interface CreateBranchPreview extends PreviewBase {
  op: 'create-branch'
  name: string
  /** Where it starts: the current branch's name, or a short hash (detached). */
  from: string | null
  /** Its commit (short hash); null before the first commit. */
  at: string | null
  /** Uncommitted changes that come along. */
  carried: number
}

/** A branch Switch branch offers. */
export interface BranchChoice {
  /** What the request names: `feature`, or `origin/feature` for a branch only on the remote. */
  name: string
  /** True for a branch only on a remote (switching makes a local one following it). */
  remote: boolean
  current: boolean
  /** Its last commit: when (ms) and its subject. */
  date: number
  subject: string
}

export interface SwitchPreview extends PreviewBase {
  op: 'switch-branch'
  branch: string
  /** Every branch to pick from: local ones first (newest first), then remote-only ones. */
  branches: BranchChoice[]
  /** A remote-only branch: the local name made for it (it follows `branch`). */
  local: string | null
  /** Uncommitted changes that come along. */
  carried: number
  /** Uncommitted files the switch would replace (ws-relative): the switch is blocked until they
   *  are committed or discarded — Pomade never hides changes away. */
  conflicts: string[]
}

export interface FetchPreview extends PreviewBase {
  op: 'fetch'
  /** The remote looked at (the upstream's, else origin, else the only one). */
  remote: string | null
  url: string
  host: RemoteHost
}

export interface PullPreview extends PreviewBase {
  op: 'pull'
  push: PushTarget | null
  /** This branch's commits not on the upstream (as of the last fetch). */
  local: number
}

export interface PublishPreview extends PreviewBase {
  op: 'publish'
  push: PushTarget | null
  /** Commits that go there for the first time. */
  commits: number
}

export interface RebasePreview extends PreviewBase {
  op: 'rebase'
  onto: RebaseOnto
  /** What the branch goes on top of, as named (`main`, `origin/main`); null when there is none. */
  target: string | null
  branch: string | null
  /** Commits on the target this branch does not have. */
  theirs: number
  /** This branch's commits not on the target — the ones replayed. */
  mine: number
}

export interface ResolvePreview extends PreviewBase {
  op: 'resolve-file'
  path: string
  /** Other files whose conflict is still open. */
  others: string[]
  /** What stopped: a rebase, or a merge landing a branch (E-041) — the last file finishes it. */
  stopped: 'rebase' | 'merge'
  /** Where the finished rebase is pushed (`origin/main`) — Get their changes, then push started
   *  it; null otherwise. */
  pushes: string | null
}

export interface ContinuePreview extends PreviewBase {
  op: 'rebase-continue'
  /** Files whose conflict is still open (blocked while any). */
  conflicts: string[]
  /** The commit being replayed (yours). */
  commit: { hash: string; subject: string } | null
  /** Commits still to replay after this one. */
  remaining: number
  /** Combined, the commit changes nothing: it is left out. */
  empty: boolean
  /** Where the finished rebase is pushed (`origin/main`) — Get their changes, then push started
   *  it; null otherwise. */
  pushes: string | null
}

export interface AbortPreview extends PreviewBase {
  op: 'rebase-abort'
  /** The branch as it goes back, and its commit before the rebase (short hash). */
  branch: string | null
  before: string | null
  /** Pomade recorded the state before this rebase and checks the abort against it. */
  recorded: boolean
}

export interface WorktreeAddPreview extends PreviewBase {
  op: 'worktree-add'
  branch: string
  /** A remote-only branch: the local branch made for it (it follows `branch`). */
  local: string | null
  /** The new folder (absolute). */
  path: string
}

export interface MergeBranchPreview extends PreviewBase {
  op: 'merge-branch'
  branch: string
  mode: LandMode
  /** The branch work lands on (`main`); null when there is none. */
  into: string | null
  /** Its commits main does not have. */
  commits: number
  /** Their subjects, oldest first — the message box's prefill. */
  subjects: string[]
  /** Files the landing changes on main. */
  files: number
  /** The worktree it is checked out in (absolute), if any. */
  worktree: string | null
  /** Agents live in that worktree: the merge waits. */
  agents: LiveAgent[]
}

export interface MergeContinuePreview extends PreviewBase {
  op: 'merge-continue'
  /** The branch being landed, when known. */
  branch: string | null
  /** How it lands: known when Pomade started the merge; null = a merge commit (git's own). */
  mode: LandMode | null
  conflicts: string[]
}

export interface MergeAbortPreview extends PreviewBase {
  op: 'merge-abort'
  branch: string | null
  recorded: boolean
}

export interface RemoveLandedPreview extends PreviewBase {
  op: 'remove-landed'
  branch: string
  /** Its worktree folder (absolute), removed with it. */
  worktree: string | null
  /** How the landing was verified: the tip is in main, or Pomade's squash commit (short hash). */
  landed: { by: 'reachable' } | { by: 'squash'; commit: string } | null
  /** A remote branch of the same name that stays (`origin/feature`), named so nobody expects it gone. */
  remoteStays: string | null
  /** Where that remote lives (GitHub, GitLab, a host, a path). */
  remoteWhere: string | null
}

export interface RebaseBranchPreview extends PreviewBase {
  op: 'rebase-branch'
  branch: string
  target: string | null
  theirs: number
  mine: number
  /** Where the rebase runs: its worktree (absolute), or null for a temporary one. */
  worktree: string | null
}

export type GitOpPreview =
  | CommitPushPreview
  | SyncPreview
  | UndoPreview
  | DiscardPreview
  | ConnectPreview
  | StagePreview
  | CommitStagedPreview
  | CreateBranchPreview
  | SwitchPreview
  | FetchPreview
  | PullPreview
  | PublishPreview
  | RebasePreview
  | ResolvePreview
  | ContinuePreview
  | AbortPreview
  | WorktreeAddPreview
  | MergeBranchPreview
  | MergeContinuePreview
  | MergeAbortPreview
  | RemoveLandedPreview
  | RebaseBranchPreview

// ── Results ───────────────────────────────────────────────────────────────────

export type GitFailureKind =
  | 'auth'
  | 'not-found'
  | 'remote-moved'
  | 'remote-refused'
  | 'network'
  | 'timeout'
  | 'conflict'
  | 'busy'
  | 'locked'
  | 'changed'
  | 'identity'
  | 'blocked'
  | 'other'

export interface GitFailure {
  kind: GitFailureKind
  /** The plain-language message. */
  message: string
  /** What the copy button copies (a command to run, or git's own line). */
  copy?: string
  /** git's last stderr line, when the message is Pomade's wording. */
  detail?: string
  /** The commit landed before the step that failed (its short hash): it stays, unpushed. */
  committed?: string
  /** A conflict was aborted and the repo verified exactly as before. */
  restored?: boolean
}

export type GitOpResult =
  /** `paused`: a rebase (Pull, Rebase, Continue) stopped on a conflict in these files (ws-relative)
   *  — the conflict tab takes over; Abort puts everything back. */
  /** `landed`: a branch landed on main (Merge into main, or the merge's Continue) — the renderer
   *  offers to remove it and its worktree. `worktree`: a folder Check out to a worktree made. */
  | { ok: true; message: string; commit?: string; paused?: { files: string[] }; landed?: { branch: string }; worktree?: string }
  | { ok: false; failure: GitFailure }

/** A folder's relation to git, for the project dialog. */
export type FolderGitInfo =
  | { kind: 'missing' }
  | { kind: 'repo'; remoteUrl: string | null }
  /** Inside a repository that tracks it (not ignored there). */
  | { kind: 'inside'; repoName: string; remoteUrl: string | null }
  | { kind: 'none' }

export interface InitRepoResult {
  /** The first commit's short hash; null when none was made (`failure` says why). */
  commit: string | null
  failure?: GitFailure
}

// ── Limits ────────────────────────────────────────────────────────────────────

/** A discarded file is kept only when it is text (UTF-8, no NUL) up to this size — what Document
 *  History can show and restore. Anything else is not discarded. */
export const DISCARD_MAX_BYTES = 2 * 1024 * 1024
/** At most this many files per discard; past it nothing is discarded. */
export const DISCARD_MAX_FILES = 500
/** A network step (fetch, push, ls-remote) gets this long before it is stopped. */
export const GIT_NET_TIMEOUT_MS = 60_000
/** A local step (commit with its hooks, rebase, revert) gets this long. */
export const GIT_LOCAL_TIMEOUT_MS = 120_000

// ── Hosts ─────────────────────────────────────────────────────────────────────

/** The host of a remote URL, for wording messages. */
export function remoteHost(url: string): RemoteHost {
  const u = url.trim()
  const scp = /^([^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u)
  const proto = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(u)
  let host: string | null = null
  let ssh = false
  let sshTarget: string | null = null
  if (proto && !/^file$/i.test(proto[1])) {
    host = proto[3].toLowerCase()
    ssh = /^(ssh|git\+ssh|ssh\+git)$/i.test(proto[1])
    if (ssh) sshTarget = `${proto[2] ? `${proto[2]}@` : ''}${host}`
  } else if (scp && !/^[a-z]:$/i.test(`${scp[2]}:`) && !u.startsWith('/') && !u.startsWith('.')) {
    host = scp[2].toLowerCase()
    ssh = true
    sshTarget = `${scp[1] ?? ''}${host}`
  }
  if (host === null) return { kind: 'local', name: 'the remote', ssh: false, sshTarget: null }
  if (host === 'github.com' || host.endsWith('.github.com')) return { kind: 'github', name: 'GitHub', ssh, sshTarget }
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return { kind: 'gitlab', name: 'GitLab', ssh, sshTarget }
  return { kind: 'other', name: host, ssh, sshTarget }
}

/** `GitHub (origin/main)` — where a push goes, for sentences. */
export function targetLabel(t: PushTarget): string {
  return `${t.host.kind === 'local' ? remoteLabel(t.url) : t.host.name} (${t.remote}/${t.branch})`
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** git's last stderr line worth showing: the last `fatal:`/`error:` line, else the last line. */
export function lastGitLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i--) if (/^(fatal|error):/i.test(lines[i])) return lines[i]
  return lines[lines.length - 1] ?? 'git failed without saying why.'
}

export interface ErrorContext {
  /** What was being done: sending commits, getting theirs, or checking a new remote. */
  action: 'push' | 'get' | 'check'
  host: RemoteHost
  url: string
}

const AUTH_PATTERNS = [
  /permission denied \(publickey/i,
  /permission denied, please try again/i,
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /invalid username or password/i,
  /http basic: access denied/i,
  /returned error: 40[13]/i,
  /host key verification failed/i,
  /permission to .+ denied to/i,
  /support for password authentication was removed/i,
  /you are not allowed to push/i
]
const NOT_FOUND_PATTERNS = [
  /repository not found/i,
  /does not appear to be a git repository/i,
  /the project you were looking for could not be found/i,
  /returned error: 404/i
]
const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /could not resolve hostname/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /network is unreachable/i,
  /failed to connect to/i,
  /no route to host/i,
  /connection reset by peer/i
]

function verb(action: ErrorContext['action']): string {
  return action === 'push' ? 'refused the push' : action === 'get' ? 'refused to send their changes' : 'refused access'
}

function authAdvice(host: RemoteHost): { text: string; copy: string } {
  if (host.ssh) {
    const target = host.sshTarget ?? 'git@github.com'
    return {
      text: `your SSH key was not accepted. Check it with \`ssh -T ${target}\` in a terminal.`,
      copy: `ssh -T ${target}`
    }
  }
  if (host.kind === 'github') return { text: 'not signed in. Run `gh auth login` in a terminal.', copy: 'gh auth login' }
  if (host.kind === 'gitlab') return { text: 'not signed in. Run `glab auth login` in a terminal.', copy: 'glab auth login' }
  return {
    text: 'not signed in. Sign in so that `git push` works for this repository in a terminal.',
    copy: 'git push'
  }
}

/** git's failure output (stderr, and push's porcelain stdout) → a plain-language failure. */
export function classifyGitError(text: string, ctx: ErrorContext): GitFailure {
  const detail = lastGitLine(text)
  const host = ctx.host
  const where = host.kind === 'local' ? remoteLabel(ctx.url) : host.name
  if (/index\.lock|unable to create .*\.lock/i.test(text)) {
    return {
      kind: 'locked',
      message: 'Another git program is working in this repository right now (a terminal or an agent). Try again in a moment.',
      detail,
      copy: detail
    }
  }
  if (/\[rejected\]/.test(text) && /fetch first|non-fast-forward|behind its remote/i.test(text)) {
    return {
      kind: 'remote-moved',
      message: `${where} has commits you don’t have yet — someone pushed in the meantime.`,
      detail,
      copy: detail
    }
  }
  const remoteRejected = /\[remote rejected\][^(]*\(([^)]*)\)/.exec(text)
  if (remoteRejected) {
    return {
      kind: 'remote-refused',
      message: `${where} refused the push: ${remoteRejected[1]}.`,
      detail,
      copy: detail
    }
  }
  if (AUTH_PATTERNS.some((p) => p.test(text))) {
    const a = authAdvice(host)
    return { kind: 'auth', message: `${where} ${verb(ctx.action)} — ${a.text}`, copy: a.copy, detail }
  }
  if (NOT_FOUND_PATTERNS.some((p) => p.test(text))) {
    if (host.kind === 'local') {
      return { kind: 'not-found', message: `There is no repository at ${remoteLabel(ctx.url)}.`, detail, copy: detail }
    }
    const a = authAdvice(host)
    return {
      kind: 'not-found',
      message: `${where} says there is no such repository — or you are signed in with an account that cannot see it. Check the address; if it is right, ${a.text.replace(/^not signed in\. /, '')}`,
      copy: a.copy,
      detail
    }
  }
  if (NETWORK_PATTERNS.some((p) => p.test(text))) {
    return {
      kind: 'network',
      message: `Could not reach ${where} — check the internet connection, then try again.`,
      detail,
      copy: detail
    }
  }
  if (/please tell me who you are|unable to auto-detect email|empty ident name/i.test(text)) return identityFailure()
  return { kind: 'other', message: detail, copy: detail }
}

const IDENTITY_COMMANDS = 'git config --global user.name "Your Name"\ngit config --global user.email "you@example.com"'

/** Git has no user.name / user.email: what is wrong and what to run. */
export function identityBlock(): GitBlock {
  return {
    message: `Git doesn’t know your name and email yet, so it can’t record who made a commit. Run this in a terminal (with your own name and email), then try again:\n${IDENTITY_COMMANDS}`,
    copy: IDENTITY_COMMANDS
  }
}

export function identityFailure(): GitFailure {
  const b = identityBlock()
  return { kind: 'identity', message: b.message, copy: b.copy }
}

export function timeoutFailure(ctx: ErrorContext | null, seconds: number): GitFailure {
  const where = ctx ? (ctx.host.kind === 'local' ? remoteLabel(ctx.url) : ctx.host.name) : 'git'
  return {
    kind: 'timeout',
    message: ctx
      ? `${where} did not answer within ${seconds} seconds — nothing more was sent. Try again later.`
      : `git did not finish within ${seconds} seconds and was stopped.`
  }
}

// ── Sentences ─────────────────────────────────────────────────────────────────

/** A piece of a sentence: plain text, or a glossary term (hover explains it). */
export type Seg = string | { term: GlossaryTerm; text: string }

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The text of a sentence (tests, toasts, aria). */
export function segText(segs: readonly Seg[]): string {
  return segs.map((s) => (typeof s === 'string' ? s : s.text)).join('')
}

function quoted(subject: string): string {
  return `“${subject.length > 60 ? `${subject.slice(0, 59)}…` : subject}”`
}

/** "push 2 commits to GitHub (origin/main)" — " — a new branch there" when the push creates it. */
function pushSegs(commits: number, push: PushTarget): Seg[] {
  return [
    { term: 'push', text: 'push' },
    ` ${plural(commits, 'commit', 'commits')} to ${push.host.kind === 'local' ? remoteLabel(push.url) : push.host.name} (`,
    { term: 'upstream', text: `${push.remote}/${push.branch}` },
    push.setUpstream ? ') — a new branch there' : ')'
  ]
}

/** The preview line: exactly what `run` will do. */
export function previewSentence(p: GitOpPreview): Seg[] {
  switch (p.op) {
    case 'commit-push': {
      const push = p.push
      if (p.files === 0) {
        if (!push) return ['Nothing to commit.']
        if (p.behind > 0) {
          return [`Nothing to commit — your ${plural(p.pushCommits, 'unpushed commit waits', 'unpushed commits wait')} here until you get their changes.`]
        }
        return ['This will ', ...pushSegs(p.pushCommits, push), '.']
      }
      const head: Seg[] = ['This will ', { term: 'commit', text: 'commit' }, ` ${plural(p.files, 'file', 'files')}`]
      if (!push) return [...head, '. No ', { term: 'remote', text: 'remote' }, ' — the commit stays on this Mac.']
      if (!p.pushes) return [...head, '. Nothing is ', { term: 'push', text: 'pushed' }, ' — the commit stays on this Mac until you push.']
      if (p.behind > 0) {
        return [
          ...head,
          '. ',
          { term: 'upstream', text: `${push.remote}/${push.branch}` },
          ` has ${plural(p.behind, 'commit', 'commits')} you don’t have yet, so the push will be turned down — the commit stays here until you get their changes.`
        ]
      }
      return [...head, ' and ', ...pushSegs(p.pushCommits, push), '.']
    }
    case 'sync-push': {
      const push = p.push
      if (!push) return ['This branch is not on a remote.']
      return [
        'This will get the new commits from ',
        `${push.host.kind === 'local' ? remoteLabel(push.url) : push.host.name} (`,
        { term: 'upstream', text: `${push.remote}/${push.branch}` },
        `), put your ${plural(p.local, 'unpushed commit', 'unpushed commits')} on top of them (`,
        { term: 'rebase', text: 'rebase' },
        '), then ',
        { term: 'push', text: 'push' },
        '. If their changes ',
        { term: 'conflict', text: 'conflict' },
        ' with yours, a conflict tab opens: combine them there, then it pushes — or abort, back to before.'
      ]
    }
    case 'undo-commit': {
      if (!p.commit) return ['There is no commit to undo.']
      const what = p.merge ? `the merge ${quoted(p.commit.subject)}` : quoted(p.commit.subject)
      if (p.mode === 'undo') {
        return [
          `Not pushed yet — this takes back ${what}: the commit goes away and its changes are back as `,
          { term: 'uncommitted', text: 'uncommitted' },
          '.'
        ]
      }
      const where = p.push ? (p.push.host.kind === 'local' ? remoteLabel(p.push.url) : p.push.host.name) : 'the remote'
      return [
        `Already on ${where} — this adds a commit that cancels ${what}`,
        p.merge ? ' (against its first parent)' : '',
        ' (',
        { term: 'revert', text: 'revert' },
        ') and ',
        { term: 'push', text: 'pushes' },
        ' it. Nothing is rewritten.'
      ]
    }
    case 'discard': {
      const n = p.items.length
      if (n === 0) return ['Nothing will be discarded.']
      return [
        'This will ',
        { term: 'discard', text: 'discard' },
        ` the changes to ${plural(n, 'file', 'files')}. What they hold now is kept for 7 days in Document history.`
      ]
    }
    case 'connect-remote': {
      const where = p.host.kind === 'local' ? remoteLabel(p.url) : `${p.host.name} (${remoteLabel(p.url)})`
      return [
        `${where} answered — `,
        p.branches === 0 ? 'an empty repository' : `it has ${plural(p.branches, 'branch', 'branches')}`,
        `. This will add it as the `,
        { term: 'remote', text: 'remote' },
        ` “${p.name}”; Commit & push then sends your commits there.`
      ]
    }
    case 'stage':
    case 'unstage': {
      const one = p.paths.length === 1
      const what = one ? baseOf(p.paths[0]) : plural(p.paths.length, 'file', 'files')
      if (p.op === 'stage') {
        return ['This will ', { term: 'stage', text: 'stage' }, ` ${what} — ${one ? 'it goes' : 'they go'} into the next commit; the rest stays as it is.`]
      }
      return ['This will ', { term: 'stage', text: 'unstage' }, ` ${what} — ${one ? 'it stays' : 'they stay'} changed on disk, just not in the next commit.`]
    }
    case 'commit-staged': {
      const n = p.staged.length
      if (n === 0) return ['Nothing is staged.']
      const what = n === 1 ? `the staged file (${baseOf(p.staged[0])})` : `the ${n} staged files`
      const head: Seg[] = ['This will ', { term: 'commit', text: 'commit' }, ` ${what}`]
      const others: Seg[] = [` ${p.others === 1 ? '1 other change stays' : `${p.others} other changes stay`} `, { term: 'uncommitted', text: 'uncommitted' }]
      if (p.pushes && p.push) return [...head, ' and ', ...pushSegs(p.pushCommits, p.push), '.', ...(p.others === 0 ? [] : [...others, '.'])]
      const rest: Seg[] = p.others === 0 ? [' Nothing is '] : [...others, '; nothing is ']
      return [...head, '.', ...rest, { term: 'push', text: 'pushed' }, '.']
    }
    case 'create-branch': {
      const from = p.from ? ` from ${p.from}${p.at && p.at !== p.from ? ` (${p.at})` : ''}` : ''
      return [
        'This will create the ',
        { term: 'branch', text: 'branch' },
        ` “${p.name}”${from} and switch to it.`,
        ...carried(p.carried)
      ]
    }
    case 'switch-branch': {
      if (!p.branch) return ['Pick a branch to switch to.']
      // Blocked by uncommitted files: nothing comes along until they are dealt with.
      const along = p.conflicts.length > 0 ? [] : carried(p.carried)
      if (p.local) {
        return [
          `This will make a local “${p.local}” from `,
          { term: 'upstream', text: p.branch },
          ' (it follows it) and switch to it: the files change to that ',
          { term: 'branch', text: 'branch' },
          '’s version.',
          ...along
        ]
      }
      return [`This will switch to “${p.branch}”: the files change to that `, { term: 'branch', text: 'branch' }, '’s version.', ...along]
    }
    case 'fetch': {
      if (!p.remote) return ['No remote — there is nothing to fetch from.']
      const where = p.host.kind === 'local' ? remoteLabel(p.url) : p.host.name
      return [
        `This will look at ${where} (`,
        { term: 'remote', text: p.remote },
        ') and note its new commits, without changing your files (',
        { term: 'fetch', text: 'fetch' },
        ').'
      ]
    }
    case 'pull': {
      const push = p.push
      if (!push) return ['This branch is not on a remote.']
      const head: Seg[] = [
        'This will get the new commits from ',
        `${hostName(push)} (`,
        { term: 'upstream', text: `${push.remote}/${push.branch}` },
        ')'
      ]
      if (p.local === 0) return [...head, ' into your branch (', { term: 'pull', text: 'pull' }, ').']
      return [
        ...head,
        ` and put your ${plural(p.local, 'unpushed commit', 'unpushed commits')} on top of them (`,
        { term: 'rebase', text: 'rebase' },
        ').',
        ...conflictTail()
      ]
    }
    case 'publish': {
      const push = p.push
      if (!push) return ['No remote — there is nowhere to publish to.']
      return [
        'This will ',
        { term: 'publish', text: 'publish' },
        ` the branch “${push.branch}” to ${hostName(push)} as `,
        { term: 'upstream', text: `${push.remote}/${push.branch}` },
        ` — ${plural(p.commits, 'commit', 'commits')} ${p.commits === 1 ? 'goes' : 'go'} there — and the branch follows it from now on.`
      ]
    }
    case 'rebase': {
      if (!p.target) return [p.onto === 'main' ? 'There is no main branch to rebase onto.' : 'This branch follows nothing to rebase onto.']
      return [
        `This will put your ${plural(p.mine, 'commit', 'commits')} on top of ${p.target}’s ${plural(p.theirs, 'newer commit', 'newer commits')} (`,
        { term: 'rebase', text: 'rebase' },
        ').',
        ...conflictTail()
      ]
    }
    case 'resolve-file': {
      const name = baseOf(p.path)
      const merge = p.stopped === 'merge'
      if (p.others.length === 0) {
        return merge
          ? [`This will save the result as ${name}, mark it resolved, then commit the `, { term: 'merge', text: 'merge' }, '.']
          : [`This will save the result as ${name}, mark it resolved, then continue the `, { term: 'rebase', text: 'rebase' }, '.', ...pushTail(p.pushes)]
      }
      return [
        `This will save the result as ${name} and mark it resolved — ${plural(p.others.length, 'more file', 'more files')} to resolve before the `,
        merge ? { term: 'merge', text: 'merge' } : { term: 'rebase', text: 'rebase' },
        merge ? ' is committed.' : ' goes on.'
      ]
    }
    case 'rebase-continue': {
      const what = p.commit ? `your commit ${quoted(p.commit.subject)}` : 'the next commit'
      const more = p.remaining > 0 ? `, then ${plural(p.remaining, 'more commit is', 'more commits are')} replayed` : ''
      if (p.empty) {
        return [`Combined, ${what} changes nothing — it is left out, and the `, { term: 'rebase', text: 'rebase' }, ` goes on${more}.`, ...pushTail(p.pushes)]
      }
      return [`This will make ${what} with the combined files and continue the `, { term: 'rebase', text: 'rebase' }, `${more}.`, ...pushTail(p.pushes)]
    }
    case 'rebase-abort': {
      const where = p.branch ? `“${p.branch}”${p.before ? ` at ${p.before}` : ''}` : p.before ? `the commit ${p.before}` : 'the branch'
      return [
        'This puts everything back exactly as before the ',
        { term: 'rebase', text: 'rebase' },
        `: ${where}, your files as they were (`,
        { term: 'abort', text: 'abort' },
        p.recorded ? '). Pomade checks it afterwards.' : ').'
      ]
    }
    case 'worktree-add': {
      if (!p.branch) return ['Pick a branch to check out.']
      const what: Seg[] = p.local
        ? [`This will make a local “${p.local}” from `, { term: 'upstream', text: p.branch }, ' (it follows it) and check it out in a new ']
        : [`This will check out “${p.branch}” in a new `]
      return [...what, { term: 'worktree', text: 'worktree' }, ` folder, ${p.path}. This checkout stays exactly as it is.`]
    }
    case 'merge-branch': {
      if (!p.into) return ['There is no main branch to land on.']
      const n = plural(p.commits, 'commit', 'commits')
      if (p.mode === 'squash') {
        return [
          `This lands ${n} from “${p.branch}” as 1 commit on ${p.into} (`,
          { term: 'squash', text: 'squash merge' },
          ').',
          ...landTail()
        ]
      }
      return [
        `This lands ${n} from “${p.branch}” on ${p.into} with a `,
        { term: 'merge', text: 'merge commit' },
        ' that keeps them.',
        ...landTail()
      ]
    }
    case 'merge-continue': {
      const what = p.branch ? `“${p.branch}”` : 'the branch'
      return p.mode === 'squash'
        ? [`This will commit the combined files: ${what} lands as 1 commit (`, { term: 'squash', text: 'squash merge' }, ').']
        : [`This will commit the combined files: ${what} lands with a `, { term: 'merge', text: 'merge commit' }, '.']
    }
    case 'merge-abort':
      return [
        'This puts everything back exactly as before the ',
        { term: 'merge', text: 'merge' },
        ': main and your files as they were (',
        { term: 'abort', text: 'abort' },
        p.recorded ? '). Pomade checks it afterwards.' : ').'
      ]
    case 'remove-landed': {
      if (!p.landed) return [`“${p.branch}” has not landed on main — it stays.`]
      const how = p.landed.by === 'squash' ? `landed as ${p.landed.commit}` : 'its commits are there'
      const folder: Seg[] = p.worktree ? [' and its ', { term: 'worktree', text: 'worktree' }, ` folder ${p.worktree}`] : []
      const stays = p.remoteStays ? ` ${p.remoteStays} stays on ${p.remoteWhere ?? 'the remote'}.` : ''
      return [
        `“${p.branch}” is in main (${how}). This removes the `,
        { term: 'branch', text: 'branch' },
        ...folder,
        `.${stays}`
      ]
    }
    case 'rebase-branch': {
      if (!p.target) return ['There is no main branch to rebase onto.']
      const where = p.worktree ? `, in its worktree ${p.worktree}` : ', in a temporary folder — this checkout is untouched'
      return [
        `This will put “${p.branch}”’s ${plural(p.mine, 'commit', 'commits')} on top of ${p.target}’s ${plural(p.theirs, 'newer commit', 'newer commits')} (`,
        { term: 'rebase', text: 'rebase' },
        `)${where}. If their changes `,
        { term: 'conflict', text: 'conflict' },
        ' with its own, nothing changes.'
      ]
    }
  }
}

function landTail(): Seg[] {
  return [' If its changes ', { term: 'conflict', text: 'conflict' }, ' with main’s, a conflict tab opens: combine them there, or abort, back to before.']
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function hostName(t: PushTarget): string {
  return t.host.kind === 'local' ? remoteLabel(t.url) : t.host.name
}

function carried(n: number): Seg[] {
  if (n === 0) return []
  return [` Your ${n === 1 ? '1 ' : `${n} `}`, { term: 'uncommitted', text: 'uncommitted' }, ` ${n === 1 ? 'change comes' : 'changes come'} along.`]
}

/** Get their changes, then push: the finished rebase is pushed. */
function pushTail(to: string | null): Seg[] {
  return to ? [' Once it finishes, your commits are ', { term: 'push', text: 'pushed' }, ` to ${to}.`] : []
}

function conflictTail(): Seg[] {
  return [' If their changes ', { term: 'conflict', text: 'conflict' }, ' with yours, a conflict tab opens: combine them there, or abort, back to before.']
}

/** One file's line in a discard preview. */
export function discardLine(item: DiscardItem): string {
  const name = item.path.slice(item.path.lastIndexOf('/') + 1)
  const staged = item.staged ? ' (its staged version is kept too)' : ''
  switch (item.action) {
    case 'restore':
      return `${name} — back to the last commit${staged}`
    case 'delete':
      return `${name} — new, deleted${staged}`
    case 'bring-back':
      return `${name} — deleted, comes back`
    case 'unrename':
      return `${name} — renamed back to ${(item.from ?? '').slice((item.from ?? '').lastIndexOf('/') + 1)}${staged}`
  }
}

/** Why a file stays in a discard. */
export function skipLine(s: DiscardSkip): string {
  const name = s.path.slice(s.path.lastIndexOf('/') + 1)
  switch (s.reason) {
    case 'binary':
      return `${name} — stays: binary files are not discarded (Pomade can keep text files up to 2 MB)`
    case 'too-big':
      return `${name} — stays: over 2 MB, too big to keep a copy of`
    case 'not-utf8':
      return `${name} — stays: not UTF-8 text, Pomade could not keep an exact copy`
    case 'too-many':
      return `${name} — stays: more than ${DISCARD_MAX_FILES} files in one discard`
  }
}

/** The message of a successful discard. */
export function discardDoneMessage(n: number, skipped: number): string {
  const kept = `Discarded ${plural(n, 'file', 'files')} — kept for 7 days in Document history.`
  if (skipped === 0) return kept
  return `${kept} ${skipped === 1 ? '1 file was' : `${skipped} files were`} left as ${skipped === 1 ? 'it is' : 'they are'}.`
}

/** Is `url` safe to hand to git as a remote address? (Not an option, no whitespace or control
 *  characters.) */
export function remoteUrlProblem(url: string): string | null {
  const u = url.trim()
  if (!u) return 'Paste the address of the remote repository.'
  if (u.startsWith('-')) return 'That is not a repository address.'
  if (/[\s\u0000-\u001f]/.test(u)) return 'A repository address has no spaces.'
  return null
}
