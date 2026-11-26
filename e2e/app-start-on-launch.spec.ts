// modules: core, filetree
// E-027 e2e — start on launch (docs/HOST-API.md §1 `startOnLaunch`): an app whose manifest says
// `startOnLaunch: true` has its launch panel's frame loaded, hidden, when Pomade starts, so it can
// badge its strip icon before the user ever opens it; opening the panel then shows that same
// frame. A copy of the hello fixture with the flag on is the app under test.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { callIn, connectedFrame, HELLO_DIR, markOf, welcomeOf } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

test.describe('E-027 startOnLaunch', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let appDir: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    appDir = await tempDir('pomade-hello-launch-')
    await fs.cp(HELLO_DIR, appDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(appDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    // `both` comes first here, so the launch panel is the first panel-capable icon: `both`.
    const strip = manifest.strip as { id: string }[]
    await fs.writeFile(
      join(appDir, 'manifest.json'),
      JSON.stringify({ ...manifest, strip: [strip[2], strip[0], strip[1]], startOnLaunch: true })
    )
    app = await launchApp(fixture, { POMADE_DEV_APPS: appDir })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(appDir, { recursive: true, force: true })
  })

  test('the launch panel loads hidden at launch and can badge its icon before it is opened', async () => {
    const iframe = page.getByTestId('panel-frame-app-hello-both')
    const frame = await connectedFrame(iframe)
    await expect(iframe).toBeHidden()
    await expect(page.getByTestId('side-panel-files')).toBeVisible()
    expect(await welcomeOf(frame)).toEqual({ surface: 'panel', icon: 'both', route: 'needs-you' })
    // Only the launch panel: the other panel icon's frame is not loaded.
    await expect(page.getByTestId('panel-frame-app-hello-panel')).toHaveCount(0)

    expect((await callIn(frame, 'strip.setBadge', { icon: 'both', count: 4 })).ok).toBe(true)
    await expect(page.getByTestId('strip-badge-app-hello-both')).toHaveText('4')
  })

  test('opening the panel shows that same frame, with its state', async () => {
    const before = await markOf(await connectedFrame(page.getByTestId('panel-frame-app-hello-both')))
    await page.getByTestId('strip-app-hello-both').click()
    const iframe = page.getByTestId('panel-frame-app-hello-both')
    await expect(iframe).toBeVisible()
    await expect(iframe).toHaveCount(1)
    expect(await markOf(await connectedFrame(iframe))).toBe(before)
  })
})
