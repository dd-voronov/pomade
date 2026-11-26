// modules: core, tabs, terminal, agents
// Pomade E-022 e2e — T-116 terminal scrollback snapshot: persist, replay with divider, forget.
//
// The thing under test: a PLAIN terminal's ring buffer is persisted to
// `.pomade/state/scrollback/<tabId>` (keyed on the TAB, which is what survives a restart — the
// termId does not), replayed above a dim `── session restored ──` divider when T-114's revive
// brings the tab back, and DELETED the moment the tab closes ("when I close it, we forget").
//
// Oracles, in order of authority: the snapshot FILE on disk (the only thing that can survive a
// restart), `pty.replay(termId)` (exactly the bytes the pane paints: restored scrollback +
// divider + ring buffer), `pty.buffer(termId)` (the LIVE ring only — proving the replayed history
// is not fed back into it, which is what makes restore→quit→restore converge instead of
// duplicating), and the xterm rows in the DOM (proof it reached the screen).
//
// State chains WITHIN each describe (its app runs are sequential) — tests append, never insert.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchApp } from './fixtures/app'
import { discardLine, promptCount, readBuffer, waitForPrompt, writePty, writeWhenReady } from './fixtures/stores'
import { FAKE_AGENT_TUI, seedFakeAgent } from './fixtures/fake-agent'
import { expectQuiet, quietWindow, TEST_SNAPSHOT_IDLE_MS } from './fixtures/timing'

// The human-readable core of the restore divider (the real rule is padded with `─` and wrapped in
// the dim SGR pair). Counting its occurrences is how "exactly one divider" is asserted.
const DIVIDER = 'session restored'

// A stand-in agent CLI — T-128 harness v3: a TUI-SHAPED one. A real agent CLI does not just print
// lines: it turns focus reporting (`?1004h`) and any-motion mouse tracking (`?1003h` + SGR
// `?1006h`) ON, QUERIES the terminal (CPR `ESC[6n`, DA1 `ESC[c`) and paints inside the ALTERNATE
// screen. Those bytes land in the ring buffer, hence in the T-116 snapshot — so a REPLAY re-feeds
// every query to xterm, which answers each one on `onData` (T-123's lesson). That is exactly the
// T-128 subject, and the reason the pre-v3 harness left this bug invisible for a whole epic
// ("green by coincidence", P-023's own warning).
//
// The QUERIES are emitted at STARTUP only, deliberately not in the farewell path: the replies
// xterm sends while the agent is LIVE are genuine input (the running agent consumes them, as a
// real CLI does), so a query printed next to the farewell would put real garbage in the fresh
// shell on ANY build and stop the specs below from discriminating. The MODE ENABLES are re-emitted
// right before the farewell on purpose — a mode is STATE, and the recording has to END with those
// modes on for the reset half of the fix to be observable. That is also the realistic shape: a CLI
// that is killed, crashes, or whose ring tail was RING_MAX-trimmed mid-session leaves focus and
// mouse reporting enabled in the recording (the Owner's `^[[I`-on-every-focus-change symptom).
// `/exit` is matched with a wildcard because the live replies arrive with no CR and get prepended
// to the next line the agent reads — a real CLI parses them out of its input, a stand-in cannot.

