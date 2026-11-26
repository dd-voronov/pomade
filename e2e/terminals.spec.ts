// modules: terminal, tabs
// Pomade Wave 2b e2e — terminals, agents, bulk actions, and dead-tab restore.
// Drives the real Electron app: PTYs live in main and are exercised via window.pomade.pty
// (buffer/write) so assertions read the authoritative ring buffer rather than xterm's canvas.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { readBuffer, writePty, writeWhenReady } from './fixtures/stores'
import { FAKE_AGENT_ECHO_EXIT_ANNOUNCE, seedFakeAgent } from './fixtures/fake-agent'
import { expectQuiet } from './fixtures/timing'

/** The persisted per-project tab state on disk (empty string until the first write lands). */
function persistedState(fixture: Fixture, projectId: string): Promise<string> {
  return fs
    .readFile(join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`), 'utf8')
    .catch(() => '')
}



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

interface TabSnapshot {
  id: string
  kind: string
  title: string
  agentId?: string
}

// Read a terminal tab's metadata straight from the tabs-store (via the __pomadeStores
// e2e hook) — the UI has no per-tab kind/agent affordances to assert against yet.
function tabByTermId(page: Page, projectId: string, termId: string): Promise<TabSnapshot | null> {
  return page.evaluate(
    ({ pid, tid }) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
      const tab = tabs.find((t) => t.termId === tid)
      if (!tab) return null
      return { id: tab.id, kind: tab.kind, title: tab.title, agentId: tab.agentId }
    },
    { pid: projectId, tid: termId }
  )
}

// T-114 — a tab's status by TAB id. After a revive the termId has been swapped, so the restored
// tab can no longer be found by the termId the previous run left behind.
function tabStatusById(page: Page, projectId: string, tabId: string): Promise<string> {
  return page.evaluate(
    ({ pid, tid }) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
      return tabs.find((t) => t.id === tid)?.status ?? 'missing'
    },
    { pid: projectId, tid: tabId }
  )
}

test.describe('terminals & agents', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT_ANNOUNCE })
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // T-023: dead-on-open regression guard. Runs FIRST — right after app startup — and mixes
  // paced UI opens with a same-window store burst (which defeats any UI pacing and lands
  // inside the liveness-cache window that caused the original bug).
  test('rapid fresh opens right after startup are always live', async () => {
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    for (let i = 0; i < 3; i++) {
      await page.getByTestId('tab-add').click()
      await page.getByTestId('tab-add-terminal').click()
    }
    await page.evaluate(async (pid) => {
      const stores = window.__pomadeStores
      const project = stores.useWorkspaceStore.getState().projectById(pid)
      const terminals = stores.useTerminalsStore.getState()
      await Promise.all([terminals.newTerminal(project), terminals.newTerminal(project)])
    }, alpha)

    // All five panes are live now…
    await expect(page.locator('[data-term-id][data-status="live"]')).toHaveCount(5)
    await expect(page.locator('[data-testid^="terminal-dead-"]')).toHaveCount(0)
    // …and stay live throughout the window any deferred reconcile would fire in (real-world
    // React effect timing, not interval-derived).
    await expectQuiet(async () => {
      await expect(page.locator('[data-term-id][data-status="live"]')).toHaveCount(5)
      await expect(page.locator('[data-testid^="terminal-dead-"]')).toHaveCount(0)
    }, 1000)
  })

  // E-005 user-test round 1 (T-023, real root cause): React StrictMode in DEV builds
  // mounts every component, simulates an unmount (running effect cleanups), then mounts it
  // again. TerminalPane's unmount cleanup used to kill the PTY — so in `npm run dev` EVERY
  // fresh terminal/agent died instantly (relaunch survived: no StrictMode re-mount on dep
  // change). Production React never double-invokes, which is why the e2e suite stayed
  // green. This spec forces the same unmount+remount in the prod build by swapping the
  // tab's id (= the pane's React key) while keeping the termId: a pane is a VIEW — its
  // unmount must never kill the PTY.
  test('a pane unmount+remount of the same tab must not kill its PTY', async () => {
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()
    const termId = await openTerminal(page)
    await writeWhenReady(page, termId, 'echo REMOUNT_BEFORE\r')
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain('REMOUNT_BEFORE')

    await page.evaluate(
      ({ pid, tid }) => {
        const tabsStore = window.__pomadeStores.useTabsStore.getState()
        const tab = tabsStore.tabsByProject[pid].find((t) => t.termId === tid)!
        tabsStore.updateTab(pid, tab.id, { id: `${tab.id}-remounted` })
        tabsStore.setActive(pid, `${tab.id}-remounted`)
      },
      { pid: alpha, tid: termId }
    )

    // A wrongly-fired kill would land inside this real-world window (effect cleanup timing) —
    // the PTY survives the remount throughout.
    await expectQuiet(async () => {
      await expect(page.locator(`[data-term-id="${termId}"]`)).toHaveAttribute('data-status', 'live')
    }, 1500)
    const list = await page.evaluate(() => window.pomade.pty.list())
    // T-044: pty.list() entries now also carry a `busy` flag — match the fields we care about.
    expect(list).toContainEqual(expect.objectContaining({ termId, alive: true }))

    // Still the same interactive shell, scrollback intact.
    await writePty(page, termId, 'echo REMOUNT_AFTER\r')
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain('REMOUNT_AFTER')
  })

  test('new terminal opens interactive zsh at the project root', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const termId = await openTerminal(page)
    await writeWhenReady(page, termId, 'echo PWDMARK $(pwd)\r')
    const alphaPath = join(fixture.workspaceRoot, 'Projects/alpha')
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain(`PWDMARK ${alphaPath}`)
  })

  test('keeps running with scrollback intact while hidden on a project switch', async () => {
    const { alpha, beta } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    // A ticking loop that emits an ever-increasing counter.
    const termId = await openTerminal(page)
    const paneMountId = await page
      .locator(`[data-term-id="${termId}"]`)
      .getAttribute('data-mount-id')
    await writeWhenReady(
      page,
      termId,
      'n=0; while true; do n=$((n+1)); echo TICK_$n; sleep 0.4; done\r'
    )

    const maxTick = (buf: string): number =>
      [...buf.matchAll(/TICK_(\d+)/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0)

    await expect.poll(() => readBuffer(page, termId).then(maxTick), { timeout: 10_000 }).toBeGreaterThan(1)
    const before = maxTick(await readBuffer(page, termId))

    // Switch away — Alpha's pane is hidden (display:none), never unmounted.
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.locator(`[data-term-id="${termId}"]`)).toHaveCount(1) // still mounted
    // Output continues while hidden — poll for a LATER tick instead of sleeping a fixed 2s.
    await expect
      .poll(() => readBuffer(page, termId).then(maxTick), { timeout: 15_000 })
      .toBeGreaterThan(before)

    // Switch back: output continued while hidden AND early output is still in scrollback.
    await page.getByTestId(`project-${alpha}`).click()
    await expect(page.locator(`[data-term-id="${termId}"]`)).toHaveAttribute(
      'data-mount-id',
      paneMountId ?? ''
    ) // same xterm instance
    const after = await readBuffer(page, termId)
    expect(maxTick(after)).toBeGreaterThan(before) // appended while hidden
    expect(after).toContain('TICK_1') // scrollback intact
  })

  test('starts a fake agent, bulk-stops terminals, and exits agents', async () => {
    const { beta } = fixture.projects
    await page.getByTestId(`project-${beta}`).click()

    // Start the stand-in agent.
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    const agentTermId = await visibleTermId(page)
    await expect.poll(() => readBuffer(page, agentTermId), { timeout: 10_000 }).toContain('AGENT_READY')

    // Prove it's a live, interactive process.
    await writePty(page, agentTermId, 'hello\r')
    await expect
      .poll(() => readBuffer(page, agentTermId), { timeout: 10_000 })
      .toContain('AGENT_GOT: hello')

    // Add a plain terminal, then bulk-stop plain terminals only.
    const plainTermId = await openTerminal(page)
    await expect(page.locator(`[data-term-id="${plainTermId}"]`)).toHaveCount(1)

    await page.getByTestId('bulk-actions').click()
    await page.getByTestId('bulk-stop-terminals').click()
    await expect(page.locator(`[data-term-id="${plainTermId}"]`)).toHaveCount(0) // plain gone
    await expect(page.locator(`[data-term-id="${agentTermId}"]`)).toHaveCount(1) // agent stays

    // Exit all agents: /exit is typed, the process ends, and the tab closes.
    await page.getByTestId('bulk-actions').click()
    await page.getByTestId('bulk-exit-agents').click()
    await expect(page.locator(`[data-term-id="${agentTermId}"]`)).toHaveCount(0, { timeout: 10_000 })
  })

  // T-024: /exit ends the agent CLI but the pty (zsh) lives on — the tab must stop
  // claiming to be an agent, in the UI and in the persisted state file.
  test('after /exit the agent tab downgrades to a plain terminal', async () => {
    const { beta } = fixture.projects
    await page.getByTestId(`project-${beta}`).click()

    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    const termId = await visibleTermId(page)
    await expect.poll(() => readBuffer(page, termId), { timeout: 10_000 }).toContain('AGENT_READY')
    expect((await tabByTermId(page, beta, termId))?.kind).toBe('agent')

    await writePty(page, termId, '/exit\r')
    await expect.poll(() => readBuffer(page, termId), { timeout: 10_000 }).toContain('AGENT_EXITING')

    // The foreground-process watcher notices the CLI ended → kind + auto-title flip.
    await expect
      .poll(async () => (await tabByTermId(page, beta, termId))?.kind, { timeout: 15_000 })
      .toBe('terminal')
    const tab = await tabByTermId(page, beta, termId)
    expect(tab?.title).toMatch(/^zsh \d+$/)
    expect(tab?.agentId).toBeUndefined()

    // Same pane, same PTY — still a live, usable shell.
    await expect(page.locator(`[data-term-id="${termId}"]`)).toHaveAttribute('data-status', 'live')
    await writePty(page, termId, 'echo BACK_TO_SHELL_MARK\r')
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain('BACK_TO_SHELL_MARK')

    // The persisted state file reflects reality (debounced renderer + main writes).
    const stateFile = join(fixture.workspaceRoot, '.pomade', 'state', `${beta}.json`)
    await expect
      .poll(
        async () => {
          try {
            const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
              openTabs: { kind: string; termId?: string; agentId?: string }[]
            }
            const t = state.openTabs.find((x) => x.termId === termId)
            return t ? `${t.kind}:${t.agentId ?? 'none'}` : 'missing'
          } catch {
            return 'unreadable'
          }
        },
        { timeout: 10_000 }
      )
      .toBe('terminal:none')
  })

  // T-024, both ways (user-test round 1): after /exit downgraded the tab, typing a roster
  // agent command into that same shell must upgrade it back — kind, agentId, title. And
  // the cycle must be repeatable (the original marker-counting died after one /exit).
  test('typing a roster agent command upgrades the tab back to an agent', async () => {
    const { beta } = fixture.projects
    await page.getByTestId(`project-${beta}`).click()

    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    const termId = await visibleTermId(page)
    await expect.poll(() => readBuffer(page, termId), { timeout: 10_000 }).toContain('AGENT_READY')

    // Downgrade: /exit → plain terminal.
    await writePty(page, termId, '/exit\r')
    await expect
      .poll(async () => (await tabByTermId(page, beta, termId))?.kind, { timeout: 15_000 })
      .toBe('terminal')

    // Upgrade: type the agent's roster command into the SAME (still shimmed) shell. The downgrade
    // above is driven by the shell's prompt marker, so the shell is already at a fresh prompt.
    const scriptPath = join(fixture.workspaceRoot, 'fake-agent.sh')
    await writePty(page, termId, `${scriptPath}\r`)
    await expect
      .poll(async () => (await tabByTermId(page, beta, termId))?.kind, { timeout: 15_000 })
      .toBe('agent')
    const upgraded = await tabByTermId(page, beta, termId)
    expect(upgraded?.agentId).toBe('claude-test')
    expect(upgraded?.title).toBe('claude-test')

    // Downgrade AGAIN — the exec/prompt pairing keeps working across cycles.
    await writePty(page, termId, '/exit\r')
    await expect
      .poll(async () => (await tabByTermId(page, beta, termId))?.kind, { timeout: 15_000 })
      .toBe('terminal')

    // A user rename survives the upgrade: title kept, kind/agentId still updated.
    const tabId = (await tabByTermId(page, beta, termId))?.id
    await page.evaluate(
      ({ pid, tid }) => {
        ;window.__pomadeStores.useTabsStore
          .getState()
          .updateTab(pid, tid, { title: 'my workhorse', renamed: true })
      },
      { pid: beta, tid: tabId }
    )
    await writePty(page, termId, `${scriptPath}\r`)
    await expect
      .poll(async () => (await tabByTermId(page, beta, termId))?.kind, { timeout: 15_000 })
      .toBe('agent')
    expect((await tabByTermId(page, beta, termId))?.title).toBe('my workhorse')
  })

  test('a user-renamed agent tab keeps its custom title after /exit', async () => {
    const { beta } = fixture.projects
    await page.getByTestId(`project-${beta}`).click()

    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    const termId = await visibleTermId(page)
    await expect.poll(() => readBuffer(page, termId), { timeout: 10_000 }).toContain('AGENT_READY')

    // Simulate a user rename through the store (T-021's UI isn't built yet).
    const tabId = (await tabByTermId(page, beta, termId))?.id
    expect(tabId).toBeTruthy()
    await page.evaluate(
      ({ pid, tid }) => {
        ;window.__pomadeStores.useTabsStore
          .getState()
          .updateTab(pid, tid, { title: 'my pet agent', renamed: true })
      },
      { pid: beta, tid: tabId }
    )

    await writePty(page, termId, '/exit\r')
    await expect
      .poll(async () => (await tabByTermId(page, beta, termId))?.kind, { timeout: 15_000 })
      .toBe('terminal')

    expect((await tabByTermId(page, beta, termId))?.title).toBe('my pet agent')
    await expect(page.getByTestId(`tab-${tabId}`)).toContainText('my pet agent')
  })
})

// ─── T-025: env sanitization — children must not inherit the launching IDE ────────
test.describe('pty env sanitization', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // Pretend Pomade itself was started from a VS Code terminal INSIDE a claude session —
    // the Owner's real `npm run dev` environment (user-test round 1). Every var below was
    // observed leaking on the actual machine.
    app = await launchApp(fixture, {
      TERM_PROGRAM: 'vscode',
        TERM_PROGRAM_VERSION: '1.90.0',
        VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git-fake.sock',
        VSCODE_INJECTION: '1',
        GIT_ASKPASS:
          '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass.sh',
        // Parent claude-session identity: without stripping these, `claude` in a Pomade pty
        // auto-connects to the VS Code extension (SSE port) and/or thinks it's a child session.
        CLAUDE_CODE_SSE_PORT: '28043',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 'fake-parent-session',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_EFFORT: 'high',
        AI_AGENT: 'claude-code_fake_agent',
        GIT_EDITOR: 'true',
        USER_ZDOTDIR: '/Users/fake',
        __CFBundleIdentifier: 'com.microsoft.VSCode',
        // Legit user exports must SURVIVE sanitization.
        ANTHROPIC_API_KEY: 'sk-ant-fake-e2e',
        CLAUDE_CONFIG_DIR: '/tmp/fake-claude-config'
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // P-018: the pty masquerades as Apple_Terminal (so agent CLIs' `auto` notification
  // channel bells at turn end) while POMADE=1 keeps the real host identity detectable.
  test('a pty child sees TERM_PROGRAM=Apple_Terminal + POMADE=1 and no VS Code leakage', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const termId = await openTerminal(page)
    await writeWhenReady(
      page,
      termId,
      'echo IDE_CHECK ${TERM_PROGRAM:-unset} ${POMADE:-unset} ${VSCODE_GIT_IPC_HANDLE:-unset} ${VSCODE_INJECTION:-unset} ${GIT_ASKPASS:-unset} ${ELECTRON_RUN_AS_NODE:-unset}\r'
    )
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain('IDE_CHECK Apple_Terminal 1 unset unset unset unset')
  })

  test('a pty child sees no parent-claude-session leakage, but keeps user exports', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const termId = await openTerminal(page)
    await writeWhenReady(
      page,
      termId,
      'echo CLAUDE_CHECK ${CLAUDE_CODE_SSE_PORT:-unset} ${CLAUDECODE:-unset} ' +
        '${CLAUDE_CODE_ENTRYPOINT:-unset} ${CLAUDE_CODE_SESSION_ID:-unset} ' +
        '${CLAUDE_CODE_CHILD_SESSION:-unset} ${CLAUDE_EFFORT:-unset} ${AI_AGENT:-unset} ' +
        '${__CFBundleIdentifier:-unset} ${USER_ZDOTDIR:-unset}\r'
    )
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain('CLAUDE_CHECK unset unset unset unset unset unset unset unset unset')

    // GIT_EDITOR=true (claude's no-op editor) is dropped; user auth/config vars survive.
    await writePty(
      page,
      termId,
      'echo KEEP_CHECK ${GIT_EDITOR:-unset} ${ANTHROPIC_API_KEY:-missing} ${CLAUDE_CONFIG_DIR:-missing}\r'
    )
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain('KEEP_CHECK unset sk-ant-fake-e2e /tmp/fake-claude-config')
  })
})

// T-114 (E-022) — DELIBERATE BEHAVIOUR CHANGE, this describe rewritten for it. A tab restored
// with persisted `status: 'live'` no longer reconciles to a dead pane: opening its project REVIVES
// it (terminal → fresh shell at its last known cwd; agent WITH a captured session id → the
// provider's resume command). The dead pane is still where an agent with NO session id lands —
// which is what these two tests now assert, alongside the T-023 fresh-open guard. The full
// per-outcome matrix (persisted-dead tab, resume command, cwd, sticky payloads) lives in
// `e2e/revive.spec.ts`.
test.describe('tab restore after restart: revive, and the dead pane that remains', () => {
  let fixture: Fixture

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT_ANNOUNCE })
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('a restored terminal tab revives into a live shell when its project is opened', async () => {
    // Two full Electron relaunches back-to-back: legitimately slow, and it occasionally brushed
    // the 30s default under full-suite load (transient timeout, not a logic failure). Triple the
    // budget for this test so the launch cost never trips it.
    test.slow()
    const { alpha } = fixture.projects

    // Session 1: open a terminal in Alpha, let its tab state persist, then quit.
    const app1 = await launchApp(fixture)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await page1.getByTestId(`project-${alpha}`).click()
    await page1.getByTestId('tab-add').click()
    await page1.getByTestId('tab-add-terminal').click()
    const oldTermId = await visibleTermId(page1)
    // The (tuned) debounced state write must land before quitting — poll the file itself.
    await expect
      .poll(() => persistedState(fixture, alpha), { timeout: 15_000 })
      .toContain(oldTermId)
    await app1.close()

    // Session 2: opening Alpha revives the tab in place — a fresh PTY under a NEW termId, no
    // dead pane and no button to click (T-114). The old termId is gone with the old process.
    const app2 = await launchApp(fixture)
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await page2.getByTestId(`project-${alpha}`).click()

    await expect(page2.locator('[data-term-id][data-status="live"]:visible')).toHaveCount(1, {
      timeout: 15_000
    })
    await expect(page2.locator(`[data-term-id="${oldTermId}"]`)).toHaveCount(0)
    await expect(page2.locator('[data-testid^="terminal-dead-"]')).toHaveCount(0)

    // …and it is a real, usable interactive shell, not just a live-looking pane.
    const newTermId = await visibleTermId(page2)
    await writeWhenReady(page2, newTermId, 'echo REVIVED_MARK\r')
    await expect
      .poll(() => readBuffer(page2, newTermId), { timeout: 10_000 })
      .toContain('REVIVED_MARK')
    await app2.close()
  })

  // E-005 user-test round 1 (the Owner's exact repro): quit → relaunch → every NEWLY created
  // terminal/agent must still open live, even when created immediately after startup while the
  // restored tabs' reconcile and its 400ms liveness cache are still in flight. T-114 changes what
  // the restored tabs themselves do: the terminal revives, while the agent — a fresh-started
  // session with no captured id — is still the dead pane (grooming decision: auto-starting a fresh
  // agent would look resumed with empty context), and its Relaunch still works.
  test('with a restored dead agent tab present, brand-new terminals and agents open live', async () => {
    test.slow()
    const { alpha } = fixture.projects

    // Session 1: persist a terminal AND an agent tab, then quit.
    const app1 = await launchApp(fixture)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await page1.getByTestId(`project-${alpha}`).click()
    await page1.getByTestId('tab-add').click()
    await page1.getByTestId('tab-add-terminal').click()
    const plainTerm1 = await visibleTermId(page1)
    const plainTab1 = (await tabByTermId(page1, alpha, plainTerm1))?.id ?? ''
    await page1.getByTestId('tab-add').click()
    await page1.getByTestId('tab-add-agent-claude-test').click()
    const agentTerm1 = await visibleTermId(page1)
    const agentTab1 = (await tabByTermId(page1, alpha, agentTerm1))?.id ?? ''
    expect(plainTab1).not.toBe('')
    expect(agentTab1).not.toBe('')
    await expect
      .poll(() => readBuffer(page1, agentTerm1), { timeout: 10_000 })
      .toContain('AGENT_READY')
    // The (tuned) debounced state write must land before quitting — poll the file itself.
    await expect
      .poll(() => persistedState(fixture, alpha), { timeout: 15_000 })
      .toContain(agentTab1)
    await app1.close()

    // Session 2: immediately after startup, create a fresh terminal + a fresh agent
    // (an "agent never opened before" also failed in the field) amid the restored tabs.
    const app2 = await launchApp(fixture)
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await page2.getByTestId(`project-${alpha}`).click()

    await page2.getByTestId('tab-add').click()
    await page2.getByTestId('tab-add-terminal').click()
    const freshTerm = await visibleTermId(page2)
    await page2.getByTestId('tab-add').click()
    await page2.getByTestId('tab-add-agent-claude-test').click()
    const freshAgent = await visibleTermId(page2)

    // Restored terminal: REVIVED (live, new termId). Restored agent (no session id): dead.
    await expect
      .poll(async () => await tabStatusById(page2, alpha, plainTab1), { timeout: 15_000 })
      .toBe('live')
    await expect(page2.locator(`[data-term-id="${plainTerm1}"]`)).toHaveCount(0)
    await expect
      .poll(async () => await tabStatusById(page2, alpha, agentTab1), { timeout: 15_000 })
      .toBe('dead')
    await expect(page2.getByTestId(`terminal-dead-${agentTab1}`)).toHaveCount(1)

    // Fresh tabs: live, now and after reconcile settles.
    await expect(page2.locator(`[data-term-id="${freshTerm}"]`)).toHaveAttribute(
      'data-status',
      'live'
    )
    await expect(page2.locator(`[data-term-id="${freshAgent}"]`)).toHaveAttribute(
      'data-status',
      'live'
    )
    await expect
      .poll(() => readBuffer(page2, freshAgent), { timeout: 10_000 })
      .toContain('AGENT_READY')
    // Real-world window (late reconcile/kill would fire within it) — both stay live throughout.
    await expectQuiet(async () => {
      await expect(page2.locator(`[data-term-id="${freshTerm}"]`)).toHaveAttribute(
        'data-status',
        'live'
      )
    }, 1200)
    await expect(page2.locator(`[data-term-id="${freshAgent}"]`)).toHaveAttribute(
      'data-status',
      'live'
    )

    // The dead pane's Relaunch still spins a fresh live PTY in place (unchanged by T-114).
    await page2.getByTestId(`tab-${agentTab1}`).click()
    await page2.getByTestId(`relaunch-${agentTab1}`).click()
    await expect
      .poll(async () => await tabStatusById(page2, alpha, agentTab1), { timeout: 15_000 })
      .toBe('live')
    await app2.close()
  })
})
