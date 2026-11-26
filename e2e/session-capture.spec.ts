// modules: core, projects, tabs, terminal, agents
// Pomade e2e — session-id capture. Built by T-113 (E-022), REWORKED by E-025 into prompt-gated,
// tab-owned attribution: main's session watcher (src/main/session-watcher.ts) no longer
// attributes transcripts by pty-output recency — it binds an id ONLY inside a bounded,
// bidirectional ±window opened by a FIRST-PROMPT SUBMIT in a specific tab (real keystrokes:
// xterm onKey Enter on a non-empty line — the genuine-input path, T-123). A transcript appearing
// with no window open belongs to nobody Pomade can identify and is deliberately ignored.
//
// The stores are ISOLATED per fixture — a folder agent's configDir is `<workspace>/Agents/<name>/`
// and the codex describe redirects the store with CODEX_HOME. The real ~/.claude and ~/.codex are
// never read or written by these specs.
//
// A transcript is normally written by the agent CLI itself ~0.6–0.9s after the first submission;
// our stand-in CLI doesn't write fresh ones, so the SPEC writes real-shape files into the
// isolated store around the (typed, submitted) prompt — which is exactly the disk event a bind
// window must confirm. Prompts are typed with REAL keyboard events into the focused pane: the
// submit signal rides xterm.onKey, and `pty.write` (which bypasses xterm) must never open a
// window — one spec pins that negative.
//
// State chains WITHIN each describe (one app, one window) — tests append, never insert mid-file.

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
import { readBuffer, writePty } from './fixtures/stores'
import { FAKE_AGENT_RESUME, seedFakeAgentScript } from './fixtures/fake-agent'
import { expectQuiet, quietWindow, TEST_POLL_MS } from './fixtures/timing'

// A stand-in agent CLI (E-025 harness v2): announces readiness, then echoes every submitted
// line. `--resume <id>` APPENDS a real line to `<id>.jsonl` in the isolated store (keyed by the
// CLI's own $PWD, exactly like claude) and emits an output burst — the T-127 acceptance shape,
// so a concurrent revive makes BOTH transcripts grow across the same ticks. `/exit` prints the
// farewell line (with the resume hint) and exits, handing the shell back — the process-lifecycle
// session-end signal. The store root comes from FAKE_AGENT_STORE (set per app launch); without
// it the resume write is skipped (the command-line echo still backs the `--resume` assertions).

/** Claude Code's own cwd encoding (mirror of agent-service.encodeCwd). */
function encodeCwd(abs: string): string {
  return abs.replace(/[^a-zA-Z0-9]/g, '-')
}



/** The cwd the SHELL reports (T-086 prompt marker) — which is the cwd the watcher keyed its store
 *  on, and the one a real agent CLI would encode. On macOS that is the PHYSICAL path
 *  (`/private/var/folders/…` for a `/var/folders/…` tmpdir), so a spec must ask rather than guess. */
function ptyCwd(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.cwd(tid), termId)
}

/** E-025 — the PHYSICAL launch cwd: what a real CLI encodes into its store key. The shim's
 *  prompt marker reports zsh's LOGICAL $PWD (symlinks preserved — `/var/...` for a macOS
 *  tmpdir), but claude/codex key their stores on the physical process.cwd(), and main now
 *  canonicalizes the launch cwd the same way — so every store a spec writes must be keyed on
 *  the realpath. */
async function physCwd(page: Page, termId: string): Promise<string> {
  const cwd = await ptyCwd(page, termId)
  return cwd ? fs.realpath(cwd) : cwd
}

interface TabSnap {
  id: string
  kind: string
  status: string
  termId: string
  resumeSessionId?: string
  lastCommand?: string
  // E-025 — the persisted triple's other two legs.
  cwdAtLaunch?: string
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
      cwdAtLaunch: t.cwdAtLaunch,
      bindState: t.bindState
    }))
  }, projectId) as Promise<TabSnap[]>
}

async function snapOf(page: Page, projectId: string, tabId: string): Promise<TabSnap | undefined> {
  return (await tabSnaps(page, projectId)).find((t) => t.id === tabId)
}

async function resumeIdOf(page: Page, projectId: string, tabId: string): Promise<string> {
  return (await snapOf(page, projectId, tabId))?.resumeSessionId ?? ''
}