// T-128 — a caret-notated CSI reply echoed by zle: `^[[24;1R` (CPR), `^[[?1;2c` (DA1), `^[[I`
// (mode-1004 focus report). zsh's line editor echoes control bytes in CARET notation, which is
// why the Owner SAW the garbage; the ESC-byte form is matched too, in case something echoes raw.
const REPLY_GARBAGE = /(\^\[|\x1b)\[[0-9;?]*[RcIO]/

/** T-128 — the rows BELOW the restore divider: the FRESH shell's screen, which is the only era
 *  that may not contain reply garbage. Above the divider sits the replayed recording, and that
 *  legitimately contains the echoes of the replies xterm sent while the agent was LIVE (a running
 *  TUI must get its answers — the guard only suppresses the ones a REPLAY provokes). Falls back to
 *  the whole screen when no divider is on it, so a missing divider can never hide garbage. */
async function rowsAfterDivider(page: Page, termId: string): Promise<string> {
  const rows = await rowsText(page, termId)
  const at = rows.lastIndexOf(DIVIDER)
  return at === -1 ? rows : rows.slice(at + DIVIDER.length)
}

async function bootPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return page
}

/** Put the stand-in on disk and map the fixture's `claude-test` folder agent onto it. */

function stateFile(fixture: Fixture, projectId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`)
}

async function seedProjectState(fixture: Fixture, projectId: string, state: unknown): Promise<void> {
  await fs.mkdir(join(fixture.workspaceRoot, '.pomade', 'state'), { recursive: true })
  await fs.writeFile(stateFile(fixture, projectId), JSON.stringify(state, null, 2))
}

// ── the snapshot file: `<workspace>/.pomade/state/scrollback/<tabId>` ─────────────────
function snapshotPath(fixture: Fixture, tabId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback', tabId)
}

async function seedSnapshot(fixture: Fixture, tabId: string, content: string): Promise<void> {
  await fs.mkdir(join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback'), { recursive: true })
  await fs.writeFile(snapshotPath(fixture, tabId), content, 'utf8')
}

async function snapshotOf(fixture: Fixture, tabId: string): Promise<string | null> {
  try {
    return await fs.readFile(snapshotPath(fixture, tabId), 'utf8')
  } catch {
    return null
  }
}

async function snapshotMtime(fixture: Fixture, tabId: string): Promise<number> {
  const stat = await fs.stat(snapshotPath(fixture, tabId))
  return stat.mtimeMs
}

async function scrollbackDir(fixture: Fixture): Promise<string[]> {
  try {
    return (
      await fs.readdir(join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback'))
    ).sort()
  } catch {
    return []
  }
}

// ── pty oracles ──────────────────────────────────────────────────────────────────────

/** The full paint an attaching xterm gets: restored scrollback + divider + ring buffer. */
function readReplay(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.replay(tid), termId)
}


/** What the pane actually SHOWS — the xterm rows in the DOM (same oracle as terminal-copy). */
function rowsText(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
    return Array.from(rows)
      .map((r) => r.textContent ?? '')
      .join('\n')
  }, termId)
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function countDividers(text: string): number {
  return occurrences(text, DIVIDER)
}

interface TabSnap {
  id: string
  kind: string
  status: string
  termId: string
}

function tabSnaps(page: Page, projectId: string): Promise<TabSnap[]> {
  return page.evaluate((pid) => {
    const stores = window.__pomadeStores
    return (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      termId: t.termId
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
      // Revive = app relaunch + a real interactive login zsh; on a loaded machine that legitimately
      // exceeds 20s (T-146). Generous headroom so a slow-but-correct revive isn't read as a failure.
      { timeout: 60_000 }
    )
    .toBe(true)
  const snap = await snapOf(page, projectId, tabId)
  if (!snap) throw new Error(`tab ${tabId} vanished`)
  return snap
}

async function openProjectTerminal(page: Page, projectId: string): Promise<TabSnap> {
  await page.getByTestId(`project-${projectId}`).click()
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  await expect
    .poll(async () => (await tabSnaps(page, projectId)).length, { timeout: 20_000 })
    .toBe(1)
  return (await tabSnaps(page, projectId))[0]
}

// ─── persist → replay with ONE divider → restore/quit cycles converge ──────────────────
// Three sequential app runs in ONE fixture: (1) produce output, (2) revive and read the replay,
// (3) revive again — the cycle that must not duplicate content or stack dividers.
test.describe('T-116 — a terminal comes back with its scrollback above a restore divider', () => {
  let fixture: Fixture
  let alpha = ''
  let tabId = ''
  let termRun1 = ''
  let termRun2 = ''
  // How often MARK_ONE occurs in everything run 2 hands on — run 3's convergence baseline.
  let markOneInRun2 = 0
  const MARK_ONE = 'SCROLLBACK_MARK_ONE'
  const MARK_TWO = 'SCROLLBACK_MARK_TWO'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('run 1 — the ring buffer is persisted while the app is still running', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)
    tabId = tab.id
    termRun1 = tab.termId

    await writeWhenReady(page, termRun1, `echo ${MARK_ONE}\r`)
    await expect.poll(() => readBuffer(page, termRun1), { timeout: 20_000 }).toContain(MARK_ONE)
    // Crash-resilient, not quit-only: the debounced write (~2 s idle) lands mid-run.
    await expect
      .poll(async () => (await snapshotOf(fixture, tabId)) ?? '', { timeout: 20_000 })
      .toContain(MARK_ONE)
    // Nothing else in the workspace grew a snapshot — one file per plain terminal tab.
    expect(await scrollbackDir(fixture)).toEqual([tabId])

    await app.close()
  })

  test('run 2 — the revived pane paints old output, the divider, then the live shell', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun1)
    termRun2 = revived.termId

    // The paint an attaching xterm gets: history, then EXACTLY ONE divider, then live output.
    await expect.poll(() => readReplay(page, termRun2), { timeout: 20_000 }).toContain(DIVIDER)
    const paint = await readReplay(page, termRun2)
    expect(paint).toContain(MARK_ONE)
    expect(countDividers(paint)).toBe(1)
    expect(paint.indexOf(MARK_ONE)).toBeLessThan(paint.indexOf(DIVIDER))
    // The restored bytes are NOT fed back into the live ring buffer — that separation is what
    // keeps repeated restore cycles from duplicating scrollback (see run 3). The DIVIDER is the
    // sound sentinel: it exists only in the restored replay, is never program output and is never
    // pre-typed, so its absence from the ring proves the restored bytes aren't in the live ring.
    // MARK_ONE is deliberately NOT asserted-absent here (T-146): T-115 legitimately pre-types the
    // last command `echo …MARK_ONE` into the revived shell, whose line-editor echo puts MARK_ONE in
    // the ring — asserting its absence contradicts that feature and races the async pre-type.
    const ring = await readBuffer(page, termRun2)
    expect(ring).not.toContain(DIVIDER)

    // …and it really reached the screen.
    await expect.poll(() => rowsText(page, termRun2), { timeout: 20_000 }).toContain(MARK_ONE)
    expect(await rowsText(page, termRun2)).toContain(DIVIDER)

    // The shell below the divider is a live, usable one. Ctrl+C first: T-115 pre-typed the last
    // executed command into this fresh shell's line editor, and typing over it would submit both.
    await waitForPrompt(page, termRun2)
    await discardLine(page, termRun2)
    await writePty(page, termRun2, `echo ${MARK_TWO}\r`)
    await expect.poll(() => readBuffer(page, termRun2), { timeout: 20_000 }).toContain(MARK_TWO)
    const after = await readReplay(page, termRun2)
    expect(after.indexOf(DIVIDER)).toBeLessThan(after.indexOf(MARK_TWO))

    // The debounced snapshot must hand MARK_TWO on before this run ends — poll the file itself.
    await expect
      .poll(async () => (await snapshotOf(fixture, tabId)) ?? '', { timeout: 20_000 })
      .toContain(MARK_TWO)
    // The convergence baseline for run 3: how often MARK_ONE appears in everything this run will
    // hand on (a marker occurs several times by construction — the echoed command line, its
    // output — so the invariant is that ANOTHER cycle adds none of them, not that it appears once).
    markOneInRun2 = occurrences(await readReplay(page, termRun2), MARK_ONE)
    expect(markOneInRun2).toBeGreaterThan(0)
    await app.close()
  })

  test('run 3 — a second restore cycle keeps both sessions and still ONE divider', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun2)

    await expect.poll(() => readReplay(page, revived.termId), { timeout: 20_000 }).toContain(MARK_TWO)
    const paint = await readReplay(page, revived.termId)
    // Cumulative: the run-1 history survived the run-2 restore instead of being overwritten…
    expect(paint).toContain(MARK_ONE)
    expect(paint).toContain(MARK_TWO)
    // …with nothing duplicated by passing through a second cycle: the snapshot is base + this
    // run's ring, never base + its own replay, so the count is exactly what run 2 handed on.
    expect(occurrences(paint, MARK_ONE)).toBe(markOneInRun2)
    // …and the divider does not stack: the restore boundary is injected at replay time and is
    // never written to disk, so there is one, always.
    expect(countDividers(paint)).toBe(1)
    expect(paint.indexOf(MARK_TWO)).toBeLessThan(paint.indexOf(DIVIDER))

    await app.close()
  })
})

// ─── forget on close is now DEFERRED by T-149 ────────────────────────────────────────────
// T-116 originally deleted the snapshot the instant a tab closed ("when I close it, we forget").
// T-149's per-project reopen stack keeps a closed tab — and its scrollback — reopenable, so the
// snapshot must now SURVIVE the close: it is forgotten only when the entry permanently LEAVES the
// stack (cap eviction; a vanished-doc drop, which owns no snapshot; or an explicit clear). The
// eviction-forget path is pinned in reopen-closed-tab.spec.ts §4. This test pins the superseding
// contract at the close edge: the file stays put, ready for a reopen.
test.describe('T-149 — closing a terminal KEEPS its scrollback for reopen (deferred forget)', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the snapshot file survives the close (the tab is on the reopen stack)', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)

    await writeWhenReady(page, tab.termId, 'echo KEEP_ME_MARK\r')
    await expect
      .poll(async () => (await snapshotOf(fixture, tab.id)) ?? '', { timeout: 20_000 })
      .toContain('KEEP_ME_MARK')

    // An idle plain terminal closes silently (no close guard), through the strip's × — the same
    // tab-lifecycle diff every other close path (Cmd+W, bulk close, context menu) goes through.
    await page.getByTestId(`close-${tab.id}`).click()
    await expect.poll(async () => (await tabSnaps(page, alpha)).length, { timeout: 20_000 }).toBe(0)

    // T-149 — the tab is now on the reopen stack, so its snapshot is NOT forgotten (a forget would
    // have fired within a tick of the close if it were going to; a pending debounced write within
    // a few tuned idles). It remains — held for the whole window — as the scrollback a reopen replays.
    await expectQuiet(async () => {
      expect(await snapshotOf(fixture, tab.id)).toContain('KEEP_ME_MARK')
      expect(await scrollbackDir(fixture)).toEqual([tab.id])
    }, quietWindow(TEST_SNAPSHOT_IDLE_MS, 5))
  })
})

// ─── sticky: an un-revived tab's snapshot is never touched ─────────────────────────────
// Fabricated restore state + a hand-written snapshot (revive.spec.ts's pattern): the only way to
// pin "two whole app runs that never open the project" without depending on a first real run.
test.describe('T-116 — an un-revived snapshot is byte-stable across restarts', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  const TAB = 'sticky-scroll-tab'
  const GONE_TERM = 'sticky-scroll-gone'
  const STICKY = 'STICKY_SCROLLBACK_MARK\r\n'
  let baseline = ''
  let baselineMtime = 0

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: TAB,
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 1',
          termId: GONE_TERM,
          cwd: join(fixture.workspaceRoot, 'Projects/alpha'),
          status: 'live'
        }
      ],
      activeTabId: TAB
    })
    await seedSnapshot(fixture, TAB, STICKY)
    baseline = (await snapshotOf(fixture, TAB)) ?? ''
    baselineMtime = await snapshotMtime(fixture, TAB)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('two runs that never open the project leave the file untouched', async () => {
    test.slow()
    for (const _run of [1, 2]) {
      const run = await launchApp(fixture)
      const page = await bootPage(run)
      // Stay on the boot-time active project (the Workspace project) — alpha is never
      // opened, so nothing revives, no pty is spawned, and nothing may rewrite the snapshot.
      await expect(page.getByTestId('panehost')).toHaveAttribute(
        'data-active-project',
        '__workspace__'
      )
      // Panes mount + reconcile inside this window, and a spurious revive's debounced write
      // (tuned SNAPSHOT_IDLE) would land well within it — the file must hold THROUGHOUT.
      await expectQuiet(async () => {
        expect(await snapshotOf(fixture, TAB)).toBe(baseline)
        // No mtime churn either: the file was not rewritten with identical content.
        expect(await snapshotMtime(fixture, TAB)).toBe(baselineMtime)
      }, quietWindow(TEST_SNAPSHOT_IDLE_MS, 5))
      await run.close()
      // …and the close path (final flushes) rewrote nothing either.
      expect(await snapshotOf(fixture, TAB)).toBe(baseline)
      expect(await snapshotMtime(fixture, TAB)).toBe(baselineMtime)
    }
  })

  test('the third run replays it', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, TAB, GONE_TERM)

    await expect
      .poll(() => readReplay(page, revived.termId), { timeout: 20_000 })
      .toContain('STICKY_SCROLLBACK_MARK')
    const paint = await readReplay(page, revived.termId)
    expect(countDividers(paint)).toBe(1)
    expect(paint.indexOf('STICKY_SCROLLBACK_MARK')).toBeLessThan(paint.indexOf(DIVIDER))
  })
})

// ─── agent tabs never replay (grooming decision) ───────────────────────────────────────
test.describe('T-116 — an agent tab revives with no replay', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  const TAB = 'agent-scroll-tab'
  const GONE_TERM = 'agent-scroll-gone'
  const RESUME_ID = 'acacacac-acac-4cac-8cac-acacacacacac'
  const OLD = 'AGENT_OLD_SCROLLBACK_MARK\r\n'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    await seedFakeAgent(fixture, { script: FAKE_AGENT_TUI })
    // E-025 — revive VALIDATES a persisted id against the tab's store (keyed by the physical
    // launch cwd) before spawning `--resume`; the fabricated id needs its transcript on disk.
    const storeDir = join(
      fixture.workspaceRoot,
      'Agents/claude-test/projects',
      (await fs.realpath(join(fixture.workspaceRoot, 'Projects/alpha'))).replace(
        /[^a-zA-Z0-9]/g,
        '-'
      )
    )
    await fs.mkdir(storeDir, { recursive: true })
    await fs.writeFile(
      join(storeDir, `${RESUME_ID}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'seeded transcript' },
        timestamp: new Date().toISOString()
      }) + '\n'
    )
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: TAB,
          projectId: alpha,
          kind: 'agent',
          title: 'claude-test',
          termId: GONE_TERM,
          agentId: 'claude-test',
          cwd: join(fixture.workspaceRoot, 'Projects/alpha'),
          status: 'live',
          lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
          resumeSessionId: RESUME_ID
        }
      ],
      activeTabId: TAB
    })
    // A leftover from before this tab was upgraded to an agent. It must not be painted over the
    // CLI's own resume redraw (the Owner: "agent controls their own restore process").
    await seedSnapshot(fixture, TAB, OLD)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('no divider, no old bytes — only the resume command flow', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, TAB, GONE_TERM)

    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain(`--resume ${RESUME_ID}`)
    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain('AGENT_READY')
    // Real-world window (async replay/paint timing, not interval-derived): anything that was
    // going to be painted would land well inside 2500ms — held throughout, not slept through.
    await expectQuiet(async () => {
      const paint = await readReplay(page, revived.termId)
      expect(paint).not.toContain('AGENT_OLD_SCROLLBACK_MARK')
      expect(paint).not.toContain(DIVIDER)
      // And an agent term never WRITES a snapshot either: the leftover file is untouched.
      expect(await snapshotOf(fixture, TAB)).toBe(OLD)
    }, 2500)
  })
})

