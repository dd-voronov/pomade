// Pomade — git-core: the `pomade-git` command (docs/modules/git/pomade-git.md). Git operations from
// Runner, a terminal or an agent, with Pomade open or closed, on the Git panel's rails, each
// reporting a structured result (shared/git-runs.ts). The entry (git-core/pomade-git.ts) supplies
// the outside world: environment, output, and Pomade's answer over the socket.
//
//   pomade-git <commit-push | pull | push | fetch> <repo…> [--json] [--job <name>] [--message <text>]
//              [--wait <seconds>] [--stable]
//
// Rails, on top of the panel's (git-core/rails.ts):
//   - One operation per repo at a time: the same lock as the panel (git-core/lock.ts); a busy repo
//     is waited for (`--wait`, default 30 s), then skipped as busy.
//   - Commit & push and Pull are skipped while an agent works in the repo (Pomade's answer over the
//     socket, plus `claude` / `codex` processes found on this Mac). An agent Pomade reports idle does
//     not count, nor does a process running in that agent's terminal; one with no state does.
//   - Nothing changes unless the run can get their changes: commit-push fetches first; a fetch
//     that fails leaves everything as it was. A conflict is aborted and the commit this run made is
//     taken back, so the repository ends exactly as before — checked, and said when it is not.
//   - Never force, never reset hard, never clean, never stash. A push that fails keeps the commit
//     (and their changes): the next run pushes it.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import {
  GIT_RUN_OPS,
  type GitRunOp,
  type GitRunOutput,
  type GitRunResult,
  type GitRunStatus,
  type GitRunStep,
  type GitRunStepName,
  type LiveAgentEntry
} from 'pomade-kit/protocol'

import { identityFailure, remoteHost, targetLabel, type ErrorContext, type PushTarget } from '@shared/git-ops'
import type { RepoState } from '@shared/git-state'
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, GIT_RUN_TITLE, autoCommitMessage, cleanJobName } from '@shared/git-runs'

import type { AgentProcess } from './agent-processes'
import { commitAll, indexSnapshot, takeBackCommit } from './commit'
import { lockRepo } from './lock'
import {
  StepFailure,
  fingerprint,
  hasIdentity,
  inProgress,
  isBlock,
  opsEnv,
  pushTargetOf,
  pushTo,
  readOk,
  remotesOf,
  sameFingerprint,
  step
} from './rails'
import { discoverRepos, readRemotes, readRepoState } from './repo-state'
import { appendRunLog } from './run-log'
import { catchUp, inFiles } from './sync'

export const USAGE = `Usage: pomade-git <operation> <repo…> [options]

Operations:
  commit-push   commit every change (if any), get their changes (rebase), push
  pull          get their changes (fetch + rebase) into a repository with nothing uncommitted
  push          push this branch's commits
  fetch         fetch from the branch's remote

A repo is its name as the Git panel shows it (Knowledge, Pomade) or a path to it.

Options:
  --json             print the structured result instead of the summary
  --job <name>       the Runner job this run belongs to: the commit says so (Pomade-Job: trailer)
  --message <text>   the commit message (default: "Committed automatically · <date time>")
  --wait <seconds>   how long to wait for another operation in the repo (default 30; 0 = don't)
  --stable           the stable Pomade's workspace and user data (default: the dev Pomade's)

Exit code: 0 every repo done or skipped · 1 a repo failed · 2 the command line was wrong.`

const DEFAULT_WAIT_S = 30
const LOCK_POLL_MS = 500

/** Who is live in a folder now: Pomade's answer (`agents.liveIn`; null = Pomade is not running),
 *  and the agent processes. */
export interface AgentProbe {
  pomade(folder: string): Promise<LiveAgentEntry[] | null>
  processes(folder: string): Promise<AgentProcess[]>
  /** The run is over (a socket connection closes). */
  close?(): void
}

export interface CommandDeps {
  env: Readonly<Record<string, string | undefined>>
  /** Where relative repo paths start. */
  cwd: string
  now: () => number
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** The probe for the Pomade whose user data the options chose. */
  agents: (userData: string) => AgentProbe
  /** Pomade's user data (the run log) and home (the workspace pointer), as the options chose. */
  userData: (stable: boolean) => string
  home: (stable: boolean) => string
  sleep?: (ms: number) => Promise<void>
}

