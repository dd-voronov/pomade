// Pomade — E-040: the git operator layer (main process; no Electron). Staging, Commit staged,
// branches (create, switch), Fetch, Pull, Publish branch, Rebase, and the conflict tab's reads and
// its Mark resolved / Continue / Abort. Every operation is previewed and run through git-ops.ts
// (`preview` / `runOp`), on the rails of git-run.ts: the token, the per-repo lock, git that never
// prompts, explicit pushes.
//
// Safety rails of this layer:
//   - No hidden stash, ever. A switch that would replace uncommitted files is refused with what to
//     do (commit or discard them first); git's own refusal backs it up (`switch` without --force,
//     --merge or --discard-changes). Pull and Rebase start only on a repository with nothing
//     uncommitted, so Abort can always put it back exactly.
//   - Never force, `reset --hard`, `clean`, or delete a branch. A rebase stopped on a conflict is
//     ended only by finishing it (Mark resolved & continue) or by `rebase --abort` — git's own
//     return to the state before. Pomade records that state (git-run.ts `fingerprint`) before every
//     rebase it starts and checks the abort against it.
//   - Publish pushes `-u` to the branch's own name, never forced (git-run.ts `pushTo`).
//
//   operatorPreview(state, req) / operatorRun(state, req, run)   the operations, for git-ops.ts
//   readRebase(repo) / readConflictFile(repo, path)             the conflict tab's reads (a merge
//                                                               stopped by E-041's Merge into main too)

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONFLICT_MARKER_SIZE,
  CONFLICT_MAX_BYTES,
  parseMerged,
  parseRebaseFiles,
  type ConflictFile,
  type ConflictResolution,
  type ConflictSide,
  type RebaseState
} from '@shared/git-conflict'
import {
  GIT_LOCAL_TIMEOUT_MS,
  identityBlock,
  lastGitLine,
  remoteHost,
  targetLabel,
  type AbortPreview,
  type BranchChoice,
  type CommitStagedPreview,
  type ContinuePreview,
  type CreateBranchPreview,
  type ErrorContext,
  type FetchPreview,
  type GitBlock,
  type GitOpPreview,
  type GitOpRequest,
  type GitOpResult,
  type GitOpRun,
  type PublishPreview,
  type PullPreview,
  type PushTarget,
  type RebaseOnto,
  type RebasePreview,
  type ResolvePreview,
  type StagePreview,
  type SwitchPreview
} from '@shared/git-ops'
import { isWithin, joinRel, type RepoState } from '@shared/git-state'

import {
  CHANGED,
  conflictedPaths,
  fingerprint,
  hasIdentity,
  ignoredOverwrites,
  inProgress,
  inProgressBlock,
  inRepo,
  isBlock,
  opsEnv,
  pathspecs,
  pushPlan,
  pushTargetOf,
  pushTo,
  raw,
  rawBytes,
  readOk,
  remotesOf,
  repoToken,
  sameFingerprint,
  shortHead,
  stateOf,
  step,
  StepFailure,
  type Fingerprint
} from './git-run'
import { finishMerge, readMerge } from './git-branches'

type OperatorRequest = Exclude<GitOpRequest, { op: 'commit-push' | 'sync-push' | 'undo-commit' | 'discard' | 'connect-remote' }>

// ── The state before a rebase ───────────────────────────────────────────────

interface Before {
  fp: Fingerprint
  /** What the rebase puts the branch on (`main`, `origin/main`). */
  onto: string
  /** Get their changes, then push: where the branch is pushed once the rebase finishes. */
  thenPush?: PushTarget
}

/** Per repo: the state before the rebase Pomade started there, until it ends. Abort is checked
 *  against it. (A rebase started elsewhere — a terminal — has none; Abort is then git's alone.) */
const before = new Map<string, Before>()

// ── Small facts ─────────────────────────────────────────────────────────────

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function list(paths: readonly string[]): string {
  const names = paths.map(base)
  return `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

async function count(cwd: string, range: string): Promise<number> {
  return Number((await readOk(cwd, ['rev-list', '--count', range]))?.trim()) || 0
}

async function revOf(cwd: string, ref: string): Promise<string | null> {
  return (await readOk(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]))?.trim() || null
}

/** The common blocks: git's own error, a half-done operation, a detached HEAD. */
async function commonBlock(state: RepoState, opts: { detachedOk?: boolean } = {}): Promise<GitBlock | null> {
  if (state.error) return { message: state.error, copy: state.error }
  const busy = await inProgress(state.absPath)
  if (busy) return inProgressBlock(busy)
  if (!opts.detachedOk && state.branch === null) {
    return state.hasCommits
      ? { message: 'This repository is not on a branch (detached HEAD). Switch to a branch first.' }
      : { message: 'This repository has no commits yet — make the first commit first.' }
  }
  return null
}

const UNCOMMITTED_BLOCK: GitBlock = {
  message:
    'There are uncommitted changes. Commit or discard them first — Pomade rebases only a repository with nothing uncommitted, so Abort can always put everything back exactly. Nothing is ever hidden away.'
}

/** Change paths (repo-relative) a request names, from the snapshot's changes — renamed files with
 *  their old name. Unknown paths are dropped. */
function namedChanges(state: RepoState, paths: readonly string[], pick: (staged: boolean) => boolean): { ws: string[]; inRepo: string[] } {
  const ws: string[] = []
  const rel: string[] = []
  for (const c of state.changes) {
    if (!paths.includes(c.path) || c.status === 'conflict' || !pick(!!c.staged)) continue
    ws.push(c.path)
    rel.push(inRepo(state.root, c.path))
    if (c.from) rel.push(inRepo(state.root, c.from))
  }
  return { ws, inRepo: rel }
}

// ── Stage / unstage ─────────────────────────────────────────────────────────

async function previewStage(state: RepoState, op: 'stage' | 'unstage', paths: string[]): Promise<StagePreview> {
  const named = namedChanges(state, paths, (staged) => (op === 'stage' ? true : staged))
  const token = await repoToken(state.absPath, `${op}\0${JSON.stringify(paths)}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    const b = await commonBlock(state, { detachedOk: true })
    if (b) return b
    if (named.ws.length === 0) return { message: op === 'stage' ? 'Nothing to stage there any more.' : 'Nothing is staged there any more.' }
    return null
  })()
  return { op, repo: state.root, token, paths: named.ws, blocked }
}

