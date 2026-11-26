// modules: agents, terminal
// Pomade E-025 slice 5 e2e — the Unbound ⚠️ UI: a clickable warning mark on a live agent tab
// whose bind window closed with no uniquely-attributable session id, and its recovery popover
// (manual id entry validated against the tab's expected store / Ignore / Cancel).
//
// The unbound state is produced the deterministic way (slice 2's tie): two submits driven
// through the store action in one tick + ONE transcript → the watcher refuses both tabs. The
// keystroke path is pinned by session-capture.spec; this file is about the UI + manual bind.
//
// State chains WITHIN the describe (one app, one window) — tests append, never insert mid-file.

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
import { readBuffer } from './fixtures/stores'
import { FAKE_AGENT_ECHO } from './fixtures/fake-agent'

function encodeCwd(abs: string): string {
  return abs.replace(/[^a-zA-Z0-9]/g, '-')
}


interface TabSnap {
  id: string
  kind: string
  status: string
  termId: string
  resumeSessionId?: string
  lastCommand?: string
  bindState?: string
}

function tabSnaps(page: Page, projectId: string): Promise<TabSnap[]> {
  return page.evaluate((pid) => {
    const stores = window.__pomadeStores
    return (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      termId: t.termId,
      resumeSessionId: t.resumeSessionId,
      lastCommand: t.lastCommand,
      bindState: t.bindState
    }))
  }, projectId) as Promise<TabSnap[]>
}

async function snapOf(page: Page, projectId: string, tabId: string): Promise<TabSnap | undefined> {
  return (await tabSnaps(page, projectId)).find((t) => t.id === tabId)
}

async function newAgentTab(
  page: Page,
  projectId: string
): Promise<{ tabId: string; termId: string }> {
  const before = new Set((await tabSnaps(page, projectId)).map((t) => t.id))
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-agent-claude-test').click()
  await expect
    .poll(
      async () =>
        (await tabSnaps(page, projectId)).filter((t) => t.kind === 'agent' && !before.has(t.id))
          .length,
      { timeout: 15_000 }
    )
    .toBe(1)
  const tab = (await tabSnaps(page, projectId)).find((t) => t.kind === 'agent' && !before.has(t.id))
  if (!tab) throw new Error('new agent tab not found')
  await expect.poll(() => readBuffer(page, tab.termId), { timeout: 15_000 }).toContain('AGENT_READY')
  return { tabId: tab.id, termId: tab.termId }
}