export interface ParsedArgs {
  op: GitRunOp
  repos: string[]
  json: boolean
  job: string | null
  message: string | null
  waitS: number
  stable: boolean
}

/** The command line → what to run, or the usage error. */
export function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const [opArg, ...rest] = argv
  if (!opArg || opArg === '-h' || opArg === '--help') return { error: '' }
  if (!(GIT_RUN_OPS as readonly string[]).includes(opArg)) return { error: `Unknown operation "${opArg}".` }
  const out: ParsedArgs = { op: opArg as GitRunOp, repos: [], json: false, job: null, message: null, waitS: DEFAULT_WAIT_S, stable: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    const value = (): string | null => (i + 1 < rest.length ? rest[++i] : null)
    if (a === '--json') out.json = true
    else if (a === '--stable') out.stable = true
    else if (a === '--job') {
      const v = value()
      const name = v === null ? null : cleanJobName(v)
      if (name === null) return { error: '--job needs a name: one line, at most 100 characters.' }
      out.job = name
    } else if (a === '--message' || a === '-m') {
      const v = value()?.trim()
      if (!v) return { error: '--message needs the text.' }
      out.message = v
    } else if (a === '--wait') {
      const v = Number(value())
      if (!Number.isFinite(v) || v < 0) return { error: '--wait needs a number of seconds.' }
      out.waitS = v
    } else if (a.startsWith('-')) return { error: `Unknown option "${a}".` }
    else out.repos.push(a)
  }
  if (out.repos.length === 0) return { error: 'Name at least one repo.' }
  if (out.op !== 'commit-push' && out.message !== null) return { error: '--message is for commit-push.' }
  return out
}

// ── Finding the repos ─────────────────────────────────────────────────────────

export interface RepoRef {
  name: string
  /** Real path. */
  path: string
}

async function isRepoRoot(dir: string): Promise<boolean> {
  return fs
    .lstat(join(dir, '.git'))
    .then(() => true)
    .catch(() => false)
}

async function real(p: string): Promise<string> {
  return fs.realpath(p).catch(() => p)
}

/** The workspace root Pomade recorded in its home, or `POMADE_WORKSPACE`. */
async function workspaceOf(deps: CommandDeps, stable: boolean): Promise<string | null> {
  const fromEnv = deps.env.POMADE_WORKSPACE?.trim()
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv
  const text = await fs.readFile(join(deps.home(stable), 'workspace'), 'utf8').catch(() => '')
  const root = text.trim()
  return root && isAbsolute(root) ? root : null
}

type Resolved = { ok: true; repo: RepoRef } | { ok: false; reason: string }

/** Resolve the repo arguments: a path (absolute, `./…`, `~/…`, or one that exists from here), or a
 *  name the workspace's discovery knows (the Git panel's naming). */
export async function resolveRepos(args: readonly string[], deps: CommandDeps, stable: boolean): Promise<Resolved[]> {
  let found: { name: string; path: string }[] | null = null
  let workspace: string | null | undefined
  const known = async (): Promise<{ name: string; path: string }[]> => {
    if (found) return found
    workspace = await workspaceOf(deps, stable)
    found = workspace
      ? (await discoverRepos(workspace)).map((r) => ({ name: r === '' ? basename(workspace!) : basename(r), path: join(workspace!, r) }))
      : []
    return found
  }
  const out: Resolved[] = []
  for (const arg of args) {
    const pathLike = isAbsolute(arg) || arg.startsWith('./') || arg.startsWith('../') || arg === '.' || arg === '~' || arg.startsWith('~/')
    const asPath = arg === '~' || arg.startsWith('~/') ? join(homedir(), arg.slice(1)) : resolve(deps.cwd, arg)
    if (pathLike) {
      out.push((await isRepoRoot(asPath)) ? { ok: true, repo: { name: basename(asPath), path: await real(asPath) } } : { ok: false, reason: `${arg} is not a git repository (no .git there).` })
      continue
    }
    const matches = (await known()).filter((r) => r.name === arg)
    if (matches.length === 1) out.push({ ok: true, repo: { name: arg, path: await real(matches[0].path) } })
    else if (matches.length > 1) {
      out.push({ ok: false, reason: `Several repositories are called ${arg} (${matches.map((m) => m.path).join(', ')}) — pass its path instead.` })
    } else if (await isRepoRoot(asPath)) out.push({ ok: true, repo: { name: basename(asPath), path: await real(asPath) } })
    else if (workspace === null) {
      out.push({ ok: false, reason: `No repository called ${arg}: Pomade has not recorded a workspace yet — pass the repo's path instead.` })
    } else out.push({ ok: false, reason: `No repository called ${arg} in ${workspace}.` })
  }
  return out
}