async function runStage(state: RepoState, op: 'stage' | 'unstage', paths: string[], opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewStage(state, op, paths)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const named = namedChanges(state, paths, (staged) => (op === 'stage' ? true : staged))
  const input = pathspecs(named.inRepo)
  if (op === 'stage') {
    await step(cwd, env, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input })
  } else if (state.hasCommits) {
    await step(cwd, env, ['--literal-pathspecs', 'restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'], { input })
  } else {
    // No commit to go back to: unstaging takes the files out of the index (they stay on disk).
    await step(cwd, env, ['--literal-pathspecs', 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input })
  }
  const what = p.paths.length === 1 ? base(p.paths[0]) : plural(p.paths.length, 'file', 'files')
  return { ok: true, message: op === 'stage' ? `Staged ${what}.` : `Unstaged ${what}.` }
}

// ── Commit staged ───────────────────────────────────────────────────────────

async function previewCommitStaged(state: RepoState, wantPush: boolean): Promise<CommitStagedPreview> {
  const staged = state.changes.filter((c) => c.staged).map((c) => c.path)
  const others = state.changes.filter((c) => c.status !== 'conflict' && (!c.staged || c.staged === 'part')).length
  const { target, ahead } = await pushPlan(state)
  const push = isBlock(target) ? null : target
  const pushes = wantPush && push !== null
  const token = await repoToken(state.absPath, pushes && push ? `${state.upstream ?? ''}\0${push.remote}\0${push.url}` : '')
  const blocked = await (async (): Promise<GitBlock | null> => {
    const b = await commonBlock(state)
    if (b) return b
    if (isBlock(target) && wantPush) return target
    if (staged.length === 0) return { message: 'Nothing is staged — stage the files to commit first.' }
    if (!(await hasIdentity(state.absPath))) return identityBlock()
    return null
  })()
  return { op: 'commit-staged', repo: state.root, token, staged, others, branch: state.branch, push, pushes, pushCommits: ahead + 1, blocked }
}

async function runCommitStaged(state: RepoState, wantPush: boolean, opts: GitOpRun): Promise<GitOpResult> {
  const message = (opts.message ?? '').trim()
  if (!message) return { ok: false, failure: { kind: 'blocked', message: 'Write a message saying what changed.' } }
  const p = await previewCommitStaged(state, wantPush)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  // Exactly the index: no pathspec, no -a — what is staged is what the preview counted.
  await step(cwd, env, ['commit', '-q', '--cleanup=whitespace', '-F', '-'], { input: opts.message ?? message })
  const commit = await shortHead(cwd)
  const rest = p.others === 0 ? '' : ` ${p.others === 1 ? '1 other change stays' : `${p.others} other changes stay`} uncommitted.`
  const what = plural(p.staged.length, 'staged file', 'staged files')
  if (!p.pushes || !p.push) return { ok: true, message: `Committed ${commit} — ${what}.${rest}`, commit }
  await pushTo(cwd, env, state.branch!, p.push, commit)
  return { ok: true, message: `Committed ${commit} — ${what} — and pushed to ${targetLabel(p.push)}.${rest}`, commit }
}

// ── Branches ────────────────────────────────────────────────────────────────

/** Why `name` cannot be a new branch's name; null when it can. */
async function branchNameProblem(cwd: string, name: string): Promise<string | null> {
  if (!name) return 'Name the branch, e.g. fix/login-typo.'
  if (name.startsWith('-') || /\s/.test(name) || (await raw(cwd, ['check-ref-format', '--branch', name])).code !== 0) {
    return `“${name}” can’t be a branch name — use letters, digits, - _ . and /, with no spaces and none of ~ ^ : ? * [ \\.`
  }
  if (await revOf(cwd, `refs/heads/${name}`)) return `A branch “${name}” already exists — Switch branch… goes there.`
  return null
}