/** `resumeSessionId` as it landed on disk — the field only survives a reload if it persisted. */
async function persistedResumeId(
  fixture: Fixture,
  projectId: string,
  tabId: string
): Promise<string> {
  try {
    const raw = await fs.readFile(
      join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`),
      'utf8'
    )
    const state = JSON.parse(raw) as { openTabs?: { id: string; resumeSessionId?: string }[] }
    return state.openTabs?.find((t) => t.id === tabId)?.resumeSessionId ?? ''
  } catch {
    return ''
  }
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
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
  ]
  await fs.writeFile(join(storeDir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
}

/** Write a claude transcript of the given records (a branch's copied lines, a background copy's). */
async function writeClaudeLines(storeDir: string, sessionId: string, records: Record<string, unknown>[]): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true })
  await fs.writeFile(join(storeDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

/** Write a real-shape codex rollout: `session_meta` on line 0 carries the id AND the cwd, which
 *  is the ONLY attribution key for codex (its paths are date-nested, not cwd-keyed). */
async function writeCodexSession(
  sessionsRoot: string,
  sessionId: string,
  cwd: string,
  day = '18'
): Promise<void> {
  const dir = join(sessionsRoot, '2026', '08', day)
  await fs.mkdir(dir, { recursive: true })
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { session_id: sessionId, cwd, timestamp: new Date().toISOString() }
    }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } })
  ]
  await fs.writeFile(join(dir, `rollout-${sessionId}.jsonl`), lines.join('\n') + '\n')
}

async function waitForOutput(page: Page, termId: string): Promise<void> {
  await expect
    .poll(() => readBuffer(page, termId).then((b) => b.length), { timeout: 15_000 })
    .toBeGreaterThan(0)
}

/** E-025 — a REAL first-prompt submit: activate the tab, focus its pane (the click focuses
 *  xterm) and type the prompt with genuine keyboard events + Enter. This is the ONLY input path
 *  that opens a bind window — the keystrokes ride xterm.onKey into `terminals-store.handleSubmit`
 *  (`pty.write` bypasses xterm entirely and must never arm one). */
async function typeSubmit(page: Page, tabId: string, text: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click()
  await page.getByTestId(`terminal-${tabId}`).click({ position: { x: 60, y: 60 } })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** Open a new agent tab from the "+" menu and return {tabId, termId} of the NEW agent tab
 *  (diffed against the ids already known — order in the strip is not assumed). */
async function newAgentTab(
  page: Page,
  projectId: string,
  agentMenuId = 'tab-add-agent-claude-test'
): Promise<{ tabId: string; termId: string }> {
  const before = new Set((await tabSnaps(page, projectId)).map((t) => t.id))
  await page.getByTestId('tab-add').click()
  await page.getByTestId(agentMenuId).click()
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

/** The tab's persisted bindState (E-025 triple), read from the live store. */
async function bindStateOf(page: Page, projectId: string, tabId: string): Promise<string> {
  return page.evaluate(
    ({ pid, tid }) => {
      const stores = window.__pomadeStores
      const tab = (stores.useTabsStore.getState().tabsByProject[pid] ?? []).find(
        (t: { id: string }) => t.id === tid
      )
      return tab?.bindState ?? ''
    },
    { pid: projectId, tid: tabId }
  )
}

// ─── claude-style store: fresh capture, re-stamp, hand-typed launch, restart ───────
test.describe('T-113 — live capture in a claude-style store', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let scriptPath = ''
  let storeDir = ''
  let alpha = ''
  // Launch-order-independent uuid-shaped ids (claude session ids are UUIDv4 file basenames).
  const FIRST_ID = '11111111-1111-4111-8111-111111111111'
  const SECOND_ID = '22222222-2222-4222-8222-222222222222'
  const TYPED_ID = '33333333-3333-4333-8333-333333333333'
  let agentTabId = ''
  let agentTermId = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_RESUME })
    // Map the fixture's folder agent (Agents/claude-test/) to the stand-in so it resolves and
    // launches. Its configDir — hence its session store — lives inside the fixture workspace.
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

  test('capture is PROMPT-GATED: no submit, no bind — a real submit binds, bidirectionally', async () => {
    test.slow()
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()

    await expect
      .poll(async () => (await tabSnaps(page, alpha)).filter((t) => t.kind === 'agent').length, {
        timeout: 15_000
      })
      .toBe(1)
    const tab = (await tabSnaps(page, alpha)).find((t) => t.kind === 'agent')
    agentTabId = tab?.id ?? ''
    agentTermId = tab?.termId ?? ''
    expect(agentTabId).not.toBe('')
    await expect.poll(() => readBuffer(page, agentTermId), { timeout: 15_000 }).toContain('AGENT_READY')

    // Nothing has been captured yet: the store holds no transcript for this session.
    expect(await resumeIdOf(page, alpha, agentTabId)).toBe('')

    // Seed the transcript where the shell actually is (see ptyCwd) — BEFORE any prompt. The
    // E-025 negative: with no first-prompt submit there is no window, so the file is IGNORED
    // (the pre-E-025 recency watcher stamped it within ~2 polls — revert-proof discriminator).
    const cwd = await physCwd(page, agentTermId)
    expect(cwd).not.toBe('')
    storeDir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwd))
    await writeClaudeSession(storeDir, FIRST_ID)
    await expectQuiet(async () => {
      expect(await resumeIdOf(page, alpha, agentTabId)).toBe('')
    }, quietWindow(TEST_POLL_MS, 4))

    // A REAL first-prompt submit (typed keystrokes + Enter) opens the ±window — and because the
    // window is BIDIRECTIONAL, the transcript created seconds BEFORE the submit qualifies.
    await typeSubmit(page, agentTabId, 'Summarize [[vault-structure]] §Folder map for me')
    await expect
      .poll(() => readBuffer(page, agentTermId), { timeout: 15_000 })
      .toContain('AGENT_GOT: Summarize')
    await expect.poll(() => resumeIdOf(page, alpha, agentTabId), { timeout: 15_000 }).toBe(FIRST_ID)
    expect(await bindStateOf(page, alpha, agentTabId)).toBe('bound')
    // …and it reached disk, which is the only reason it can survive a reload.
    await expect
      .poll(() => persistedResumeId(fixture, alpha, agentTabId), { timeout: 15_000 })
      .toBe(FIRST_ID)
  })

  // E-025 inverts the old T-113 expectation: a newer transcript appearing MID-SESSION with no
  // user action in this tab does NOT re-stamp it. Only a (re)bind cycle (`/clear`/`/branch`/
  // `/resume` + the next submit) may move a bound tab's id — recency re-stamping was exactly
  // the T-127 corruption vector.
  test('a newer transcript with no submit does NOT re-stamp a bound tab', async () => {
    await writeClaudeSession(storeDir, SECOND_ID)
    // > several (tuned) poll intervals of the old always-on watcher — held throughout.
    await expectQuiet(async () => {
      expect(await resumeIdOf(page, alpha, agentTabId)).toBe(FIRST_ID)
    }, quietWindow(TEST_POLL_MS, 4))
    // Remove the orphan before the next test opens a window: a REAL orphan cannot exist (a
    // transcript is born at a submission), but this fabricated one would sit inside the next
    // submit's bidirectional ±window and legitimately win the earliest-born pairing there.
    await fs.rm(join(storeDir, `${SECOND_ID}.jsonl`), { force: true })
  })

  // A hand-typed launch reaches the same exec-marker path as a Pomade-launched agent. With TWO
  // live agent terms in one cwd, attribution is decided by WHOSE tab the submit happened in —
  // and the first tab's ownership of FIRST_ID stands (an owned id is never re-attributed).
  test('a hand-typed agent launch binds via ITS OWN submit, without disturbing the other agent', async () => {
    test.slow()
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()

    await expect
      .poll(async () => (await tabSnaps(page, alpha)).filter((t) => t.kind === 'terminal').length, {
        timeout: 15_000
      })
      .toBe(1)
    const shell = (await tabSnaps(page, alpha)).find((t) => t.kind === 'terminal')
    const typedTabId = shell?.id ?? ''
    const typedTermId = shell?.termId ?? ''
    expect(typedTabId).not.toBe('')
    await waitForOutput(page, typedTermId)

    // Type the roster command by hand → exec marker → agent start → the tab upgrades. (The
    // launch line may go through pty.write — launch detection is the exec marker, not onKey.)
    await writePty(page, typedTermId, `${scriptPath}\r`)
    await expect.poll(() => readBuffer(page, typedTermId), { timeout: 15_000 }).toContain('AGENT_READY')
    await expect
      .poll(async () => (await snapOf(page, alpha, typedTabId))?.kind ?? '', { timeout: 15_000 })
      .toBe('agent')
    // The upgrade stamped the launch leg of the triple: cwd-at-launch (the store key).
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            ({ pid, tid }) => {
              const stores = window.__pomadeStores
              const t = (stores.useTabsStore.getState().tabsByProject[pid] ?? []).find(
                (x: { id: string }) => x.id === tid
              )
              return t?.cwdAtLaunch ?? ''
            },
            { pid: alpha, tid: typedTabId }
          )) as string,
        { timeout: 15_000 }
      )
      .not.toBe('')

    // ITS first-prompt submit (real keystrokes) opens ITS window; the transcript follows.
    await typeSubmit(page, typedTabId, 'ping from the typed tab')
    await expect
      .poll(() => readBuffer(page, typedTermId), { timeout: 15_000 })
      .toContain('AGENT_GOT: ping')
    await writeClaudeSession(storeDir, TYPED_ID)

    await expect.poll(() => resumeIdOf(page, alpha, typedTabId), { timeout: 15_000 }).toBe(TYPED_ID)
    // The other live agent term keeps the id it already owned — no cross-stamping.
    expect(await resumeIdOf(page, alpha, agentTabId)).toBe(FIRST_ID)
  })

  // The whole point of E-022: a FRESH-started session is resumable after a reload. T-114 makes it
  // AUTOMATIC — opening the project revives the tab straight into `--resume <the captured id>`, so
  // the restored tab is never a dead pane at all (deliberate change to this test's first half).
  // The manual "Resume session" button remains the path for a session that dies DURING a run,
  // which the second half exercises by killing the revived pty.
  test('after a restart the tab auto-resumes its captured id, and Resume relaunches it', async () => {
    test.slow()
    const preRestartTermId = agentTermId
    await app.close()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${alpha}`).click()

    // T-114 auto-revive: live again on a NEW termId, running the resume form of the command.
    await expect
      .poll(
        async () => {
          const snap = await snapOf(page, alpha, agentTabId)
          return (
            snap?.status === 'live' &&
            snap.termId !== preRestartTermId &&
            (snap.lastCommand ?? '').includes(`--resume ${FIRST_ID}`)
          )
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    const revived = await snapOf(page, alpha, agentTabId)
    // The captured id rode through the restore untouched (sticky invariant).
    expect(revived?.resumeSessionId).toBe(FIRST_ID)
    await expect
      .poll(() => readBuffer(page, revived?.termId ?? ''), { timeout: 20_000 })
      .toContain(`--resume ${FIRST_ID}`)

    // Kill the revived pty: the tab goes dead mid-run and still offers Resume for the same id.
    await page.evaluate(
      (tid) => window.pomade.pty.kill(tid),
      revived?.termId ?? ''
    )
    await page.getByTestId(`tab-${agentTabId}`).click()
    await expect
      .poll(async () => (await snapOf(page, alpha, agentTabId))?.status ?? '', { timeout: 20_000 })
      .toBe('dead')
    expect(await resumeIdOf(page, alpha, agentTabId)).toBe(FIRST_ID)

    const resumeBtn = page.getByTestId(`resume-${agentTabId}`)
    await expect(resumeBtn).toBeVisible({ timeout: 15_000 })
    await resumeBtn.click()

    // Wait for the relaunch to land (lastCommand is set a beat BEFORE the new pty exists).
    await expect
      .poll(
        async () => {
          const snap = await snapOf(page, alpha, agentTabId)
          return snap?.status === 'live' && (snap.lastCommand ?? '').includes(`--resume ${FIRST_ID}`)
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    const relaunched = await snapOf(page, alpha, agentTabId)
    await expect
      .poll(() => readBuffer(page, relaunched?.termId ?? ''), { timeout: 20_000 })
      .toContain(`--resume ${FIRST_ID}`)
  })
})

// ─── codex-shape store: session_meta cwd match is the ONLY attribution key ─────────
test.describe('T-113 — live capture in a codex-shape store', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let sessionsRoot = ''
  let alpha = ''
  const MATCHING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const FOREIGN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_RESUME, name: 'fake-codex.sh' })
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { codex: scriptPath }, hidden: [] }, null, 2)
    )
    // CODEX_HOME is codex's own config-dir env var, which main now honours (T-113). It is what
    // makes a codex-store e2e possible at all: the built-in codex would otherwise resolve to the
    // real ~/.codex, which no spec may touch.
    const codexHome = join(fixture.workspaceRoot, 'codex-home')
    sessionsRoot = join(codexHome, 'sessions')
    await fs.mkdir(codexHome, { recursive: true })
    app = await launchApp(fixture, { CODEX_HOME: codexHome })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a rollout whose session_meta cwd matches the project stamps the tab; a foreign cwd does not', async () => {
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-codex').click()

    await expect
      .poll(async () => (await tabSnaps(page, alpha)).filter((t) => t.kind === 'agent').length, {
        timeout: 15_000
      })
      .toBe(1)
    const tab = (await tabSnaps(page, alpha)).find((t) => t.kind === 'agent')
    const tabId = tab?.id ?? ''
    const termId = tab?.termId ?? ''
    expect(tabId).not.toBe('')
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('AGENT_READY')

    const cwd = await physCwd(page, termId)
    expect(cwd).not.toBe('')

    // E-025 — the bind window opens at THIS tab's first-prompt submit (real keystrokes).
    await typeSubmit(page, tabId, 'hi codex, list the vault Journal notes')
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('AGENT_GOT: hi codex')

    // A rollout for a DIFFERENT cwd is in the same store but belongs to no live term here.
    await writeCodexSession(sessionsRoot, FOREIGN_ID, join(cwd, 'somewhere-else'), '17')
    // The matching one stamps.
    await writeCodexSession(sessionsRoot, MATCHING_ID, cwd)
    await expect.poll(() => resumeIdOf(page, alpha, tabId), { timeout: 15_000 }).toBe(MATCHING_ID)

    // A further foreign-cwd rollout must not disturb the captured id.
    await writeCodexSession(sessionsRoot, FOREIGN_ID, join(cwd, 'elsewhere'), '16')
    // > several (tuned) poll intervals + the attribution window — held throughout.
    await expectQuiet(async () => {
      expect(await resumeIdOf(page, alpha, tabId)).toBe(MATCHING_ID)
    }, quietWindow(TEST_POLL_MS, 4))
  })
})

