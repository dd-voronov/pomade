// modules: agents, terminal, tabs, core
// E-033 e2e — the agent tabs API (docs/HOST-API.md §4 `agentTabs`), driven from a stand-in agents
// app (e2e/fixtures/apps/agents, id `pomade-agents`): it lists the agent tabs with their sessions
// and live states, launches an agent with a first prompt, renames a tab and marks it unnamed, hears
// the user's rename, focuses a tab, and resumes a closed session in a new tab. It also serves the
// roster the "+" menu reads (rule 7), and the Session history button opens its Sessions view. Every terminal
// — an agent's too — knows its tab (`POMADE_TAB_ID`) and its project (`POMADE_PROJECT_ID`).
//
// The agent is a zsh stand-in: its first prompt writes a real-shape transcript into an isolated
// store (so the session binds exactly as a real CLI's does), `--resume <id>` appends to it, and
// `/work`, `/ask`, `/idle` draw what claude draws for a working turn, a permission dialog and idle
// (the title's ✳ over its empty prompt — a `❯` row alone between two rules). Like claude, `/clear`
// and `/branch` write the new session's transcript at once (a branch's lines name its parent), and
// `/resume <id>` switches to an existing one — what `agentTab.changed` reports the cause of.

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { seedFakeAgent } from './fixtures/fake-agent'
import { activeProjectOf, activeTabOf, openHelloFromMenu, setActiveProject } from './fixtures/hello-app'
import { readBuffer, tabsOf, writePty } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import type { CallResult } from './fixtures/globals'

const AGENTS_DIR = resolve(__dirname, 'fixtures/apps/agents')
const SHOTS = process.env.POMADE_E2E_SHOTS ?? ''

/** A screenshot for the UI review, only when POMADE_E2E_SHOTS names a folder. */
async function shot(target: { screenshot(o: { path: string }): Promise<unknown> }, name: string): Promise<void> {
  if (SHOTS) await target.screenshot({ path: join(SHOTS, name) })
}

/** The stand-in agent CLI (claude-shaped output). */
const FAKE_AGENT_TABS = `#!/bin/zsh
current=""
store="$FAKE_AGENT_STORE/projects/\${\${PWD:A}//[^a-zA-Z0-9]/-}"
line_json() { print -r -- "{\\"type\\":\\"user\\",\\"message\\":{\\"role\\":\\"user\\",\\"content\\":\\"$1\\"},\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}"; }
if [[ "$1" == "--resume" && -n "$2" ]]; then
  current="$2"
  mkdir -p "$store"
  line_json resumed >> "$store/$2.jsonl"
  echo "RESUMED $2"
fi
composer() { print -r -- '────────────────────────'; print -r -- '❯ '; print -r -- '────────────────────────' }
printf '\\e]0;✳ Claude\\a'
echo AGENT_READY
composer
while IFS= read -r line; do
  case "$line" in
    /work) printf '\\e]0;◐ Working\\a'; echo WORKING ;;
    /idle) printf '\\e]0;✳ Claude\\a'; echo IDLE; composer ;;
    /ask) printf '\\e]0;✳ Claude\\a'; echo 'Do you want to proceed?'; echo '❯ 1. Yes'; echo '  2. No'; echo 'Esc to cancel' ;;
    /tabid) echo "TABID=$POMADE_TAB_ID PROJECTID=$POMADE_PROJECT_ID"; composer ;;
    /clear)
      current="$(uuidgen | tr A-Z a-z)"
      print -r -- "{\"type\":\"user\",\"uuid\":\"c-$current\",\"message\":{\"role\":\"user\",\"content\":\"/clear\"}}" >> "$store/$current.jsonl"
      echo "CLEARED $current"; composer ;;
    /branch)
      parent="$current"; current="$(uuidgen | tr A-Z a-z)"
      print -r -- "{\"type\":\"user\",\"uuid\":\"b-$current\",\"forkedFrom\":{\"sessionId\":\"$parent\",\"messageUuid\":\"m1\"}}" >> "$store/$current.jsonl"
      echo "BRANCHED $current FROM $parent"; composer ;;
    "/resume "*)
      current="\${line#/resume }"
      line_json resumed >> "$store/$current.jsonl"
      echo "RESUMED $current"; composer ;;
    /exit) exit 0 ;;
    *)
      if [[ -z "$current" ]]; then
        current="$(uuidgen | tr A-Z a-z)"
        mkdir -p "$store"
        line_json "$line" >> "$store/$current.jsonl"
      fi
      echo "AGENT_GOT: $line"; composer ;;
  esac
done
`