// ─── the terminal→agent upgrade stops snapshotting; `/exit` resumes it ─────────────────
test.describe('T-116 — snapshotting follows what is running in the shell', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  let scriptPath = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    scriptPath = await seedFakeAgent(fixture, { script: FAKE_AGENT_TUI })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('an upgrade drops the snapshot; the /exit downgrade starts it again', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)

    await writeWhenReady(page, tab.termId, 'echo BEFORE_UPGRADE_MARK\r')
    await expect
      .poll(async () => (await snapshotOf(fixture, tab.id)) ?? '', { timeout: 20_000 })
      .toContain('BEFORE_UPGRADE_MARK')

    // Typing a roster agent command upgrades the tab — it is an AGENT tab now, and an agent tab
    // never snapshots and never replays, so the file goes away.
    await writePty(page, tab.termId, `${scriptPath}\r`)
    await expect
      .poll(async () => (await snapOf(page, alpha, tab.id))?.kind ?? '', { timeout: 20_000 })
      .toBe('agent')
    await expect.poll(() => snapshotOf(fixture, tab.id), { timeout: 20_000 }).toBeNull()

    // `/exit` hands the shell back — a plain terminal again, so it snapshots again, and the
    // pre-agent history (still in the live ring buffer) comes back with it.
    await writePty(page, tab.termId, '/exit\r')
    await expect
      .poll(async () => (await snapOf(page, alpha, tab.id))?.kind ?? '', { timeout: 20_000 })
      .toBe('terminal')
    await writeWhenReady(page, tab.termId, 'echo AFTER_DOWNGRADE_MARK\r')
    await expect
      .poll(async () => (await snapshotOf(fixture, tab.id)) ?? '', { timeout: 20_000 })
      .toContain('AFTER_DOWNGRADE_MARK')
    expect(await snapshotOf(fixture, tab.id)).toContain('BEFORE_UPGRADE_MARK')
  })
})

