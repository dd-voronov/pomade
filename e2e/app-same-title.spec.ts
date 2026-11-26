// modules: core, tabs
// T-295 e2e — an app title equal to the tab's current title still marks the tab app-titled: a
// frame's `tabs.setTitle` and a keyed `tabs.openApp` with `title` both claim the title whatever the
// tab shows now, so a later manifest retitle (app tab kind title) leaves such a tab alone while a
// tab the app never titled follows the manifest. The hello fixture is installed with `pomade apps`
// so its manifest can be changed and reinstalled.
// Screenshots go to POMADE_T295_SHOTS when set, else e2e/artifacts/app-same-title/ (gitignored).

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { callIn, connectedFrame, HELLO_DIR } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

interface KeyedTab {
  id: string
  key?: string
  title: string
  appTitled?: boolean
}

const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const SHOTS = process.env['POMADE_T295_SHOTS'] || resolve(__dirname, 'artifacts/app-same-title')

test.describe('T-295 same app title marks the tab app-titled', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let panel: Frame
  let buildDir: string

  const pomade = (...args: string[]): string =>
    execFileSync(POMADE_BIN, args, { env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir }, encoding: 'utf8' })

  const keyedTabs = (): Promise<KeyedTab[]> =>
    page.evaluate((pid) => {
      const s = (window as unknown as {
        __pomadeStores: { useTabsStore: { getState(): { tabsFor(id: string): (KeyedTab & { kind: string })[] } } }
      }).__pomadeStores.useTabsStore.getState()
      return s
        .tabsFor(pid)
        .filter((t) => t.kind === 'app' && t.key !== undefined)
        .map((t) => ({ id: t.id, key: t.key, title: t.title, appTitled: t.appTitled }))
    }, fixture.projects.alpha)
  const tabByKey = async (key: string): Promise<KeyedTab> => {
    const tab = (await keyedTabs()).find((t) => t.key === key)
    expect(tab, `keyed tab ${key}`).toBeDefined()
    return tab!
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    buildDir = await tempDir('pomade-hello-t295-')
    await fs.cp(HELLO_DIR, buildDir, { recursive: true })
    pomade('apps', 'install', buildDir)
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.getByTestId('strip-app-hello-panel').click()
    panel = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(buildDir, { recursive: true, force: true })
  })

  test('the current title, set again by the app, survives a manifest retitle; an untouched tab follows', async () => {
    for (const key of ['set', 'open', 'plain']) {
      expect(await callIn(panel, 'tabs.openApp', { key, kind: 'output', route: `output/${key}` })).toEqual({ ok: true, value: {} })
    }
    await expect.poll(async () => (await keyedTabs()).map((t) => t.title)).toEqual(['Output', 'Output', 'Output'])
    expect((await keyedTabs()).map((t) => t.appTitled)).toEqual([undefined, undefined, undefined])

    // The frame sets its tab's title to what the tab already shows.
    const setTab = await tabByKey('set')
    await page.getByTestId(`tab-${setTab.id}`).click()
    const frame = await connectedFrame(page.getByTestId(`app-pane-${setTab.id}`).locator('iframe'))
    expect(await callIn(frame, 'tabs.setTitle', { title: 'Output' })).toEqual({ ok: true, value: {} })
    // A keyed open with the title the tab already shows.
    expect(await callIn(panel, 'tabs.openApp', { key: 'open', route: 'output/open', title: 'Output' })).toEqual({ ok: true, value: {} })
    await expect.poll(async () => [(await tabByKey('set')).appTitled, (await tabByKey('open')).appTitled]).toEqual([true, true])
    expect((await tabByKey('plain')).appTitled).toBeUndefined()

    const manifest = JSON.parse(await fs.readFile(join(buildDir, 'manifest.json'), 'utf8')) as {
      tabKinds: Record<string, { title: string }>
    }
    manifest.tabKinds['output']!.title = 'Results'
    await fs.writeFile(join(buildDir, 'manifest.json'), JSON.stringify(manifest))
    expect(pomade('apps', 'install', buildDir)).toContain('Updated into')

    const plain = await tabByKey('plain')
    await expect(page.getByTestId(`tab-title-${plain.id}`)).toHaveText('Results')
    for (const key of ['set', 'open']) {
      const t = await tabByKey(key)
      await expect(page.getByTestId(`tab-title-${t.id}`)).toHaveText('Output')
    }
    expect((await keyedTabs()).map((t) => [t.key, t.title])).toEqual([
      ['set', 'Output'],
      ['open', 'Output'],
      ['plain', 'Results']
    ])
    await page.getByTestId('tabstrip').screenshot({ path: `${SHOTS}/T-295-same-title-tabs.png` })
  })
})
