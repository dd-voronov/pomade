// E-042 — the `pomade-git` command against real repos: fixture repos with bare local remotes in
// temp dirs, a test user data and home, git's config isolated. "Pomade closed": nothing answers on
// a socket (the probe's Pomade answer is null) unless a test says otherwise; agent processes are
// found for real (a fake `claude` started with its cwd in the repo).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { GitRunOutput, LiveAgentEntry } from 'pomade-kit/protocol'

import { JOB_TRAILER, summarizeRuns } from '@shared/git-runs'

import { agentProcessesIn } from './agent-processes'
import { main, parseArgs, type AgentProbe, type CommandDeps } from './command'
import { tryLockRepo } from './lock'

let scratch: string
const savedEnv = { ...process.env }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env })
}

async function write(path: string, text: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, text)
}

interface Fixture {
  root: string
  ws: string
  repo: string
  remote: string
  other: string
  userData: string
  home: string
}

let n = 0
async function fixture(): Promise<Fixture> {
  const root = join(scratch, `f${++n}`)
  const ws = join(root, 'ws')
  const repo = join(ws, 'Knowledge')
  const remote = join(root, 'knowledge.git')
  const other = join(root, 'other')
  const userData = join(root, 'ud')
  const home = join(root, 'home')
  git(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
  await write(join(repo, '.gitignore'), '*.log\n')
  await write(join(repo, 'notes.md'), 'one\n')
  await write(join(repo, 'debug.log'), 'ignored, never touched\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'start')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  git(root, 'clone', '-q', remote, other)
  await write(join(home, 'workspace'), `${ws}\n`)
  return { root, ws, repo, remote, other, userData, home }
}

const noAgents: AgentProbe = { pomade: async () => null, processes: async () => [] }

function deps(f: Fixture, agents: AgentProbe = noAgents, now = (): number => Date.now()): CommandDeps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    env: {},
    cwd: f.root,
    now,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    agents: () => agents,
    userData: () => f.userData,
    home: () => f.home,
    out,
    err
  }
}

async function run(f: Fixture, argv: string[], agents?: AgentProbe): Promise<{ code: number; json: GitRunOutput; d: ReturnType<typeof deps> }> {
  const d = deps(f, agents)
  const code = await main([...argv, '--json'], d)
  return { code, json: JSON.parse(d.out.join('')) as GitRunOutput, d }
}

/** Everything "exactly as before" means: HEAD, the branch, the full status (ignored files too) and
 *  every file's bytes outside .git. */
async function snapshot(repo: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else files[relative(repo, p)] = createHash('sha1').update(await fs.readFile(p)).digest('hex')
    }
  }
  await walk(repo)
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    branch: git(repo, 'symbolic-ref', 'HEAD'),
    status: git(repo, 'status', '--porcelain=v2', '--ignored'),
    files: JSON.stringify(files)
  }
}

/** Someone else pushes a change to notes.md. */
async function theyPush(f: Fixture, text = 'theirs\n'): Promise<void> {
  git(f.other, 'pull', '-q', '--rebase')
  await write(join(f.other, 'notes.md'), text)
  git(f.other, 'commit', '-q', '-am', 'their change')
  git(f.other, 'push', '-q')
}

