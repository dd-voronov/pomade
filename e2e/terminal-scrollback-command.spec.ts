// modules: terminal, tabs
// Pomade T-300 e2e — a terminal started WITH a command saves its scrollback like a plain one.
//
// The thing under test: `pty.create` with a launch `command` starts the term non-snapshotting
// (T-128: the command may be an agent, whose TUI frames must never be persisted, and the roster
// match that says so is async). The launch command's own verdict then decides: a command that is
// not an agent turns snapshotting on. Agent launches keep the T-128 behaviour — the
// "button-launched agent tab" describe in terminal-scrollback.spec.ts holds that line.
//
// Oracles: the snapshot FILE (`.pomade/state/scrollback/<tabId>`, the only thing that survives a
// restart), `pty.replay(termId)` (the bytes a reattaching pane paints) and the xterm rows.
//
// The shells read a temp ZDOTDIR (never the real home rc files). The runs chain — append only.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'
import { present } from './fixtures/assert'
import { readBuffer, tabsOf, waitForPrompt, writeWhenReady } from './fixtures/stores'
import { expectQuiet, quietWindow, TEST_SNAPSHOT_IDLE_MS } from './fixtures/timing'
import { tempDir } from './fixtures/temp'

const DIVIDER = 'session restored'
const CMD_MARK = 'CMD_RAN'
const PLAIN_MARK = 'PLAIN_RAN'
const CMD_TITLE = 't300-cmd'

function snapshotPath(fixture: Fixture, tabId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback', tabId)
}

async function snapshotOf(fixture: Fixture, tabId: string): Promise<string | null> {
  try {
    return await fs.readFile(snapshotPath(fixture, tabId), 'utf8')
  } catch {
    return null
  }
}

function readReplay(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.replay(tid), termId)
}

function rowsText(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
    return Array.from(rows)
      .map((r) => r.textContent ?? '')
      .join('\n')
  }, termId)
}

/** A temp ZDOTDIR whose `.zshrc` only sets a prompt — the shells never read the real rc files. */
async function makeZdotdir(): Promise<string> {
  const dir = await tempDir('pomade-t300-zdot-')
  await fs.writeFile(join(dir, '.zshrc'), 'PROMPT="t300> "\n')
  return dir
}

/** Open a terminal started with `echo CMD_MARK` (the `tabs.openTerminal`-with-command path). */
async function openCommandTerminal(page: Page, fixture: Fixture, pid: string): Promise<void> {
  await page.evaluate(
    async ({ pid, cwd, command, title }) => {
      await window.__pomadeStores.useTerminalsStore.getState().newCommandTerminal(pid, { cwd, command, title })
    },
    { pid, cwd: join(fixture.workspaceRoot, 'Projects', 'alpha'), command: `echo ${CMD_MARK}`, title: CMD_TITLE }
  )
}