async function previewCreateBranch(state: RepoState, rawName: string): Promise<CreateBranchPreview> {
  const cwd = state.absPath
  const name = rawName.trim()
  const at = state.hasCommits ? await shortHead(cwd) : null
  const token = await repoToken(cwd, `branch\0${name}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    const b = await commonBlock(state, { detachedOk: true })
    if (b) return b
    if (!state.hasCommits) return { message: 'This repository has no commits yet — make the first commit before creating branches.' }
    const problem = await branchNameProblem(cwd, name)
    return problem ? { message: problem } : null
  })()
  return { op: 'create-branch', repo: state.root, token, name, from: state.branch ?? at, at, carried: state.changes.length, blocked }
}

async function runCreateBranch(state: RepoState, name: string, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewCreateBranch(state, name)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  // From HEAD, so nothing uncommitted can be in the way; no upstream until it is published.
  await step(cwd, await opsEnv(cwd), ['switch', '-q', '--no-track', '-c', p.name])
  return { ok: true, message: `Created “${p.name}” and switched to it.` }
}

/** Every branch Switch branch offers: local ones (newest first), then those only on a remote. */
async function branchChoices(state: RepoState): Promise<BranchChoice[]> {
  const cwd = state.absPath
  const fmt = '--format=%(refname)%00%(committerdate:unix)%00%(subject)'
  const read = async (ns: string): Promise<{ ref: string; date: number; subject: string }[]> =>
    ((await readOk(cwd, ['for-each-ref', '--sort=-committerdate', fmt, ns])) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, date, subject] = l.split('\0')
        return { ref, date: Number(date) * 1000, subject: subject ?? '' }
      })
  const local = await read('refs/heads')
  const localNames = new Set(local.map((b) => b.ref.slice('refs/heads/'.length)))
  const remotes = (await remotesOf(cwd)).map((r) => r.name)
  const out: BranchChoice[] = local.map((b) => {
    const name = b.ref.slice('refs/heads/'.length)
    return { name, remote: false, current: name === state.branch, date: b.date, subject: b.subject }
  })
  for (const b of await read('refs/remotes')) {
    const name = b.ref.slice('refs/remotes/'.length)
    if (name.endsWith('/HEAD')) continue
    const remote = remotes.filter((r) => name.startsWith(`${r}/`)).sort((a, z) => z.length - a.length)[0]
    if (!remote || localNames.has(name.slice(remote.length + 1))) continue
    out.push({ name, remote: true, current: false, date: b.date, subject: b.subject })
  }
  return out
}

async function previewSwitch(state: RepoState, branch: string): Promise<SwitchPreview> {
  const cwd = state.absPath
  const branches = await branchChoices(state)
  const choice = branches.find((b) => b.name === branch)
  let local: string | null = null
  if (choice?.remote) {
    const remotes = (await remotesOf(cwd)).map((r) => r.name).filter((r) => branch.startsWith(`${r}/`))
    const remote = remotes.sort((a, z) => z.length - a.length)[0]
    local = remote ? branch.slice(remote.length + 1) : null
  }
  const rev = choice ? await revOf(cwd, choice.remote ? `refs/remotes/${branch}` : `refs/heads/${branch}`) : null
  // Uncommitted files the switch would replace: a file that differs between here and there.
  let conflicts: string[] = []
  let ignored: string | null = null
  if (rev && state.hasCommits) {
    const there = new Set(((await readOk(cwd, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', rev])) ?? '').split('\0').filter(Boolean))
    conflicts = state.changes
      .filter((c) => {
        const own = [inRepo(state.root, c.path), ...(c.from ? [inRepo(state.root, c.from)] : [])]
        if (c.dir) return [...there].some((t) => own.some((o) => isWithin(t, o)))
        return own.some((o) => there.has(o))
      })
      .map((c) => c.path)
    ignored = await ignoredOverwrites(cwd, ['HEAD', rev], `Switching to “${branch}”`)
  }
  const token = await repoToken(cwd, `switch\0${branch}\0${rev ?? ''}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    const b = await commonBlock(state, { detachedOk: true })
    if (b) return b
    if (!state.hasCommits) return { message: 'This repository has no commits yet — there is no other branch to switch to.' }
    if (!branch) return { message: 'Pick a branch to switch to.' }
    if (!choice || !rev) return { message: `There is no branch “${branch}” here.` }
    if (choice.current) return { message: `You are on “${branch}” already.` }
    if (conflicts.length > 0) {
      const n = conflicts.length
      return {
        message: `Switching to “${branch}” would replace ${n === 1 ? 'a file' : `${n} files`} you changed and haven’t committed: ${list(conflicts)}. Commit or discard ${n === 1 ? 'it' : 'them'} first — Pomade never hides changes away.`
      }
    }
    if (ignored) return { message: ignored }
    return null
  })()
  return {
    op: 'switch-branch',
    repo: state.root,
    token,
    branch,
    branches,
    local,
    carried: state.changes.length - conflicts.length,
    conflicts,
    blocked
  }
}

async function runSwitch(state: RepoState, branch: string, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewSwitch(state, branch)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  // Plain `switch`: git itself refuses to replace an uncommitted change (no --force, no --merge).
  if (p.local) await step(cwd, env, ['switch', '-q', '-c', p.local, '--track', `refs/remotes/${p.branch}`])
  else await step(cwd, env, ['switch', '-q', '--no-guess', p.branch])
  const name = p.local ?? p.branch
  return { ok: true, message: p.local ? `Switched to “${name}”, which follows ${p.branch}.` : `Switched to “${name}”.` }
}

// ── Fetch / publish ─────────────────────────────────────────────────────────