// ─── built-in claude honours CLAUDE_CONFIG_DIR (T-113 follow-up, the Owner's review) ─────
// childEnv passes CLAUDE_CONFIG_DIR through to pty children (user config is kept, T-025), so a
// Pomade inheriting it (e.g. dev run from inside a folder-agent session) has the built-in
// claude WRITING its store there. Main must scan the same place, or history/capture silently
// find nothing. Folder agents pin their configDir explicitly and are untouched by this var.
test.describe('T-113 — built-in claude store follows CLAUDE_CONFIG_DIR', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let configDir = ''
  const REDIRECTED_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_RESUME, name: 'fake-claude.sh' })
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { claude: scriptPath }, hidden: [] }, null, 2)
    )
    configDir = join(fixture.workspaceRoot, 'claude-config-home')
    await fs.mkdir(configDir, { recursive: true })
    app = await launchApp(fixture, { CLAUDE_CONFIG_DIR: configDir })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a transcript in the redirected store stamps the built-in claude tab', async () => {
    const alpha = fixture.projects.alpha
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude').click()

    await expect
      .poll(async () => (await tabSnaps(page, alpha)).filter((t) => t.kind === 'agent').length, {
        timeout: 15_000
      })
      .toBe(1)
    const tab = (await tabSnaps(page, alpha)).find((t) => t.kind === 'agent')
    const tabId = tab?.id ?? ''
    const termId = tab?.termId ?? ''
    expect(tabId).not.toBe('')
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('AGENT_READY')

    // The transcript lands where the CLI would write it under this env: the REDIRECTED store,
    // keyed by the shell-reported (physical) cwd. Pre-fix, main watched ~/.claude instead and
    // this stamp never happened. E-025 — the bind is prompt-gated, so submit first.
    const cwd = await physCwd(page, termId)
    expect(cwd).not.toBe('')
    await typeSubmit(page, tabId, 'read the redirected store note')
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('AGENT_GOT: read')
    await writeClaudeSession(join(configDir, 'projects', encodeCwd(cwd)), REDIRECTED_ID)
    await expect.poll(() => resumeIdOf(page, alpha, tabId), { timeout: 15_000 }).toBe(REDIRECTED_ID)
  })
})

