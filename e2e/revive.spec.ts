// modules: tabs, terminal, agents
// Pomade E-022 e2e — T-114 auto-revive on project open.
//
// The thing under test: a tab restored with persisted `status: 'live'` (its PTY died with the
// previous app process) is no longer a dead pane. It waits — RUNTIME-ONLY, its persisted payload
// untouched — until its PROJECT is opened, and then either comes back live (agent → the provider's
// resume command, terminal → a fresh shell at its last known cwd) or flips to an honest, persisted
// 'dead' (agent with no session id, vanished roster agent, failed spawn).
//
// Restore state is FABRICATED (a `.pomade/state/<projectId>.json` written before launch) rather
// than produced by a first app run: it is the only way to pin every discriminator at once — a
// persisted-dead tab next to persisted-live ones, an agent with and without a session id, a cwd
// that no longer exists. `e2e/terminals.spec.ts` covers the real quit→relaunch round trip.
//
// The boot-time active project is the Workspace project, so a real project's tabs are
// always pending at boot and revive on the first click of its Projects panel row — which is exactly the
// window the sticky-payload invariant lives in.
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
import { readBuffer, writePty, writeWhenReady } from './fixtures/stores'
import { FAKE_AGENT_RESUME, seedFakeAgent } from './fixtures/fake-agent'
import { expectQuiet, quietWindow, TEST_POLL_MS } from './fixtures/timing'

// A stand-in agent CLI (E-025 harness v2, same script as session-capture.spec): announces
// readiness, echoes every submitted line — and `--resume <id>` APPENDS a real line to
// `<id>.jsonl` in the isolated store (keyed by the CLI's own $PWD, exactly like claude) and
// emits an output BURST. That is the T-127 acceptance shape: a concurrent same-cwd revive makes
// BOTH transcripts grow across the same poll ticks, which is precisely what scrambled the old
// recency attribution. The store root comes from FAKE_AGENT_STORE (per app launch); without it
// the resume write is skipped and only the echo remains (the pre-E-025 harness behavior).

/** Claude Code's own cwd encoding (mirror of agent-service.encodeCwd). */
function encodeCwd(abs: string): string {
  return abs.replace(/[^a-zA-Z0-9]/g, '-')
}

/** E-025 — seed a real-shape transcript into the claude-test folder agent's store, keyed by the
 *  PHYSICAL cwd (what a real CLI encodes — the shell reports `/private/var/...` for a
 *  `/var/...` tmpdir). Revive now VALIDATES a persisted id against this store before spawning
 *  `--resume`, so every fabricated agent-with-id fixture must have its transcript on disk. */
async function seedTranscript(
  fixture: Fixture,
  cwdAbs: string,
  sessionId: string
): Promise<string> {
  const dir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwdAbs))
  await fs.mkdir(dir, { recursive: true })
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `seeded transcript for ${sessionId}` },
    timestamp: new Date().toISOString()
  })
  await fs.writeFile(join(dir, `${sessionId}.jsonl`), line + '\n')
  return dir
}

/** Put the stand-in on disk and map the fixture's `claude-test` folder agent onto it, so the
 *  roster resolves it and `agentCommand(agent, id)` can build `<script> --resume <id>`. */

