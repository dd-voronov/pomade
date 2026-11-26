// Pomade — git-core: the rails every git operation runs on (no Electron): running git so it can
// never wait for a prompt, a step that fails into a plain-language failure, the repo facts an
// operation's preview reads, the token and the fingerprint, and explicit pushes. The panel's
// operations (main/git-ops.ts, main/git-operator.ts — through main/git-run.ts, which adds the
// main-process pieces) and the `pomade-git` command (git-core/command.ts) all run on these; the
// per-repo lock is git-core/lock.ts.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  GIT_LOCAL_TIMEOUT_MS,
  GIT_NET_TIMEOUT_MS,
  classifyGitError,
  remoteHost,
  timeoutFailure,
  type ErrorContext,
  type GitBlock,
  type GitFailure,
  type PushTarget
} from '@shared/git-ops'
import { parseRemotes, REMOTES_ARGS, type GitRemote, type RepoOperation, type RepoState } from '@shared/git-state'

import { operationOf } from './repo-state'

// ── Running git ─────────────────────────────────────────────────────────────

export interface Ran {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** Stopped by its `signal` (a background operation giving way). */
  aborted?: boolean
}

/** The environment of every mutating git call: no prompt can ever wait for an answer. */
export async function opsEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  // The user's own ssh command (env, then the repo's core.sshCommand) stays; BatchMode is added so
  // ssh fails instead of asking for a passphrase or a host-key confirmation.
  let ssh = process.env.GIT_SSH_COMMAND?.trim() || ''
  if (!ssh) {
    const cfg = await raw(cwd, ['config', '--get', 'core.sshCommand'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    ssh = cfg.code === 0 ? cfg.stdout.trim() : ''
  }
  if (!ssh) ssh = process.env.GIT_SSH ? `'${process.env.GIT_SSH.replace(/'/g, `'\\''`)}'` : 'ssh'
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes`,
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    LANGUAGE: 'en_US'
  }
}

/** Run git; never throws. stdin gets `input` (or nothing) and is closed. `signal` stops it the way
 *  the time bound does (SIGTERM, then SIGKILL). */
export function raw(
  cwd: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Ran> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', args as string[], { cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: (err as Error).message, timedOut: false })
      return
    }
    const out: Buffer[] = []
    const errOut: Buffer[] = []
    let timedOut = false
    let aborted = false
    const stop = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs ?? GIT_LOCAL_TIMEOUT_MS)
    const onAbort = (): void => {
      aborted = true
      stop()
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => errOut.push(b))
    child.stdin.on('error', () => {})
    const done = (r: Ran): void => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const ran = (code: number | null): Ran => ({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(errOut).toString('utf8'),
      timedOut,
      aborted
    })
    child.on('error', (err) => done({ code: -1, stdout: '', stderr: err.message, timedOut, aborted }))
    child.on('close', (code) => done(ran(code)))
    // A stopped git is done when it exits: its transport (ssh, upload-pack) can outlive it holding
    // the output pipes, and it writes nothing to the repository.
    child.on('exit', (code) => {
      if (!timedOut && !aborted) return
      child.stdout.destroy()
      child.stderr.destroy()
      done(ran(code))
    })
    child.stdin.end(opts.input ?? '')
  })
}

/** Raw bytes of stdout (a blob). Null on failure. */
export function rawBytes(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn('git', args as string[], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] })
    const out: Buffer[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_LOCAL_TIMEOUT_MS)
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? Buffer.concat(out) : null)
    })
  })
}

/** A step that failed: thrown inside an operation, turned into its result by `operation`. */
export class StepFailure extends Error {
  constructor(readonly failure: GitFailure) {
    super(failure.message)
  }
}

/** Run a step; a non-zero exit throws a StepFailure (classified with `ctx` for network steps).
 *  `signal` stops it (a background operation giving way): a `busy` failure. */