// ─── T-128: the replay paint never feeds the pty ───────────────────────────────────────
// The Owner's 0.2.0 repro, manifestation 1: typed `claude`, `hi`, `/exit`, quit, relaunch → the
// farewell painted fine but the fresh prompt filled with `^[[I ^[[?1;2c ^[[?39;3R…` and kept
// leaking `^[[I` on every focus change. The replayed snapshot carries the agent TUI's QUERIES and
// MODE ENABLES; xterm answers the queries on `onData` (which is a pty forward, T-123) and honours
// the modes, so a recording of a dead session was typing into a live shell.
//
// Oracles: `pty.buffer(newTermId)` — the LIVE ring of the fresh pty, i.e. exactly what this shell
// emitted and echoed, with none of the restored bytes in it (T-116 keeps them apart) — plus the
// xterm rows. Reply garbage in either is the bug. State chains within the describe.
test.describe('T-128 — a replayed agent era never reaches the fresh shell', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''
  let scriptPath = ''
  let tabId = ''
  let termRun1 = ''
  let termRun2 = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    scriptPath = await seedFakeAgent(fixture, { script: FAKE_AGENT_TUI })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('run 1 — the exited agent leaves its TUI era AND its farewell in the snapshot', async () => {
    test.slow()
    app = await launchApp(fixture)
    page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)
    tabId = tab.id
    termRun1 = tab.termId

    await writeWhenReady(page, termRun1, 'echo T128_PRE_AGENT_MARK\r')
    await expect
      .poll(() => readBuffer(page, termRun1), { timeout: 20_000 })
      .toContain('T128_PRE_AGENT_MARK')

    // Hand-typed launch → the tab upgrades and the TUI-shaped stand-in runs its burst.
    await writePty(page, termRun1, `${scriptPath}\r`)
    await expect.poll(() => readBuffer(page, termRun1), { timeout: 20_000 }).toContain('AGENT_READY')
    await expect
      .poll(async () => (await snapOf(page, alpha, tabId))?.kind ?? '', { timeout: 20_000 })
      .toBe('agent')

    // `/exit` → farewell, downgrade, snapshotting resumes and persists BOTH eras.
    await writePty(page, termRun1, '/exit\r')
    await expect
      .poll(async () => (await snapOf(page, alpha, tabId))?.kind ?? '', { timeout: 20_000 })
      .toBe('terminal')
    await expect
      .poll(async () => (await snapshotOf(fixture, tabId)) ?? '', { timeout: 20_000 })
      .toContain('To resume this session, run: claude --resume')

    // The snapshot is loaded: it really does carry the queries and mode enables the replay will
    // re-feed to xterm (without this, the specs below would pass on any build).
    const snapshot = (await snapshotOf(fixture, tabId)) ?? ''
    expect(snapshot).toContain('\x1b[6n') // CPR query
    expect(snapshot).toContain('\x1b[c') // DA1 query
    expect(snapshot).toContain('\x1b[?1004h') // focus reporting left ON
    expect(snapshot).toContain('\x1b[?1003h') // any-motion mouse left ON
    // CONTROL, and the boundary of the whole fix: while the agent was LIVE its queries WERE
    // answered into the pty — the echo of those replies is right here in this era's own bytes.
    // The guard suppresses only what a REPLAY provokes; a running TUI still gets its answers.
    expect(snapshot).toMatch(/\^\[\[[0-9]+;[0-9]+R/)
    await app.close()
    app = undefined
  })

  test('run 2 — the farewell paints and NOTHING the paint provokes reaches the pty', async () => {
    test.slow()
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun1)
    termRun2 = revived.termId

    // The restore itself is unchanged: farewell + pre-agent history above exactly one divider.
    await expect
      .poll(() => readReplay(page, termRun2), { timeout: 20_000 })
      .toContain('To resume this session, run: claude --resume')
    const paint = await readReplay(page, termRun2)
    expect(paint).toContain('T128_PRE_AGENT_MARK')
    expect(countDividers(paint)).toBe(1)
    await expect
      .poll(() => rowsText(page, termRun2), { timeout: 20_000 })
      .toContain('To resume this session, run: claude --resume')
    expect(await rowsText(page, termRun2)).toContain(DIVIDER)

    // THE T-128 ASSERTION. The fresh zsh's own output holds no auto-reply garbage: the replay's
    // queries were answered inside the guard window and dropped, and the replayed `?1004h`/`?1003h`
    // were reset in xterm afterwards, so nothing keeps arriving either.
    // Real-world window (zsh echo round-trip, not interval-derived): any storm would have been
    // echoed several times over inside 2500ms — held throughout, not slept through.
    await expectQuiet(async () => {
      expect(await readBuffer(page, termRun2)).not.toMatch(REPLY_GARBAGE)
      expect(await rowsAfterDivider(page, termRun2)).not.toMatch(REPLY_GARBAGE)
    }, 2500)

    // …and the pane is USABLE: real keystrokes (xterm → onData → pty) land, which is also the
    // proof that the guard window actually CLOSED. Ctrl+C first — T-115 pre-typed the pre-agent
    // command into this shell's line editor.
    await page.getByTestId(`tab-${tabId}`).click()
    await page.getByTestId(`terminal-${tabId}`).click({ position: { x: 60, y: 60 } })
    const prompts = await promptCount(page, termRun2)
    await page.keyboard.press('Control+c')
    await expect.poll(() => promptCount(page, termRun2), { timeout: 10_000 }).toBeGreaterThan(prompts)
    await page.keyboard.type('echo T128_TYPED_MARK')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => readBuffer(page, termRun2), { timeout: 20_000 })
      .toContain('T128_TYPED_MARK')
    // Typing did not smuggle garbage in either (a leaked mode would report the click above).
    expect(await readBuffer(page, termRun2)).not.toMatch(REPLY_GARBAGE)
  })

  test('run 2 — a focus flip after the replay leaks no focus/mouse reports', async () => {
    test.slow()
    // The Owner's "keeps leaking `^[[I` on focus changes": the replayed stream re-ENABLED focus
    // reporting (`?1004h`) and any-motion mouse tracking (`?1003h`/`?1006h`) in a terminal whose
    // pty is a plain zsh, so every focus flip and every pointer event kept sending reports into it
    // long after the paint. A mode is STATE, which is why suppressing the paint's replies alone is
    // not enough — the resets are a second, separate half of the fix.
    //
    // The oracle is `cat -v`, not the shell's echo: zle SWALLOWS a lone `ESC[I` as an unbound key
    // sequence (probed — the spec passed with the resets removed while relying on echo), whereas
    // `cat -v` renders every byte it receives on stdin in caret notation, so anything the pane
    // emits shows up as OUTPUT. Typing it also re-proves the guard window closed.
    await page.getByTestId(`terminal-${tabId}`).click({ position: { x: 60, y: 60 } })
    await page.keyboard.type('cat -v')
    await page.keyboard.press('Enter')
    await page.keyboard.type('T128_CAT_PROBE')
    await page.keyboard.press('Enter')
    // Two copies = the tty's own echo + `cat` writing the line back: it is running and reading.
    await expect
      .poll(() => readBuffer(page, termRun2).then((b) => occurrences(b, 'T128_CAT_PROBE')), {
        timeout: 20_000
      })
      .toBeGreaterThanOrEqual(2)
    const beforeFlips = (await readBuffer(page, termRun2)).length

    for (const _flip of [1, 2, 3]) {
      await page.evaluate((tid) => {
        const ta = document.querySelector(
          `[data-term-id="${tid}"] .xterm-helper-textarea`
        ) as HTMLTextAreaElement | null
        ta?.blur()
        ta?.focus()
      }, termRun2)
      // eslint-disable-next-line playwright/no-wait-for-timeout -- paces three distinct focus flips like a user's; with the fix nothing is observable to wait on
      await page.waitForTimeout(150)
    }
    // A real pointer press/release over the pane: under a replayed `?1003h`+`?1006h` it reports
    // itself (`ESC[<0;…M`) instead of just placing the caret.
    await page.getByTestId(`terminal-${tabId}`).click({ position: { x: 90, y: 40 } })

    // NOTHING arrives on stdin: `cat` writes nothing, so no escape shows up in the window it
    // owns. Real-world window (tty round-trip after the click, not interval-derived) — held
    // throughout, not slept through.
    await expectQuiet(async () => {
      const leaked = (await readBuffer(page, termRun2)).slice(beforeFlips)
      expect(leaked).not.toMatch(/\^\[/)
      expect(leaked).not.toMatch(REPLY_GARBAGE)
      expect(await rowsAfterDivider(page, termRun2)).not.toMatch(REPLY_GARBAGE)
    }, 1500)
    await page.keyboard.press('Control+c') // let go of `cat` before the app is torn down
  })
})

