// modules: git, agents, terminal
// Pomade E-043 e2e — the branch ↔ agent session link. A stand-in agents app (e2e/fixtures/apps/
// agents, id `pomade-agents`) answers `sessions.forRepo` and `sessions.liveIn` through the broker:
// each local In progress row names the session working on it (agent + session name), and its link
// resumes the session in a new agent tab, or goes to the live tab already on it. "Is an agent live
// here?" asks the app too — merge waits on an agent only the app knows of, and so does
// `pomade-git` (Pomade open, over its socket) unless the app says that agent is idle (T-323). A session with no project, or one since removed,
// resumes in the Workspace project (T-227, PLATFORM rule 9). Without the app (installed but not running, or not
// responding): no link, and the platform's own answer stands. A real zsh — heavy partition.
// Set POMADE_E043_SHOTS=<dir> for screenshots.

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { promises as fs, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { FAKE_AGENT_RESUME, seedFakeAgent } from './fixtures/fake-agent'
import { write } from './fixtures/git-ops-repos'
import { createBranchFixture, type BranchFixture } from './fixtures/git-branch-repos'
import { activeProjectOf, openHelloFromMenu } from './fixtures/hello-app'
import { activeIdOf, readBuffer, tabsOf, writePty } from './fixtures/stores'
import { showGitPanel } from './fixtures/panels'

const AGENTS_DIR = resolve(__dirname, 'fixtures/apps/agents')
const BIN = resolve(__dirname, '../bin/pomade-git')
const SHOTS = process.env.POMADE_E043_SHOTS

const SESSION = '7b5c3451-0370-4bf9-b6fd-617d56545a78'
const FEATURE_SESSION = '0f9e8d7c-6b5a-4938-8271-605f4e3d2c1b'

let fx: BranchFixture
let app: ElectronApplication
let page: Page
let agents: Frame
let alphaReal: string

test.describe.configure({ mode: 'serial' })

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function agentsFrame(): Promise<Frame> {
  const iframe = page.getByTestId('app-frame-pomade-agents').first()
  let frame: Frame | null = null
  await expect
    .poll(async () => {
      frame = (await (await iframe.elementHandle())?.contentFrame()) ?? null
      return frame?.evaluate(() => window.__agents?.status ?? 'loading').catch(() => 'loading') ?? 'no frame'
    })
    .toBe('connected')
  return frame!
}

/** What the stand-in answers from now on. */
async function setApp(state: { sessions?: unknown[] | null; live?: unknown[] | null; silent?: boolean }): Promise<void> {
  await agents.evaluate((s) => Object.assign(window.__agents, s), state)
}

async function requests(method: string): Promise<Record<string, unknown>[]> {
  return agents.evaluate(
    (m) => window.__agents.requests.filter((r) => r.method === m).map((r) => r.params ?? {}),
    method
  )
}

/** Open the Git panel on alpha's repo view, re-reading In progress (the panel opening reads it).
 *  An open panel is collapsed first: its strip icon only selects it, it does not close it. */
async function openRepoView(): Promise<void> {
  await page.getByTestId(`project-${fx.projects.alpha}`).click()
  if (await page.getByTestId('git-panel').isVisible()) {
    await page.getByTestId('git-panel-collapse').click()
    await expect(page.getByTestId('git-panel')).toBeHidden()
  }
  await showGitPanel(page)
  await expect(page.getByTestId('git-repo-view')).toBeVisible()
  await expect(page.getByTestId('git-progress-agent/t1')).toBeVisible()
}

function link(row: string): ReturnType<Page['getByTestId']> {
  return page.getByTestId('git-repo-view').getByTestId(`git-progress-${row}`).getByTestId('git-progress-session')
}

async function agentTabsOnSession(): Promise<{ id: string; termId: string; status?: string }[]> {
  return (await tabsOf(page, fx.projects.alpha))
    .filter((t) => t.kind === 'agent' && t.resumeSessionId === SESSION)
    .map((t) => ({ id: t.id, termId: t.termId ?? '', status: t.status }))
}

function mergePreview(): Promise<{ blocked?: { message: string } }> {
  return page.evaluate(() => window.pomade.git.preview('Projects/alpha', { op: 'merge-branch', branch: 'agent/t1', mode: 'squash' })) as Promise<{
    blocked?: { message: string }
  }>
}

test.beforeAll(async () => {
  fx = await createBranchFixture()
  alphaReal = realpathSync(fx.alpha)
  await seedFakeAgent(fx, { script: FAKE_AGENT_RESUME })
  // The folder agent's own store holds the worktree session's transcript (what a resume needs).
  const store = join(fx.workspaceRoot, 'Agents/claude-test')
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Take notes' }, timestamp: '2026-11-09T14:00:00Z' })
  await write(join(store, 'projects', fx.agentWt.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`), `${line}\n`)
  ;({ app, page } = await launchAppPage(fx, { ...fx.env, POMADE_DEV_APPS: AGENTS_DIR, FAKE_AGENT_STORE: store }))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('the agents app installed but not running: no session links', async () => {
  await openRepoView()
  await expect(page.getByTestId('git-progress-feature')).toBeVisible()
  await expect(page.getByTestId('git-repo-view').getByTestId('git-progress-session')).toHaveCount(0)
})

test('the app answering: worktree and branch rows name agent and session; the others none', async () => {
  await page.getByTestId(`project-${fx.projects.alpha}`).click()
  await openHelloFromMenu(page, 'pomade-agents')
  agents = await agentsFrame()
  const base = { agent: 'claude-test', status: 'active', project: fx.projects.alpha, startedAt: '2026-11-09T14:00:00Z' }
  await setApp({
    live: [],
    sessions: [
      { ...base, id: SESSION, name: 'Notes pass', live: 'closed', cwd: fx.agentWt, branch: 'agent/t1', lastActiveAt: '2026-11-09T14:30:00Z' },
      // An older session in the same worktree: the row links the latest.
      { ...base, id: 'older-session', name: 'First try', live: 'closed', cwd: fx.agentWt, branch: 'agent/t1', lastActiveAt: '2026-11-08T09:00:00Z' },
      { ...base, id: FEATURE_SESSION, name: null, live: 'closed', cwd: alphaReal, branch: 'feature', lastActiveAt: '2026-11-09T12:00:00Z' }
    ]
  })
  await openRepoView()

  await expect(link('agent/t1')).toHaveText('claude-test·Notes pass')
  await expect(page.getByTestId('git-progress-agent/t1')).toHaveAttribute('data-session', SESSION)
  await expect(link('feature')).toHaveText('claude-test·unnamed session')
  await expect(link('stale')).toHaveCount(0)
  // Asked by folder: the worktree's own; a branch by the repository's folder and its name.
  const asked = await requests('sessions.forRepo')
  expect(asked).toContainEqual({ folder: fx.agentWt })
  expect(asked).toContainEqual({ folder: alphaReal, branch: 'feature' })
  expect(asked).toContainEqual({ folder: alphaReal, branch: 'stale' })
  await shot('e043-rows')
  // The row's tooltip says what the link does.
  await page.getByTestId('git-progress-agent/t1').hover()
  await expect(page.getByText('Agent session: claude-test · Notes pass — click it to resume it in a new tab')).toBeVisible()
  await shot('e043-rows-tooltip')
})

test('click: resumes the session in a new agent tab; again: goes to that tab; once it ended: a new tab', async () => {
  await link('agent/t1').click()
  await expect.poll(async () => (await agentTabsOnSession()).length, { timeout: 15_000 }).toBe(1)
  const [first] = await agentTabsOnSession()
  expect(await activeIdOf(page, fx.projects.alpha)).toBe(first.id)
  const tab = (await tabsOf(page, fx.projects.alpha)).find((t) => t.id === first.id)!
  expect(tab).toMatchObject({ agentId: 'claude-test', cwd: fx.agentWt })
  await expect.poll(() => readBuffer(page, first.termId), { timeout: 20_000 }).toContain(`RESUMED ${SESSION}`)

  // Another tab comes to the front; the link goes back to the live one — no second tab.
  await openRepoView()
  await page.getByTestId('git-progress-feature').click()
  await expect.poll(() => activeIdOf(page, fx.projects.alpha)).not.toBe(first.id)
  await link('agent/t1').click()
  await expect.poll(() => activeIdOf(page, fx.projects.alpha)).toBe(first.id)
  expect(await agentTabsOnSession()).toHaveLength(1)

  // The agent ends: the link resumes it again, in a new tab.
  await writePty(page, first.termId, '/exit\r')
  await expect.poll(() => readBuffer(page, first.termId), { timeout: 15_000 }).toContain('To resume this session')
  await openRepoView()
  await link('agent/t1').click()
  await expect
    .poll(async () => (await agentTabsOnSession()).filter((t) => t.id !== first.id).length, { timeout: 15_000 })
    .toBe(1)
  const second = (await agentTabsOnSession()).find((t) => t.id !== first.id)!
  await expect.poll(() => readBuffer(page, second.termId), { timeout: 20_000 }).toContain(`RESUMED ${SESSION}`)
  await writePty(page, second.termId, '/exit\r')
  await expect.poll(() => readBuffer(page, second.termId), { timeout: 15_000 }).toContain('To resume this session')
})

test('a session the app no longer finds: the link says so', async () => {
  await setApp({
    sessions: [
      { id: 'gone-session', agent: 'claude-test', status: 'active', project: null, startedAt: '2026-11-09T14:00:00Z', name: 'Gone', live: 'closed', cwd: fx.agentWt, branch: null, lastActiveAt: '2026-11-10T14:30:00Z' }
    ]
  })
  await openRepoView()
  await expect(link('agent/t1')).toHaveText('claude-test·Gone')
  await link('agent/t1').click()
  await expect(page.getByText(/Could not open the session: No session "gone-session"/)).toBeVisible()
})

test('T-227 a session with no project, or one since removed, resumes in the Workspace project', async () => {
  const WS = '__workspace__'
  const onSession = async (): Promise<{ id: string; termId: string }[]> =>
    (await tabsOf(page, WS)).filter((t) => t.kind === 'agent' && t.resumeSessionId === SESSION).map((t) => ({ id: t.id, termId: t.termId ?? '' }))
  const resumeFrom = async (project: string | null, name: string): Promise<void> => {
    const before = (await onSession()).length
    await setApp({
      sessions: [{ id: SESSION, agent: 'claude-test', status: 'active', project, startedAt: '2026-11-09T14:00:00Z', name, live: 'closed', cwd: fx.agentWt, branch: 'agent/t1', lastActiveAt: '2026-11-09T14:30:00Z' }]
    })
    await openRepoView()
    await expect(link('agent/t1')).toHaveText(`claude-test·${name}`)
    await link('agent/t1').click()
    await expect.poll(async () => (await onSession()).length, { timeout: 15_000 }).toBe(before + 1)
    const tab = (await onSession()).at(-1)!
    await expect.poll(() => activeProjectOf(page)).toBe(WS)
    expect(await activeIdOf(page, WS)).toBe(tab.id)
    await expect.poll(() => readBuffer(page, tab.termId), { timeout: 20_000 }).toContain(`RESUMED ${SESSION}`)
    await writePty(page, tab.termId, '/exit\r')
    await expect.poll(() => readBuffer(page, tab.termId), { timeout: 15_000 }).toContain('To resume this session')
  }
  await resumeFrom(null, 'No project')
  await resumeFrom('a-project-since-removed', 'Project removed')
})

test('"agent live here?" asks the app: merge waits on a Runner run only the app knows of; pomade-git skips', async () => {
  await expect.poll(async () => (await mergePreview()).blocked ?? null).toBeNull()
  await setApp({ live: [{ sessionId: null, agent: 'claude-test', cwd: fx.agentWt, source: 'run', job: 'Nightly notes' }] })
  expect((await mergePreview()).blocked?.message).toBe(
    `An agent is working here (claude-test in ${fx.agentWt}) — this waits until it ends, so nothing changes under its feet.`
  )
  expect(await requests('sessions.liveIn')).toContainEqual({ folder: fx.agentWt })

  // pomade-git, run while Pomade is open, asks Pomade over its socket — the app's answer counts.
  await setApp({ live: [{ sessionId: 's9', agent: 'claude-test', cwd: alphaReal, source: 'tab', job: null }] })
  const home = join(fx.scratch, 'pomade-home-e043')
  await write(join(home, 'workspace'), `${fx.workspaceRoot}\n`)
  await write(join(fx.alpha, 'notes.md'), '# Notes\n')
  const r = spawnSync(process.execPath, [BIN, 'commit-push', 'alpha', '--json'], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', POMADE_USER_DATA: fx.userDataDir, POMADE_HOME: home, ...fx.env }
  })
  const out = JSON.parse(r.stdout) as { results: { status: string; reason: string | null; steps: { step: string; detail: string }[] }[] }
  expect(out.results[0]).toMatchObject({ status: 'skipped', reason: 'agent working' })
  expect(out.results[0].steps[0].detail).toContain(`claude-test in ${alphaReal} (per Pomade)`)
  await fs.rm(join(fx.alpha, 'notes.md'))

  // T-323 — the app says its tab is idle: pomade-git goes on (its agents step names the idle tab),
  // while the Git panel's merge still waits on any live agent, idle or not.
  const pomadeGit = (op: string): { status: string; steps: { step: string; outcome: string; detail: string }[] } => {
    const res = spawnSync(process.execPath, [BIN, op, 'alpha', '--json'], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', POMADE_USER_DATA: fx.userDataDir, POMADE_HOME: home, ...fx.env }
    })
    return (JSON.parse(res.stdout) as { results: { status: string; steps: { step: string; outcome: string; detail: string }[] }[] }).results[0]
  }
  await setApp({ live: [{ sessionId: 's9', agent: 'claude-test', cwd: alphaReal, source: 'tab', job: null, state: 'idle' }] })
  expect(pomadeGit('pull').steps[0]).toEqual({ step: 'agents', outcome: 'done', detail: `no agent working here — idle: claude-test in ${alphaReal} (per Pomade)` })
  await setApp({ live: [{ sessionId: 's9', agent: 'claude-test', cwd: alphaReal, source: 'tab', job: null, state: 'needs-you' }] })
  expect(pomadeGit('pull')).toMatchObject({ status: 'skipped', steps: [{ step: 'agents', outcome: 'skipped' }] })
  await setApp({ live: [{ sessionId: 's9', agent: 'claude-test', cwd: fx.agentWt, source: 'tab', job: null, state: 'idle' }] })
  expect((await mergePreview()).blocked?.message).toBe(
    `An agent is working here (claude-test in ${fx.agentWt}) — this waits until it ends, so nothing changes under its feet.`
  )

  await setApp({ live: [] })
  expect((await mergePreview()).blocked ?? null).toBeNull()
})

test('the app not responding: no links, merge goes by Pomade\'s own terminals', async () => {
  await setApp({ silent: true })
  await openRepoView()
  await expect(page.getByTestId('git-progress-feature')).toBeVisible()
  await expect(page.getByTestId('git-repo-view').getByTestId('git-progress-session')).toHaveCount(0, { timeout: 10_000 })
  expect((await mergePreview()).blocked ?? null).toBeNull()
})