// ── One repo ──────────────────────────────────────────────────────────────────

class Run {
  readonly steps: GitRunStep[] = []
  commit: string | null = null
  constructor(
    readonly op: GitRunOp,
    readonly repo: RepoRef
  ) {}
  step(step: GitRunStepName, outcome: GitRunStatus, detail: string, commits?: number): void {
    this.steps.push(commits === undefined ? { step, outcome, detail } : { step, outcome, detail, commits })
  }
  end(status: GitRunStatus, reason: string | null = null): GitRunResult {
    return { repo: this.repo.name, path: this.repo.path, op: this.op, status, reason, steps: this.steps, commit: this.commit }
  }
  fail(reason: string): GitRunResult {
    return this.end('failed', reason)
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const capital = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}`

async function readState(path: string): Promise<RepoState> {
  // Nested repos (relative to this one) keep their files out of its changes, as in the panel.
  const roots = await discoverRepos(path)
  return readRepoState(path, '', roots.includes('') ? roots : ['', ...roots], readRemotes(path, ''))
}

/** Why the repo cannot take an operation that moves its branch, or null. */
async function branchBlock(state: RepoState): Promise<string | null> {
  if (state.error) return state.error
  const busy = await inProgress(state.absPath)
  if (busy) return `${capital(busy)} is in progress in this repository — finish or abort it first (git status says how).`
  if (state.branch === null) return 'This repository is not on a branch (detached HEAD) — switch to one first, e.g. git switch main.'
  return null
}

/** The `agents` step: skipped while an agent works or waits for the person in the repo — one Pomade
 *  reports working or needs-you, or with no state, and any agent process not running under the
 *  terminal shell of an agent Pomade reports idle. Idle ones are named in the step's detail. */
async function agentCheck(run: Run, agents: AgentProbe): Promise<boolean> {
  const [fromPomade, fromProcesses] = await Promise.all([
    agents.pomade(run.repo.path).catch(() => null),
    agents.processes(run.repo.path).catch(() => [])
  ])
  const idle = (fromPomade ?? []).filter((a) => a.state === 'idle')
  const idleShells = new Set(idle.flatMap((a) => a.terminalPids ?? []))
  const perPomade = (a: LiveAgentEntry): string => `${a.agentId} in ${a.cwd} (per Pomade${a.state === 'needs-you' ? ', waits for you' : ''})`
  const who = [
    ...(fromPomade ?? []).filter((a) => a.state !== 'idle').map(perPomade),
    ...fromProcesses
      .filter((p) => ![p.pid, ...p.ancestors].some((pid) => idleShells.has(pid)))
      .map((p) => `${p.agent} in ${p.cwd} (pid ${p.pid})`)
  ]
  if (who.length > 0) {
    run.step('agents', 'skipped', `agent working: ${who.join('; ')}`)
    return false
  }
  run.step('agents', 'done', idle.length > 0 ? `no agent working here — idle: ${idle.map(perPomade).join('; ')}` : 'no agent working here')
  return true
}

function stepFailure(err: unknown): string {
  if (err instanceof StepFailure) return err.failure.message
  return (err as Error).message || String(err)
}

/** Fetch the target's remote; the failure's message, or null. */
async function fetchTarget(path: string, env: NodeJS.ProcessEnv, target: PushTarget): Promise<string | null> {
  const net: ErrorContext = { action: 'get', host: target.host, url: target.url }
  try {
    await step(path, env, ['fetch', '--no-write-fetch-head', target.remote], { net })
    return null
  } catch (err) {
    return stepFailure(err)
  }
}

async function aheadOf(path: string, state: RepoState, target: PushTarget): Promise<number> {
  if (!state.hasCommits) return 0
  if (target.setUpstream) return Number((await readOk(path, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${target.remote}`]))?.trim()) || 0
  return Number((await readOk(path, ['rev-list', '--count', '@{u}..HEAD']))?.trim()) || 0
}