function stateFile(fixture: Fixture, projectId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`)
}

/** Write a fabricated `ProjectState` — the tabs a previous app run would have left behind. */
async function seedProjectState(
  fixture: Fixture,
  projectId: string,
  state: unknown
): Promise<string> {
  const dir = join(fixture.workspaceRoot, '.pomade', 'state')
  await fs.mkdir(dir, { recursive: true })
  const raw = JSON.stringify(state, null, 2)
  await fs.writeFile(stateFile(fixture, projectId), raw)
  return raw
}



/** The cwd the SHELL reports (T-086 prompt marker). On macOS that is the PHYSICAL path
 *  (`/private/var/folders/…` for a `/var/folders/…` tmpdir), so specs assert on a suffix. */
function ptyCwd(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.cwd(tid), termId)
}

interface TabSnap {
  id: string
  kind: string
  status: string
  termId: string
  cwd: string
  attention?: boolean
  resumeSessionId?: string
  lastCommand?: string
}

function tabSnaps(page: Page, projectId: string): Promise<TabSnap[]> {
  return page.evaluate((pid) => {
    const stores = window.__pomadeStores
    return (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      termId: t.termId,
      cwd: t.cwd,
      attention: t.attention,
      resumeSessionId: t.resumeSessionId,
      lastCommand: t.lastCommand
    }))
  }, projectId) as Promise<TabSnap[]>
}

async function snapOf(page: Page, projectId: string, tabId: string): Promise<TabSnap | undefined> {
  return (await tabSnaps(page, projectId)).find((t) => t.id === tabId)
}

/** Poll until `tabId` is live on a termId OTHER than the one the previous run left behind. */
async function waitRevived(
  page: Page,
  projectId: string,
  tabId: string,
  deadTermId: string
): Promise<TabSnap> {
  await expect
    .poll(
      async () => {
        const snap = await snapOf(page, projectId, tabId)
        return snap?.status === 'live' && snap.termId !== deadTermId
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  const snap = await snapOf(page, projectId, tabId)
  if (!snap) throw new Error(`tab ${tabId} vanished`)
  return snap
}

// T-151 — the Projects panel attention counter is the LIVE DERIVED count of unread (dotted) tabs.
function attentionCount(page: Page, projectId: string): Promise<number> {
  return page.evaluate(
    (pid) => (window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? [])
      .filter((t) => t.attention).length,
    projectId
  )
}

// ─── the five restore outcomes, one app run, one project open ──────────────────────
test.describe('T-114 — revive on project open', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let alphaRoot = ''
  const RESUME_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  // termIds of the previous run — every one of them is gone from main's pty map.
  const T = {
    agentWithId: 'gone-agent-with-id',
    agentNoId: 'gone-agent-no-id',
    termDeep: 'gone-term-deep',
    termDead: 'gone-term-dead',
    termVanished: 'gone-term-vanished'
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
    await seedFakeAgent(fixture, { script: FAKE_AGENT_RESUME })
    // E-025 — revive validates a persisted id against the tab's store (keyed by the PHYSICAL
    // launch cwd), so the agent-with-id fixture needs its transcript on disk.
    await seedTranscript(fixture, await fs.realpath(alphaRoot), RESUME_ID)
    // A real sub-directory the restored terminal was last `cd`'d into…
    await fs.mkdir(join(alphaRoot, 'deep'), { recursive: true })
    // …and NO `gone-forever/` — the vanished-cwd case.
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: 'agent-with-id',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: T.agentWithId,
          agentId: 'claude-test',
          cwd: alphaRoot,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: RESUME_ID
        },
        {
          id: 'agent-no-id',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: T.agentNoId,
          agentId: 'claude-test',
          cwd: alphaRoot,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh')
        },
        {
          id: 'term-deep',
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 1',
          termId: T.termDeep,
          cwd: join(alphaRoot, 'deep'),
          status: 'live'
        },
        {
          id: 'term-dead',
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 2',
          termId: T.termDead,
          cwd: alphaRoot,
          status: 'dead'
        },
        {
          id: 'term-vanished',
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 3',
          termId: T.termVanished,
          cwd: join(alphaRoot, 'gone-forever'),
          status: 'live'
        }
      ],
      activeTabId: 'agent-with-id'
    })
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('an agent tab with a session id revives with the resume command', async () => {
    test.slow()
    // Before the project is opened, nothing is revived — and, crucially, no dead pane was ever
    // rendered for a pending tab (a flash of Relaunch/Resume buttons on a tab that is about to
    // come back live would be a lie). The tab persisted as DEAD does show its dead pane already.
    await expect(page.getByTestId('terminal-dead-term-dead')).toHaveCount(1)
    // Held through the real-world mount window: no pending tab may flash a dead pane.
    await expectQuiet(async () => {
      for (const id of ['agent-with-id', 'agent-no-id', 'term-deep', 'term-vanished']) {
        await expect(page.getByTestId(`terminal-dead-${id}`)).toHaveCount(0)
      }
    }, 1500)

    // Open the project — the revive trigger.
    await page.getByTestId(`project-${alpha}`).click()

    const revived = await waitRevived(page, alpha, 'agent-with-id', T.agentWithId)
    // The resume command was really typed into the fresh pty, and the agent came up under it.
    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain(`--resume ${RESUME_ID}`)
    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain('AGENT_READY')
    // Every restore payload rode along untouched; only termId/status/lastCommand moved.
    expect(revived.kind).toBe('agent')
    expect(revived.resumeSessionId).toBe(RESUME_ID)
    expect(revived.lastCommand).toContain(`--resume ${RESUME_ID}`)
    await expect(page.getByTestId('terminal-agent-with-id')).toHaveAttribute('data-status', 'live')
  })

  test('an agent tab WITHOUT a session id becomes a dead pane with Relaunch', async () => {
    // Grooming decision: auto-starting a FRESH agent would look resumed with empty context.
    await expect
      .poll(async () => (await snapOf(page, alpha, 'agent-no-id'))?.status ?? '', {
        timeout: 20_000
      })
      .toBe('dead')
    // Its termId is NOT swapped (no pty was spawned) and there is no Resume button to offer.
    expect((await snapOf(page, alpha, 'agent-no-id'))?.termId).toBe(T.agentNoId)
    await page.getByTestId('tab-agent-no-id').click()
    await expect(page.getByTestId('terminal-dead-agent-no-id')).toBeVisible()
    await expect(page.getByTestId('relaunch-agent-no-id')).toBeVisible()
    await expect(page.getByTestId('resume-agent-no-id')).toHaveCount(0)
  })

  test('a terminal tab revives as a plain shell at its PERSISTED cwd', async () => {
    const revived = await waitRevived(page, alpha, 'term-deep', T.termDeep)
    await expect
      .poll(() => ptyCwd(page, revived.termId), { timeout: 20_000 })
      .toMatch(/\/Projects\/alpha\/deep$/)
    // A plain shell, not a re-run of anything: the tab carries no command and the pty is usable.
    expect(revived.lastCommand).toBeUndefined()
    await writeWhenReady(page, revived.termId, 'echo REVIVED_SHELL_MARK\r')
    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain('REVIVED_SHELL_MARK')
  })

  test('a tab whose persisted status is dead stays dead', async () => {
    const snap = await snapOf(page, alpha, 'term-dead')
    expect(snap?.status).toBe('dead')
    expect(snap?.termId).toBe(T.termDead) // never revived ⇒ never re-keyed
    await page.getByTestId('tab-term-dead').click()
    await expect(page.getByTestId('terminal-dead-term-dead')).toBeVisible()
    await expect(page.getByTestId('relaunch-term-dead')).toBeVisible()
  })

  test('a terminal whose cwd vanished revives at the project root', async () => {
    const revived = await waitRevived(page, alpha, 'term-vanished', T.termVanished)
    const cwd = await ptyCwd(page, revived.termId)
    expect(cwd).not.toContain('gone-forever')
    await expect
      .poll(() => ptyCwd(page, revived.termId), { timeout: 20_000 })
      .toMatch(/\/Projects\/alpha$/)
  })
})

// ─── the sticky-payload invariant: a whole run without opening the project ─────────
test.describe('T-114 — restore payloads are sticky while a project is never opened', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  let alphaRoot = ''
  let seeded = ''
  const STICKY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const AGENT_TERM = 'sticky-gone-agent'
  const TERM_TERM = 'sticky-gone-term'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
    await seedFakeAgent(fixture, { script: FAKE_AGENT_RESUME })
    // E-025 — the second run's revive validates the id; the transcript exists BEFORE run 1 too,
    // which must change nothing there (no window ever opens in an un-opened project).
    await seedTranscript(fixture, await fs.realpath(alphaRoot), STICKY_ID)
    await fs.mkdir(join(alphaRoot, 'nested'), { recursive: true })
    seeded = await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: 'sticky-agent',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: AGENT_TERM,
          agentId: 'claude-test',
          cwd: alphaRoot,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: STICKY_ID
        },
        {
          id: 'sticky-term',
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 1',
          termId: TERM_TERM,
          cwd: join(alphaRoot, 'nested'),
          status: 'live'
        }
      ],
      activeTabId: 'sticky-agent'
    })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // The whole point of the epic: a reload that never opens the project must lose NOTHING. Every
  // project's panes mount at boot (PaneHost), so this is precisely where the old
  // reconcile-to-dead used to rewrite `status` — and with it the revive discriminator.
  test('a run that never opens the project leaves its state file byte-identical', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    // Stay on the boot-time active project (the Workspace project): alpha is never opened.
    await expect(page.getByTestId('panehost')).toHaveAttribute(
      'data-active-project',
      '__workspace__'
    )
    // Held while every pane mounts and reconciles, and through several tuned debounce windows
    // any wrongful save would fire in: tabs stay LIVE (pending), and no pty is ever spawned.
    await expectQuiet(async () => {
      const snaps = await tabSnaps(page, alpha)
      expect(snaps.map((t) => t.status).sort()).toEqual(['live', 'live'])
      const list = await page.evaluate(() => window.pomade.pty.list())
      expect(list).toHaveLength(0)
    }, 1500)

    await app.close()
    app = undefined
    expect(await fs.readFile(stateFile(fixture, alpha), 'utf8')).toBe(seeded)
  })

  test('the NEXT run revives both tabs correctly from the untouched payloads', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()

    const agent = await waitRevived(page, alpha, 'sticky-agent', AGENT_TERM)
    expect(agent.resumeSessionId).toBe(STICKY_ID)
    await expect
      .poll(() => readBuffer(page, agent.termId), { timeout: 20_000 })
      .toContain(`--resume ${STICKY_ID}`)

    const term = await waitRevived(page, alpha, 'sticky-term', TERM_TERM)
    await expect
      .poll(() => ptyCwd(page, term.termId), { timeout: 20_000 })
      .toMatch(/\/Projects\/alpha\/nested$/)
  })
})

// ─── revive is a REQUESTED spawn: it must raise no attention ───────────────────────
test.describe('T-114 — revive raises no attention', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let beta = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta
    const alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: 'quiet-a',
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 1',
          termId: 'quiet-gone-a',
          cwd: alphaRoot,
          status: 'live'
        },
        {
          id: 'quiet-b',
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 2',
          termId: 'quiet-gone-b',
          cwd: alphaRoot,
          status: 'live'
        }
      ],
      activeTabId: 'quiet-a'
    })
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('revived tabs get no attention dot and bump no Projects panel counter', async () => {
    test.slow()
    await page.getByTestId(`project-${alpha}`).click()
    const a = await waitRevived(page, alpha, 'quiet-a', 'quiet-gone-a')
    const b = await waitRevived(page, alpha, 'quiet-b', 'quiet-gone-b')

    // `quiet-b` is NOT the active tab, so a bell during its revive would have dotted it.
    expect(a.attention).toBeUndefined()
    expect(b.attention).toBeUndefined()

    // Leave the project and let both fresh shells finish drawing while HIDDEN — now any
    // attention event would also increment alpha's Projects panel counter.
    await page.getByTestId(`project-${beta}`).click()
    // Real-world window (fresh zsh prompt drawing while hidden, not interval-derived): no
    // attention event may fire — held throughout.
    await expectQuiet(async () => {
      expect(await attentionCount(page, alpha)).toBe(0)
      const snaps = await tabSnaps(page, alpha)
      expect(snaps.filter((t) => t.attention).map((t) => t.id)).toEqual([])
    }, 2500)

    // Control: the channel IS live for these revived ptys — a real bell counts.
    await writeWhenReady(page, b.termId, "printf '\\a'\r")
    await expect.poll(() => attentionCount(page, alpha), { timeout: 20_000 }).toBeGreaterThan(0)
  })
})

// ─── cwd persistence: the tab follows the shell's `cd` ─────────────────────────────
test.describe('T-114 — a live terminal persists its cwd', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    await fs.mkdir(join(fixture.workspaceRoot, 'Projects/alpha/sub/deeper'), { recursive: true })
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a cd in a live terminal updates the tab cwd, in memory and on disk', async () => {
    test.slow()
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()
    await expect
      .poll(async () => (await tabSnaps(page, alpha)).length, { timeout: 20_000 })
      .toBe(1)
    const tab = (await tabSnaps(page, alpha))[0]

    // The launch cwd is the project root and the shell starts there, so the first prompt marker
    // reports NO change and fires no event — the tab keeps the (workspace-relative) cwd it opened
    // with. That "only on a real change" filter is what makes the event safe to persist from.
    await expect
      .poll(async () => (await snapOf(page, alpha, tab.id))?.cwd ?? '', { timeout: 20_000 })
      .toMatch(/(^|\/)Projects\/alpha$/)

    await writeWhenReady(page, tab.termId, 'cd sub/deeper\r')
    await expect
      .poll(async () => (await snapOf(page, alpha, tab.id))?.cwd ?? '', { timeout: 20_000 })
      .toMatch(/\/Projects\/alpha\/sub\/deeper$/)

    // …and it reached disk, which is the only reason a revive can use it.
    await expect
      .poll(
        async () => {
          try {
            const raw = await fs.readFile(stateFile(fixture, alpha), 'utf8')
            const state = JSON.parse(raw) as { openTabs?: { id: string; cwd?: string }[] }
            return state.openTabs?.find((t) => t.id === tab.id)?.cwd ?? ''
          } catch {
            return 'unreadable'
          }
        },
        { timeout: 20_000 }
      )
      .toMatch(/\/Projects\/alpha\/sub\/deeper$/)
  })
})

// ─── E-025 (T-127 acceptance) — double-reload + CONCURRENT same-cwd revive ──────────
// The repro that killed recency attribution: two agent tabs in ONE cwd, distinct ids, both
// revived by a single project open (`reviveProject` spawns them in parallel). The upgraded fake
// agent makes `--resume <id>` append to the REAL `<id>.jsonl` and burst output, so both
// transcripts grow across the same poll ticks — the exact interleaving that made the old
// watcher cross-assign the ids. E-025: launch-time CLAIMS pin each id to its tab (no window is
// even open), so the mapping is deterministic. The two un-opened reloads first prove the sticky
// byte-identity (T-127's "double-reload-without-opening" leg).
test.describe('E-025 — double-reload then concurrent same-cwd revive keeps each id home', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  let seeded = ''
  let storeEnv: Record<string, string> = {}
  let sharedStoreDir = ''
  const ID_A = '12121212-1212-4121-8121-121212121212'
  const ID_B = '34343434-3434-4343-8343-343434343434'
  const TERM_A = 't127-gone-a'
  const TERM_B = 't127-gone-b'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
    const physRoot = await fs.realpath(alphaRoot)
    await seedFakeAgent(fixture, { script: FAKE_AGENT_RESUME })
    await seedTranscript(fixture, physRoot, ID_A)
    sharedStoreDir = await seedTranscript(fixture, physRoot, ID_B)
    storeEnv = { FAKE_AGENT_STORE: join(fixture.workspaceRoot, 'Agents/claude-test') }
    seeded = await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: 't127-tab-a',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: TERM_A,
          agentId: 'claude-test',
          cwd: alphaRoot,
          cwdAtLaunch: physRoot,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: ID_A,
          bindState: 'bound'
        },
        {
          id: 't127-tab-b',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: TERM_B,
          agentId: 'claude-test',
          cwd: alphaRoot,
          cwdAtLaunch: physRoot,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: ID_B,
          bindState: 'bound'
        }
      ],
      activeTabId: 't127-tab-a'
    })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('two un-opened reloads leave the state file byte-identical', async () => {
    test.slow()
    for (const run of [1, 2]) {
      app = await launchApp(fixture, storeEnv)
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByTestId('app-shell')).toBeVisible()
      await expect(page.getByTestId('panehost')).toHaveAttribute(
        'data-active-project',
        '__workspace__'
      )
      // Held while panes mount + reconcile and through several tuned debounce windows any
      // wrongful save would fire in — the file stays byte-identical THROUGHOUT the run.
      await expectQuiet(async () => {
        expect(await fs.readFile(stateFile(fixture, alpha), 'utf8'), `during run ${run}`).toBe(seeded)
      }, 1500)
      await app.close()
      app = undefined
      expect(await fs.readFile(stateFile(fixture, alpha), 'utf8'), `after run ${run}`).toBe(seeded)
    }
  })

  test('the open revives BOTH tabs concurrently and neither id moves or dies', async () => {
    test.slow()
    app = await launchApp(fixture, storeEnv)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()

    const a = await waitRevived(page, alpha, 't127-tab-a', TERM_A)
    const b = await waitRevived(page, alpha, 't127-tab-b', TERM_B)
    // Both fake agents really resumed: each appended to ITS transcript and burst output —
    // both files grew in the same poll window, the recency killer.
    await expect.poll(() => readBuffer(page, a.termId), { timeout: 20_000 }).toContain(`RESUMED ${ID_A}`)
    await expect.poll(() => readBuffer(page, b.termId), { timeout: 20_000 }).toContain(`RESUMED ${ID_B}`)
    // RECENCY DECOY (the revert discriminator): make tab A the most-recent talker, then grow
    // B's transcript — the old watcher attributed the growth by output recency and stamped A
    // with B's id (the T-127 scramble); E-025's ownership makes the growth a no-event.
    await writePty(page, a.termId, 'decoy chatter after resume\r')
    await expect
      .poll(() => readBuffer(page, a.termId), { timeout: 20_000 })
      .toContain('AGENT_GOT: decoy chatter')
    await fs.appendFile(
      join(sharedStoreDir, `${ID_B}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'late growth' } }) + '\n'
    )
    // Any (wrong) re-attribution has several (tuned) poll ticks to manifest — the mapping is
    // pinned THROUGHOUT the window, not just after it.
    await expectQuiet(async () => {
      const snapA = await snapOf(page, alpha, 't127-tab-a')
      const snapB = await snapOf(page, alpha, 't127-tab-b')
      expect(snapA?.resumeSessionId).toBe(ID_A)
      expect(snapB?.resumeSessionId).toBe(ID_B)
      expect(snapA?.status).toBe('live')
      expect(snapB?.status).toBe('live')
    }, quietWindow(TEST_POLL_MS, 4))
  })
})