// ─── E-025 — multi-agent disambiguation in ONE store (the T-127 class of bugs) ─────
// ≥2 live agents sharing one cwd share one scan dir. Attribution is decided by WHOSE tab the
// first-prompt submit happened in — a queue of AwaitingId tabs ordered by submit time, files
// paired to submits in creation order (a transcript is born at the first submission, so file
// order follows submit order — evidence, not recency). The only refuse case is a true
// sub-second submit tie; an owned id is never re-attributed. State chains within the describe.
test.describe('E-025 — multi-agent same-cwd disambiguation', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let scriptPath = ''
  let storeDir = ''
  const ID_A = '44444444-4444-4444-8444-444444444444'
  const ID_B = '55555555-5555-4555-8555-555555555555'
  const ID_C = '66666666-6666-4666-8666-666666666666'
  const ID_T = '77777777-7777-4777-8777-777777777777'
  let a1 = { tabId: '', termId: '' }
  let a2 = { tabId: '', termId: '' }
  let a3 = { tabId: '', termId: '' }
  let t1 = { tabId: '', termId: '' }
  let t2 = { tabId: '', termId: '' }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_RESUME })
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { 'claude-test': scriptPath }, hidden: [] }, null, 2)
    )
    // PRODUCTION poll timing for this app (T-177 opt-out): the pairing test below deliberately
    // exercises "TWO files appear in one poll window" (files 80ms apart), and the tie specs test
    // the tie logic itself — a shrunk tick would make the one-window path a coin flip.
    app = await launchApp(fixture, { POMADE_TEST_POLL_MS: '' })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // THE genuinely-concurrent case the old two-agent test never covered (it kept one agent
  // silent): both tabs live in one store, both prompt, both windows open at once, TWO files
  // appear in one poll window — and each tab binds ITS file, paired by submit order.
  test('two AwaitingId tabs pair appearing files to submits IN ORDER (queue, not recency)', async () => {
    test.slow()
    a1 = await newAgentTab(page, alpha)
    a2 = await newAgentTab(page, alpha)
    const cwd = await physCwd(page, a1.termId)
    expect(cwd).not.toBe('')
    storeDir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwd))

    await typeSubmit(page, a1.tabId, 'first submit — summarize the alpha README')
    // Keep the two submits clearly orderable: their wall-clock gap must exceed SUBMIT_TIE_MS (750 ms,
    // product semantics with no test hook), with margin for the second submit's own latency.
    // eslint-disable-next-line playwright/no-wait-for-timeout -- wall-clock gap between two submits is the subject; nothing to observe
    await page.waitForTimeout(1200)
    await typeSubmit(page, a2.tabId, 'second submit — list the alpha notes')

    // Two transcripts land in creation order while BOTH windows are open.
    await writeClaudeSession(storeDir, ID_A)
    // eslint-disable-next-line playwright/no-wait-for-timeout -- wall-clock gap so the two files' birthtimes are strictly ordered
    await page.waitForTimeout(80)
    await writeClaudeSession(storeDir, ID_B)

    await expect.poll(() => resumeIdOf(page, alpha, a1.tabId), { timeout: 15_000 }).toBe(ID_A)
    await expect.poll(() => resumeIdOf(page, alpha, a2.tabId), { timeout: 15_000 }).toBe(ID_B)
    expect(await bindStateOf(page, alpha, a1.tabId)).toBe('bound')
    expect(await bindStateOf(page, alpha, a2.tabId)).toBe('bound')
  })

  test('an already-owned id is ignored, never re-attributed (ownership invariant)', async () => {
    test.slow()
    a3 = await newAgentTab(page, alpha)
    await typeSubmit(page, a3.tabId, 'third submit — check the vault backlog')
    // ID_A's transcript is recreated with a FRESH birthtime — inside a3's ±window, unowned it
    // would bind. It is OWNED by a1, so the watcher must ignore it (refuse-don't-steal).
    await fs.rm(join(storeDir, `${ID_A}.jsonl`), { force: true })
    await writeClaudeSession(storeDir, ID_A)
    // Several PRODUCTION poll ticks (this app opted out of the tuned tick) — held throughout.
    await expectQuiet(async () => {
      expect(await resumeIdOf(page, alpha, a3.tabId)).toBe('')
      expect(await resumeIdOf(page, alpha, a1.tabId)).toBe(ID_A)
    }, quietWindow(1000, 3))
    // Its OWN transcript still binds it — the window is still open.
    await writeClaudeSession(storeDir, ID_C)
    await expect.poll(() => resumeIdOf(page, alpha, a3.tabId), { timeout: 15_000 }).toBe(ID_C)
    expect(await resumeIdOf(page, alpha, a1.tabId)).toBe(ID_A)
  })

  // The sole refuse case: two submits inside the tie threshold cannot be ordered, so pairing
  // one file would be a coin-flip — BOTH tabs go Unbound (never a wrong bind). Driven through
  // the store action directly: real keyboards cannot land two submits in the same sub-second
  // tick deterministically, and the subject here is the watcher's refusal logic (the keystroke
  // path is pinned by the typed-submit specs above).
  test('a true sub-second submit tie refuses BOTH tabs (never a coin-flip bind)', async () => {
    test.slow()
    t1 = await newAgentTab(page, alpha)
    t2 = await newAgentTab(page, alpha)
    await page.evaluate(
      ({ pid, x, y }) => {
        const store = window.__pomadeStores.useTerminalsStore.getState()
        store.handleSubmit(pid, x, 'tie submit one')
        store.handleSubmit(pid, y, 'tie submit two')
      },
      { pid: alpha, x: t1.tabId, y: t2.tabId }
    )
    await writeClaudeSession(storeDir, ID_T)
    await expect.poll(() => bindStateOf(page, alpha, t1.tabId), { timeout: 15_000 }).toBe('unbound')
    await expect.poll(() => bindStateOf(page, alpha, t2.tabId), { timeout: 15_000 }).toBe('unbound')
    expect(await resumeIdOf(page, alpha, t1.tabId)).toBe('')
    expect(await resumeIdOf(page, alpha, t2.tabId)).toBe('')
    // The bound neighbours are untouched by the refusal.
    expect(await resumeIdOf(page, alpha, a1.tabId)).toBe(ID_A)
    expect(await resumeIdOf(page, alpha, a2.tabId)).toBe(ID_B)
  })

  test('an Unbound tab re-enters AwaitingId on its next submit and binds a qualifying file', async () => {
    // ID_T is still unowned and was born seconds ago — inside the BIDIRECTIONAL window the
    // retry submit opens. The refused tab recovers without /clear or manual entry.
    await typeSubmit(page, t1.tabId, 'retry submit — take the orphaned session')
    await expect.poll(() => resumeIdOf(page, alpha, t1.tabId), { timeout: 15_000 }).toBe(ID_T)
    await expect.poll(() => bindStateOf(page, alpha, t1.tabId), { timeout: 15_000 }).toBe('bound')
    // The tied twin stays unbound — the retry was t1's alone.
    expect(await bindStateOf(page, alpha, t2.tabId)).toBe('unbound')
    expect(await resumeIdOf(page, alpha, t2.tabId)).toBe('')
  })

  test('a window with nothing qualifying EXPIRES to Unbound', async () => {
    test.slow()
    const t3 = await newAgentTab(page, alpha)
    await typeSubmit(page, t3.tabId, 'a prompt whose transcript never appears')
    // Well before the 30s expiry: still no verdict (the window is open, nothing qualifying
    // appeared) — held for 3s, sized against SESSION_BIND_WINDOW_MS, not the poll tick.
    await expectQuiet(async () => {
      expect(await bindStateOf(page, alpha, t3.tabId)).toBe('')
    }, 3000)
    // SESSION_BIND_WINDOW_MS (30s) after the submit, the window resolves to Unbound.
    await expect.poll(() => bindStateOf(page, alpha, t3.tabId), { timeout: 40_000 }).toBe('unbound')
    expect(await resumeIdOf(page, alpha, t3.tabId)).toBe('')
  })
})