interface AgentTab {
  tabId: string
  projectId: string
  agentId: string
  cwd: string | null
  launchedAt: string | null
  sessionId: string | null
  title: string
  titleSource: string
  unnamed: boolean
  state: string
}
interface Changed {
  tab: AgentTab
  changes: string[]
  session?: { cause: string; previousSessionId: string | null }
}

async function agentsFrame(page: Page): Promise<Frame> {
  const iframe = page.getByTestId('app-frame-pomade-agents').first()
  let frame: Frame | null = null
  await expect
    .poll(async () => {
      frame = (await (await iframe.elementHandle())?.contentFrame()) ?? null
      return frame?.evaluate(() => window.__agents?.status ?? 'loading').catch(() => 'loading') ?? 'no frame'
    })
    .toBe('connected')
  return frame!
}

function callIn(frame: Frame, method: string, params?: unknown): Promise<CallResult> {
  return frame.evaluate(([m, p]) => window.__agents.call(m as string, p), [method, params] as const)
}

async function listed(frame: Frame): Promise<AgentTab[]> {
  const r = await callIn(frame, 'agentTabs.list', {})
  return r.ok ? (r.value as { tabs: AgentTab[] }).tabs : []
}

async function changedEvents(frame: Frame): Promise<Changed[]> {
  return frame.evaluate(() =>
    window.__agents.events.filter((e) => e.name === 'agentTab.changed').map((e) => e.payload as Changed)
  )
}

async function eventsFor(frame: Frame, tabId: string): Promise<string[][]> {
  return (await changedEvents(frame)).filter((e) => e.tab.tabId === tabId).map((e) => e.changes)
}

/** Every session change of a tab, as [the new session, why]. */
async function sessionChangesOf(frame: Frame, tabId: string): Promise<[string | null, Changed['session']][]> {
  return (await changedEvents(frame))
    .filter((e) => e.tab.tabId === tabId && e.changes.includes('session'))
    .map((e) => [e.tab.sessionId, e.session])
}

/** The person types a line into the tab and presses Enter — real keystrokes, the only input that
 *  arms a session binding (a `pty.write` does not). */