export async function step(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  opts: { input?: string; net?: ErrorContext; committed?: string; signal?: AbortSignal } = {}
): Promise<Ran> {
  const timeoutMs = opts.net ? GIT_NET_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS
  const r = await raw(cwd, args, { env, input: opts.input, timeoutMs, signal: opts.signal })
  if (r.aborted) throw new StepFailure({ kind: 'busy', message: 'Stopped to give way to another operation in this repository.' })
  if (r.timedOut) throw new StepFailure({ ...timeoutFailure(opts.net ?? null, timeoutMs / 1000), committed: opts.committed })
  if (r.code !== 0) {
    const text = `${r.stderr}\n${r.stdout}`
    const failure = opts.net
      ? classifyGitError(text, opts.net)
      : classifyGitError(text, { action: 'push', host: remoteHost(''), url: '' })
    throw new StepFailure({ ...failure, committed: opts.committed })
  }
  return r
}

export async function readOk(cwd: string, args: readonly string[]): Promise<string | null> {
  const r = await raw(cwd, args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
  return r.code === 0 ? r.stdout : null
}

// ── Repo facts ──────────────────────────────────────────────────────────────

const OPERATION_WORDS: Record<RepoOperation, string> = {
  rebase: 'a rebase',
  merge: 'a merge',
  'cherry-pick': 'a cherry-pick',
  revert: 'a revert'
}

/** An operation git left half-done (a rebase, merge, cherry-pick, revert), in words; null if none. */
export async function inProgress(cwd: string): Promise<string | null> {
  const op = await operationOf(cwd)
  return op ? OPERATION_WORDS[op] : null
}

export function inProgressBlock(what: string): GitBlock {
  return {
    message: `${what[0].toUpperCase()}${what.slice(1)} is in progress in this repository. Finish or abort it in a terminal first (git status says how).`,
    copy: 'git status'
  }
}

/** Does git know who makes commits here (user.name and user.email, or the env equivalents)? */
export async function hasIdentity(cwd: string): Promise<boolean> {
  const env = process.env
  const name = env.GIT_AUTHOR_NAME || env.GIT_COMMITTER_NAME || (await readOk(cwd, ['config', '--get', 'user.name']))?.trim()
  const email = env.GIT_AUTHOR_EMAIL || env.GIT_COMMITTER_EMAIL || (await readOk(cwd, ['config', '--get', 'user.email']))?.trim()
  return Boolean(name) && Boolean(email)
}

export async function remotesOf(cwd: string): Promise<GitRemote[]> {
  const out = await readOk(cwd, REMOTES_ARGS)
  return out === null ? [] : parseRemotes(out)
}

/** Where this branch pushes: its upstream, else `origin` (or the only remote) under the branch's
 *  own name, set as upstream by the push. Null without a remote; a block when the upstream is a
 *  local branch. */
export function pushTargetOf(state: RepoState, remotes: readonly GitRemote[]): PushTarget | GitBlock | null {
  if (remotes.length === 0 || state.branch === null) return null
  if (state.upstream !== null) {
    let best: GitRemote | null = null
    for (const r of remotes) {
      if (state.upstream.startsWith(`${r.name}/`) && (best === null || r.name.length > best.name.length)) best = r
    }
    if (!best) {
      return { message: `This branch follows another local branch (${state.upstream}) — Pomade pushes only to a remote. Push it in a terminal.` }
    }
    return {
      remote: best.name,
      branch: state.upstream.slice(best.name.length + 1),
      url: best.url,
      host: remoteHost(best.url),
      setUpstream: false
    }
  }
  const r = remotes.find((x) => x.name === 'origin') ?? remotes[0]
  return { remote: r.name, branch: state.branch, url: r.url, host: remoteHost(r.url), setUpstream: true }
}

export function isBlock(x: PushTarget | GitBlock | null): x is GitBlock {
  return x !== null && 'message' in x
}

/** The token a preview hands out: HEAD, the branch, its upstream and every uncommitted path with
 *  its status. `run` refuses when it differs ("the repo changed since the preview"). */
export async function repoToken(cwd: string, extra = ''): Promise<string> {
  const head = (await readOk(cwd, ['rev-parse', '-q', '--verify', 'HEAD']))?.trim() ?? ''
  const status = (await readOk(cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'])) ?? ''
  return createHash('sha1').update(`${head}\0${status}\0${extra}`).digest('hex')
}

/** The state "exactly as before" is checked against: HEAD, the branch HEAD is on, the index
 *  (every entry with its blob) and the full status — untracked and ignored files included. */
export interface Fingerprint {
  head: string
  ref: string
  index: string
  status: string
}

export async function fingerprint(cwd: string): Promise<Fingerprint> {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  const [head, ref, index, status] = await Promise.all([
    raw(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { env }),
    raw(cwd, ['symbolic-ref', '-q', 'HEAD'], { env }),
    raw(cwd, ['ls-files', '-s', '-z'], { env }),
    raw(cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignored=matching'], { env })
  ])
  const h = (s: string): string => createHash('sha1').update(s).digest('hex')
  return { head: head.stdout.trim(), ref: ref.stdout.trim(), index: h(index.stdout), status: h(status.stdout) }
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): string[] {
  const diffs: string[] = []
  if (a.head !== b.head) diffs.push('HEAD moved')
  if (a.ref !== b.ref) diffs.push('the branch changed')
  if (a.index !== b.index) diffs.push('the staged files changed')
  if (a.status !== b.status) diffs.push('the files on disk changed')
  return diffs
}

/** Files with an open conflict (repo-relative). */
export async function conflictedPaths(cwd: string): Promise<string[]> {
  return ((await readOk(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])) ?? '').split('\0').filter(Boolean)
}

/** git overwrites ignored files without asking when it checks out a file at their path. Before a
 *  rebase or a switch: the sentence refusing it when files that change (`git diff --name-only
 *  <range>`) are ignored files here; null when none are. `what` starts the sentence. */
export async function ignoredOverwrites(cwd: string, range: readonly string[], what = 'Their changes'): Promise<string | null> {
  const changedThere = ((await readOk(cwd, ['diff', '--name-only', '--no-renames', '-z', ...range])) ?? '').split('\0').filter(Boolean)
  if (changedThere.length === 0) return null
  const ignored = (
    (
      await raw(cwd, ['--literal-pathspecs', 'ls-files', '-o', '-i', '--exclude-standard', '-z', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        input: pathspecs(changedThere)
      })
    ).stdout ?? ''
  )
    .split('\0')
    .filter(Boolean)
  if (ignored.length === 0) return null
  return `${what} would overwrite ${ignored.slice(0, 3).join(', ')}${ignored.length > 3 ? ` and ${ignored.length - 3} more` : ''}, which git ignores here. Move it aside first — nothing was changed.`
}

export function inRepo(repo: string, path: string): string {
  return repo === '' ? path : path.slice(repo.length + 1)
}

/** NUL-separated pathspecs for `--pathspec-from-file=- --pathspec-file-nul`. */
export function pathspecs(paths: readonly string[]): string {
  return paths.map((p) => `${p}\0`).join('')
}

export async function shortHead(cwd: string): Promise<string> {
  return ((await readOk(cwd, ['rev-parse', '--short', 'HEAD'])) ?? '').trim()
}

// ── Pushing ─────────────────────────────────────────────────────────────────

export const CHANGED: GitFailure = {
  kind: 'changed',
  message: 'The repository changed since the preview (an agent or a terminal?). Nothing was done — look at the preview again.'
}

/** Push `target` (never forced). Returns the porcelain output. */
export async function pushTo(cwd: string, env: NodeJS.ProcessEnv, branch: string, target: PushTarget, committed?: string): Promise<void> {
  const args = ['push', '--porcelain']
  if (target.setUpstream) args.push('-u')
  args.push(target.remote, `refs/heads/${branch}:refs/heads/${target.branch}`)
  await step(cwd, env, args, { net: { action: 'push', host: target.host, url: target.url }, committed })
}
