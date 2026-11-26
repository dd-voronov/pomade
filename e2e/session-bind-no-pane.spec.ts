// modules: core, projects, tabs, terminal, agents
// Pomade e2e — T-168: a session-id BIND lands for a live agent tab whose pane NEVER mounted.
//
// This is the data-loss case the ticket targets. Before T-168 the session-id (and agent-start /
// exec / cwd-persist / attention) store transitions were subscribed from each TerminalPane's mount
// effect, so a transition landed ONLY while that pane was mounted — correctness rode entirely on
// the hidden-not-unmounted invariant (PaneHost keeps every project's panes mounted). Any violation
// of it silently dropped the transition. T-168 moves those subscriptions into terminals-store,
// keyed by termId off tabsByProject, so they no longer depend on a pane existing.
//
// To construct a genuinely pane-less live agent, we flip the renderer to the WORKSPACE PICKER
// (workspace-store `root = null`) — the App branch that renders NO PaneHost at all — BEFORE
// launching the agent through the store. The pty is created by MAIN, which keeps its own workspace
// root, so `pty.create` still resolves; the renderer simply never mounts a pane for the tab. We
// then drive the bind entirely through the store + main (handleSubmit + a real transcript on disk,
// exactly as session-capture does through the store) and assert the id binds and persists.
//
// REVERT-PROOF: with the pane subscriptions put back into TerminalPane, this tab's pane is not
// mounted (no PaneHost), so `pty:session-id` would reach no listener and the bind would never
// happen. It passes only because the subscription is store-owned. A real interactive zsh runs, so
// this file is in HEAVY_ZSH_NAMES.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { readBuffer, tabsOf } from './fixtures/stores'
import { FAKE_AGENT_RESUME, seedFakeAgentScript } from './fixtures/fake-agent'

/** Claude Code's own cwd encoding (mirror of agent-service.encodeCwd). */
function encodeCwd(abs: string): string {
  return abs.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The PHYSICAL launch cwd — what a real CLI encodes into its store key (macOS realpath). */
async function physCwd(page: Page, termId: string): Promise<string> {
  const cwd = await page.evaluate((tid) => window.pomade.pty.cwd(tid), termId)
  return cwd ? fs.realpath(cwd) : cwd
}

/** Write a real-shape claude transcript (basename = session id) into an isolated store. */
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

async function tabField(
  page: Page,
  projectId: string,
  tabId: string,
  field: 'resumeSessionId' | 'bindState' | 'cwdAtLaunch' | 'status' | 'kind'
): Promise<string> {
  const tab = (await tabsOf(page, projectId)).find((t) => t.id === tabId)
  return (tab?.[field] as string | undefined) ?? ''
}

/** True when App is showing the workspace picker (root === null ⇒ no PaneHost, no panes). */
async function paneCount(page: Page, tabId: string): Promise<number> {
  return page.getByTestId(`pane-${tabId}`).count()
}

test.describe('T-168 — session-id bind for a never-mounted pane', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  const SESSION_ID = 'c0ffee00-1168-4168-8168-c0ffeec0ffee'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_RESUME })
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { 'claude-test': scriptPath }, hidden: [] }, null, 2)
    )
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // Open alpha so it is hydrated and main knows the active workspace, then we will flip the
    // renderer to the picker for the pane-less launch.
    await page.getByTestId(`project-${alpha}`).click()
    await expect(page.getByTestId('panehost')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a live agent launched while the renderer shows the picker binds its session id with no pane', async () => {
    test.slow()

    // Flip to the workspace picker FIRST (no PaneHost), THEN launch the agent through the store.
    // The tab enters tabsByProject (so terminals-store subscribes its termId), but React renders
    // the picker branch, so no PaneHost and no pane for this tab ever mounts.
    const created = await page.evaluate(async (pid) => {
      const stores = window.__pomadeStores
      const project = stores.useWorkspaceStore.getState().projectById(pid)
      const roster = await window.pomade.agents.roster()
      const agent = roster.find((a) => a.id === 'claude-test')
      stores.useWorkspaceStore.setState({ root: null })
      const before = new Set(
        (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => t.id)
      )
      await stores.useTerminalsStore.getState().startAgent(project, agent)
      const tab = (stores.useTabsStore.getState().tabsByProject[pid] ?? []).find(
        (t) => t.kind === 'agent' && !before.has(t.id)
      )
      return tab ? { tabId: tab.id as string, termId: tab.termId as string } : null
    }, alpha)
    expect(created).not.toBeNull()
    const { tabId, termId } = created!

    // The renderer is on the picker and this tab has no pane in the DOM — now and throughout.
    await expect(page.getByTestId('pick-workspace')).toBeVisible()
    await expect(page.getByTestId('panehost')).toHaveCount(0)
    expect(await paneCount(page, tabId)).toBe(0)

    // The agent is running (real pty in main), even though no pane rendered it.
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('AGENT_READY')

    // A MOVED transition proves itself pane-less too: agent-start stamped the launch cwd via the
    // store subscription (no pane effect exists to do it).
    await expect
      .poll(() => tabField(page, alpha, tabId, 'cwdAtLaunch'), { timeout: 15_000 })
      .not.toBe('')

    // Nothing bound yet.
    expect(await tabField(page, alpha, tabId, 'resumeSessionId')).toBe('')

    // Arm the bind window through the store (the genuine-input keystroke path lives in the pane,
    // which does not exist here — session-capture's tie spec drives handleSubmit the same way),
    // then drop the transcript the watcher confirms. This is the exact bind the pane used to own.
    await page.evaluate(
      ({ pid, tid }) => {
        const store = window.__pomadeStores.useTerminalsStore.getState()
        store.handleSubmit(pid, tid, 'first prompt from the pane-less agent')
      },
      { pid: alpha, tid: tabId }
    )
    const cwd = await physCwd(page, termId)
    expect(cwd).not.toBe('')
    const storeDir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwd))
    await writeClaudeSession(storeDir, SESSION_ID)

    // The store subscription caught pty:session-id and bound the tab — with no pane in existence.
    await expect
      .poll(() => tabField(page, alpha, tabId, 'resumeSessionId'), { timeout: 15_000 })
      .toBe(SESSION_ID)
    expect(await tabField(page, alpha, tabId, 'bindState')).toBe('bound')

    // Still no pane ever mounted for this tab.
    expect(await paneCount(page, tabId)).toBe(0)

    // And it reached disk (the only reason it could survive a reload).
    await expect
      .poll(async () => {
        try {
          const raw = await fs.readFile(
            join(fixture.workspaceRoot, '.pomade', 'state', `${alpha}.json`),
            'utf8'
          )
          const state = JSON.parse(raw) as {
            openTabs?: { id: string; resumeSessionId?: string }[]
          }
          return state.openTabs?.find((t) => t.id === tabId)?.resumeSessionId ?? ''
        } catch {
          return ''
        }
      }, { timeout: 15_000 })
      .toBe(SESSION_ID)
  })
})