async function typeSubmit(page: Page, tabId: string, text: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click()
  await page.getByTestId(`terminal-${tabId}`).click({ position: { x: 60, y: 60 } })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function termOf(page: Page, projectId: string, tabId: string): Promise<string> {
  return (await tabsOf(page, projectId)).find((t) => t.id === tabId)?.termId ?? ''
}

test.describe('E-033 agent tabs API', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let agents: Frame
  let store: string
  let script: string
  let launched: string
  let sessionId: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    script = await seedFakeAgent(fixture, { script: FAKE_AGENT_TABS })
    store = join(fixture.userDataDir, 'agent-store')
    await fs.mkdir(store, { recursive: true })
    app = await launchApp(fixture, { POMADE_DEV_APPS: AGENTS_DIR, FAKE_AGENT_STORE: store })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await setActiveProject(page, fixture.projects.beta)
    await openHelloFromMenu(page, 'pomade-agents')
    agents = await agentsFrame(page)
    // What the agents app answers for the roster: the fixture's folder agent (its own store), and
    // an agent only the app knows, with a mode of its own.
    await agents.evaluate(
      ([s, cmd]) => {
        window.__agents.roster = [
          { id: 'claude-test', name: 'Claude Test', command: 'claude-test', provider: 'claude', configDir: s },
          {
            id: 'app-only',
            name: 'App-only agent',
            command: cmd,
            provider: 'claude',
            configDir: s,
            modes: [
              { id: 'normal', name: 'Normal', args: [] },
              { id: 'plan', name: 'Plan', args: ['--plan'] }
            ]
          }
        ]
      },
      [store, script] as const
    )
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fixture?.cleanup()
  })

  test('launch: an agent with a first prompt in a project; listed with its folder, launch time and bound session', async () => {
    const r = await callIn(agents, 'agentTabs.launch', { agentId: 'claude-test', projectId: fixture.projects.alpha, prompt: 'hello there' })
    expect(r.ok).toBe(true)
    launched = (r.value as { tabId: string }).tabId
    expect(await activeProjectOf(page)).toBe(fixture.projects.alpha)
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(launched)
    const termId = await termOf(page, fixture.projects.alpha, launched)
    await expect.poll(() => readBuffer(page, termId), { timeout: 20_000 }).toContain('AGENT_GOT: hello there')
    const alphaAbs = await fs.realpath(join(fixture.workspaceRoot, 'Projects/alpha'))
    await expect
      .poll(async () => (await listed(agents)).find((t) => t.tabId === launched)?.sessionId ?? null, { timeout: 15_000 })
      .toMatch(/^[0-9a-f-]{36}$/)
    const tab = (await listed(agents)).find((t) => t.tabId === launched)!
    sessionId = tab.sessionId!
    expect(tab).toMatchObject({
      projectId: fixture.projects.alpha,
      agentId: 'claude-test',
      cwd: alphaAbs,
      title: 'Claude Test',
      titleSource: 'default',
      unnamed: false,
      state: 'idle'
    })
    expect(Date.now() - Date.parse(tab.launchedAt!)).toBeLessThan(60_000)
    await fs.access(join(store, 'projects', alphaAbs.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`))
    const changes = await eventsFor(agents, launched)
    expect(changes[0]).toEqual(['opened'])
    expect(changes.some((c) => c.includes('session'))).toBe(true)
  })

  test('live state: working, needs you at a permission prompt, idle — read from the agent\'s output', async () => {
    const termId = await termOf(page, fixture.projects.alpha, launched)
    const stateOf = async (): Promise<string | undefined> => (await listed(agents)).find((t) => t.tabId === launched)?.state
    await writePty(page, termId, '/work\r')
    await expect.poll(stateOf, { timeout: 10_000 }).toBe('working')
    await writePty(page, termId, '/ask\r')
    await expect.poll(stateOf, { timeout: 10_000 }).toBe('needs-you')
    await writePty(page, termId, '/idle\r')
    await expect.poll(stateOf, { timeout: 10_000 }).toBe('idle')
    const states = (await changedEvents(agents)).filter((e) => e.tab.tabId === launched && e.changes.includes('state')).map((e) => e.tab.state)
    expect(states).toEqual(['working', 'needs-you', 'idle'])
  })

  test('titles both ways: the app names the tab, marks it unnamed (italics + dot), and hears the user rename it', async () => {
    const title = page.getByTestId(`tab-title-${launched}`)
    expect(await callIn(agents, 'agentTabs.setTitle', { tabId: launched, title: 'G4 tickets' })).toEqual({ ok: true, value: {} })
    await expect(title).toHaveText('G4 tickets')
    await expect(page.getByTestId(`tab-unnamed-${launched}`)).toHaveCount(0)

    expect(await callIn(agents, 'agentTabs.setTitle', { tabId: launched, title: null })).toEqual({ ok: true, value: {} })
    await expect(title).toHaveText('Claude Test')
    await expect(title).toHaveCSS('font-style', 'italic')
    await expect(page.getByTestId(`tab-unnamed-${launched}`)).toBeVisible()
    await shot(page.getByTestId('tabstrip'), 'agent-tab-unnamed.png')
    expect((await listed(agents)).find((t) => t.tabId === launched)).toMatchObject({ title: 'Claude Test', titleSource: 'default', unnamed: true })

    await title.dblclick()
    const input = page.getByTestId(`tab-rename-input-${launched}`)
    await input.fill('Mine now')
    await input.press('Enter')
    await expect(title).toHaveText('Mine now')
    await expect(title).toHaveCSS('font-style', 'normal')
    await expect(page.getByTestId(`tab-unnamed-${launched}`)).toHaveCount(0)
    await expect
      .poll(async () => (await changedEvents(agents)).filter((e) => e.tab.tabId === launched && e.changes.includes('title')).map((e) => [e.tab.title, e.tab.titleSource, e.tab.unnamed]))
      .toEqual([
        ['G4 tickets', 'app', false],
        ['Claude Test', 'default', true],
        ['Mine now', 'user', false]
      ])
    expect((await callIn(agents, 'agentTabs.setTitle', { tabId: 'nope', title: 'x' })).error?.code).toBe('not-found')
  })

  test('focus: the tab\'s project becomes active and the tab its active tab', async () => {
    await setActiveProject(page, fixture.projects.beta)
    await expect.poll(() => activeProjectOf(page)).toBe(fixture.projects.beta)
    expect((await callIn(agents, 'agentTabs.focus', { tabId: launched })).ok).toBe(true)
    expect(await activeProjectOf(page)).toBe(fixture.projects.alpha)
    expect(await activeTabOf(page, fixture.projects.alpha)).toBe(launched)
  })

  test('every terminal knows its tab and project: POMADE_TAB_ID and POMADE_PROJECT_ID in the agent\'s session and in a plain shell', async () => {
    const agentTerm = await termOf(page, fixture.projects.alpha, launched)
    await writePty(page, agentTerm, '/tabid\r')
    await expect.poll(() => readBuffer(page, agentTerm)).toContain(`TABID=${launched} PROJECTID=${fixture.projects.alpha}`)
    await page.evaluate(async (pid) => {
      const s = window.__pomadeStores
      await s.useTerminalsStore.getState().newTerminal(s.useWorkspaceStore.getState().projectById(pid))
    }, fixture.projects.alpha)
    const shell = (await tabsOf(page, fixture.projects.alpha)).find((t) => t.kind === 'terminal')!
    await expect.poll(() => readBuffer(page, shell.termId!), { timeout: 15_000 }).not.toBe('')
    await writePty(page, shell.termId!, 'echo "SHELL_TAB=$POMADE_TAB_ID SHELL_PROJECT=$POMADE_PROJECT_ID"\r')
    await expect
      .poll(() => readBuffer(page, shell.termId!), { timeout: 10_000 })
      .toContain(`SHELL_TAB=${shell.id} SHELL_PROJECT=${fixture.projects.alpha}`)
    // The Workspace project's terminals name its id.
    await page.evaluate(async () => {
      const s = window.__pomadeStores
      await s.useTerminalsStore.getState().newTerminal(s.useWorkspaceStore.getState().projectById('__workspace__'))
    })
    const wsShell = (await tabsOf(page, '__workspace__')).find((t) => t.kind === 'terminal')!
    await expect.poll(() => readBuffer(page, wsShell.termId!), { timeout: 15_000 }).not.toBe('')
    await writePty(page, wsShell.termId!, 'echo "WS_PROJECT=$POMADE_PROJECT_ID"\r')
    await expect.poll(() => readBuffer(page, wsShell.termId!), { timeout: 10_000 }).toContain('WS_PROJECT=__workspace__')
    // A plain terminal is no agent tab.
    expect((await listed(agents)).map((t) => t.tabId)).toEqual([launched])
  })

  test('a session change says why: /clear, /branch (a fork, with its parent), an in-session /resume', async () => {
    await setActiveProject(page, fixture.projects.alpha)
    const termId = await termOf(page, fixture.projects.alpha, launched)
    const sessionOf = async (): Promise<string | null> => (await listed(agents)).find((t) => t.tabId === launched)?.sessionId ?? null

    await typeSubmit(page, launched, '/clear')
    await expect.poll(() => readBuffer(page, termId), { timeout: 10_000 }).toMatch(/CLEARED [0-9a-f-]{36}/)
    const cleared = /CLEARED ([0-9a-f-]{36})/.exec(await readBuffer(page, termId))![1]
    await typeSubmit(page, launched, 'first prompt after the clear')
    await expect.poll(sessionOf, { timeout: 15_000 }).toBe(cleared)

    await typeSubmit(page, launched, '/branch')
    await expect.poll(() => readBuffer(page, termId), { timeout: 10_000 }).toMatch(/BRANCHED [0-9a-f-]{36}/)
    const branched = /BRANCHED ([0-9a-f-]{36})/.exec(await readBuffer(page, termId))![1]
    await typeSubmit(page, launched, 'first prompt of the branch')
    await expect.poll(sessionOf, { timeout: 15_000 }).toBe(branched)

    await typeSubmit(page, launched, `/resume ${sessionId}`)
    await expect.poll(sessionOf, { timeout: 15_000 }).toBe(sessionId)

    // The launch's first prompt bound the first session; each command after it says why.
    expect(await sessionChangesOf(agents, launched)).toEqual([
      [sessionId, { cause: 'first', previousSessionId: null }],
      [cleared, { cause: 'clear', previousSessionId: sessionId }],
      [branched, { cause: 'fork', previousSessionId: cleared }],
      [sessionId, { cause: 'resume', previousSessionId: branched }]
    ])
    // A change without `session` carries no `session` part.
    expect((await changedEvents(agents)).filter((e) => !e.changes.includes('session') && e.session !== undefined)).toEqual([])
  })

  test('resume: a closed session reopens in a new tab; resuming a session a live tab holds focuses it', async () => {
    await page.evaluate(
      ([pid, tid]) => window.__pomadeStores.useTabsStore.getState().closeTab(pid, tid),
      [fixture.projects.alpha, launched] as const
    )
    await expect.poll(() => listed(agents)).toEqual([])
    await expect.poll(() => eventsFor(agents, launched).then((c) => c.at(-1))).toEqual(['closed'])

    const r = await callIn(agents, 'agentTabs.resume', { agentId: 'claude-test', sessionId, projectId: fixture.projects.alpha })
    expect(r.ok).toBe(true)
    const resumed = (r.value as { tabId: string }).tabId
    expect(resumed).not.toBe(launched)
    const termId = await termOf(page, fixture.projects.alpha, resumed)
    await expect.poll(() => readBuffer(page, termId), { timeout: 20_000 }).toContain(`RESUMED ${sessionId}`)
    await expect.poll(async () => (await listed(agents)).map((t) => [t.tabId, t.sessionId])).toEqual([[resumed, sessionId]])

    const again = await callIn(agents, 'agentTabs.resume', { agentId: 'claude-test', sessionId, projectId: fixture.projects.alpha })
    expect(again).toEqual({ ok: true, value: { tabId: resumed } })
    expect((await tabsOf(page, fixture.projects.alpha)).filter((t) => t.kind === 'agent')).toHaveLength(1)

    const missing = await callIn(agents, 'agentTabs.resume', { agentId: 'claude-test', sessionId: 'no-such-session', projectId: fixture.projects.alpha })
    expect(missing.error?.code).toBe('not-found')
    expect((await callIn(agents, 'agentTabs.launch', { agentId: 'ghost' })).error?.code).toBe('not-found')
    expect((await callIn(agents, 'agentTabs.launch', { agentId: 'claude-test', mode: 'turbo' })).error?.code).toBe('invalid-params')
    expect((await callIn(agents, 'agentTabs.launch', { agentId: 'claude-test', cwd: 'Projects/missing' })).error?.code).toBe('not-found')
  })

  test('a mode the app\'s roster gives is launched with its args', async () => {
    const r = await callIn(agents, 'agentTabs.launch', { agentId: 'app-only', projectId: fixture.projects.beta, mode: 'plan' })
    expect(r.ok).toBe(true)
    const tabId = (r.value as { tabId: string }).tabId
    const tab = (await tabsOf(page, fixture.projects.beta)).find((t) => t.id === tabId)!
    expect(tab.lastCommand).toBe(`${script} --plan`)
    await expect.poll(() => readBuffer(page, tab.termId!), { timeout: 20_000 }).toContain('AGENT_READY')
  })

  test('the "+" menu lists the app\'s roster; the Session history button opens the app\'s Sessions view', async () => {
    await page.getByTestId('tab-add').click()
    await expect(page.getByTestId('tab-add-agent-app-only')).toHaveText('App-only agent')
    await expect(page.getByTestId('tab-add-agent-claude-test')).toHaveText('Claude Test')
    await expect(page.getByTestId('tab-add-agent-claude')).toHaveCount(0)
    await shot(page.getByTestId('tab-add-menu'), 'plus-menu-app-roster.png')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tab-add-menu')).toHaveCount(0)

    await page.getByTestId('session-history-open').click()
    await expect(page.getByTestId('session-history')).toHaveCount(0)
    const project = await activeProjectOf(page)
    await expect
      .poll(async () => (await tabsOf(page, project)).filter((t) => t.kind === 'app').map((t) => (t as { route?: string }).route))
      .toEqual(['sessions'])
    await expect(agents.locator('#route')).toHaveText('Route: "sessions"')
    await shot(page, 'agents-app-sessions.png')
  })

  test('an agents app that stops answering: the "+" menu falls back to Pomade\'s own scan', async () => {
    await agents.evaluate(() => {
      window.__agents.silent = true
    })
    await page.getByTestId('tab-add').click()
    await expect(page.getByTestId('tab-add-agent-claude')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('tab-add-agent-codex')).toBeVisible()
    await expect(page.getByTestId('tab-add-agent-app-only')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})
