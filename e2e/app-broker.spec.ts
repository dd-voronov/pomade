// modules: core
// E-028 e2e — the broker (docs/HOST-API.md §4 `apps`): app-to-app calls go through Pomade.
// The caller app's backend calls the test app's backend (backend → Pomade → backend); Pomade's own
// client (the platform, rule 7) calls it too; a frame serves its app's API and calls another app;
// and every refusal a caller can fall back on: not declared, not installed, unknown method, not
// responding, the server going away, and the server's own error. Backends are long-lived child
// processes → heavy project.

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { HostClient } from 'pomade-kit/sdk'

import { firstAppWindow, launchApp } from './fixtures/app'
import { callIn, connectedFrame, HELLO_DIR, openHelloFromMenu } from './fixtures/hello-app'
import { clientAs, waitForSocket } from './fixtures/socket-client'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const TEST_DIR = resolve(__dirname, 'fixtures/apps/backend')
const CALLER_DIR = resolve(__dirname, 'fixtures/apps/caller')

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'resolved'
  } catch (err) {
    return (err as { code: string }).code
  }
}

test.describe('E-028 broker', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let helloDir: string
  let platform: HostClient
  let caller: HostClient

  const stateOf = async (id: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await fs.readFile(join(fixture.userDataDir, 'app-state', id, 'state.json'), 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // A hello copy that serves an API (`echo`) from its frame and calls the test app.
    helloDir = await tempDir('pomade-hello-broker-')
    await fs.cp(HELLO_DIR, helloDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(helloDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(helloDir, 'manifest.json'),
      JSON.stringify({ ...manifest, id: 'hello-broker', name: 'Hello broker', strip: [], shortcuts: [], api: ['echo'], calls: ['e028-test'] })
    )
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${TEST_DIR};${CALLER_DIR};${helloDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await waitForSocket(fixture.userDataDir, 'e028-caller')
    platform = await clientAs(fixture.userDataDir, 'pomade', 'command')
    caller = await clientAs(fixture.userDataDir, 'e028-caller', 'backend')
    await expect.poll(async () => (await stateOf('e028-test')).backend !== undefined, { timeout: 20000 }).toBe(true)
  })

  test.afterAll(async () => {
    platform?.close()
    caller?.close()
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(helloDir, { recursive: true, force: true })
  })

  test("one app's backend calls another's through Pomade", async () => {
    await expect
      .poll(async () => (await stateOf('e028-caller')).call, { timeout: 20000 })
      .toMatchObject({ ok: true, value: { echo: { n: 42 }, from: 'e028-caller' } })
  })

  test('Pomade itself reads an app API (rule 7) with the platform client', async () => {
    await expect(platform.apps.call('e028-test', 'echo', { q: 1 })).resolves.toMatchObject({ echo: { q: 1 }, from: 'pomade' })
  })

  test('refusals a caller falls back on', async () => {
    expect(await codeOf(caller.apps.call('hello-broker', 'echo'))).toBe('capability-denied')
    expect(await codeOf(caller.apps.call('e028-missing', 'echo'))).toBe('app-absent')
    expect(await codeOf(caller.apps.call('e028-test', 'nope'))).toBe('unknown-method')
    expect(await codeOf(caller.apps.call('e028-test', 'fail'))).toBe('not-found')
    expect(await codeOf(caller.apps.call('e028-test', 'slow', {}, { timeoutMs: 300 }))).toBe('app-not-responding')
    // Declared, installed, but nothing serves its API yet: absent.
    expect(await codeOf(platform.apps.call('hello-broker', 'echo'))).toBe('app-absent')
  })

  test('a frame serves its app API and calls another app', async () => {
    await openHelloFromMenu(page, 'hello-broker')
    const frame = await connectedFrame(page.getByTestId('app-frame-hello-broker'))
    await expect(callIn(frame, 'api.serve')).resolves.toEqual({ ok: true, value: { methods: ['echo'] } })
    await expect(platform.apps.call('hello-broker', 'echo', { from: 'test' })).resolves.toEqual({
      echo: { from: 'test' },
      from: 'pomade',
      method: 'echo',
      surface: 'tab'
    })
    const out = await callIn(frame, 'apps.call', { app: 'e028-test', method: 'echo', params: { f: 1 } })
    expect(out).toMatchObject({ ok: true, value: { echo: { f: 1 }, from: 'hello-broker' } })
  })

  test('a server that goes away mid-call answers app-not-responding', async () => {
    const pending = codeOf(caller.apps.call('e028-test', 'slow', {}, { timeoutMs: 20000 }))
    const { pid } = (await stateOf('e028-test')).backend as { pid: number }
    await new Promise((r) => setTimeout(r, 200))
    process.kill(pid, 'SIGKILL')
    expect(await pending).toBe('app-not-responding')
  })
})