// ─── E-025 — two Pomade PROJECTS pointed at the same folder (same store) ───────────
// The recency watcher had no way to tell which project a new id belonged to. Prompt-gating
// names the TAB (and with it the project): the id binds where the submit happened.
test.describe('E-025 — cross-project attribution on the same cwd', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  const ALPHA2 = 'proj-alpha2'
  const ID_P1 = '88888888-8888-4888-8888-888888888888'
  const ID_P2 = '99999999-9999-4999-8999-999999999999'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_RESUME })
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { 'claude-test': scriptPath }, hidden: [] }, null, 2)
    )
    // A SECOND project rooted at the SAME folder as alpha — the fast-project-switching case.
    const wsFile = join(fixture.workspaceRoot, '.pomade', 'workspace.json')
    const config = JSON.parse(await fs.readFile(wsFile, 'utf8')) as {
      projects: { id: string; name: string; rootPath: string; visibleAgents: string[]; order: number }[]
    }
    config.projects.push({
      id: ALPHA2,
      name: 'Alpha Mirror',
      rootPath: 'Projects/alpha',
      visibleAgents: ['*'],
      order: 2
    })
    await fs.writeFile(wsFile, JSON.stringify(config, null, 2))
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a new id binds the tab whose prompt was submitted, in the RIGHT project', async () => {
    test.slow()
    // One live agent in each project, both in the same cwd → the same scan dir.
    await page.getByTestId(`project-${alpha}`).click()
    const p1 = await newAgentTab(page, alpha)
    await page.getByTestId(`project-${ALPHA2}`).click()
    const p2 = await newAgentTab(page, ALPHA2)
    const cwd = await physCwd(page, p1.termId)
    expect(cwd).not.toBe('')
    const storeDir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwd))

    // Prompt the MIRROR project's tab first — its transcript must land there, not in alpha.
    await typeSubmit(page, p2.tabId, 'mirror project prompt — read the shared README')
    // RECENCY DECOY: make the OTHER project's tab the most-recent talker before the file
    // appears (pty-level write — it bypasses xterm, so it is NOT a submit and opens no
    // window). The old watcher attributed by output recency and stamped p1 with p2's id —
    // exactly T-127's cross-assignment; prompt-gating must bind where the SUBMIT happened.
    await writePty(page, p1.termId, 'recency decoy chatter\r')
    await expect
      .poll(() => readBuffer(page, p1.termId), { timeout: 15_000 })
      .toContain('AGENT_GOT: recency decoy')
    await writeClaudeSession(storeDir, ID_P2)
    await expect.poll(() => resumeIdOf(page, ALPHA2, p2.tabId), { timeout: 15_000 }).toBe(ID_P2)
    expect(await resumeIdOf(page, alpha, p1.tabId)).toBe('')

    // Now the original project's tab: its own submit, its own id — the mirror is untouched.
    await page.getByTestId(`project-${alpha}`).click()
    await typeSubmit(page, p1.tabId, 'alpha project prompt — read the shared notes')
    await writeClaudeSession(storeDir, ID_P1)
    await expect.poll(() => resumeIdOf(page, alpha, p1.tabId), { timeout: 15_000 }).toBe(ID_P1)
    expect(await resumeIdOf(page, ALPHA2, p2.tabId)).toBe(ID_P2)
  })
})