test.describe('T-300 — a command terminal keeps its scrollback across a restart', () => {
  let fixture: Fixture
  let zdotdir = ''
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''
  let cmdTabId = ''
  let plainTabId = ''
  let cmdTermRun1 = ''

  async function boot(): Promise<void> {
    ;({ app, page } = await launchAppPage(fixture, { ZDOTDIR: zdotdir }))
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    zdotdir = await makeZdotdir()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    if (zdotdir) await fs.rm(zdotdir, { recursive: true, force: true })
  })

  test('run 1 — a command terminal writes its snapshot while the app runs', async () => {
    test.slow()
    await boot()
    await page.evaluate(async (pid) => {
      const s = window.__pomadeStores
      const proj = s.useWorkspaceStore.getState().projects.find((p: { id: string }) => p.id === pid)
      await s.useTerminalsStore.getState().newTerminal(proj)
    }, alpha)
    await openCommandTerminal(page, fixture, alpha)
    const tabs = (await tabsOf(page, alpha)).filter((t) => t.kind === 'terminal')
    const cmd = present(tabs.find((t) => t.title === CMD_TITLE), 'command tab')
    const plain = present(tabs.find((t) => t.title !== CMD_TITLE), 'plain tab')
    cmdTabId = cmd.id
    plainTabId = plain.id
    cmdTermRun1 = present(cmd.termId, 'command termId')

    await writeWhenReady(page, present(plain.termId, 'plain termId'), `echo ${PLAIN_MARK}\r`)
    await expect.poll(() => readBuffer(page, cmdTermRun1), { timeout: 20_000 }).toContain(CMD_MARK)

    // The command terminal persists mid-run (the debounced write), exactly like the plain one.
    await expect
      .poll(async () => (await snapshotOf(fixture, cmdTabId)) ?? '', { timeout: 20_000 })
      .toContain(CMD_MARK)
    await expect
      .poll(async () => (await snapshotOf(fixture, plainTabId)) ?? '', { timeout: 20_000 })
      .toContain(PLAIN_MARK)
    await app?.close()
    app = undefined
  })

  test('run 2 — the revived command tab paints its output above the divider', async () => {
    test.slow()
    await boot()
    await expect
      .poll(
        async () => {
          const t = (await tabsOf(page, alpha)).find((x) => x.id === cmdTabId)
          return t?.status === 'live' && t.termId !== cmdTermRun1
        },
        { timeout: 60_000 }
      )
      .toBe(true)
    const revived = present((await tabsOf(page, alpha)).find((t) => t.id === cmdTabId), 'revived tab')
    const termId = present(revived.termId, 'revived termId')

    await expect.poll(() => readReplay(page, termId), { timeout: 20_000 }).toContain(DIVIDER)
    const paint = await readReplay(page, termId)
    expect(paint.indexOf(CMD_MARK)).toBeGreaterThan(-1)
    expect(paint.indexOf(CMD_MARK)).toBeLessThan(paint.indexOf(DIVIDER))
    await expect.poll(() => rowsText(page, termId), { timeout: 20_000 }).toContain(CMD_MARK)
    expect(await rowsText(page, termId)).toContain(DIVIDER)
  })
})

// Relaunch re-runs the tab's `lastCommand`: the same launch-command spawn, now on an existing tab.
test.describe('T-300 — Relaunch of a command terminal snapshots again', () => {
  let fixture: Fixture
  let zdotdir = ''
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    zdotdir = await makeZdotdir()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    if (zdotdir) await fs.rm(zdotdir, { recursive: true, force: true })
  })

  test('the relaunched command rewrites the file the kill left absent', async () => {
    test.slow()
    ;({ app, page } = await launchAppPage(fixture, { ZDOTDIR: zdotdir }))
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()
    await openCommandTerminal(page, fixture, alpha)
    const tab = present((await tabsOf(page, alpha)).find((t) => t.title === CMD_TITLE), 'command tab')
    const oldTerm = present(tab.termId, 'termId')
    await expect.poll(() => readBuffer(page, oldTerm), { timeout: 20_000 }).toContain(CMD_MARK)
    await waitForPrompt(page, oldTerm)
    // A requested kill writes nothing (and cancels the pending write); with the file gone, only
    // the relaunched term can bring it back.
    await page.evaluate((tid) => window.pomade.pty.kill(tid), oldTerm)
    await expect
      .poll(async () => (await tabsOf(page, alpha)).find((t) => t.id === tab.id)?.status, {
        timeout: 20_000
      })
      .toBe('dead')
    await fs.unlink(snapshotPath(fixture, tab.id)).catch(() => undefined)
    await expectQuiet(async () => {
      expect(await snapshotOf(fixture, tab.id)).toBeNull()
    }, quietWindow(TEST_SNAPSHOT_IDLE_MS, 2))

    await page.evaluate(
      async ({ pid, tid }) => window.__pomadeStores.useTerminalsStore.getState().relaunch(pid, tid),
      { pid: alpha, tid: tab.id }
    )
    await expect
      .poll(async () => (await snapshotOf(fixture, tab.id)) ?? '', { timeout: 20_000 })
      .toContain(CMD_MARK)
  })
})