beforeAll(async () => {
  scratch = await fs.realpath(await mkdtemp(join(tmpdir(), 'pomade-git-')))
  await write(join(scratch, 'gitconfig'), '[user]\n\tname = Pomade Test\n\temail = t@pomade.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
  process.env.GIT_CONFIG_GLOBAL = join(scratch, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_TERMINAL_PROMPT = '0'
})

afterAll(async () => {
  process.env = savedEnv
  await fs.rm(scratch, { recursive: true, force: true })
})

describe('parseArgs', () => {
  it('reads the operation, the repos and the options', () => {
    expect(parseArgs(['commit-push', 'Knowledge', './x', '--json', '--job', ' Knowledge twice daily ', '--wait', '0'])).toEqual({
      op: 'commit-push',
      repos: ['Knowledge', './x'],
      json: true,
      job: 'Knowledge twice daily',
      message: null,
      waitS: 0,
      stable: false
    })
  })

  it('refuses what it cannot run', () => {
    expect(parseArgs(['merge', 'K'])).toEqual({ error: 'Unknown operation "merge".' })
    expect(parseArgs(['pull'])).toEqual({ error: 'Name at least one repo.' })
    expect(parseArgs(['pull', 'K', '--message', 'x'])).toEqual({ error: '--message is for commit-push.' })
    expect(parseArgs(['pull', 'K', '--job', 'a\nb'])).toHaveProperty('error')
    expect(parseArgs(['pull', 'K', '--force'])).toEqual({ error: 'Unknown option "--force".' })
    expect(parseArgs(['--help'])).toEqual({ error: '' })
  })
})

describe('pomade-git commit-push', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await fixture()
  })

  it('commits, pulls and pushes; run again with nothing changed it says so', async () => {
    await write(join(f.repo, 'notes.md'), 'one\ntwo\n')
    await write(join(f.repo, 'new.md'), 'new\n')
    const first = await run(f, ['commit-push', 'Knowledge', '--job', 'Knowledge twice daily'])
    expect(first.code).toBe(0)
    const r = first.json.results[0]
    expect(r).toMatchObject({ repo: 'Knowledge', path: f.repo, op: 'commit-push', status: 'done', reason: null })
    expect(r.commit).toBe(git(f.repo, 'rev-parse', 'HEAD').trim())
    expect(git(f.remote, 'rev-parse', 'main').trim()).toBe(r.commit)
    expect(r.steps.map((s) => [s.step, s.outcome])).toEqual([
      ['agents', 'done'],
      ['commit', 'done'],
      ['pull', 'done'],
      ['push', 'done']
    ])
    // Only a done pull step carries the commit count: 0 when up to date.
    expect(r.steps.map((s) => ('commits' in s ? [s.step, s.commits] : [s.step]))).toEqual([['agents'], ['commit'], ['pull', 0], ['push']])
    const message = git(f.repo, 'log', '-1', '--format=%B')
    expect(message).toMatch(/^Committed automatically · job "Knowledge twice daily" · \d{4}-\d\d-\d\d \d\d:\d\d\n/)
    expect(git(f.repo, 'log', '-1', `--format=%(trailers:key=${JOB_TRAILER},valueonly)`).trim()).toBe('Knowledge twice daily')
    expect(git(f.repo, 'status', '--porcelain')).toBe('')

    const second = await run(f, ['commit-push', 'Knowledge'])
    expect(second.code).toBe(0)
    expect(second.json.results[0]).toMatchObject({ status: 'done', commit: null })
    expect(second.json.results[0].steps).toContainEqual({ step: 'commit', outcome: 'skipped', detail: 'nothing to commit' })
    expect(second.json.results[0].steps).toContainEqual({ step: 'push', outcome: 'skipped', detail: 'nothing to push' })

    // Both runs are in the run log; the last one is the repo's.
    const log = summarizeRuns(await fs.readFile(join(f.userData, 'git', 'runs.jsonl'), 'utf8'))
    expect(log.get(f.repo)?.result.status).toBe('done')
    expect(log.get(f.repo)?.unseenFailure).toBe(false)
  })

  it('a conflict fails with the reason and leaves the repository exactly as before', async () => {
    await theyPush(f)
    await write(join(f.repo, 'notes.md'), 'mine\n')
    const before = await snapshot(f.repo)
    const remoteBefore = git(f.remote, 'rev-parse', 'main')
    const { code, json } = await run(f, ['commit-push', 'Knowledge'])
    expect(code).toBe(1)
    const r = json.results[0]
    expect(r.status).toBe('failed')
    expect(r.reason).toContain('Their changes conflict with yours in notes.md')
    expect(r.reason).toContain('exactly as before')
    expect(r.commit).toBeNull()
    expect(r.steps.find((s) => s.step === 'pull')).toMatchObject({ outcome: 'failed', detail: 'conflict in notes.md' })
    expect(r.steps.some((s) => 'commits' in s)).toBe(false)
    expect(await snapshot(f.repo)).toEqual(before)
    expect(git(f.remote, 'rev-parse', 'main')).toBe(remoteBefore)
    const log = summarizeRuns(await fs.readFile(join(f.userData, 'git', 'runs.jsonl'), 'utf8'))
    expect(log.get(f.repo)?.unseenFailure).toBe(true)
  })

  it('gets their changes under its own commit when they do not conflict', async () => {
    await theyPush(f, 'one\n\ntheirs at the end\n')
    await write(join(f.repo, 'other.md'), 'mine\n')
    const { code, json } = await run(f, ['commit-push', 'Knowledge'])
    expect(code).toBe(0)
    expect(json.results[0].steps.find((s) => s.step === 'pull')).toEqual({ step: 'pull', outcome: 'done', detail: 'got 1 commit from origin/main', commits: 1 })
    expect(json.results[0].steps.filter((s) => 'commits' in s).map((s) => s.step)).toEqual(['pull'])
    expect(git(f.remote, 'log', '--format=%s', 'main').split('\n').slice(0, 2)[1]).toBe('their change')
  })

  it('skips while an agent process works in the repo — Pomade closed', async () => {
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const bin = join(f.root, 'bin')
    await write(join(bin, 'claude'), '#!/bin/sh\nwhile true; do sleep 1; done\n')
    await fs.chmod(join(bin, 'claude'), 0o755)
    const agent: ChildProcess = spawn(join(bin, 'claude'), [], { cwd: join(f.repo), stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 300))
      const before = await snapshot(f.repo)
      const probe: AgentProbe = { pomade: async () => null, processes: agentProcessesIn }
      const { code, json } = await run(f, ['commit-push', 'Knowledge'], probe)
      expect(code).toBe(0)
      expect(json.results[0]).toMatchObject({ status: 'skipped', reason: 'agent working', commit: null })
      expect(json.results[0].steps).toEqual([
        { step: 'agents', outcome: 'skipped', detail: `agent working: claude in ${await fs.realpath(f.repo)} (pid ${agent.pid})` }
      ])
      expect(await snapshot(f.repo)).toEqual(before)
    } finally {
      agent.kill('SIGKILL')
    }
  })

  it('skips while Pomade says an agent is live in the repo', async () => {
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const asked: string[] = []
    const probe: AgentProbe = {
      pomade: async (folder) => {
        asked.push(folder)
        return [{ agentId: 'claude', cwd: f.repo }]
      },
      processes: async () => []
    }
    const { json } = await run(f, ['commit-push', 'Knowledge'], probe)
    expect(asked).toEqual([f.repo])
    expect(json.results[0]).toMatchObject({ status: 'skipped', reason: 'agent working' })
  })

  // T-323 — an idle agent does not hold the repo; one that works, waits for the person, or whose
  // state Pomade does not know does.
  const pomadeSays = (agents: LiveAgentEntry[]): AgentProbe => ({ pomade: async () => agents, processes: async () => [] })

  it('goes on past an agent Pomade reports idle; its agents step says no agent works and names it', async () => {
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const { code, json } = await run(f, ['commit-push', 'Knowledge'], pomadeSays([{ agentId: 'claude', cwd: f.repo, state: 'idle', terminalPids: [4242] }]))
    expect(code).toBe(0)
    expect(json.results[0]).toMatchObject({ status: 'done', reason: null })
    expect(json.results[0].steps[0]).toEqual({ step: 'agents', outcome: 'done', detail: `no agent working here — idle: claude in ${f.repo} (per Pomade)` })
    expect(git(f.remote, 'rev-parse', 'main').trim()).toBe(json.results[0].commit)
  })

  it.each([
    ['working', { state: 'working' as const }, `claude in REPO (per Pomade)`],
    ['needs-you', { state: 'needs-you' as const }, `claude in REPO (per Pomade, waits for you)`],
    ['no state', {}, `claude in REPO (per Pomade)`]
  ])('skips for an agent Pomade reports %s', async (_name, state, who) => {
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const before = await snapshot(f.repo)
    const agents: LiveAgentEntry[] = [
      { agentId: 'codex', cwd: f.repo, state: 'idle', terminalPids: [4242] },
      { agentId: 'claude', cwd: f.repo, ...state }
    ]
    const { json } = await run(f, ['commit-push', 'Knowledge'], pomadeSays(agents))
    expect(json.results[0]).toMatchObject({ status: 'skipped', reason: 'agent working', commit: null })
    expect(json.results[0].steps).toEqual([{ step: 'agents', outcome: 'skipped', detail: `agent working: ${who.replace('REPO', f.repo)}` }])
    expect(await snapshot(f.repo)).toEqual(before)
  })

  it("an idle tab's own agent process does not hold the repo; a process Pomade does not know does", async () => {
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const bin = join(f.root, 'bin')
    await write(join(bin, 'claude'), '#!/bin/sh\nwhile true; do sleep 1; done\n')
    await fs.chmod(join(bin, 'claude'), 0o755)
    // The "terminal shell": a shell that runs the agent as its child (no exec — `; true` keeps it).
    const shell: ChildProcess = spawn('/bin/sh', ['-c', `true; ${join(bin, 'claude')}; true`], { cwd: f.repo, stdio: 'ignore' })
    let stray: ChildProcess | null = null
    try {
      await new Promise((r) => setTimeout(r, 300))
      const repoReal = await fs.realpath(f.repo)
      const inRepo = await agentProcessesIn(f.repo)
      expect(inRepo).toHaveLength(1)
      const tabAgent = inRepo[0]
      expect(tabAgent.ancestors[0]).toBe(shell.pid)
      const tab = (state: LiveAgentEntry['state'], pid = shell.pid!): AgentProbe => ({
        pomade: async () => [{ agentId: 'claude', cwd: f.repo, state, terminalPids: [pid] }],
        processes: agentProcessesIn
      })

      // Its tab is idle: the process is that tab's — no veto.
      const goes = await run(f, ['commit-push', 'Knowledge', '--message', 'idle tab'], tab('idle'))
      expect(goes.json.results[0]).toMatchObject({ status: 'done' })
      expect(goes.json.results[0].steps[0]).toMatchObject({ step: 'agents', outcome: 'done' })

      // Idle by Pomade, but the process runs under another shell: Pomade does not know it — veto.
      await write(join(f.repo, 'notes.md'), 'changed again\n')
      const other = await run(f, ['commit-push', 'Knowledge'], tab('idle', 1))
      expect(other.json.results[0].steps).toEqual([
        { step: 'agents', outcome: 'skipped', detail: `agent working: claude in ${repoReal} (pid ${tabAgent.pid})` }
      ])

      // Pomade closed: the same process vetoes.
      const closed = await run(f, ['commit-push', 'Knowledge'], { pomade: async () => null, processes: agentProcessesIn })
      expect(closed.json.results[0]).toMatchObject({ status: 'skipped', reason: 'agent working' })

      // A stray `claude` started outside Pomade, next to the idle tab: it vetoes, the tab's does not.
      stray = spawn(join(bin, 'claude'), [], { cwd: f.repo, stdio: 'ignore' })
      await new Promise((r) => setTimeout(r, 300))
      const mixed = await run(f, ['commit-push', 'Knowledge'], tab('idle'))
      expect(mixed.json.results[0].steps).toEqual([{ step: 'agents', outcome: 'skipped', detail: `agent working: claude in ${repoReal} (pid ${stray.pid})` }])
    } finally {
      stray?.kill('SIGKILL')
      shell.kill('SIGKILL')
      for (const p of await agentProcessesIn(f.repo).catch(() => [])) process.kill(p.pid, 'SIGKILL')
    }
  })

  it('waits for the repo lock, or reports busy', async () => {
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const held = await tryLockRepo(f.repo, 'Commit & push')
    expect(held.ok).toBe(true)
    const busy = await run(f, ['commit-push', 'Knowledge', '--wait', '0'])
    expect(busy.json.results[0]).toMatchObject({ status: 'skipped', reason: 'busy — “Commit & push” is running in this repository' })
    expect(git(f.repo, 'status', '--porcelain')).not.toBe('')
    setTimeout(() => void (held.ok && held.release()), 400)
    const waited = await run(f, ['commit-push', 'Knowledge', '--wait', '5'])
    expect(waited.json.results[0].status).toBe('done')
  })

  it('a repo without a remote: commits, and says the rest stays here', async () => {
    git(f.repo, 'remote', 'remove', 'origin')
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const { code, json } = await run(f, ['commit-push', f.repo])
    expect(code).toBe(0)
    expect(json.results[0].status).toBe('done')
    expect(json.results[0].steps.slice(2)).toEqual([
      { step: 'pull', outcome: 'skipped', detail: 'no remote' },
      { step: 'push', outcome: 'skipped', detail: 'no remote — the commit stays on this Mac' }
    ])
  })

  it('a remote it cannot reach changes nothing', async () => {
    git(f.repo, 'remote', 'set-url', 'origin', join(f.root, 'gone.git'))
    await write(join(f.repo, 'notes.md'), 'changed\n')
    const before = await snapshot(f.repo)
    const { code, json } = await run(f, ['commit-push', 'Knowledge'])
    expect(code).toBe(1)
    expect(json.results[0].status).toBe('failed')
    expect(json.results[0].reason).toContain('Nothing was changed.')
    expect(await snapshot(f.repo)).toEqual(before)
  })
})

