// modules: core, terminal, tabs
// E-030 e2e — `tabs.openTerminal` (docs/HOST-API.md §4 "tabs.open"): an app opens a terminal tab
// in a folder that runs its command, right of the active tab, titled by the app. HEAVY partition:
// the call spawns a real interactive zsh.

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const HELLO_DIR = resolve(__dirname, 'fixtures/apps/hello')

test.describe('E-030 tabs.openTerminal', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let appDir: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    appDir = await tempDir('pomade-hello-tabs-')
    await fs.cp(HELLO_DIR, appDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(appDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(join(appDir, 'manifest.json'), JSON.stringify({ ...manifest, id: 'hello-tabs', capabilities: ['tabs.open'] }))
    app = await launchApp(fixture, { POMADE_DEV_APPS: appDir })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-app-hello-tabs').click()
    await expect.poll(() => page.frames().some((f) => f.url().startsWith('pomade-app://hello-tabs/'))).toBe(true)
    frame = page.frames().find((f) => f.url().startsWith('pomade-app://hello-tabs/')) as Frame
    await expect
      .poll(() => frame.evaluate(() => window.__hello?.status ?? 'loading'))
      .toBe('connected')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    if (appDir) await fs.rm(appDir, { recursive: true, force: true })
  })

  test('a terminal tab in the folder runs the command, titled by the app, right of the active tab', async () => {
    const res = await frame.evaluate(
      () =>
        window.__hello.call('tabs.openTerminal', {
          cwd: 'Projects/alpha',
          command: 'pwd > e030-terminal.txt',
          title: 'Where am I'
        })
    )
    expect(res).toMatchObject({ ok: true, value: {} })
    const out = join(fixture.workspaceRoot, 'Projects/alpha/e030-terminal.txt')
    await expect.poll(() => fs.readFile(out, 'utf8').catch(() => ''), { timeout: 20000 }).toMatch(/Projects\/alpha\n$/)
    const tabs = await page.evaluate((pid) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      return { tabs: s.tabsByProject[pid].map((t) => [t.kind, t.title]), active: s.activeTabByProject[pid], ids: s.tabsByProject[pid].map((t) => t.id) }
    }, fixture.projects.alpha)
    expect(tabs.tabs).toEqual([
      ['app', 'Hello'],
      ['terminal', 'Where am I']
    ])
    expect(tabs.active).toBe(tabs.ids[1])
    await expect(page.getByTestId(`tab-${tabs.ids[1]}`)).toContainText('Where am I')
  })
})