// ─── E-025 — revive VALIDATES the known id against the tab's store ──────────────────
test.describe('E-025 — revive validation: an id the disk cannot back becomes a dead pane', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  const VALID_ID = '56565656-5656-4565-8565-565656565656'
  const STALE_ID = '78787878-7878-4787-8787-787878787878' // NO transcript on disk
  const TERM_VALID = 'val-gone-a'
  const TERM_STALE = 'val-gone-b'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
    const physRoot = await fs.realpath(alphaRoot)
    await seedFakeAgent(fixture, { script: FAKE_AGENT_RESUME })
    await seedTranscript(fixture, physRoot, VALID_ID) // only the VALID id exists
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: 'val-tab-ok',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: TERM_VALID,
          agentId: 'claude-test',
          cwd: alphaRoot,
          cwdAtLaunch: physRoot,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: VALID_ID,
          bindState: 'bound'
        },
        {
          id: 'val-tab-stale',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: TERM_STALE,
          agentId: 'claude-test',
          cwd: alphaRoot,
          cwdAtLaunch: physRoot,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: STALE_ID,
          bindState: 'bound'
        }
      ],
      activeTabId: 'val-tab-ok'
    })
    app = await launchApp(fixture)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the backed id revives; the unbacked one goes dead with its id KEPT (Resume retry)', async () => {
    test.slow()
    const page = await app!.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()

    const ok = await waitRevived(page, alpha, 'val-tab-ok', TERM_VALID)
    await expect
      .poll(() => readBuffer(page, ok.termId), { timeout: 20_000 })
      .toContain(`--resume ${VALID_ID}`)

    await expect
      .poll(async () => (await snapOf(page, alpha, 'val-tab-stale'))?.status ?? '', {
        timeout: 20_000
      })
      .toBe('dead')
    const stale = await snapOf(page, alpha, 'val-tab-stale')
    expect(stale?.termId).toBe(TERM_STALE) // no pty was spawned for it
    expect(stale?.resumeSessionId).toBe(STALE_ID) // the id is KEPT — retrying is the user's call
    await page.getByTestId('tab-val-tab-stale').click()
    await expect(page.getByTestId('terminal-dead-val-tab-stale')).toBeVisible()
    await expect(page.getByTestId('resume-val-tab-stale')).toBeVisible()
  })
})