describe('pomade-git pull, push, fetch', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await fixture()
  })

  it('pull gets their commits; refuses uncommitted changes; a conflict is put back exactly', async () => {
    await theyPush(f)
    expect((await run(f, ['pull', 'Knowledge'])).json.results[0].steps).toEqual([
      { step: 'agents', outcome: 'done', detail: 'no agent working here' },
      { step: 'pull', outcome: 'done', detail: 'got 1 commit from origin/main', commits: 1 }
    ])
    await write(join(f.repo, 'notes.md'), 'dirty\n')
    const dirty = await run(f, ['pull', 'Knowledge'])
    expect(dirty.json.results[0]).toMatchObject({ status: 'failed' })
    expect(dirty.json.results[0].reason).toContain('uncommitted changes')
    git(f.repo, 'commit', '-q', '-am', 'mine')
    await theyPush(f, 'theirs again\n')
    const before = await snapshot(f.repo)
    const conflict = await run(f, ['pull', 'Knowledge'])
    expect(conflict.code).toBe(1)
    expect(conflict.json.results[0].reason).toContain('conflict with yours in notes.md')
    expect(conflict.json.results[0].steps.some((s) => 'commits' in s)).toBe(false)
    expect(await snapshot(f.repo)).toEqual(before)
  })

  it('the pull step counts the commits it got: several, then none when up to date', async () => {
    await theyPush(f, 'first\n')
    await theyPush(f, 'second\n')
    const got = (await run(f, ['pull', 'Knowledge'])).json.results[0].steps.find((s) => s.step === 'pull')
    expect(got).toEqual({ step: 'pull', outcome: 'done', detail: 'got 2 commits from origin/main', commits: 2 })
    const upToDate = (await run(f, ['pull', 'Knowledge'])).json.results[0].steps.find((s) => s.step === 'pull')
    expect(upToDate).toEqual({ step: 'pull', outcome: 'done', detail: 'up to date with origin/main', commits: 0 })
  })

  it('push sends local commits, says when there is nothing, and fails when the remote moved', async () => {
    await write(join(f.repo, 'a.md'), 'a\n')
    git(f.repo, 'add', '-A')
    git(f.repo, 'commit', '-q', '-m', 'local')
    const pushed = await run(f, ['push', 'Knowledge'])
    expect(pushed.json.results[0]).toMatchObject({ status: 'done', steps: [{ step: 'push', outcome: 'done' }] })
    expect((await run(f, ['push', 'Knowledge'])).json.results[0].steps).toEqual([{ step: 'push', outcome: 'skipped', detail: 'nothing to push' }])
    git(f.repo, 'commit', '-q', '--allow-empty', '-m', 'mine')
    await theyPush(f)
    const moved = await run(f, ['push', 'Knowledge'])
    expect(moved.code).toBe(1)
    expect(moved.json.results[0].reason).toContain('has commits you don’t have yet')
  })

  it('fetch reports what is new', async () => {
    await theyPush(f)
    const { json } = await run(f, ['fetch', 'Knowledge'])
    expect(json.results[0]).toMatchObject({ status: 'done', steps: [{ step: 'fetch', outcome: 'done', detail: 'fetched origin — 1 new commit on origin/main' }] })
  })
})

describe('repo arguments', () => {
  let f: Fixture
  beforeEach(async () => {
    f = await fixture()
  })
  afterEach(() => {
    delete process.env.POMADE_WORKSPACE
  })

  it('a name the workspace does not have, or several repos share, fails that repo only', async () => {
    await write(join(f.ws, 'Projects', 'Knowledge', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const { code, json } = await run(f, ['fetch', 'Nope', 'Knowledge', f.repo])
    expect(code).toBe(1)
    expect(json.results.map((r) => r.status)).toEqual(['failed', 'failed', 'done'])
    expect(json.results[0].reason).toBe(`No repository called Nope in ${f.ws}.`)
    expect(json.results[1].reason).toContain('Several repositories are called Knowledge')
  })

  it('prints a summary without --json', async () => {
    const d = deps(f)
    expect(await main(['fetch', 'Knowledge'], d)).toBe(0)
    expect(d.out.join('')).toBe('Knowledge · Fetch · done\n  fetch  done     fetched origin — 0 new commits on origin/main\n')
  })
})