// ─── E-025 slice 3 — the (re)bind lifecycle: /clear, /branch, in-session /resume ──────
// `/clear`, `/branch` and exit-then-restart are business-wise the SAME event ("a new session is
// being created in this tab") and all route through AwaitingId at the NEXT first-prompt submit.
// Claude's `/fork` is not: its copy runs in the background and the tab keeps its session.
// In-session `/resume` is its OWN mode (ratified 2026-08-19): it never hunts for a new id — it
// ADOPTS an existing transcript (explicit `<id>` validated on disk, or the file that starts
// growing). Between a rebind command and its successful rebind the tab KEEPS its last-known id.
test.describe('E-025 — rebind lifecycle (/clear, /branch, in-session /resume)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let storeDir = ''
  const ID_1 = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1'
  const ID_2 = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2'
  const ID_3 = 'c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3'
  const ID_5 = 'd5d5d5d5-5555-4555-8555-d5d5d5d5d5d5'
  const ID_BG = 'bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb'
  const ID_OLD = 'e6e6e6e6-6666-4666-8666-e6e6e6e6e6e6'
  const ID_GROW = 'f7f7f7f7-7777-4777-8777-f7f7f7f7f7f7'
  const NONEXISTENT = '00000000-dead-4bad-8bad-000000000000'
  let a1 = { tabId: '', termId: '' }
  let a2 = { tabId: '', termId: '' }

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
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('/clear re-arms: the NEXT submit rebinds this tab to the new id, the neighbour untouched', async () => {
    test.slow()
    a1 = await newAgentTab(page, alpha)
    a2 = await newAgentTab(page, alpha)
    const cwd = await physCwd(page, a1.termId)
    storeDir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwd))

    // Bind both tabs to their own sessions first.
    await typeSubmit(page, a1.tabId, 'bind me first — a vault question')
    await writeClaudeSession(storeDir, ID_1)
    await expect.poll(() => resumeIdOf(page, alpha, a1.tabId), { timeout: 15_000 }).toBe(ID_1)
    await typeSubmit(page, a2.tabId, 'bind me second — a journal question')
    await writeClaudeSession(storeDir, ID_2)
    await expect.poll(() => resumeIdOf(page, alpha, a2.tabId), { timeout: 15_000 }).toBe(ID_2)

    // `/clear` re-arms but the tab KEEPS its last-known id until the rebind succeeds — an app
    // restart inside this gap must resume the pre-clear session (ratified semantics).
    await typeSubmit(page, a1.tabId, '/clear')
    await expectQuiet(async () => {
      expect(await resumeIdOf(page, alpha, a1.tabId)).toBe(ID_1)
      expect(await bindStateOf(page, alpha, a1.tabId)).toBe('bound')
    }, quietWindow(TEST_POLL_MS, 4))

    // The next first-prompt submit opens the window; the NEW transcript rebinds THIS tab only.
    await typeSubmit(page, a1.tabId, 'first prompt of the post-clear session')
    await writeClaudeSession(storeDir, ID_3)
    await expect.poll(() => resumeIdOf(page, alpha, a1.tabId), { timeout: 15_000 }).toBe(ID_3)
    expect(await resumeIdOf(page, alpha, a2.tabId)).toBe(ID_2)
  })

  test('claude\'s /fork keeps the tab on its own session — its background copy is never bound; /branch re-arms', async () => {
    // `/fork` copies the conversation into a BACKGROUND session (its lines marked `sessionKind:
    // "bg"`) and keeps working here: the tab's session does not change.
    await typeSubmit(page, a2.tabId, '/fork')
    await writeClaudeLines(storeDir, ID_BG, [
      { type: 'queue-operation', operation: 'enqueue', sessionId: ID_BG },
      { type: 'user', uuid: 'bg-1', sessionId: ID_BG, sessionKind: 'bg', message: { role: 'user', content: 'copied' } }
    ])
    await typeSubmit(page, a2.tabId, 'keep working here')
    await expectQuiet(async () => {
      expect(await resumeIdOf(page, alpha, a2.tabId)).toBe(ID_2)
      expect(await bindStateOf(page, alpha, a2.tabId)).toBe('bound')
    }, quietWindow(TEST_POLL_MS, 4))
    // `/branch` moves the tab to a copy written at once, its lines naming the parent. The
    // background copy above sits in the same store, born inside this window and earlier — it
    // must still not take the tab.
    await typeSubmit(page, a2.tabId, '/branch')
    await writeClaudeLines(storeDir, ID_5, [
      { type: 'user', uuid: 'br-1', sessionId: ID_5, forkedFrom: { sessionId: ID_2, messageUuid: 'br-1' }, message: { role: 'user', content: 'copied' } }
    ])
    await typeSubmit(page, a2.tabId, 'first prompt of the branch')
    await expect.poll(() => resumeIdOf(page, alpha, a2.tabId), { timeout: 15_000 }).toBe(ID_5)
    expect(await resumeIdOf(page, alpha, a1.tabId)).toBe(ID_3)
  })

  test('in-session `/resume <id>` ADOPTS the existing transcript immediately — validated on disk', async () => {
    // The transcript being resumed EXISTS (an orphaned earlier session). Written now, with no
    // window open, so nothing else can bind it first.
    await writeClaudeSession(storeDir, ID_OLD)
    await typeSubmit(page, a1.tabId, `/resume ${ID_OLD}`)
    await expect.poll(() => resumeIdOf(page, alpha, a1.tabId), { timeout: 15_000 }).toBe(ID_OLD)
    expect(await bindStateOf(page, alpha, a1.tabId)).toBe('bound')
    expect(await resumeIdOf(page, alpha, a2.tabId)).toBe(ID_5)
  })

  test('`/resume <nonexistent-id>` never binds (validate — a resume of it would fail)', async () => {
    await typeSubmit(page, a2.tabId, `/resume ${NONEXISTENT}`)
    // Several (tuned) poll ticks — nothing may adopt the bogus id, held throughout.
    await expectQuiet(async () => {
      expect(await resumeIdOf(page, alpha, a2.tabId)).toBe(ID_5)
    }, quietWindow(TEST_POLL_MS, 4))
  })

  test('bare `/resume` (interactive picker) adopts the existing file that GROWS at the next submit', async () => {
    // The pick target: an existing orphan transcript, present BEFORE the window arms.
    await writeClaudeSession(storeDir, ID_GROW)
    await typeSubmit(page, a2.tabId, '/resume')
    // The user picked a session in the TUI (no tracked submit), then sends the next message —
    // that submit opens the adopt-existing window, and the picked transcript starts growing.
    await typeSubmit(page, a2.tabId, 'continuing in the resumed session')
    await fs.appendFile(
      join(storeDir, `${ID_GROW}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'continuing' } }) + '\n'
    )
    await expect.poll(() => resumeIdOf(page, alpha, a2.tabId), { timeout: 15_000 }).toBe(ID_GROW)
    expect(await bindStateOf(page, alpha, a2.tabId)).toBe('bound')
    expect(await resumeIdOf(page, alpha, a1.tabId)).toBe(ID_OLD)
  })
})

// ─── E-025 slice 3 — session END via process lifecycle ─────────────────────────────
// The agent's foreground process returning to the shell (`/exit`, crash, Ctrl+C/D — all reach
// the same exec→prompt marker pair) reverts the tab to a plain terminal and CLEARS its agent
// triple; the farewell line stays in scrollback (and survives a reload for a terminal-born tab,
// whose T-116 snapshot resumes on the downgrade).
test.describe('E-025 — session end reverts the tab to a plain terminal', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  const ID_END = 'ababcdcd-abab-4bab-8bab-abcdefabcdef'
  let scriptPath = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_RESUME })
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

  test('exit clears the triple, reverts the kind, and the farewell survives a reload', async () => {
    test.slow()
    // TERMINAL-born tab (it owns a scrollback snapshot; a tab created as an agent never
    // snapshots — documented T-116 limit), upgraded by a hand-typed launch.
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()
    await expect
      .poll(async () => (await tabSnaps(page, alpha)).filter((t) => t.kind === 'terminal').length, {
        timeout: 15_000
      })
      .toBe(1)
    const shell = (await tabSnaps(page, alpha)).find((t) => t.kind === 'terminal')
    const tabId = shell?.id ?? ''
    const termId = shell?.termId ?? ''
    await waitForOutput(page, termId)
    await writePty(page, termId, `${scriptPath}\r`)
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('AGENT_READY')
    await expect
      .poll(async () => (await snapOf(page, alpha, tabId))?.kind ?? '', { timeout: 15_000 })
      .toBe('agent')

    // Bind it, so there is a triple to clear.
    await typeSubmit(page, tabId, 'a last message before exit')
    const cwd = await physCwd(page, termId)
    const storeDir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwd))
    await writeClaudeSession(storeDir, ID_END)
    await expect.poll(() => resumeIdOf(page, alpha, tabId), { timeout: 15_000 }).toBe(ID_END)
    expect((await snapOf(page, alpha, tabId))?.cwdAtLaunch ?? '').not.toBe('')

    // `/exit` — the fake agent prints the farewell line and exits; the shell survives, the
    // exec→prompt marker pair raises ptyAgentExit, and the tab reverts with the triple cleared.
    await typeSubmit(page, tabId, '/exit')
    await expect
      .poll(async () => (await snapOf(page, alpha, tabId))?.kind ?? '', { timeout: 15_000 })
      .toBe('terminal')
    const reverted = await snapOf(page, alpha, tabId)
    expect(reverted?.status).toBe('live')
    expect(reverted?.resumeSessionId).toBeUndefined()
    expect(reverted?.cwdAtLaunch).toBeUndefined()
    expect(reverted?.bindState).toBeUndefined()
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 15_000 })
      .toContain('To resume this session, run: claude --resume')

    // Reload: the tab revives as a PLAIN terminal (no resume — the triple is gone), and its
    // restored scrollback still shows the farewell line (the manual-recovery copy source).
    // The T-116 snapshot (tuned debounce) must land before quitting — poll the file itself.
    await expect
      .poll(
        () =>
          fs
            .readFile(join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback', tabId), 'utf8')
            .catch(() => ''),
        { timeout: 15_000 }
      )
      .toContain('To resume this session, run: claude --resume')
    await app.close()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${alpha}`).click()
    await expect
      .poll(
        async () => {
          const snap = await snapOf(page, alpha, tabId)
          return snap?.status === 'live' && snap.termId !== termId && snap.kind === 'terminal'
        },
        { timeout: 20_000 }
      )
      .toBe(true)
    const revived = await snapOf(page, alpha, tabId)
    expect(revived?.resumeSessionId).toBeUndefined()
    const replay = await page.evaluate(
      (tid) => window.pomade.pty.replay(tid),
      revived?.termId ?? ''
    )
    expect(replay).toContain('To resume this session, run: claude --resume')
  })
})
