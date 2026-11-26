// modules: agents
// heavy-exempt: reads the "+" menu's agent items but never picks one, so no terminal opens
// T-242 e2e — a slow login shell never marks an agent "not mapped".
//
// The roster's command check runs the user's interactive login zsh. Here the user (a test ZDOTDIR
// fixture, never the real home rc files) has a .zshrc that takes far longer than the roster waits
// whenever it runs without a terminal — the check's shell, not a pty. The "+" menu must list every
// agent without the "!" badge (the check is unknown, not "not found"), and quitting the app must
// kill the still-running check shell together with what its startup files started.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { expectQuiet } from './fixtures/timing'
import { tempDir } from './fixtures/temp'

/** A sleep length no other process uses, so the leftover check below finds only ours. */
const SLOW_SLEEP = '45.242'

const sleepersLeft = (): Promise<string> =>
  new Promise((resolve) => execFile('pgrep', ['-f', `sleep ${SLOW_SLEEP}`], (_err, stdout) => resolve(stdout.trim())))

test.describe('a slow login shell never marks an agent "not mapped"', () => {
  let fixture: Fixture
  let userZdotdir: string
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    userZdotdir = await tempDir('pomade-zdot-')
    await fs.writeFile(join(userZdotdir, '.zshrc'), `[[ -t 0 ]] || sleep ${SLOW_SLEEP}\n`)
    app = await launchApp(fixture, { ZDOTDIR: userZdotdir })
    page = await firstAppWindow(app)
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(userZdotdir, { recursive: true, force: true })
  })

  test('past the check shell\'s old 8 s limit, the "+" menu shows every agent without "!"', async () => {
    // The slow check shell stays running past the 8 s a check used to be allowed before its
    // "not found" stuck for the app run.
    await expectQuiet(async () => expect(await sleepersLeft()).not.toBe(''), 9_000, 500)
    await page.getByTestId('tab-add').click()
    await expect(page.getByTestId('tab-add-menu')).toBeVisible()
    for (const [id, name] of [
      ['claude', 'Claude'],
      ['codex', 'Codex'],
      ['claude-test', 'claude-test']
    ]) {
      await expect(page.getByTestId(`tab-add-agent-${id}`)).toHaveText(name)
    }
    await page.keyboard.press('Escape')
  })

  test('quitting kills the running check shell and what it started', async () => {
    await app.close()
    await expect.poll(sleepersLeft, { timeout: 5_000 }).toBe('')
  })
})