// ─── T-128: a BUTTON-launched agent tab keeps its farewell ─────────────────────────────
// The Owner's repro, manifestation 2: a tab created FROM THE "+" MENU came back completely EMPTY
// after `/exit` + relaunch. `startAgent` passed no `snapshotKey`, so the T-116 downgrade had
// nothing to snapshot with — the documented limit, which E-025 turned into a real bug the moment
// the farewell line became the manual-recovery copy source. It now carries a key (and snapshots
// NOTHING while the agent runs).
test.describe('T-128 — a button-launched agent tab snapshots after its /exit downgrade', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''
  let tabId = ''
  let termRun1 = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    await seedFakeAgent(fixture, { script: FAKE_AGENT_TUI })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('run 1 — nothing is written while the agent runs; the downgrade starts it', async () => {
    test.slow()
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    await expect
      .poll(async () => (await tabSnaps(page, alpha)).filter((t) => t.kind === 'agent').length, {
        timeout: 20_000
      })
      .toBe(1)
    const tab = present((await tabSnaps(page, alpha)).find((t) => t.kind === 'agent'), 'agent tab')
    tabId = tab.id
    termRun1 = tab.termId
    await expect.poll(() => readBuffer(page, termRun1), { timeout: 20_000 }).toContain('AGENT_READY')

    // A term spawned WITH a launch command starts non-snapshotting: an agent's TUI frames are
    // never persisted (and never replayed), key or no key. A snapshotting term would have
    // written one (tuned) SNAPSHOT_IDLE after AGENT_READY — hold several idles to prove none does.
    await expectQuiet(async () => {
      expect(await snapshotOf(fixture, tabId)).toBeNull()
      expect(await scrollbackDir(fixture)).toEqual([])
    }, quietWindow(TEST_SNAPSHOT_IDLE_MS, 4))

    // `/exit`: the farewell, the downgrade — and now a snapshot, because the tab HAS a key.
    await writePty(page, termRun1, '/exit\r')
    await expect
      .poll(async () => (await snapOf(page, alpha, tabId))?.kind ?? '', { timeout: 20_000 })
      .toBe('terminal')
    await expect
      .poll(async () => (await snapshotOf(fixture, tabId)) ?? '', { timeout: 20_000 })
      .toContain('To resume this session, run: claude --resume')
    await app.close()
    app = undefined
  })

  test('run 2 — the revived pane shows the farewell above the divider, garbage-free', async () => {
    test.slow()
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun1)

    await expect
      .poll(() => readReplay(page, revived.termId), { timeout: 20_000 })
      .toContain('To resume this session, run: claude --resume')
    expect(countDividers(await readReplay(page, revived.termId))).toBe(1)
    await expect
      .poll(() => rowsText(page, revived.termId), { timeout: 20_000 })
      .toContain('To resume this session, run: claude --resume')
    // The same replay guard applies here — this snapshot is an agent era too. Real-world window
    // (zsh echo round-trip, not interval-derived), held throughout.
    await expectQuiet(async () => {
      expect(await readBuffer(page, revived.termId)).not.toMatch(REPLY_GARBAGE)
      expect(await rowsAfterDivider(page, revived.termId)).not.toMatch(REPLY_GARBAGE)
    }, 2500)
  })
})