async function fetchRemote(state: RepoState): Promise<{ name: string; url: string } | null> {
  const remotes = await remotesOf(state.absPath)
  const target = pushTargetOf(state, remotes)
  if (target && !isBlock(target)) return { name: target.remote, url: target.url }
  const r = remotes.find((x) => x.name === 'origin') ?? remotes[0]
  return r ? { name: r.name, url: r.url } : null
}

async function previewFetch(state: RepoState): Promise<FetchPreview> {
  const remote = await fetchRemote(state)
  const token = createHash('sha1').update(`fetch\0${remote?.name ?? ''}\0${remote?.url ?? ''}`).digest('hex')
  const blocked: GitBlock | null = state.error
    ? { message: state.error, copy: state.error }
    : !remote
      ? { message: 'No remote — there is nothing to fetch from.' }
      : null
  return { op: 'fetch', repo: state.root, token, remote: remote?.name ?? null, url: remote?.url ?? '', host: remoteHost(remote?.url ?? ''), blocked }
}

async function runFetch(state: RepoState, opts: GitOpRun, yielded?: AbortSignal): Promise<GitOpResult> {
  const p = await previewFetch(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked || !p.remote) return { ok: false, failure: { kind: 'blocked', ...(p.blocked ?? { message: 'No remote.' }) } }
  const cwd = state.absPath
  await step(cwd, await opsEnv(cwd), ['fetch', '--no-write-fetch-head', p.remote], {
    net: { action: 'get', host: p.host, url: p.url },
    signal: yielded
  })
  const where = p.host.kind === 'local' ? p.url : p.host.name
  if (!state.upstream) return { ok: true, message: `Fetched from ${where}.` }
  const behind = await count(cwd, 'HEAD..@{u}')
  return {
    ok: true,
    message:
      behind === 0
        ? `Fetched from ${where} — nothing new for ${state.branch ?? 'this branch'}.`
        : `Fetched from ${where} — ${state.upstream} has ${plural(behind, 'commit', 'commits')} you don’t have yet.`
  }
}

