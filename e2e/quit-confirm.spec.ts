// modules: core, terminal, agents, editor
// Pomade T-098 e2e — quit protection. Every quit path (app-menu Quit / Cmd+Q, the red
// traffic-light close) is intercepted in main and confirmed by renderer-built dialogs; when
// live terminal/agent sessions exist a SECOND, stronger confirm carries the real counts.
//
// Test-mode contract under test: the confirmation is BYPASSED in NODE_ENV=test unless a spec
// opts in with POMADE_TEST_QUIT_CONFIRM=1 — otherwise every other suite's `app.close()`
// teardown would hang. The first describe opts IN; the second proves the bypass.
//
// Keystrokes can't be synthesized into native menu accelerators (T-036 note), so the quit is
// triggered where the OS would trigger it: `app.quit()` (Cmd+Q / app-menu Quit) and
// `BrowserWindow.close()` (the red button / Cmd+Shift+W) inside the main process.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

/** The Cmd+Q / app-menu-Quit path, from inside main. Returns as soon as the request is in
 *  flight — the gate prevents the quit, so nothing actually exits. */
function pressQuit(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ app: electronApp }) => {
    electronApp.quit()
  })
}

/** The red traffic light / "Close Window" path: the window's own `close` event. */
function pressWindowClose(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close()
  })
}

async function openTerminal(page: Page): Promise<string> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

function liveTermIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const list = (await window.pomade.pty.list()) as { termId: string; alive: boolean }[]
    return list.filter((t) => t.alive).map((t) => t.termId)
  })
}

test.describe('quit confirmation (opted in)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let closed = false

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_TEST_QUIT_CONFIRM: '1' })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // Main only asks the renderer once its page has finished loading (before that an
    // unconfirmed quit proceeds, so the app can never become unquittable).
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    if (!closed) await app?.close()
    await fixture?.cleanup()
  })

  test('Cmd+Q with no live sessions shows ONE dialog; Cancel leaves the app running', async () => {
    await pressQuit(app)

    await expect(page.getByTestId('quit-confirm')).toBeVisible()
    // No sessions ⇒ the second, stronger confirm must not exist.
    await expect(page.getByTestId('quit-confirm-sessions')).toHaveCount(0)

    await page.getByTestId('quit-cancel').click()
    await expect(page.getByTestId('quit-confirm')).toHaveCount(0)

    // Still alive AND functional: the app answers input after an aborted quit.
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect(page.getByTestId('panehost')).toHaveAttribute(
      'data-active-project',
      fixture.projects.alpha
    )
  })

  test('the red close button runs the same flow; Esc aborts and the window survives', async () => {
    await pressWindowClose(app)
    await expect(page.getByTestId('quit-confirm')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('quit-confirm')).toHaveCount(0)

    // The window itself must still be there — no "window vanished but the app lives" limbo.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test('a second quit attempt while the dialog is open does not stack dialogs', async () => {
    await pressQuit(app)
    await expect(page.getByTestId('quit-confirm')).toBeVisible()
    await pressQuit(app)
    await pressWindowClose(app)
    await expect(page.getByTestId('quit-confirm')).toHaveCount(1)

    await page.getByTestId('quit-cancel').click()
    await expect(page.getByTestId('quit-confirm')).toHaveCount(0)
  })

  test('with a live terminal: confirming the first dialog shows the count; Cancel keeps the PTY', async () => {
    const termId = await openTerminal(page)
    await expect.poll(() => liveTermIds(page)).toContain(termId)

    await pressQuit(app)
    await page.getByTestId('quit-ok').click()

    await expect(page.getByTestId('quit-confirm-sessions')).toBeVisible()
    await expect(page.getByTestId('quit-sessions-message')).toContainText(
      '1 terminal is still running.'
    )

    await page.getByTestId('quit-sessions-cancel').click()
    await expect(page.getByTestId('quit-confirm-sessions')).toHaveCount(0)

    // Nothing happened: app alive, PTY untouched.
    await expect(page.getByTestId('app-shell')).toBeVisible()
    expect(await liveTermIds(page)).toContain(termId)
  })

  test('counts split by tab kind: agents and terminals are named separately', async () => {
    // The agent LAUNCHER path is covered in terminals.spec; what matters here is that the
    // renderer splits main's live-pty truth by the tab kind only it knows, so a live pty is
    // re-labelled as an agent tab through the __pomadeStores hook (same setup-only use as the
    // tab-rename simulation) rather than booting a stand-in agent CLI.
    const alpha = fixture.projects.alpha
    await page.evaluate((pid) => {
      const tabsStore = window.__pomadeStores.useTabsStore
      const tabs = tabsStore.getState().tabsByProject[pid]
      const term = tabs.find((t) => t.kind === 'terminal')!
      tabsStore.getState().updateTab(pid, term.id, { kind: 'agent' })
    }, alpha)

    const second = await openTerminal(page)
    await expect.poll(() => liveTermIds(page)).toContain(second)

    await pressQuit(app)
    await page.getByTestId('quit-ok').click()
    await expect(page.getByTestId('quit-sessions-message')).toContainText(
      '1 agent and 1 terminal are still running.'
    )

    await page.getByTestId('quit-sessions-cancel').click()
    await expect(page.getByTestId('quit-confirm-sessions')).toHaveCount(0)
  })

  test('confirming BOTH dialogs quits the app', async () => {
    await pressQuit(app)
    await page.getByTestId('quit-ok').click()
    await expect(page.getByTestId('quit-confirm-sessions')).toBeVisible()

    const exited = app.waitForEvent('close')
    await page.getByTestId('quit-sessions-ok').click()
    await exited
    closed = true
  })
})

