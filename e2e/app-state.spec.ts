// modules: core, tabs
// E-027 e2e — the app state API (docs/HOST-API.md §4 `state`): `state.get` / `state.set` backed by
// `<userData>/app-state/<id>/state.json`, shared by all of an app's frames (here the hello
// fixture's tab and its side panel), with `state.changed` reaching the other frames, per-app
// isolation, validation, and persistence across a relaunch.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp, relaunchApp } from './fixtures/app'
import { callIn, connectedFrame, eventsOf, HELLO_DIR, openHelloFromMenu } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

test.describe('E-027 app state', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let otherDir: string
  let env: Record<string, string>

  const stateFile = (id: string): string => join(fixture.userDataDir, 'app-state', id, 'state.json')
  const readStateFile = async (id: string): Promise<unknown> => JSON.parse(await fs.readFile(stateFile(id), 'utf8'))

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // A second app (another id) to prove the state is per app.
    otherDir = await tempDir('pomade-hello-other-')
    await fs.cp(HELLO_DIR, otherDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(otherDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(otherDir, 'manifest.json'),
      JSON.stringify({ ...manifest, id: 'hello-other', name: 'Hello (other)', strip: [], shortcuts: [] })
    )
    env = { POMADE_DEV_APPS: `${HELLO_DIR};${otherDir}` }
    app = await launchApp(fixture, env)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(otherDir, { recursive: true, force: true })
  })

  async function helloTab(): Promise<Frame> {
    if ((await page.getByTestId('app-frame-hello').count()) === 0) await openHelloFromMenu(page)
    return connectedFrame(page.getByTestId('app-frame-hello'))
  }

  async function helloPanel(): Promise<Frame> {
    await page.getByTestId('strip-app-hello-panel').click()
    return connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  }

  test('a value set in the tab is read in the panel; the panel hears state.changed, the setter does not', async () => {
    const tab = await helloTab()
    const panel = await helloPanel()
    expect(await callIn(panel, 'state.get', { key: 'pins' })).toEqual({ ok: true, value: { value: null } })

    expect(await callIn(tab, 'state.set', { key: 'pins', value: ['T-001', { note: 'é ✓' }] })).toEqual({ ok: true, value: {} })
    expect(await callIn(panel, 'state.get', { key: 'pins' })).toEqual({ ok: true, value: { value: ['T-001', { note: 'é ✓' }] } })
    await expect.poll(() => eventsOf(panel, 'state.changed')).toEqual([{ key: 'pins', value: ['T-001', { note: 'é ✓' }] }])
    expect(await eventsOf(tab, 'state.changed')).toEqual([])
    // Written before the call resolved, as one JSON object per app.
    expect(await readStateFile('hello')).toEqual({ pins: ['T-001', { note: 'é ✓' }] })

    expect(await callIn(panel, 'state.set', { key: 'view', value: 'board' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => eventsOf(tab, 'state.changed')).toEqual([{ key: 'view', value: 'board' }])
    expect(await readStateFile('hello')).toEqual({ pins: ['T-001', { note: 'é ✓' }], view: 'board' })
  })

  test('null removes a key; invalid keys and non-JSON values are invalid-params and change nothing', async () => {
    const tab = await helloTab()
    expect(await callIn(tab, 'state.set', { key: 'view', value: null })).toEqual({ ok: true, value: {} })
    expect(await callIn(tab, 'state.get', { key: 'view' })).toEqual({ ok: true, value: { value: null } })
    expect(await readStateFile('hello')).toEqual({ pins: ['T-001', { note: 'é ✓' }] })

    // Built inside the frame: a Date and NaN survive postMessage's structured clone, as an app would send them.
    const codes = await tab.evaluate(async () => {
      const call = window.__hello.call
      const cases: unknown[] = [
        { key: '', value: 1 },
        { key: 'k'.repeat(201), value: 1 },
        { key: 'k' },
        { key: 'k', value: Number.NaN },
        { key: 'k', value: { at: new Date(0) } }
      ]
      const out: (string | undefined)[] = []
      for (const params of cases) out.push((await call('state.set', params)).error?.code)
      return out
    })
    expect(codes).toEqual(Array(5).fill('invalid-params'))
    expect(await readStateFile('hello')).toEqual({ pins: ['T-001', { note: 'é ✓' }] })
  })

  test('each app has its own state', async () => {
    await openHelloFromMenu(page, 'hello-other')
    const other = await connectedFrame(page.getByTestId('app-frame-hello-other'))
    expect(await callIn(other, 'state.get', { key: 'pins' })).toEqual({ ok: true, value: { value: null } })
    expect(await callIn(other, 'state.set', { key: 'pins', value: 1 })).toEqual({ ok: true, value: {} })
    expect(await readStateFile('hello-other')).toEqual({ pins: 1 })
    expect(await readStateFile('hello')).toEqual({ pins: ['T-001', { note: 'é ✓' }] })
    expect(await eventsOf(await helloTab(), 'state.changed')).toHaveLength(1)
  })

  test('the state survives a relaunch', async () => {
    const relaunched = await relaunchApp(app, fixture, env)
    app = relaunched.app
    page = relaunched.page
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const tab = await connectedFrame(page.getByTestId('app-frame-hello'))
    expect(await callIn(tab, 'state.get', { key: 'pins' })).toEqual({ ok: true, value: { value: ['T-001', { note: 'é ✓' }] } })
  })
})
