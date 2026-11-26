// modules: git, core
// Pomade E-042 e2e — the `pomade-git` command (docs/modules/git/pomade-git.md), run as its own
// process exactly as a terminal or Runner runs it (`bin/pomade-git`, the built
// out/main/pomade-git.js), against the fixture repos with LOCAL BARE remotes
// (e2e/fixtures/git-ops-repos.ts), with a test user data and home — never ~/.pomade. First with
// Pomade closed: commit & push, nothing to commit, a conflict put back byte for byte, an agent
// process in the repo. Then Pomade launches: the repo rows show the last run, the failed run's
// mark waits for the user, History words the automatic commit; a run while Pomade is open marks
// live; a stand-in Runner (e2e/fixtures/apps/runner) answering "jobs for repo X" gives the
// Scheduled line, which opens the job; Runner absent or not answering → no line; a Runner that
// starts serving after the panel showed, or publishes `jobs.changed` or `runs.changed`, updates the line at once.
// Set POMADE_TEST_E042_SHOTS=<dir> for screenshots.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, gitIn, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { tabsOf } from './fixtures/hello-app'
import { showGitPanel } from './fixtures/panels'

const BIN = resolve(__dirname, '../bin/pomade-git')
const BUILT = resolve(__dirname, '../out/main/pomade-git.js')
const RUNNER_DIR = resolve(__dirname, 'fixtures/apps/runner')
const SHOTS = process.env.POMADE_TEST_E042_SHOTS
const ALPHA_JOB = {
  id: 'alpha-twice-daily',
  name: 'Alpha twice daily',
  operation: 'commit-push',
  schedule: '13:00, 20:00',
  nextRun: '2026-11-12T13:00:00.000Z',
  lastResult: { status: 'done', at: '2026-11-11T13:00:00.000Z' },
  route: 'jobs/alpha-twice-daily'
}

let fx: GitOpsFixture
let home: string
let app: ElectronApplication | null = null
let page: Page

const g = (cwd: string, ...args: string[]): string => gitIn(fx.scratch, cwd, ...args).trim()

interface Result {
  repo: string
  path: string
  status: string
  reason: string | null
  steps: { step: string; outcome: string; detail: string }[]
  commit: string | null
}

/** Run the command as a fresh process: the test's user data and home, git's config isolated. */
function pomadeGit(...args: string[]): { code: number; results: Result[]; stdout: string } {
  const r = spawnSync(process.execPath, [BIN, ...args, '--json'], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '',
      POMADE_USER_DATA: fx.userDataDir,
      POMADE_HOME: home,
      ...fx.env
    }
  })
  let results: Result[] = []
  try {
    results = (JSON.parse(r.stdout) as { results: Result[] }).results
  } catch {
    throw new Error(`pomade-git printed no JSON (exit ${r.status}): ${r.stdout}\n${r.stderr}`)
  }
  return { code: r.status ?? -1, results, stdout: r.stdout }
}