test.describe('quit confirmation bypass (standard test env)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('without the opt-in a live PTY never blocks app.close() (teardowns stay instant)', async () => {
    const termId = await openTerminal(page)
    await expect.poll(() => liveTermIds(page)).toContain(termId)

    const started = Date.now()
    await app.close()
    // The orderly shutdown (flush ≤1s + PTY reap ≤2s) is the only cost; a dialog would hang
    // here until the 30s test timeout.
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

// T-187 — the THREE-stage chain: when BOTH a live session AND a dirty doc exist, the docs confirm
// appears IN ADDITION to the existing two, sequenced LAST (quit → sessions → docs). Self-contained
// (own fixture + opt-in) so it never perturbs the two-stage chain above; it opens a terminal, which
// is why it belongs in this heavy spec.
test.describe('T-187 — dirty docs are the third stage, after sessions', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let closed = false

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const root = fixture.workspaceRoot
    await fs.writeFile(join(root, 'Projects/alpha', 'seq.txt'), 'seq original\n')
    await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
    await fs.writeFile(
      join(root, '.pomade/state/proj-alpha.json'),
      JSON.stringify(
        {
          openTabs: [
            {
              id: 'doc-seq',
              projectId: 'proj-alpha',
              kind: 'doc',
              title: 'seq.txt',
              path: 'Projects/alpha/seq.txt',
              mode: 'raw',
              dirty: false
            }
          ],
          activeTabId: 'doc-seq'
        },
        null,
        2
      )
    )
    app = await launchApp(fixture, { POMADE_TEST_QUIT_CONFIRM: '1' })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId('project-proj-alpha').click()
  })

  test.afterAll(async () => {
    if (!closed) await app?.close()
    await fixture?.cleanup()
  })

  test('quit → sessions → docs, in that order', async () => {
    // A live terminal (stage 2 trigger) AND a dirty doc (stage 3 trigger).
    const termId = await openTerminal(page)
    await expect.poll(() => liveTermIds(page)).toContain(termId)
    await page.getByTestId('tab-doc-seq').click()
    await page.locator('[data-testid="raw-editor"] .cm-content:visible').click()
    await page.keyboard.type(' SEQ-EDIT')
    await expect(page.locator('[data-testid="doc-save"]:visible')).toHaveText('Save')

    await pressQuit(app)
    // Stage 1.
    await expect(page.getByTestId('quit-confirm')).toBeVisible()
    await expect(page.getByTestId('quit-confirm-sessions')).toHaveCount(0)
    await expect(page.getByTestId('quit-confirm-docs')).toHaveCount(0)
    await page.getByTestId('quit-ok').click()
    // Stage 2 — sessions — comes before docs.
    await expect(page.getByTestId('quit-confirm-sessions')).toBeVisible()
    await expect(page.getByTestId('quit-confirm-docs')).toHaveCount(0)
    await page.getByTestId('quit-sessions-ok').click()
    // Stage 3 — docs — is last.
    await expect(page.getByTestId('quit-confirm-docs')).toBeVisible()
    await expect(page.getByTestId('quit-docs-message')).toContainText('1 document has unsaved changes.')

    // Discard-all completes the quit (the terminal + the edit are both dropped, as chosen).
    const exited = app.waitForEvent('close')
    await page.getByTestId('quit-docs-discard').click()
    await exited
    closed = true
  })
})
