// modules: core
// E-028 e2e — the Host API's socket channel (docs/HOST-API.md §3 "Socket"): a unix socket in
// Pomade's user data carrying the same protocol as postMessage, for app backends and commands.
// The spec process is the client, with pomade-kit/node's `connectSocket` — the same client an
// app's backend uses: handshake and identity (the per-app key Pomade issued), the capability gate,
// methods served in main and by the window (delegated), events, refusals, and the socket's end.
// The test app's backend runs alongside (a long-lived child process → heavy project).

import { promises as fs } from 'node:fs'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { HostError, type HostClient, type ProjectRef } from 'pomade-kit/sdk'
import { connectSocket, postNotice } from 'pomade-kit/node'

import { firstAppWindow, launchApp } from './fixtures/app'
import { appKeyOf, clientAs, socketPathOf, waitForSocket } from './fixtures/socket-client'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { FAKE_AGENT_ECHO_EXIT, seedFakeAgent } from './fixtures/fake-agent'

const APP_DIR = resolve(__dirname, 'fixtures/apps/backend')
const CALLER_DIR = resolve(__dirname, 'fixtures/apps/caller')
const APP_ID = 'e028-test'

/** Send raw lines and collect the answers (for what the typed client never sends). */
function raw(path: string, lines: unknown[], expected: number): Promise<unknown[]> {
  return new Promise((done, fail) => {
    const s = createConnection(path)
    const got: unknown[] = []
    let buf = ''
    s.setEncoding('utf8')
    s.on('data', (chunk: string) => {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        got.push(JSON.parse(buf.slice(0, nl)))
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
      }
      if (got.length >= expected) {
        s.destroy()
        done(got)
      }
    })
    s.on('error', fail)
    s.on('connect', () => {
      for (const l of lines) s.write(`${JSON.stringify(l)}\n`)
    })
  })
}