async function pushStep(run: Run, state: RepoState, env: NodeJS.ProcessEnv, target: PushTarget): Promise<GitRunResult> {
  const path = run.repo.path
  const ahead = await aheadOf(path, state, target)
  if (ahead === 0) {
    run.step('push', 'skipped', 'nothing to push')
    return run.end('done')
  }
  try {
    await pushTo(path, env, state.branch!, target, run.commit?.slice(0, 7))
  } catch (err) {
    run.step('push', 'failed', stepFailure(err))
    const kept = run.commit ? `Committed ${run.commit.slice(0, 7)}, but it was not pushed: ` : ''
    return run.fail(`${kept}${stepFailure(err)}`)
  }
  run.step('push', 'done', `pushed ${plural(ahead, 'commit', 'commits')} to ${targetLabel(target)}`)
  return run.end('done')
}

/** Rebase onto the fetched upstream; on failure, take back this run's commit and check the
 *  repository against `before`. Null when it went through. */
async function pullStep(
  run: Run,
  env: NodeJS.ProcessEnv,
  target: PushTarget,
  undo: { before: Awaited<ReturnType<typeof fingerprint>>; head: string; index: Awaited<ReturnType<typeof indexSnapshot>> } | null
): Promise<GitRunResult | null> {
  const path = run.repo.path
  const label = `${target.remote}/${target.branch}`
  const caught = await catchUp(path, env)
  if (caught.ok) {
    run.step(
      'pull',
      'done',
      caught.theirs === 0 ? `up to date with ${label}` : `got ${plural(caught.theirs, 'commit', 'commits')} from ${label}`,
      caught.theirs
    )
    return null
  }
  let diffs = 'blocked' in caught ? [] : caught.diffs
  if (undo && diffs.length === 0) {
    try {
      await takeBackCommit(path, env, undo.head, undo.index)
      const made = run.steps.find((st) => st.step === 'commit' && st.outcome === 'done')
      if (made) made.detail = `${made.detail} — taken back, as their changes could not come in`
      run.commit = null
      diffs = sameFingerprint(undo.before, await fingerprint(path))
    } catch (err) {
      diffs = [`the commit could not be taken back: ${stepFailure(err)}`]
    }
  }
  if ('blocked' in caught) {
    run.step('pull', 'failed', caught.blocked)
    if (diffs.length === 0) return run.fail(`${caught.blocked} Nothing was pushed.`)
  }
  const what = 'blocked' in caught ? 'Their changes would overwrite ignored files' : caught.files.length > 0 ? `Their changes conflict with yours${inFiles(caught.files)}` : `Getting their changes failed (${caught.line})`
  if (!('blocked' in caught)) run.step('pull', 'failed', caught.files.length > 0 ? `conflict${inFiles(caught.files)}` : caught.line)
  if (diffs.length === 0) return run.fail(`${what}. Nothing was changed — the repository is exactly as before, and nothing was pushed.`)
  return run.fail(`${what}, and the repository could NOT be put back exactly (${diffs.join(', ')}). Nothing was pushed. Look at it in a terminal before anything else: git status.`)
}