// ─── E-025 — the store key is cwd-AT-LAUNCH, not the live cwd (subfolder fix) ────────
test.describe('E-025 — a subfolder-launched agent resumes in (and validates against) its launch cwd', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  const SUB_ID = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a'
  const GONE = 'sub-gone-agent'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
    await fs.mkdir(join(alphaRoot, 'deepwork'), { recursive: true })
    const physSub = await fs.realpath(join(alphaRoot, 'deepwork'))
    await seedFakeAgent(fixture, { script: FAKE_AGENT_RESUME })
    // The transcript lives in the SUBFOLDER's store — where the CLI (launched there) wrote it.
    await seedTranscript(fixture, physSub, SUB_ID)
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: 'sub-agent',
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: GONE,
          agentId: 'claude-test',
          // The LIVE cwd moved back to the project root after launch (a `cd ..` mid-session):
          // pre-E-025 the revive keyed everything on it and missed the subfolder store.
          cwd: alphaRoot,
          cwdAtLaunch: physSub,
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: SUB_ID,
          bindState: 'bound'
        }
      ],
      activeTabId: 'sub-agent'
    })
    app = await launchApp(fixture)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('revive spawns at cwdAtLaunch and validates against the subfolder store', async () => {
    test.slow()
    const page = await app!.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()

    const revived = await waitRevived(page, alpha, 'sub-agent', GONE)
    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain(`--resume ${SUB_ID}`)
    // The resume runs IN the launch directory — the store the transcript actually lives in.
    await expect
      .poll(() => ptyCwd(page, revived.termId), { timeout: 20_000 })
      .toMatch(/\/Projects\/alpha\/deepwork$/)
    expect(revived.resumeSessionId).toBe(SUB_ID)
  })
})