async function typeSubmit(page: Page, tabId: string, text: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click()
  await page.getByTestId(`terminal-${tabId}`).click({ position: { x: 60, y: 60 } })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function writeClaudeSession(storeDir: string, sessionId: string): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true })
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `hello from ${sessionId}` },
      timestamp: new Date().toISOString()
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
    })
  ]
  await fs.writeFile(join(storeDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
}

test.describe('E-025 — Unbound ⚠️ mark + recovery popover', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let storeDir = ''
  const ID_T = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
  const ID_R = 'efefefef-efef-4fef-8fef-efefefefefef'
  const NONEXISTENT = '00000000-bad0-4bad-8bad-000000000bad'
  let t1 = { tabId: '', termId: '' }
  let t2 = { tabId: '', termId: '' }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const scriptPath = join(fixture.workspaceRoot, 'fake-agent.sh')
    await fs.writeFile(scriptPath, FAKE_AGENT_ECHO, { mode: 0o755 })
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { 'claude-test': scriptPath }, hidden: [] }, null, 2)
    )
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a refused tie marks BOTH tabs with the clickable ⚠️; Cancel keeps the mark', async () => {
    test.slow()
    t1 = await newAgentTab(page, alpha)
    t2 = await newAgentTab(page, alpha)
    // No mark while nothing is unbound.
    await expect(page.getByTestId(`tab-unbound-${t1.tabId}`)).toHaveCount(0)

    // The tab's store, keyed by the PHYSICAL launch cwd (what a real CLI encodes).
    const cwd = (await page.evaluate(
      (tid) => window.pomade.pty.cwd(tid),
      t1.termId
    )) as string
    storeDir = join(
      fixture.workspaceRoot,
      'Agents/claude-test/projects',
      encodeCwd(await fs.realpath(cwd))
    )

    // A sub-second submit tie + ONE transcript → the watcher refuses both (slice 2's case).
    await page.evaluate(
      ({ pid, x, y }) => {
        const store = window.__pomadeStores.useTerminalsStore.getState()
        store.handleSubmit(pid, x, 'tie submit one')
        store.handleSubmit(pid, y, 'tie submit two')
      },
      { pid: alpha, x: t1.tabId, y: t2.tabId }
    )
    await writeClaudeSession(storeDir, ID_T)

    await expect(page.getByTestId(`tab-unbound-${t1.tabId}`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(`tab-unbound-${t2.tabId}`)).toBeVisible({ timeout: 15_000 })

    // Cancel = close the popover, KEEP the mark (deal with it later).
    await page.getByTestId(`tab-unbound-${t1.tabId}`).click()
    await expect(page.getByTestId('unbound-popover')).toBeVisible()
    await page.getByTestId('unbound-cancel').click()
    await expect(page.getByTestId('unbound-popover')).toHaveCount(0)
    await expect(page.getByTestId(`tab-unbound-${t1.tabId}`)).toBeVisible()
  })

  test('manual entry: a nonexistent id is REFUSED; the existing id binds and clears the mark', async () => {
    await page.getByTestId(`tab-unbound-${t1.tabId}`).click()
    await expect(page.getByTestId('unbound-popover')).toBeVisible()

    // A nonexistent id must never bind — its resume would fail (validated against the store).
    await page.getByTestId('unbound-id-input').fill(NONEXISTENT)
    await page.getByTestId('unbound-bind').click()
    await expect(page.getByTestId('unbound-error')).toBeVisible()
    await expect(page.getByTestId('unbound-popover')).toBeVisible() // stays open for a retry
    expect((await snapOf(page, alpha, t1.tabId))?.bindState).toBe('unbound')
    expect((await snapOf(page, alpha, t1.tabId))?.resumeSessionId).toBeUndefined()

    // The REAL id (the user copied it from the farewell line / the tie's orphan) binds.
    await page.getByTestId('unbound-id-input').fill(ID_T)
    await page.getByTestId('unbound-bind').click()
    await expect(page.getByTestId('unbound-popover')).toHaveCount(0)
    await expect(page.getByTestId(`tab-unbound-${t1.tabId}`)).toHaveCount(0)
    await expect
      .poll(async () => (await snapOf(page, alpha, t1.tabId))?.resumeSessionId ?? '', {
        timeout: 15_000
      })
      .toBe(ID_T)
    expect((await snapOf(page, alpha, t1.tabId))?.bindState).toBe('bound')
  })

  test('Ignore silences THIS unbound session only — the tab stays in the machine and rebinds', async () => {
    await page.getByTestId(`tab-unbound-${t2.tabId}`).click()
    await expect(page.getByTestId('unbound-popover')).toBeVisible()
    await page.getByTestId('unbound-ignore').click()
    await expect(page.getByTestId('unbound-popover')).toHaveCount(0)
    // Mark silenced; the tab is still unbound underneath (no auto-resume trust).
    await expect(page.getByTestId(`tab-unbound-${t2.tabId}`)).toHaveCount(0)
    expect((await snapOf(page, alpha, t2.tabId))?.bindState).toBe('unbound')
    expect((await snapOf(page, alpha, t2.tabId))?.resumeSessionId).toBeUndefined()

    // NOT abandoned: the next submit re-enters AwaitingId and its own transcript rebinds it.
    // (ID_T is owned by t1 now, so only the fresh ID_R qualifies.)
    await typeSubmit(page, t2.tabId, 'recover this tab please')
    await writeClaudeSession(storeDir, ID_R)
    await expect
      .poll(async () => (await snapOf(page, alpha, t2.tabId))?.resumeSessionId ?? '', {
        timeout: 15_000
      })
      .toBe(ID_R)
    expect((await snapOf(page, alpha, t2.tabId))?.bindState).toBe('bound')
    await expect(page.getByTestId(`tab-unbound-${t2.tabId}`)).toHaveCount(0)
  })

  test('a manually bound id ENABLES resume: the next run auto-resumes it', async () => {
    test.slow()
    // The (tuned) debounced state save must land before the round-trip quit — poll the file.
    await expect
      .poll(
        () =>
          fs
            .readFile(join(fixture.workspaceRoot, '.pomade', 'state', `${alpha}.json`), 'utf8')
            .catch(() => ''),
        { timeout: 15_000 }
      )
      .toContain(ID_T)
    await app.close()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${alpha}`).click()

    await expect
      .poll(
        async () => {
          const snap = await snapOf(page, alpha, t1.tabId)
          return (
            snap?.status === 'live' &&
            snap.termId !== t1.termId &&
            (snap.lastCommand ?? '').includes(`--resume ${ID_T}`)
          )
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    const revived = await snapOf(page, alpha, t1.tabId)
    await expect
      .poll(() => readBuffer(page, revived?.termId ?? ''), { timeout: 20_000 })
      .toContain(`--resume ${ID_T}`)
  })
})