async function previewPublish(state: RepoState): Promise<PublishPreview> {
  const cwd = state.absPath
  const target = pushTargetOf(state, await remotesOf(cwd))
  const push = isBlock(target) ? null : target
  const commits = push && state.hasCommits ? Number((await readOk(cwd, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${push.remote}`]))?.trim()) || 0 : 0
  const token = await repoToken(cwd, `publish\0${push ? `${push.remote}\0${push.url}` : ''}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    const b = await commonBlock(state)
    if (b) return b
    if (isBlock(target)) return target
    if (!push) return { message: 'No remote — connect one first (⋯ › Connect remote…).' }
    if (!push.setUpstream) return { message: `This branch is published already — it follows ${push.remote}/${push.branch}.` }
    return null
  })()
  return { op: 'publish', repo: state.root, token, push, commits, blocked }
}

async function runPublish(state: RepoState, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewPublish(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked || !p.push) return { ok: false, failure: { kind: 'blocked', ...(p.blocked ?? { message: 'No remote.' }) } }
  const cwd = state.absPath
  await pushTo(cwd, await opsEnv(cwd), state.branch!, p.push)
  return { ok: true, message: `Published “${state.branch}” to ${targetLabel(p.push)} — it follows it from now on.` }
}

// ── Pull / rebase ───────────────────────────────────────────────────────────

/** Rebase the current branch onto `rev` (named `label`). A conflict stops the rebase for the
 *  conflict tab, the state before it recorded; any other failure is aborted and checked.
 *  `thenPush` (Get their changes, then push): the caller pushes a rebase that finishes here; one
 *  stopped on a conflict is pushed when it finishes (`continueRebase`). */
export async function rebaseOnto(
  state: RepoState,
  env: NodeJS.ProcessEnv,
  rev: string,
  label: string,
  thenPush?: PushTarget
): Promise<GitOpResult> {
  const cwd = state.absPath
  const fp = await fingerprint(cwd)
  const ignored = await ignoredOverwrites(cwd, [`HEAD...${rev}`])
  if (ignored) return { ok: false, failure: { kind: 'blocked', message: ignored } }
  const theirs = await count(cwd, `HEAD..${rev}`)
  const mine = await count(cwd, `${rev}..HEAD`)
  before.set(state.root, { fp, onto: label, ...(thenPush ? { thenPush } : {}) })
  const r = await raw(cwd, ['rebase', '--rebase-merges', '--no-autostash', '--no-update-refs', rev], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (r.code === 0 && !r.timedOut) {
    before.delete(state.root)
    return {
      ok: true,
      message:
        mine === 0
          ? `Got ${plural(theirs, 'commit', 'commits')} from ${label}.`
          : `Put your ${plural(mine, 'commit', 'commits')} on top of ${label} (${plural(theirs, 'new commit', 'new commits')}).`
    }
  }
  const conflicts = await conflictedPaths(cwd)
  if (conflicts.length > 0 && (await inProgress(cwd))) {
    const files = conflicts.map((p) => joinRel(state.root, p))
    return {
      ok: true,
      paused: { files },
      message: thenPush
        ? `Their changes conflict with yours in ${list(files)}. Combine them in the conflict tab — once the rebase finishes, it pushes to ${targetLabel(thenPush)}. Or abort, back to before.`
        : `Their changes conflict with yours in ${list(files)}. Combine them in the conflict tab — or abort, back to before.`
    }
  }
  return abortChecked(state, env, fp, `Rebasing failed (${lastGitLine(r.stderr)})`, lastGitLine(r.stderr))
}

/** `rebase --abort`, then the repository compared with the state before. */
async function abortChecked(state: RepoState, env: NodeJS.ProcessEnv, fp: Fingerprint, what: string, detail: string): Promise<GitOpResult> {
  const cwd = state.absPath
  if (await inProgress(cwd)) await raw(cwd, ['rebase', '--abort'], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  before.delete(state.root)
  const diffs = sameFingerprint(fp, await fingerprint(cwd))
  if (diffs.length === 0) {
    return {
      ok: false,
      failure: { kind: 'conflict', restored: true, message: `${what}. Nothing was changed — the repository is exactly as before.`, detail, copy: detail }
    }
  }
  return {
    ok: false,
    failure: {
      kind: 'conflict',
      restored: false,
      message: `${what}, and Pomade could NOT put everything back exactly (${diffs.join(', ')}). Look at the repository in a terminal before doing anything else: git status.`,
      copy: 'git status',
      detail
    }
  }
}

async function previewPull(state: RepoState): Promise<PullPreview> {
  const cwd = state.absPath
  const target = pushTargetOf(state, await remotesOf(cwd))
  const push = isBlock(target) ? null : target
  const token = await repoToken(cwd, `pull\0${state.upstream ?? ''}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    const b = await commonBlock(state)
    if (b) return b
    if (isBlock(target)) return target
    if (!push) return { message: 'No remote — there is nothing to pull from.' }
    if (push.setUpstream) return { message: 'This branch is not on the remote yet — Publish branch puts it there.' }
    if (state.changes.length > 0) return UNCOMMITTED_BLOCK
    if (state.ahead > 0 && !(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return { op: 'pull', repo: state.root, token, push, local: state.ahead, blocked }
}

async function runPull(state: RepoState, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewPull(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked || !p.push) return { ok: false, failure: { kind: 'blocked', ...(p.blocked ?? { message: 'No remote.' }) } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const net: ErrorContext = { action: 'get', host: p.push.host, url: p.push.url }
  await step(cwd, env, ['fetch', '--no-write-fetch-head', p.push.remote], { net })
  const label = `${p.push.remote}/${p.push.branch}`
  if ((await count(cwd, 'HEAD..@{u}')) === 0) return { ok: true, message: `Nothing new on ${targetLabel(p.push)} — you have everything.` }
  return rebaseOnto(state, env, '@{u}', label)
}

/** What Rebase goes onto: the ref and its name. */
async function rebaseTarget(state: RepoState, onto: RebaseOnto): Promise<{ ref: string; label: string } | null> {
  if (onto === 'upstream') return state.upstream ? { ref: '@{u}', label: state.upstream } : null
  for (const name of ['main', 'master']) if (await revOf(state.absPath, `refs/heads/${name}`)) return { ref: `refs/heads/${name}`, label: name }
  return null
}

async function previewRebase(state: RepoState, onto: RebaseOnto): Promise<RebasePreview> {
  const cwd = state.absPath
  const target = state.hasCommits ? await rebaseTarget(state, onto) : null
  const rev = target ? await revOf(cwd, target.ref) : null
  const theirs = rev ? await count(cwd, `HEAD..${rev}`) : 0
  const mine = rev ? await count(cwd, `${rev}..HEAD`) : 0
  const token = await repoToken(cwd, `rebase\0${onto}\0${rev ?? ''}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    const b = await commonBlock(state)
    if (b) return b
    if (!target || !rev) return { message: onto === 'main' ? 'There is no main branch here to rebase onto.' : 'This branch follows nothing on a remote.' }
    if (onto === 'main' && state.branch === target.label) return { message: `You are on ${target.label} — switch to the branch you want to put on top of it.` }
    if (theirs === 0) return { message: `This branch is on top of ${target.label} already — nothing to rebase.` }
    if (state.changes.length > 0) return UNCOMMITTED_BLOCK
    if (mine > 0 && !(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return { op: 'rebase', repo: state.root, token, onto, target: target?.label ?? null, branch: state.branch, theirs, mine, blocked }
}

async function runRebase(state: RepoState, onto: RebaseOnto, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewRebase(state, onto)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked || !p.target) return { ok: false, failure: { kind: 'blocked', ...(p.blocked ?? { message: 'Nothing to rebase onto.' }) } }
  const target = (await rebaseTarget(state, onto))!
  return rebaseOnto(state, await opsEnv(state.absPath), target.ref, target.label)
}

// ── The stopped rebase ──────────────────────────────────────────────────────

async function gitDir(cwd: string): Promise<string | null> {
  return (await readOk(cwd, ['rev-parse', '--absolute-git-dir']))?.trim() || null
}

async function readText(path: string): Promise<string | null> {
  return fsp.readFile(path, 'utf8').catch(() => null)
}

/** The stopped rebase in `state`'s repo, or null when none is. */
async function rebaseOf(state: RepoState): Promise<(RebaseState & { origHead: string | null }) | null> {
  const cwd = state.absPath
  const dir = await gitDir(cwd)
  if (!dir) return null
  const merge = join(dir, 'rebase-merge')
  const apply = join(dir, 'rebase-apply')
  const at = (await fsp.stat(merge).then(() => merge).catch(() => null)) ?? (await fsp.stat(apply).then(() => apply).catch(() => null))
  if (!at) return null
  const isMerge = at === merge
  const files = parseRebaseFiles({
    headName: await readText(join(at, 'head-name')),
    onto: await readText(join(at, 'onto')),
    ...(isMerge
      ? { done: await readText(join(at, 'done')), todo: await readText(join(at, 'git-rebase-todo')) }
      : { next: await readText(join(at, 'next')), last: await readText(join(at, 'last')) })
  })
  const origHead = (await readText(join(at, 'orig-head')))?.trim() || null
  const replaying = await revOf(cwd, 'REBASE_HEAD')
  let commit: RebaseState['commit'] = null
  if (replaying) {
    const subject = ((await readOk(cwd, ['log', '-1', '--format=%s', replaying])) ?? '').trim()
    commit = { hash: replaying, subject }
  }
  const rec = before.get(state.root)
  let onto = rec?.onto ?? null
  if (!onto && files.onto) {
    const candidates: string[] = []
    if (files.branch) {
      const up = (await readOk(cwd, ['rev-parse', '--abbrev-ref', `${files.branch}@{u}`]))?.trim()
      if (up) candidates.push(up)
    }
    candidates.push('main', 'master')
    for (const c of candidates) {
      if ((await revOf(cwd, c)) === files.onto) {
        onto = c
        break
      }
    }
    onto ??= files.onto.slice(0, 7)
  }
  const conflicts = (await conflictedPaths(cwd)).map((p) => joinRel(state.root, p)).sort()
  return {
    kind: 'rebase',
    repo: state.root,
    branch: files.branch,
    onto: onto ?? '',
    commit,
    step: files.step,
    total: files.total,
    conflicts,
    recorded: !!rec,
    origHead
  }
}

/** The conflict tab's header: the stopped rebase in `repo` — or the merge stopped there (E-041,
 *  git-branches.ts) — or null when none is. */
export async function readRebase(repo: unknown): Promise<RebaseState | null> {
  const state = await stateOf(repo)
  const r = await rebaseOf(state)
  if (!r) return state.operation === 'merge' ? readMerge(state) : null
  return {
    kind: 'rebase',
    repo: r.repo,
    branch: r.branch,
    onto: r.onto,
    commit: r.commit,
    step: r.step,
    total: r.total,
    conflicts: r.conflicts,
    recorded: r.recorded
  }
}

async function readStage(cwd: string, sha: string | undefined): Promise<ConflictSide> {
  if (!sha) return { kind: 'absent' }
  const size = Number((await readOk(cwd, ['cat-file', '-s', sha]))?.trim()) || 0
  if (size > CONFLICT_MAX_BYTES) return { kind: 'too-big', size }
  const bytes = await rawBytes(cwd, ['cat-file', 'blob', sha], process.env)
  if (!bytes) return { kind: 'absent' }
  if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return { kind: 'binary', size }
  return { kind: 'text', text: bytes.toString('utf8') }
}

/** The stage blobs of a conflicted file (1 base, 2 theirs, 3 yours — see git-conflict.ts). */
async function stagesOf(cwd: string, rel: string): Promise<Record<1 | 2 | 3, string | undefined>> {
  const out = (await readOk(cwd, ['--literal-pathspecs', 'ls-files', '-u', '-z', '--', rel])) ?? ''
  const stages: Record<1 | 2 | 3, string | undefined> = { 1: undefined, 2: undefined, 3: undefined }
  for (const rec of out.split('\0').filter(Boolean)) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t/.exec(rec)
    if (m) stages[Number(m[2]) as 1 | 2 | 3] = m[1]
  }
  return stages
}

/** One conflicted file's three versions and, when they are text, the line-by-line segments
 *  (`git merge-file --diff3` of the stage blobs, in a temp folder outside the repository). */
export async function readConflictFile(repo: unknown, path: unknown): Promise<ConflictFile> {
  const state = await stateOf(repo)
  const cwd = state.absPath
  if (typeof path !== 'string' || !isWithin(path, state.root) || path === state.root) throw new Error('Not a path in this repository.')
  const rel = inRepo(state.root, path)
  if (!(await conflictedPaths(cwd)).includes(rel)) throw new Error(`${base(path)} has no open conflict.`)
  const stages = await stagesOf(cwd, rel)
  const [b, theirs, yours] = await Promise.all([readStage(cwd, stages[1]), readStage(cwd, stages[2]), readStage(cwd, stages[3])])
  let segments: ConflictFile['segments'] = null
  if (theirs.kind === 'text' && yours.kind === 'text' && (b.kind === 'text' || b.kind === 'absent')) {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'pomade-merge-'))
    try {
      const f = (n: string): string => join(dir, n)
      await Promise.all([
        fsp.writeFile(f('theirs'), theirs.text),
        fsp.writeFile(f('base'), b.kind === 'text' ? b.text : ''),
        fsp.writeFile(f('yours'), yours.text)
      ])
      const r = await raw(dir, [
        'merge-file',
        '-p',
        '--diff3',
        `--marker-size=${CONFLICT_MARKER_SIZE}`,
        '-L',
        'theirs',
        '-L',
        'base',
        '-L',
        'yours',
        f('theirs'),
        f('base'),
        f('yours')
      ])
      if (r.code >= 0 && r.code < 128 && !r.timedOut) segments = parseMerged(r.stdout)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
  return { path, theirs, base: b, yours, segments }
}

// ── Mark resolved, continue, abort ──────────────────────────────────────────

const NO_REBASE: GitBlock = { message: 'No rebase is in progress here any more.' }

async function previewResolve(state: RepoState, path: string): Promise<ResolvePreview> {
  const cwd = state.absPath
  const conflicts = (await conflictedPaths(cwd)).map((p) => joinRel(state.root, p))
  const token = await repoToken(cwd, `resolve\0${path}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    if (state.operation !== 'rebase' && state.operation !== 'merge') return NO_REBASE
    if (!conflicts.includes(path)) return { message: `${base(path)} has no open conflict any more.` }
    if (!(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return {
    op: 'resolve-file',
    repo: state.root,
    token,
    path,
    others: conflicts.filter((p) => p !== path).sort(),
    stopped: state.operation === 'merge' ? 'merge' : 'rebase',
    pushes: state.operation === 'merge' ? null : pushesTo(state),
    blocked
  }
}

async function runResolve(state: RepoState, path: string, resolution: ConflictResolution | undefined, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewResolve(state, path)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  if (!resolution || (resolution.kind === 'text' && typeof resolution.content !== 'string') || (resolution.kind === 'take' && resolution.side !== 'theirs' && resolution.side !== 'yours')) {
    return { ok: false, failure: { kind: 'blocked', message: 'Nothing to mark resolved — combine the file first.' } }
  }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const rel = inRepo(state.root, path)
  const file = join(cwd, rel)
  let content: Buffer | null
  if (resolution.kind === 'text') content = Buffer.from(resolution.content, 'utf8')
  else {
    const stages = await stagesOf(cwd, rel)
    const sha = stages[resolution.side === 'theirs' ? 2 : 3]
    content = sha ? await rawBytes(cwd, ['cat-file', 'blob', sha], env) : null
    if (sha && !content) return { ok: false, failure: CHANGED }
  }
  if (content) {
    await fsp.writeFile(file, content)
    await step(cwd, env, ['--literal-pathspecs', 'add', '--', rel])
  } else {
    // The side taken has no such file: the file goes (its versions stay in the rebase — Abort).
    await step(cwd, env, ['--literal-pathspecs', 'rm', '-q', '--cached', '--', rel])
    await fsp.rm(file, { force: true })
  }
  if (p.others.length > 0) {
    return { ok: true, message: `Marked ${base(path)} resolved — ${plural(p.others.length, 'more file', 'more files')} to go.` }
  }
  return state.operation === 'merge' ? finishMerge(state, env) : continueRebase(state, env)
}

/** `rebase --continue` (or `--skip` when the combined commit changes nothing): finished, stopped
 *  on the next conflict, or failed with git's line (the rebase stays — Abort is there). */
async function continueRebase(state: RepoState, env: NodeJS.ProcessEnv): Promise<GitOpResult> {
  const cwd = state.absPath
  const info = await rebaseOf(state)
  const empty = (await raw(cwd, ['diff', '--cached', '--quiet', 'HEAD'], { env })).code === 0
  const r = await raw(cwd, ['rebase', empty ? '--skip' : '--continue'], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (r.code === 0 && !r.timedOut && !(await inProgress(cwd))) {
    const rec = before.get(state.root)
    before.delete(state.root)
    const branch = info?.branch ? `“${info.branch}”` : 'Your branch'
    const done = `Rebase finished — ${branch} is on top of ${info?.onto || 'its target'}`
    if (!rec?.thenPush || !info?.branch) return { ok: true, message: `${done}.` }
    return pushFinished(cwd, env, info.branch, rec.thenPush, done)
  }
  const conflicts = (await conflictedPaths(cwd)).map((p) => joinRel(state.root, p))
  if (conflicts.length > 0) {
    const next = await rebaseOf(state)
    const subject = next?.commit ? ` “${next.commit.subject}”` : ''
    return {
      ok: true,
      paused: { files: conflicts },
      message: `The next commit${subject} conflicts too, in ${list(conflicts)}. Combine it in the conflict tab — or abort, back to before.`
    }
  }
  const line = r.timedOut ? 'git did not finish in time.' : lastGitLine(`${r.stderr}\n${r.stdout}`)
  return {
    ok: false,
    failure: { kind: 'other', message: `The rebase could not go on: ${line} It is still stopped — fix it, or abort, back to before.`, detail: line, copy: line }
  }
}

/** The push Get their changes, then push was started for, once its rebase has finished. A failed
 *  push leaves the rebased commits on this Mac and says so. */
async function pushFinished(cwd: string, env: NodeJS.ProcessEnv, branch: string, target: PushTarget, done: string): Promise<GitOpResult> {
  try {
    await pushTo(cwd, env, branch, target)
  } catch (err) {
    if (!(err instanceof StepFailure)) throw err
    const f = err.failure
    return { ok: false, failure: { ...f, message: `${done}, but it was not pushed: ${f.message} Your commits are on this Mac — push them from Changes.` } }
  }
  return { ok: true, message: `${done} — and pushed to ${targetLabel(target)}.` }
}

/** Where a finished rebase is pushed (Get their changes, then push), for the previews. */
function pushesTo(state: RepoState): string | null {
  const t = before.get(state.root)?.thenPush
  return t ? targetLabel(t) : null
}

async function previewContinue(state: RepoState): Promise<ContinuePreview> {
  const cwd = state.absPath
  const info = state.operation === 'rebase' ? await rebaseOf(state) : null
  const conflicts = info?.conflicts ?? []
  const empty = info ? (await raw(cwd, ['diff', '--cached', '--quiet', 'HEAD'])).code === 0 : false
  const token = await repoToken(cwd, 'continue')
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    if (!info) return NO_REBASE
    if (conflicts.length > 0) return { message: `Resolve every conflict first: ${list(conflicts)}.` }
    if (!empty && !(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return {
    op: 'rebase-continue',
    repo: state.root,
    token,
    conflicts,
    commit: info?.commit ?? null,
    remaining: info ? Math.max(0, info.total - info.step) : 0,
    empty,
    pushes: pushesTo(state),
    blocked
  }
}

async function runContinue(state: RepoState, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewContinue(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  return continueRebase(state, await opsEnv(state.absPath))
}

async function previewAbort(state: RepoState): Promise<AbortPreview> {
  const cwd = state.absPath
  const info = state.operation === 'rebase' ? await rebaseOf(state) : null
  const token = await repoToken(cwd, 'abort')
  const beforeHead = info?.origHead ? ((await readOk(cwd, ['rev-parse', '--short', info.origHead])) ?? '').trim() || null : null
  return {
    op: 'rebase-abort',
    repo: state.root,
    token,
    branch: info?.branch ?? null,
    before: beforeHead,
    recorded: info?.recorded ?? false,
    blocked: state.error ? { message: state.error, copy: state.error } : info ? null : NO_REBASE
  }
}

async function runAbort(state: RepoState, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewAbort(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const rec = before.get(state.root)
  const r = await raw(cwd, ['rebase', '--abort'], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (r.code !== 0 || r.timedOut) {
    const line = r.timedOut ? 'git did not finish in time.' : lastGitLine(r.stderr)
    return { ok: false, failure: { kind: 'other', message: `git could not abort the rebase: ${line}`, detail: line, copy: 'git rebase --abort' } }
  }
  before.delete(state.root)
  const where = p.branch ? `“${p.branch}”${p.before ? ` at ${p.before}` : ''}` : (p.before ?? 'the commit before')
  if (!rec) return { ok: true, message: `Back to before — git put ${where} back as it was before the rebase.` }
  const diffs = sameFingerprint(rec.fp, await fingerprint(cwd))
  if (diffs.length === 0) return { ok: true, message: `Back to before — ${where}, exactly as it was (checked).` }
  return {
    ok: false,
    failure: {
      kind: 'other',
      message: `The rebase was aborted, but the repository is NOT exactly as before it (${diffs.join(', ')}) — something changed it while the rebase was stopped. Look at it in a terminal: git status.`,
      copy: 'git status'
    }
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((p): p is string => typeof p === 'string') : []
}

function str(x: unknown): string {
  return typeof x === 'string' ? x : ''
}

function ontoOf(x: unknown): RebaseOnto {
  return x === 'upstream' ? 'upstream' : 'main'
}

export async function operatorPreview(state: RepoState, req: OperatorRequest | { op: string }): Promise<GitOpPreview> {
  const r = req as OperatorRequest
  switch (r.op) {
    case 'stage':
    case 'unstage':
      return previewStage(state, r.op, strings(r.paths))
    case 'commit-staged':
      return previewCommitStaged(state, r.push === true)
    case 'create-branch':
      return previewCreateBranch(state, str(r.name))
    case 'switch-branch':
      return previewSwitch(state, str(r.branch))
    case 'fetch':
      return previewFetch(state)
    case 'pull':
      return previewPull(state)
    case 'publish':
      return previewPublish(state)
    case 'rebase':
      return previewRebase(state, ontoOf(r.onto))
    case 'resolve-file':
      return previewResolve(state, str(r.path))
    case 'rebase-continue':
      return previewContinue(state)
    case 'rebase-abort':
      return previewAbort(state)
    default:
      throw new Error('Unknown git operation.')
  }
}

/** `yielded` stops a background Fetch (the repo lock asked it to give way). */
export async function operatorRun(state: RepoState, req: OperatorRequest | { op: string }, run: GitOpRun, yielded?: AbortSignal): Promise<GitOpResult> {
  const r = req as OperatorRequest
  switch (r.op) {
    case 'stage':
    case 'unstage':
      return runStage(state, r.op, strings(r.paths), run)
    case 'commit-staged':
      return runCommitStaged(state, r.push === true, run)
    case 'create-branch':
      return runCreateBranch(state, str(r.name), run)
    case 'switch-branch':
      return runSwitch(state, str(r.branch), run)
    case 'fetch':
      return runFetch(state, run, yielded)
    case 'pull':
      return runPull(state, run)
    case 'publish':
      return runPublish(state, run)
    case 'rebase':
      return runRebase(state, ontoOf(r.onto), run)
    case 'resolve-file':
      return runResolve(state, str(r.path), r.resolution, run)
    case 'rebase-continue':
      return runContinue(state, run)
    case 'rebase-abort':
      return runAbort(state, run)
    default:
      throw new Error('Unknown git operation.')
  }
}