test.describe('E-028 Host API socket', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let host: HostClient

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${APP_DIR};${CALLER_DIR}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await waitForSocket(fixture.userDataDir, APP_ID)
    host = await clientAs(fixture.userDataDir, APP_ID, 'backend')
  })

  test.afterAll(async () => {
    host?.close()
    await app?.close()
    await fixture?.cleanup()
  })

  test('the socket lives in user data, private to the user, within the macOS path limit', async () => {
    const path = socketPathOf(fixture.userDataDir)
    const st = await fs.stat(path)
    expect(st.isSocket()).toBe(true)
    expect(st.mode & 0o777).toBe(0o600)
    expect((await fs.stat(resolve(path, '..'))).mode & 0o777).toBe(0o700)
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103)
    expect((await fs.stat(resolve(fixture.userDataDir, 'app-keys', APP_ID))).mode & 0o777).toBe(0o600)
  })

  test('welcome names the app, its role and the active project; host.info answers the same', async () => {
    expect(host.welcome).toMatchObject({ hostApi: 0, appId: APP_ID, surface: 'backend', route: '' })
    expect(host.welcome.project).toMatchObject({ id: fixture.projects.alpha, kind: 'project', name: 'Alpha', root: 'Projects/alpha' })
    await expect(host.info()).resolves.toMatchObject({ hostApi: 0, appId: APP_ID, surface: 'backend', route: '' })
    const command = await clientAs(fixture.userDataDir, APP_ID, 'command')
    expect(command.welcome.surface).toBe('command')
    command.close()
  })

  test('methods served in main and by the window (delegated) answer as for a frame', async () => {
    const { entries } = await host.files.readFolder({ path: 'Projects/alpha' })
    expect(entries.map((e) => e.name)).toEqual(['README.md', 'notes.txt'])
    await expect(host.project.getActive()).resolves.toMatchObject({ id: fixture.projects.alpha })
    const list = await host.project.list()
    expect(list.projects.map((p) => p.name)).toEqual(['Alpha', 'Beta'])
    const { repos } = await host.git.getState()
    expect(repos).toEqual([])
    await host.state.set('fromBackend', { n: 1 })
    await expect(host.state.get('fromBackend')).resolves.toEqual({ n: 1 })
  })

  test('the capability gate and the frame-only methods', async () => {
    const denied = await host.files.create({ path: 'x.md' }).catch((e: unknown) => e)
    expect(denied).toBeInstanceOf(HostError)
    expect((denied as HostError).code).toBe('capability-denied')
    const picker = await host.files.pickFolder().catch((e: unknown) => e)
    expect((picker as HostError).code).toBe('capability-denied')
    expect((picker as HostError).message).toMatch(/needs an app frame/)
    const filePicker = await host.files.pickFile().catch((e: unknown) => e)
    expect((filePicker as HostError).code).toBe('capability-denied')
    expect((filePicker as HostError).message).toMatch(/needs an app frame/)
    const outside = await host.files.readFolder({ path: '../' }).catch((e: unknown) => e)
    expect((outside as HostError).code).toBe('outside-workspace')
  })

  test('bus events reach a socket client that subscribes: project.changed, project.renamed, another app\'s event', async () => {
    const changed: ProjectRef[] = []
    const renamed: unknown[] = []
    const ticks: unknown[] = []
    const off = host.project.onChange((p) => changed.push(p))
    await host.events.subscribe('project.changed', (p) => changed.push(p as unknown as ProjectRef))
    await host.events.subscribe('project.renamed', (p) => renamed.push(p))
    await host.events.subscribe('e028-caller:tick', (p) => ticks.push(p))
    await page.getByTestId(`project-${fixture.projects.beta}`).click()
    await expect.poll(() => changed.map((p) => p.name)).toContain('Beta')
    await expect(host.project.getActive()).resolves.toMatchObject({ id: fixture.projects.beta })
    await page.evaluate((id) => {
      window.__pomadeStores.useWorkspaceStore.getState()
        .updateProject(id, { name: 'Beta renamed' })
    }, fixture.projects.beta)
    await expect.poll(() => renamed).toEqual([expect.objectContaining({ project: expect.objectContaining({ name: 'Beta renamed' }) })])
    // Another app's backend sees the subscriber and publishes to it.
    const caller = await clientAs(fixture.userDataDir, 'e028-caller', 'backend')
    await expect(caller.events.hasSubscribers('tick')).resolves.toBe(true)
    await caller.events.publish('tick', { n: 1 })
    await expect.poll(() => ticks).toEqual([{ n: 1 }])
    caller.close()
    off()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test('a wrong key, an unknown app, the platform role rule and a version mismatch are refused', async () => {
    const path = socketPathOf(fixture.userDataDir)
    await expect(connectSocket({ socketPath: path, appId: APP_ID, key: 'nope', role: 'backend', env: {} })).resolves.toEqual({
      status: 'rejected',
      reason: 'unauthorized',
      hostApi: 0
    })
    const key = await appKeyOf(fixture.userDataDir, APP_ID)
    await expect(connectSocket({ socketPath: path, appId: 'not-installed', key, role: 'command', env: {} })).resolves.toMatchObject({
      status: 'rejected',
      reason: 'unauthorized'
    })
    const platformKey = await appKeyOf(fixture.userDataDir, 'pomade')
    await expect(connectSocket({ socketPath: path, appId: 'pomade', key: platformKey, role: 'backend', env: {} })).resolves.toMatchObject({
      status: 'rejected',
      reason: 'unauthorized'
    })
    const answers = await raw(
      path,
      [
        { channel: 'pomade', type: 'call', id: 'early', method: 'host.info' },
        { channel: 'pomade', type: 'hello', hostApi: 1, client: { appId: APP_ID, key, role: 'backend' } }
      ],
      2
    )
    expect(answers).toEqual([
      { channel: 'pomade', type: 'result', id: 'early', ok: false, error: { code: 'not-ready', message: 'Call before welcome' } },
      { channel: 'pomade', type: 'reject', reason: 'needs-newer-pomade', hostApi: 0 }
    ])
  })

  test("Pomade's own commands connect with the platform key", async () => {
    const platform = await clientAs(fixture.userDataDir, 'pomade', 'command')
    await expect(platform.info()).resolves.toMatchObject({ appId: 'pomade', surface: 'command', skills: [] })
    const denied = await platform.files.readFolder({ path: '' }).catch((e: unknown) => e)
    expect((denied as HostError).code).toBe('capability-denied')
    platform.close()
  })

  test('a platform command asks "is an agent live in folder X?"', async () => {
    const platform = await clientAs(fixture.userDataDir, 'pomade', 'command')
    const alpha = resolve(fixture.workspaceRoot, 'Projects/alpha')
    const beta = resolve(fixture.workspaceRoot, 'Projects/beta')
    await expect(platform.agents.liveIn(alpha)).resolves.toEqual({ live: false, agents: [] })
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect(async () => {
      await page.getByTestId('tab-add').click()
      await page.getByTestId('tab-add-agent-claude-test').click({ timeout: 2000 })
    }).toPass({ timeout: 20000 })
    await expect.poll(async () => (await platform.agents.liveIn(alpha)).live, { timeout: 20000 }).toBe(true)
    const r = await platform.agents.liveIn(alpha)
    // T-323 — the terminal's shell pid; no state until the scanner reads the agent (this stand-in
    // never sets the title the scanner reads).
    expect(r.agents).toEqual([{ agentId: 'claude-test', cwd: await fs.realpath(alpha), terminalPids: [expect.any(Number)] }])
    await expect(platform.agents.liveIn(fixture.workspaceRoot)).resolves.toMatchObject({ live: true })
    await expect(platform.agents.liveIn(beta)).resolves.toEqual({ live: false, agents: [] })
    const bad = await platform.agents.liveIn('relative').catch((e: unknown) => e)
    expect((bad as HostError).code).toBe('invalid-params')
    // An app may not ask.
    const denied = await host.agents.liveIn(alpha).catch((e: unknown) => e)
    expect((denied as HostError).code).toBe('capability-denied')
    platform.close()
  })

  /** The identity a backend of the test app runs with. */
  const backendEnv = (): Record<string, string> => ({
    POMADE_APP_ID: APP_ID,
    POMADE_APP_KEY_FILE: resolve(fixture.userDataDir, 'app-keys', APP_ID),
    POMADE_CLIENT: 'backend',
    POMADE_SOCKET: socketPathOf(fixture.userDataDir)
  })

  test('a backend posts a notice: with Pomade running it is shown at once, nothing is queued', async () => {
    const r = await postNotice({ title: 'Backend says hi' }, { source: APP_ID, userData: fixture.userDataDir, env: backendEnv() })
    expect(r).toEqual({ delivered: 'pomade', path: null })
    await expect(page.getByTestId('notice-toast-title').filter({ hasText: 'Backend says hi' })).toBeVisible()
    // A platform command names its source.
    const platformEnv = { ...backendEnv(), POMADE_APP_ID: 'pomade', POMADE_APP_KEY_FILE: resolve(fixture.userDataDir, 'app-keys', 'pomade'), POMADE_CLIENT: 'command' }
    await expect(postNotice({ title: 'Push failed' }, { source: 'pomade-git', userData: fixture.userDataDir, env: platformEnv })).resolves.toMatchObject({ delivered: 'pomade' })
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'Push failed' })
    await expect(toast.getByTestId('notice-toast-source')).toHaveText('pomade-git')
    const queued = await fs.readdir(resolve(fixture.userDataDir, 'notices', 'queue')).catch(() => [] as string[])
    expect(queued.filter((x) => x.endsWith('.json'))).toEqual([])
  })

  test('quitting Pomade ends every connection and removes the socket', async () => {
    let closed = false
    host.onClose(() => {
      closed = true
    })
    await app.close()
    await expect.poll(() => closed).toBe(true)
    await expect(fs.stat(socketPathOf(fixture.userDataDir))).rejects.toThrow(/ENOENT/)
    await expect(connectSocket({ socketPath: socketPathOf(fixture.userDataDir), appId: APP_ID, key: 'k', env: {} })).resolves.toMatchObject({
      status: 'not-running'
    })
  })

  test('with Pomade closed the notice is queued and shown at the next launch', async () => {
    const r = await postNotice({ title: 'Posted while closed' }, { source: APP_ID, userData: fixture.userDataDir, env: backendEnv() })
    expect(r.delivered).toBe('queue')
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${APP_DIR};${CALLER_DIR}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('notice-toast-title').filter({ hasText: 'Posted while closed' })).toBeVisible({ timeout: 20000 })
  })
})
