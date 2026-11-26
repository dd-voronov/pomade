// modules: core, terminal, agents, tabs
// E-031 e2e — the platform event `agentTab.exited` (docs/HOST-API.md §4 `events`): it fires for
// EVERY end of an agent process in a tab — the agent quitting (exit), ending with an error status
// (crash), its shell dying under it (crash), the tab closed (tab-closed), the bulk "exit all
// agents" (the agents quit: exit) and Pomade quitting (quit) — with the tab, its project, the
// agent, the session bound at that moment and the reason. A requested kill is an end like any
// other here (unlike the attention scanner). Observed from a hello frame that subscribes (hidden
// behind the agent tabs), and through main's test event log for the quit, when no frame is left.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { seedFakeAgent } from './fixtures/fake-agent'
import { callIn, connectedFrame, eventsOf, HELLO_DIR, openHelloFromMenu, setActiveProject } from './fixtures/hello-app'
import { readBuffer, writePty } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

/** The stand-in agent: `/exit` quits (0), `/crash` ends with status 3, `/killshell` kills its shell. */
const FAKE_AGENT_ENDINGS = `#!/bin/zsh
echo AGENT_READY
while IFS= read -r line; do
  if [[ "$line" == "/exit" ]]; then exit 0; fi
  if [[ "$line" == "/crash" ]]; then exit 3; fi
  if [[ "$line" == "/killshell" ]]; then kill -9 $PPID; fi
  echo "AGENT_GOT: $line"
done
`

interface Exited {
  tabId: string
  projectId: string
  agentId: string
  sessionId: string | null
  reason: string
}

test.describe('E-031 agentTab.exited', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let hello: Frame
  let eventLog: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ENDINGS })
    eventLog = join(fixture.userDataDir, 'bus-events.jsonl')
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR, POMADE_TEST_EVENT_LOG: eventLog })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await setActiveProject(page, fixture.projects.alpha)
    await openHelloFromMenu(page)
    hello = await connectedFrame(page.getByTestId('app-frame-hello'))
    expect(await callIn(hello, 'events.subscribe', { name: 'agentTab.exited' })).toEqual({ ok: true, value: {} })
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fixture?.cleanup()
  })

  /** Start the fake agent in Alpha (optionally resuming `sessionId`); resolves once it is ready. */
  async function startAgent(sessionId?: string): Promise<{ tabId: string; termId: string }> {
    const tab = await page.evaluate(
      async ({ pid, sid }) => {
        const stores = window.__pomadeStores
        const project = stores.useWorkspaceStore.getState().projectById(pid)
        const roster = (await window.pomade.agents.roster())
        const agent = roster.find((a) => a.id === 'claude-test')
        const before = new Set((stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => t.id))
        await stores.useTerminalsStore.getState().startAgent(project, agent, sid)
        const created = (stores.useTabsStore.getState().tabsByProject[pid] ?? []).find((t) => !before.has(t.id))
        return { tabId: created!.id, termId: created!.termId! }
      },
      { pid: fixture.projects.alpha, sid: sessionId }
    )
    await expect.poll(() => readBuffer(page, tab.termId), { timeout: 20_000 }).toContain('AGENT_READY')
    return tab
  }

  async function exits(): Promise<Exited[]> {
    return (await eventsOf(hello, 'agentTab.exited')) as Exited[]
  }

  async function logged(): Promise<Exited[]> {
    const text = await fs.readFile(eventLog, 'utf8').catch(() => '')
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; payload: Exited })
      .filter((e) => e.name === 'agentTab.exited')
      .map((e) => e.payload)
  }

  test('the agent quitting is exit, with the session bound at that moment', async () => {
    const { tabId, termId } = await startAgent('11111111-2222-3333-4444-555555555555')
    await writePty(page, termId, '/exit\r')
    await expect
      .poll(exits, { timeout: 15_000 })
      .toEqual([
        {
          tabId,
          projectId: fixture.projects.alpha,
          agentId: 'claude-test',
          sessionId: '11111111-2222-3333-4444-555555555555',
          reason: 'exit'
        }
      ])
  })

  test('an error status is crash; no session bound yet is null', async () => {
    const { tabId, termId } = await startAgent()
    await writePty(page, termId, '/crash\r')
    await expect
      .poll(async () => (await exits()).at(-1), { timeout: 15_000 })
      .toEqual({ tabId, projectId: fixture.projects.alpha, agentId: 'claude-test', sessionId: null, reason: 'crash' })
    expect(await exits()).toHaveLength(2)
  })

  test('the shell dying under the agent is crash', async () => {
    const { tabId, termId } = await startAgent()
    await writePty(page, termId, '/killshell\r')
    await expect
      .poll(async () => (await exits()).at(-1), { timeout: 15_000 })
      .toMatchObject({ tabId, reason: 'crash' })
    expect(await exits()).toHaveLength(3)
  })

  test('closing the tab is tab-closed — the requested kill counts', async () => {
    const { tabId } = await startAgent('99999999-8888-7777-6666-555555555555')
    await page.evaluate(
      ([pid, tid]) => {
        window.__pomadeStores.useTabsStore.getState().closeTab(pid, tid)
      },
      [fixture.projects.alpha, tabId] as const
    )
    await expect
      .poll(async () => (await exits()).at(-1), { timeout: 15_000 })
      .toEqual({
        tabId,
        projectId: fixture.projects.alpha,
        agentId: 'claude-test',
        sessionId: '99999999-8888-7777-6666-555555555555',
        reason: 'tab-closed'
      })
    expect(await exits()).toHaveLength(4)
  })

  test('the bulk "exit all agents" ends each agent once', async () => {
    const a = await startAgent()
    const b = await startAgent()
    await page.evaluate((pid) => {
      void window.__pomadeStores.useTerminalsStore.getState().exitAllAgents(pid)
    }, fixture.projects.alpha)
    await expect
      .poll(async () => (await exits()).slice(4).map((e) => e.tabId).sort(), { timeout: 15_000 })
      .toEqual([a.tabId, b.tabId].sort())
    expect((await exits()).slice(4).map((e) => e.reason)).toEqual(['exit', 'exit'])
  })

  test('Pomade quitting is quit, reported before the windows go', async () => {
    const { tabId } = await startAgent('abababab-cdcd-efef-0101-232323232323')
    const before = (await logged()).length
    await app.close()
    const after = (await logged()).slice(before)
    expect(after).toEqual([
      {
        tabId,
        projectId: fixture.projects.alpha,
        agentId: 'claude-test',
        sessionId: 'abababab-cdcd-efef-0101-232323232323',
        reason: 'quit'
      }
    ])
  })
})