// ─── T-128: a replay stranded in the alternate screen ──────────────────────────────────
// RING_MAX trims the OLDEST bytes, so a long agent era can leave a snapshot that enters the
// alternate screen (`?1049h`) and never leaves it. Replayed as-is, the pane would keep painting —
// prompt included — into an alt buffer whose content xterm discards, and the restored history in
// the normal buffer would be invisible. The defensive `?1049l` (xterm only, and only when the
// paint really left us there) is what lands the fresh shell back on the normal screen.
test.describe('T-128 — a snapshot that ends inside the alternate screen', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  const TAB = 't128-altscreen-tab'
  const GONE_TERM = 't128-altscreen-gone'
  const STRANDED = 'T128_NORMAL_SCREEN_MARK\r\n\x1b[?1049hT128_ALT_FRAME_MARK\r\n'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: TAB,
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 1',
          termId: GONE_TERM,
          cwd: join(fixture.workspaceRoot, 'Projects/alpha'),
          status: 'live'
        }
      ],
      activeTabId: TAB
    })
    await seedSnapshot(fixture, TAB, STRANDED)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the pane comes back on the NORMAL screen, with its history and a live prompt', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, TAB, GONE_TERM)

    // Visible = the normal buffer: the restored history is there and the alt frame is gone with
    // the buffer xterm threw away.
    await expect
      .poll(() => rowsText(page, revived.termId), { timeout: 20_000 })
      .toContain('T128_NORMAL_SCREEN_MARK')
    expect(await rowsText(page, revived.termId)).not.toContain('T128_ALT_FRAME_MARK')

    // And it is a usable shell on that screen (typed for real, so this also re-pins the guard).
    await page.getByTestId(`terminal-${TAB}`).click({ position: { x: 60, y: 60 } })
    await page.keyboard.type('echo T128_ALT_RECOVERED_MARK')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => rowsText(page, revived.termId), { timeout: 20_000 })
      .toContain('T128_ALT_RECOVERED_MARK')
  })
})