async function commitPush(run: Run, args: ParsedArgs, deps: CommandDeps, agents: AgentProbe): Promise<GitRunResult> {
  const path = run.repo.path
  if (!(await agentCheck(run, agents))) return run.end('skipped', 'agent working')
  const state = await readState(path)
  const blocked = await branchBlock(state)
  if (blocked) return run.fail(blocked)
  if (state.changes.some((c) => c.status === 'conflict')) return run.fail('A file has a conflict — resolve it first.')
  const target = pushTargetOf(state, await remotesOf(path))
  if (isBlock(target)) return run.fail(target.message)
  const files = state.changes.length
  const pulls = target !== null && !target.setUpstream
  if ((files > 0 || (pulls && state.ahead > 0)) && !(await hasIdentity(path))) return run.fail(identityFailure().message)
  const env = await opsEnv(path)
  if (pulls) {
    const failed = await fetchTarget(path, env, target)
    if (failed) {
      run.step('commit', 'skipped', files > 0 ? 'not committed — their changes could not be fetched' : 'nothing to commit')
      run.step('pull', 'failed', failed)
      return run.fail(`${failed} Nothing was changed.`)
    }
  }
  const before = await fingerprint(path)
  const head = (await readOk(path, ['rev-parse', '-q', '--verify', 'HEAD']))?.trim() ?? ''
  const index = await indexSnapshot(path)
  if (files === 0) run.step('commit', 'skipped', 'nothing to commit')
  else {
    try {
      const message = args.message !== null ? `${args.message}\n` : autoCommitMessage(args.job, deps.now())
      const short = await commitAll(state, env, message, index)
      run.commit = (await readOk(path, ['rev-parse', 'HEAD']))?.trim() ?? short
      run.step('commit', 'done', `committed ${short} (${plural(files, 'file', 'files')})`)
    } catch (err) {
      run.step('commit', 'failed', stepFailure(err))
      return run.fail(stepFailure(err))
    }
  }
  if (target === null) {
    run.step('pull', 'skipped', 'no remote')
    run.step('push', 'skipped', 'no remote — the commit stays on this Mac')
    return run.end('done')
  }
  if (target.setUpstream) run.step('pull', 'skipped', 'the branch is not on the remote yet')
  else {
    const failed = await pullStep(run, env, target, run.commit && head ? { before, head, index } : null)
    if (failed) return failed
  }
  return pushStep(run, await readState(path), env, target)
}

async function pull(run: Run, agents: AgentProbe): Promise<GitRunResult> {
  const path = run.repo.path
  if (!(await agentCheck(run, agents))) return run.end('skipped', 'agent working')
  const state = await readState(path)
  const blocked = await branchBlock(state)
  if (blocked) return run.fail(blocked)
  const target = pushTargetOf(state, await remotesOf(path))
  if (isBlock(target)) return run.fail(target.message)
  if (target === null) return run.fail('No remote — there is nothing to pull from.')
  if (target.setUpstream) return run.fail('This branch is not on the remote yet — there is nothing to pull.')
  if (state.changes.length > 0) {
    return run.fail('There are uncommitted changes. Pull runs only on a repository with nothing uncommitted, so it can always put everything back exactly (commit-push commits them first).')
  }
  if (state.ahead > 0 && !(await hasIdentity(path))) return run.fail(identityFailure().message)
  const env = await opsEnv(path)
  const failed = await fetchTarget(path, env, target)
  if (failed) {
    run.step('pull', 'failed', failed)
    return run.fail(`${failed} Nothing was changed.`)
  }
  return (await pullStep(run, env, target, null)) ?? run.end('done')
}

async function push(run: Run): Promise<GitRunResult> {
  const path = run.repo.path
  const state = await readState(path)
  const blocked = await branchBlock(state)
  if (blocked) return run.fail(blocked)
  const target = pushTargetOf(state, await remotesOf(path))
  if (isBlock(target)) return run.fail(target.message)
  if (target === null) return run.fail('No remote — there is nowhere to push.')
  return pushStep(run, state, await opsEnv(path), target)
}

