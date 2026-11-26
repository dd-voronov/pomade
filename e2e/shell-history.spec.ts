// modules: terminal
// Pomade T-242 e2e — a Pomade terminal keeps the user's zsh history.
//
// macOS /etc/zshrc sets `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` while ZDOTDIR still points at
// Pomade's shim, so without the shim's correction every Pomade terminal wrote its history into
// `<userData>/zsh-integration/`. The user here is a test ZDOTDIR fixture (never the real home rc
// files): its `.zsh_history` must receive the commands, and its own `.zshrc` HISTFILE must win.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { readBuffer, writePty, writeWhenReady } from './fixtures/stores'
import { tempDir } from './fixtures/temp'

async function visibleTermId(page: Page): Promise<string> {
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

async function openTerminal(page: Page): Promise<string> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  return visibleTermId(page)
}

const readOrEmpty = (path: string): Promise<string> => fs.readFile(path, 'utf8').catch(() => '')

test.describe('a Pomade terminal keeps the user\'s zsh history', () => {
  let fixture: Fixture
  let userZdotdir: string
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    userZdotdir = await tempDir('pomade-zdot-')
    // The user's own .zshrc sets its own HISTFILE only when the flag file exists.
    await fs.writeFile(
      join(userZdotdir, '.zshrc'),
      '[[ -f "$ZDOTDIR/use-own-histfile" ]] && HISTFILE="$ZDOTDIR/own_history"\nPROMPT="t242> "\n'
    )
    app = await launchApp(fixture, {
      ZDOTDIR: userZdotdir,
      // Pomade started from a Terminal.app tab: its session id must not reach the ptys.
      TERM_SESSION_ID: 'w0t0p0:00000000-0000-0000-0000-000000000242'
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(userZdotdir, { recursive: true, force: true })
  })

  test('HISTFILE is the user\'s own file and receives the commands', async () => {
    const termId = await openTerminal(page)
    await writeWhenReady(page, termId, 'print -r -- "HIST_IS:$HISTFILE:${TERM_SESSION_ID:-nosession}"\r')
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain(`HIST_IS:${join(userZdotdir, '.zsh_history')}:nosession`)

    await writePty(page, termId, 'echo T242_HIST_MARK\r')
    await writePty(page, termId, 'fc -W\r')
    await expect
      .poll(() => readOrEmpty(join(userZdotdir, '.zsh_history')), { timeout: 10_000 })
      .toContain('echo T242_HIST_MARK')
    expect(await readOrEmpty(join(fixture.userDataDir, 'zsh-integration', '.zsh_history'))).toBe('')
  })

  test('a HISTFILE the user\'s .zshrc sets wins', async () => {
    await fs.writeFile(join(userZdotdir, 'use-own-histfile'), '')
    const termId = await openTerminal(page)
    await writeWhenReady(page, termId, 'print -r -- "HIST_IS:$HISTFILE"\r')
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain(`HIST_IS:${join(userZdotdir, 'own_history')}`)
  })
})
