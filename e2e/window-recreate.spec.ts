// modules: core
// Pomade e2e — window recreate on activate (Dock-icon click after the last window closes).
// Window lifecycle only (no terminal/agent), so this file runs in the LIGHT pass; the
// zsh-bound Cmd+W/Cmd+T hotkey suite lives in tab-hotkeys.spec.ts (heavy).

import {
  test,
  expect,
  type ElectronApplication
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

test.describe('window recreate on activate (Dock icon after close)', () => {
  let fixture: Fixture
  let app: ElectronApplication

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('after the window is closed, activate reopens it', async () => {
    // Close the (only) window — the app keeps running on macOS.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0)

    // A Dock-icon click emits 'activate'; the handler must recreate the window.
    const reopened = app.waitForEvent('window')
    await app.evaluate(({ app: a }) => {
      a.emit('activate')
    })
    const page2 = await reopened
    await page2.waitForLoadState('domcontentloaded')
    await expect(page2.getByTestId('app-shell')).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  })
})