/** HEAD, the branch, the full status (ignored files too) and every file's bytes. */
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
    head: g(repo, 'rev-parse', 'HEAD'),
    branch: g(repo, 'symbolic-ref', 'HEAD'),
    status: g(repo, 'status', '--porcelain=v2', '--ignored'),
    files: JSON.stringify(files)
  }
}

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function launch(env: Record<string, string> = {}): Promise<void> {
  await app?.close()
  ;({ app, page } = await launchAppPage(fx, { ...fx.env, ...env }))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('project-__workspace__').click()
  await showGitPanel(page)
  await expect(page.getByTestId('git-repo-list-title')).toHaveText('All repositories')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createGitOpsFixture()
  home = join(fx.scratch, 'pomade-home')
  // What a Pomade records in its home: the workspace, so repo names resolve with Pomade closed.
  await write(join(home, 'workspace'), `${fx.workspaceRoot}\n`)
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('the command is Electron-free: the built entry never loads Electron', async () => {
  const text = await fs.readFile(BUILT, 'utf8')
  expect(text).not.toMatch(/require\(["']electron["']\)/)
})

test('Pomade closed, a fresh terminal: commit-push commits and pushes; again with nothing changed it says so', async () => {
  await write(join(fx.alpha, 'notes.txt'), 'alpha notes\nmore\n')
  const first = pomadeGit('commit-push', 'alpha', '--job', 'Alpha twice daily')
  expect(first.code).toBe(0)
  expect(first.results).toHaveLength(1)
  const r = first.results[0]
  expect(r).toMatchObject({ repo: 'alpha', status: 'done', reason: null })
  expect(r.commit).toBe(g(fx.alpha, 'rev-parse', 'HEAD'))
  expect(g(fx.remote, 'rev-parse', 'refs/heads/main')).toBe(r.commit)
  expect(g(fx.alpha, 'log', '-1', '--format=%s')).toMatch(/^Committed automatically · job "Alpha twice daily" · \d{4}-\d\d-\d\d \d\d:\d\d$/)
  expect(g(fx.alpha, 'log', '-1', '--format=%(trailers:key=Pomade-Job,valueonly)')).toBe('Alpha twice daily')

  const again = pomadeGit('commit-push', 'alpha')
  expect(again.code).toBe(0)
  expect(again.results[0]).toMatchObject({ status: 'done', commit: null })
  expect(again.results[0].steps).toContainEqual({ step: 'commit', outcome: 'skipped', detail: 'nothing to commit' })
})

test('a conflicting commit on the remote: failed with the reason; HEAD, branch, status and every byte as before', async () => {
  g(fx.other, 'pull', '-q', '--rebase')
  await write(join(fx.other, 'notes.txt'), 'their notes\n')
  g(fx.other, 'commit', '-q', '-am', 'Their notes')
  g(fx.other, 'push', '-q')
  await write(join(fx.alpha, 'notes.txt'), 'my notes\n')
  const before = await snapshot(fx.alpha)
  const remoteBefore = g(fx.remote, 'rev-parse', 'refs/heads/main')

  const { code, results } = pomadeGit('commit-push', 'alpha')
  expect(code).toBe(1)
  expect(results[0].status).toBe('failed')
  expect(results[0].reason).toBe(
    'Their changes conflict with yours in notes.txt. Nothing was changed — the repository is exactly as before, and nothing was pushed.'
  )
  expect(await snapshot(fx.alpha)).toEqual(before)
  expect(g(fx.remote, 'rev-parse', 'refs/heads/main')).toBe(remoteBefore)
})

test('an agent process working in the repo: skipped, reason "agent working"', async () => {
  await write(join(fx.beta, 'README.md'), '# Beta\n\nEdited while an agent works.\n')
  const bin = join(fx.scratch, 'agent-bin')
  await write(join(bin, 'claude'), '#!/bin/sh\nwhile true; do sleep 1; done\n')
  await fs.chmod(join(bin, 'claude'), 0o755)
  const agent: ChildProcess = spawn(join(bin, 'claude'), [], { cwd: join(fx.beta), stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 300))
    const before = await snapshot(fx.beta)
    const { code, results } = pomadeGit('commit-push', 'beta')
    expect(code).toBe(0)
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'agent working', commit: null })
    expect(results[0].steps[0].detail).toContain(`claude in ${await fs.realpath(fx.beta)} (pid ${agent.pid})`)
    expect(await snapshot(fx.beta)).toEqual(before)
  } finally {
    agent.kill('SIGKILL')
  }
})

test('next launch: the rows show the last run; the failed run left a mark until the repo is opened — for good', async () => {
  await launch()
  const alphaRun = page.getByTestId('git-run-Projects/alpha')
  await expect(alphaRun).toHaveAttribute('data-status', 'failed')
  await expect(alphaRun).toContainText(/^Commit & push failed \d\d:\d\d · Their changes conflict with yours in notes\.txt\./)
  await expect(page.getByTestId('git-run-Projects/beta')).toHaveAttribute('data-status', 'skipped')
  await expect(page.getByTestId('git-run-Projects/beta')).toContainText(/^Commit & push skipped \d\d:\d\d · agent working$/)
  await expect(page.getByTestId('git-run-Apps/gamma')).toHaveCount(0)
  await expect(page.getByTestId('git-repo-mark-Projects/alpha')).toBeVisible()
  await expect(page.getByTestId('git-repo-mark-Projects/beta')).toHaveCount(0)
  await expect(page.getByTestId('strip-badge-git')).toBeVisible()
  // No Runner installed: no Scheduled line anywhere.
  await expect(page.locator('[data-testid^="git-scheduled-"]')).toHaveCount(0)
  await shot('rows-after-closed-runs')

  // History words the automatic commit (HEAD — the conflicting run took its commit back).
  await page.getByTestId('git-repo-row-Projects/alpha').click()
  const short = g(fx.alpha, 'rev-parse', '--short=7', 'HEAD')
  const subject = page.getByTestId(`git-commit-subject-${short}`)
  await expect(subject).toHaveText(/^Committed automatically · job "Alpha twice daily" · \d\d:\d\d$/)
  await expect(subject).toHaveAttribute('data-job', 'Alpha twice daily')
  await shot('history-job-wording')
  await expect(page.getByTestId('git-repo-mark-Projects/alpha')).toHaveCount(0)
  await expect(page.getByTestId('strip-badge-git')).toHaveCount(0)

  // Seen is kept: the next launch shows the run, not the mark.
  await launch()
  await expect(page.getByTestId('git-run-Projects/alpha')).toHaveAttribute('data-status', 'failed')
  await expect(page.getByTestId('git-repo-mark-Projects/alpha')).toHaveCount(0)
  await expect(page.getByTestId('strip-badge-git')).toHaveCount(0)
})

test('Pomade open: a run that fails marks its repo at once', async () => {
  // gamma's remote refuses (a fake ssh): the fetch fails, nothing is committed.
  await write(join(fx.gamma, 'README.md'), '# Gamma\n\nEdited.\n')
  const { code, results } = pomadeGit('commit-push', 'gamma')
  expect(code).toBe(1)
  expect(results[0].reason).toContain('Nothing was changed.')
  await expect(page.getByTestId('git-run-Apps/gamma')).toHaveAttribute('data-status', 'failed')
  await expect(page.getByTestId('git-repo-mark-Apps/gamma')).toBeVisible()
  await expect(page.getByTestId('strip-badge-git')).toBeVisible()
})

test('Runner answering "jobs for repo X": the Scheduled line, which opens the job; not answering → no line', async () => {
  await launch({ POMADE_DEV_APPS: RUNNER_DIR })
  const line = page.getByTestId('git-scheduled-Projects/alpha')
  await expect(line).toHaveText('Scheduled: Commit & push · 13:00, 20:00 — edit in Runner')
  await expect(line).toHaveAttribute('data-job', 'alpha-twice-daily')
  // beta: Runner has no job for it; gamma: Runner never answers (rule 7) — neither has a line.
  await expect(page.getByTestId('git-scheduled-Projects/beta')).toHaveCount(0)
  expect(await page.evaluate(() => window.pomade.git.scheduled('Apps/gamma'))).toBeNull()
  await expect(page.getByTestId('git-scheduled-Apps/gamma')).toHaveCount(0)
  await shot('scheduled-line')

  await page.getByTestId('git-scheduled-edit-Projects/alpha').click()
  await expect
    .poll(async () => (await tabsOf(page, '__workspace__')).find((t) => t.kind === 'app' && t.appId === 'pomade-runner')?.route)
    .toBe('jobs/alpha-twice-daily')
})

test('Runner comes up after the panel showed, and its jobs change: the Scheduled line follows without a focus change', async () => {
  const ctl = join(fx.userDataDir, 'runner-ctl.json')
  const steer = (state: Record<string, unknown>): Promise<void> => fs.writeFile(ctl, JSON.stringify(state))
  await steer({ serving: false })
  await launch({ POMADE_DEV_APPS: RUNNER_DIR })
  const line = page.getByTestId('git-scheduled-Projects/alpha')
  // Runner is installed but not serving: the rows asked once and got nothing.
  await expect(page.getByTestId('git-repo-row-Projects/alpha')).toBeVisible()
  expect(await page.evaluate(() => window.pomade.git.scheduled('Projects/alpha'))).toBeNull()
  await expect(line).toHaveCount(0)

  // Runner starts serving: the line appears on its own.
  await steer({ serving: true })
  await expect(line).toHaveText('Scheduled: Commit & push · 13:00, 20:00 — edit in Runner')
  await shot('scheduled-line-after-runner-starts')

  // Runner publishes jobs.changed: the line follows the new answer, and goes when the job does.
  await steer({ serving: true, alpha: { ...ALPHA_JOB, schedule: '09:30' }, changed: 1 })
  await expect(line).toHaveText('Scheduled: Commit & push · 09:30 — edit in Runner')
  await steer({ serving: true, alpha: null, changed: 2 })
  await expect(line).toHaveCount(0)
})

test('A scheduled run ends while the panel is open: Runner publishes runs.changed and the hover shows the new Last run', async () => {
  const ctl = join(fx.userDataDir, 'runner-ctl.json')
  const steer = (state: Record<string, unknown>): Promise<void> => fs.writeFile(ctl, JSON.stringify(state))
  await steer({ serving: true })
  await launch({ POMADE_DEV_APPS: RUNNER_DIR })
  const line = page.getByTestId('git-scheduled-Projects/alpha')
  await expect(line).toHaveText('Scheduled: Commit & push · 13:00, 20:00 — edit in Runner')
  await expect(line).toHaveAttribute('title', /Last run .* · done$/)

  // The run ends: Runner's answer carries the new last result, and only runs.changed is published.
  const lastResult = { status: 'failed', at: '2026-11-12T13:00:00.000Z' }
  await steer({ serving: true, alpha: { ...ALPHA_JOB, lastResult }, ran: 1 })
  await expect(line).toHaveAttribute('title', /Last run .* · failed$/)
  await shot('scheduled-line-after-run-ends')
})