// ─── T-147: the restored block replays without zsh's partial-line marker ────────────────
// Before drawing each prompt, zsh emits a partial-line marker: a REVERSE-VIDEO glyph (`%` for a
// user, `#` for root — PROMPT_EOL_MARK) PADDED WITH SPACES to the terminal width, then `\r ␠\r`
// that overwrites the glyph. It is transient chrome — the prompt redraw that follows (`\r … \x1b[J`)
// erases it, so it is invisible live. But its padding is sized to the CAPTURE width, and a revive
// replays the snapshot into an xterm that is 80 cols until its FitAddon runs (which races, and
// usually loses, the async replay). Parsed at 80 the wide padding auto-wraps, the marker's
// self-erase lands on the wrong row, and the reverse-`%` survives as a STRAY LINE — one per
// restored prompt: the "restored block is double-spaced with a %/box glyph above every prompt" a
// user reported after a reload (T-147). Live, the identical bytes rendered clean.
//
// Fix (pty-manager.replay → stripEolMarkers): the marker is dropped from the RESTORED base of the
// replay paint, so no width-sized padding is left to wrap at any width or fit timing. The on-disk
// snapshot stays a byte-exact recording (T-116); only the replayed paint is sanitized.
//
// Oracles, strongest first: (a) the REPLAY BYTES — the restored region (above the divider) must
// carry NO partial-line marker: no reverse-video SGR and no `\r ␠\r` erase idiom. This is the
// deterministic guard — it is present pre-fix and absent post-fix regardless of render timing.
// (b) the xterm ROWS above the divider — no bare `%`/control-picture row and no inserted blank
// row — the user-visible symptom. Two commands are produced so the pre-fix bug seeded TWO markers.
test.describe('T-147 — a revived terminal replays its scrollback without doubling or a stray glyph', () => {
  let fixture: Fixture
  let alpha = ''
  let tabId = ''
  let termRun1 = ''
  const A1 = 'T147_A_ONE'
  const A2 = 'T147_A_TWO'
  const A3 = 'T147_A_THREE'
  const B1 = 'T147_B_ONE'
  const B2 = 'T147_B_TWO'
  const CONTENT = [A1, A2, A3, B1, B2]
  // The zsh partial-line marker in the RAW replay bytes: an SGR that turns reverse/standout ON
  // (code 7 as a whole `;`-separated param — `[27m` "reverse OFF" is not it), a glyph, SGR, then
  // the `\r ␠\r` (CR, space, CR) erase. This is exactly what the fix removes from restored bytes.
  const EOL_MARK_BYTES = /\x1b\[(?:\d+;)*7(?:;\d+)*m[^\x1b\r\n](?:\x1b\[[\d;]*m)* *\r \r/
  // A rendered row that is nothing but the marker glyph: the reverse-`%` (DOM text drops SGR, so a
  // literal `%`), or a box / control-picture stand-in, optionally space-padded. A legit PROMPT row
  // ENDS with `% ` and never STARTS with the glyph, so this cannot match one.
  const STRAY_MARKER = /^[%␀-␦�█]\s*$/

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('run 1 — produce two multi-line command outputs and persist them', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)
    tabId = tab.id
    termRun1 = tab.termId

    // Two separate commands ⇒ two prompts ⇒ two EOL markers captured into the snapshot.
    await writeWhenReady(page, termRun1, `printf '${A1}\\n${A2}\\n${A3}\\n'\r`)
    await expect.poll(() => readBuffer(page, termRun1), { timeout: 20_000 }).toContain(A3)
    await writePty(page, termRun1, `printf '${B1}\\n${B2}\\n'\r`)
    await expect.poll(() => readBuffer(page, termRun1), { timeout: 20_000 }).toContain(B2)
    // Let the debounced snapshot land with everything in it. The raw snapshot legitimately STILL
    // contains the markers (it is a byte-exact recording); the fix sanitizes them on REPLAY only.
    await expect
      .poll(async () => (await snapshotOf(fixture, tabId)) ?? '', { timeout: 20_000 })
      .toContain(B2)

    await app.close()
  })

  test('run 2 — the revived pane replays clean: no marker in the bytes, none on screen', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun1)

    await expect.poll(() => readReplay(page, revived.termId), { timeout: 20_000 }).toContain(B2)
    const paint = await readReplay(page, revived.termId)

    // Exactly one divider (the T-116 invariant, re-pinned).
    expect(countDividers(paint)).toBe(1)

    // (A) THE DETERMINISTIC GUARD — the restored region of the replay bytes (everything before the
    // divider) is free of zsh's partial-line marker. Pre-fix this region held TWO; the fix strips
    // them at the replay boundary, so a regression re-introduces a match here regardless of timing.
    const restoredBytes = paint.slice(0, paint.indexOf(DIVIDER))
    expect(restoredBytes).toContain(A3) // the recording really is in there…
    expect(restoredBytes).toContain(B2)
    expect(EOL_MARK_BYTES.test(restoredBytes)).toBe(false) // …with no marker left to wrap
    expect(restoredBytes).not.toContain('\r \r') // its CR-space-CR erase idiom is gone too

    // (B) THE USER-VISIBLE SYMPTOM — the rows above the divider. With the marker gone from the
    // paint there is nothing to wrap at any width, so this is deterministic too.
    await expect.poll(() => rowsText(page, revived.termId), { timeout: 20_000 }).toContain(B2)
    const rows = (await rowsText(page, revived.termId)).split('\n')
    expect(countDividers(rows.join('\n'))).toBe(1)
    const dividerRow = rows.findIndex((r) => r.includes(DIVIDER))
    expect(dividerRow).toBeGreaterThan(0)
    const restored = rows.slice(0, dividerRow)

    // No stray glyph row (pre-fix: two), and no inserted blank row within the produced span.
    expect(restored.filter((r) => STRAY_MARKER.test(r))).toEqual([])
    const first = restored.findIndex((r) => r.trim() !== '')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(restored.slice(first).some((r) => r.trim() === '')).toBe(false)

    // …and the content survived, in order — a clean replay is not an empty one.
    const seen = CONTENT.map((m) => restored.findIndex((r) => r.includes(m)))
    expect(seen.every((i) => i >= 0)).toBe(true)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)

    await app.close()
  })
})