async function fetchOp(run: Run): Promise<GitRunResult> {
  const path = run.repo.path
  const state = await readState(path)
  if (state.error) return run.fail(state.error)
  const remotes = await remotesOf(path)
  const target = pushTargetOf(state, remotes)
  const remote = target && !isBlock(target) ? target.remote : (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.name
  if (!remote) return run.fail('No remote — there is nothing to fetch from.')
  const url = remotes.find((r) => r.name === remote)?.url ?? ''
  try {
    await step(path, await opsEnv(path), ['fetch', '--no-write-fetch-head', remote], { net: { action: 'get', host: remoteHost(url), url } })
  } catch (err) {
    run.step('fetch', 'failed', stepFailure(err))
    return run.fail(stepFailure(err))
  }
  const behind = state.upstream ? Number((await readOk(path, ['rev-list', '--count', 'HEAD..@{u}']))?.trim()) || 0 : 0
  run.step('fetch', 'done', state.upstream ? `fetched ${remote} — ${plural(behind, 'new commit', 'new commits')} on ${state.upstream}` : `fetched ${remote}`)
  return run.end('done')
}

/** Run `op` on one repo, holding its lock (waiting up to `--wait`). */
export async function runOne(repo: RepoRef, args: ParsedArgs, deps: CommandDeps, agents: AgentProbe): Promise<GitRunResult> {
  const run = new Run(args.op, repo)
  const title = `${GIT_RUN_TITLE[args.op]} (pomade-git${args.job ? ` · job "${args.job}"` : ''})`
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = deps.now() + args.waitS * 1000
  for (;;) {
    let lock
    try {
      lock = await lockRepo(repo.path, title, { now: deps.now })
    } catch (err) {
      return run.fail(stepFailure(err))
    }
    if (lock.ok) {
      try {
        if (args.op === 'commit-push') return await commitPush(run, args, deps, agents)
        if (args.op === 'pull') return await pull(run, agents)
        if (args.op === 'push') return await push(run)
        return await fetchOp(run)
      } catch (err) {
        return run.fail(stepFailure(err))
      } finally {
        await lock.release()
      }
    }
    if (deps.now() >= deadline) return run.end('skipped', `busy — “${lock.holder}” is running in this repository`)
    await sleep(LOCK_POLL_MS)
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

/** The human summary of one repo's result. */
export function describe(r: GitRunResult): string {
  const head = `${r.repo} · ${GIT_RUN_TITLE[r.op]} · ${r.status}${r.reason ? ` — ${r.reason}` : ''}`
  const width = Math.max(0, ...r.steps.map((s) => s.step.length))
  const lines = r.steps.map((s) => `  ${s.step.padEnd(width)}  ${s.outcome.padEnd(7)}  ${s.detail}`)
  return [head, ...lines].join('\n')
}

/** The command. Resolves with its exit code. */
export async function main(argv: readonly string[], deps: CommandDeps): Promise<number> {
  const args = parseArgs(argv)
  if ('error' in args) {
    if (args.error) deps.stderr(`pomade-git: ${args.error}\n\n`)
    ;(args.error ? deps.stderr : deps.stdout)(`${USAGE}\n`)
    return args.error ? EXIT_USAGE : EXIT_OK
  }
  const startedAt = deps.now()
  const userData = deps.userData(args.stable)
  const resolved = await resolveRepos(args.repos, deps, args.stable)
  const agents = deps.agents(userData)
  const results: GitRunResult[] = []
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i]
    let result: GitRunResult
    if (!r.ok) result = { repo: args.repos[i], path: '', op: args.op, status: 'failed', reason: r.reason, steps: [], commit: null }
    else {
      result = await runOne(r.repo, args, deps, agents)
      try {
        await appendRunLog(userData, { kind: 'run', at: deps.now(), job: args.job, result })
      } catch (err) {
        deps.stderr(`pomade-git: could not write the run log in ${userData}: ${(err as Error).message}\n`)
      }
    }
    results.push(result)
    if (!args.json) deps.stdout(`${describe(result)}\n`)
  }
  agents.close?.()
  if (args.json) {
    const output: GitRunOutput = { op: args.op, job: args.job, at: new Date(startedAt).toISOString(), results }
    deps.stdout(`${JSON.stringify(output, null, 2)}\n`)
  }
  return results.some((r) => r.status === 'failed') ? EXIT_FAILED : EXIT_OK
}
