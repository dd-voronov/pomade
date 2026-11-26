// modules: terminal, tabs, agents
// Pomade E-022 e2e — T-115 last executed command: capture, persist sticky, pre-type on revive.
//
// The thing under test: the zsh shim's `preexec` marker is broadcast to the renderer (EV.ptyExec),
// persisted per plain-terminal tab as `TerminalTab.lastExec`, and typed back into the fresh shell —
// WITHOUT a CR — when T-114's revive brings the tab back. Nothing runs by itself: the restored text
// sits in zsh's line editor waiting for the user, which is also why it can never be re-captured and
// therefore survives any number of reloads (the Owner's double-reload case).
//
// Assertions read main's authoritative pty ring buffer (`pty.buffer`) for what the shell saw, the
// tabs-store for the in-memory field, and `.pomade/state/<projectId>.json` for the persisted one
// (the sticky assertions HAVE to read the file — the store would be happy with a field that never
// reached disk). "It did not run" is proven by a side-effect file the command would have created.
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
import { launchApp } from './fixtures/app'
import { discardLine, readBuffer, waitForPrompt, writePty, writeWhenReady } from './fixtures/stores'
import { FAKE_AGENT_ECHO_EXIT_ANNOUNCE, seedFakeAgent } from './fixtures/fake-agent'
import { expectQuiet } from './fixtures/timing'

// A stand-in "agent": announces readiness, echoes each line, exits cleanly on `/exit`
// (same shape as terminals.spec's, which the /exit downgrade test needs).

/** Put the stand-in on disk and map the fixture's `claude-test` folder agent onto it, so the roster
 *  matches it both as a launched command and as a hand-typed one. */



/** Main's own foreground-busy flag for this pty — false means no exec marker is outstanding. */
function busyOf(page: Page, termId: string): Promise<boolean | undefined> {
  return page.evaluate(
    (tid) =>
      window.pomade.pty
        .list()
        .then((l) => l.find((t) => t.termId === tid)?.busy),
    termId
  )
}

interface TabSnap {
  id: string
  kind: string
  status: string
  termId: string
  lastExec?: string
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
      lastExec: t.lastExec,
      lastCommand: t.lastCommand
    }))
  }, projectId) as Promise<TabSnap[]>
}

async function snapOf(page: Page, projectId: string, tabId: string): Promise<TabSnap | undefined> {
  return (await tabSnaps(page, projectId)).find((t) => t.id === tabId)
}

async function lastExecOf(page: Page, projectId: string, tabId: string): Promise<string> {
  return (await snapOf(page, projectId, tabId))?.lastExec ?? ''
}

/** `lastExec` as it landed on DISK — the field only survives a reload if it persisted. */
async function persistedLastExec(
  fixture: Fixture,
  projectId: string,
  tabId: string
): Promise<string> {
  try {
    const raw = await fs.readFile(
      join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`),
      'utf8'
    )
    const state = JSON.parse(raw) as { openTabs?: { id: string; lastExec?: string }[] }
    return state.openTabs?.find((t) => t.id === tabId)?.lastExec ?? ''
  } catch {
    return ''
  }
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

async function openProjectTerminal(page: Page, projectId: string): Promise<TabSnap> {
  await page.getByTestId(`project-${projectId}`).click()
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  await expect.poll(async () => (await tabSnaps(page, projectId)).length, { timeout: 20_000 }).toBe(1)
  return (await tabSnaps(page, projectId))[0]
}

async function bootPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return page
}

// ─── capture → pre-type → sticky across an un-run run → overwrite ──────────────────
// Four sequential app runs in ONE fixture: (1) run a command, (2) revive and DON'T run it,
// (3) revive again — the double-reload proof — then run something else, (4) revive with the new one.
test.describe('T-115 — last command is captured, pre-typed unsubmitted, and sticky', () => {
  let fixture: Fixture
  let alpha = ''
  let alphaRoot = ''
  let tabId = ''
  let termRun1 = ''
  let termRun2 = ''
  let termRun3 = ''
  const FIRST = 'touch sentinel-one.txt'
  const SECOND = 'touch sentinel-two.txt'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  const exists = async (name: string): Promise<boolean> =>
    fs
      .stat(join(alphaRoot, name))
      .then(() => true)
      .catch(() => false)

  test('run 1 — an executed command is captured onto the tab and persisted', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)
    tabId = tab.id
    termRun1 = tab.termId
    // Nothing has run yet, so the field is absent (not '') — older state loads unchanged.
    expect(tab.lastExec).toBeUndefined()

    await writeWhenReady(page, termRun1, `${FIRST}\r`)
    await expect.poll(() => lastExecOf(page, alpha, tabId), { timeout: 20_000 }).toBe(FIRST)
    // …and it reached disk, which is the only reason a revive can use it.
    await expect
      .poll(() => persistedLastExec(fixture, alpha, tabId), { timeout: 20_000 })
      .toBe(FIRST)
    // The command really ran in THIS run (its side effect is the "did it run?" oracle below).
    expect(await exists('sentinel-one.txt')).toBe(true)

    await app.close()
    // Remove the side effect: from here on, its reappearance would mean the command RAN.
    await fs.rm(join(alphaRoot, 'sentinel-one.txt'))
  })

  test('run 2 — the revived shell has it pre-typed, unsubmitted and unexecuted', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun1)
    termRun2 = revived.termId

    // The text is sitting after the prompt (the shell echoed what was typed into its line editor)…
    await expect.poll(() => readBuffer(page, termRun2), { timeout: 20_000 }).toContain(FIRST)
    // …and it was NEVER submitted: no exec marker fired (the shell is idle, not busy) and the file
    // the command would have created is still gone.
    // Real-world window (async pre-type already echoed; a wrongful submit would exec within
    // a round-trip) — unsubmitted and unexecuted, held throughout.
    await expectQuiet(async () => {
      expect(await busyOf(page, termRun2)).toBe(false)
      expect(await exists('sentinel-one.txt')).toBe(false)
      // The tab still carries the field (revive reads it, never rewrites it).
      expect(await lastExecOf(page, alpha, tabId)).toBe(FIRST)
    }, 2500)
    // The next test reads the persisted field after close — make sure it reached disk.
    await expect
      .poll(() => persistedLastExec(fixture, alpha, tabId), { timeout: 15_000 })
      .toBe(FIRST)
    await app.close()
  })

  test('the un-run middle run left the persisted field untouched', async () => {
    // Sticky invariant: pre-typed text is not an exec, so nothing overwrote it — this is exactly
    // the "reloaded twice without applying the command" case that must not lose the command.
    expect(await persistedLastExec(fixture, alpha, tabId)).toBe(FIRST)
  })

  test('run 3 — still pre-typed after a second reload; a NEW command overwrites it', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun2)
    termRun3 = revived.termId
    await expect.poll(() => readBuffer(page, termRun3), { timeout: 20_000 }).toContain(FIRST)
    expect(await exists('sentinel-one.txt')).toBe(false)

    // Ctrl+C discards the pre-typed line (proving it really was in zsh's line editor, editable),
    // then run something different: only a real preexec may overwrite the field.
    await waitForPrompt(page, termRun3)
    await discardLine(page, termRun3)
    await writePty(page, termRun3, `${SECOND}\r`)
    await expect.poll(() => lastExecOf(page, alpha, tabId), { timeout: 20_000 }).toBe(SECOND)
    await expect
      .poll(() => persistedLastExec(fixture, alpha, tabId), { timeout: 20_000 })
      .toBe(SECOND)
    // The discarded line never ran; the new one did.
    expect(await exists('sentinel-one.txt')).toBe(false)
    expect(await exists('sentinel-two.txt')).toBe(true)

    await app.close()
    await fs.rm(join(alphaRoot, 'sentinel-two.txt'))
  })

  test('run 4 — the revive pre-types the NEW command, not the old one', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun3)
    await expect.poll(() => readBuffer(page, revived.termId), { timeout: 20_000 }).toContain(SECOND)
    const buffer = await readBuffer(page, revived.termId)
    expect(buffer).not.toContain('sentinel-one')
    expect(await exists('sentinel-two.txt')).toBe(false) // still unsubmitted
    await app.close()
  })
})

// ─── the truncation guard: captured, persisted, never pre-typed ────────────────────
test.describe('T-115 — a command at the marker cap is captured but not pre-typed', () => {
  let fixture: Fixture
  let alpha = ''
  let tabId = ''
  let termRun1 = ''
  // 500 bytes exactly once the shim's `printf '%.500s'` has cut it — so it is possibly a command
  // sliced mid-word, and pre-typing it would invite Enter on a corrupted line.
  const LONG = `echo ${'x'.repeat(600)}`
  const XRUN = 'x'.repeat(40)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('run 1 — the capped payload is captured verbatim (500 bytes) and persisted', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)
    tabId = tab.id
    termRun1 = tab.termId

    await writeWhenReady(page, termRun1, `${LONG}\r`)
    await expect
      .poll(async () => (await lastExecOf(page, alpha, tabId)).length, { timeout: 20_000 })
      .toBe(500)
    // A 500-byte marker payload also has to survive the pty chunk boundary it may straddle
    // (MARK_CARRY_MAX) — a dropped marker would leave the field empty, not truncated.
    expect(await lastExecOf(page, alpha, tabId)).toBe(LONG.slice(0, 500))
    await expect
      .poll(async () => (await persistedLastExec(fixture, alpha, tabId)).length, { timeout: 20_000 })
      .toBe(500)

    await app.close()
  })

  test('run 2 — the revived shell gets NO pre-type, and is a usable shell', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, tabId, termRun1)

    // Real-world window (zsh startup + async pre-type; not interval-derived): anything that was
    // going to be pre-typed would have echoed inside 3000ms — held throughout.
    await expectQuiet(async () => {
      expect(await readBuffer(page, revived.termId)).not.toContain(XRUN)
      // The field itself is untouched — the guard is a PRE-TYPE rule, not a capture rule.
      expect(await lastExecOf(page, alpha, tabId)).toHaveLength(500)
    }, 3000)
    // Nothing wedged: the revived shell still takes a command.
    await writeWhenReady(page, revived.termId, 'echo CAP_SHELL_OK\r')
    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain('CAP_SHELL_OK')

    await app.close()
  })
})

// ─── agent tabs: their input belongs to the CLI ────────────────────────────────────
// Fabricated restore state (revive.spec.ts's pattern): the fastest way to pin an agent tab that
// carries BOTH a session id (so it really revives) and a `lastExec` that must be ignored.
test.describe('T-115 — an agent tab gets no pre-type on revive', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  const RESUME_ID = 'fbfbfbfb-fbfb-4bfb-8bfb-fbfbfbfbfbfb'
  const AGENT_TERM = 'pretype-gone-agent'
  const AGENT_LAST_EXEC = 'echo AGENT_NO_PRETYPE_MARK'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    const alphaRoot = join(fixture.workspaceRoot, 'Projects/alpha')
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT_ANNOUNCE })
    // E-025 — revive VALIDATES a persisted id against the tab's store (keyed by the physical
    // launch cwd) before spawning `--resume`; the fabricated id needs its transcript on disk.
    const storeDir = join(
      fixture.workspaceRoot,
      'Agents/claude-test/projects',
      (await fs.realpath(alphaRoot)).replace(/[^a-zA-Z0-9]/g, '-')
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
    const dir = join(fixture.workspaceRoot, '.pomade', 'state')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      join(dir, `${alpha}.json`),
      JSON.stringify(
        {
          openTabs: [
            {
              id: 'pretype-agent',
              projectId: alpha,
              kind: 'agent',
              title: 'claude-test',
              termId: AGENT_TERM,
              agentId: 'claude-test',
              cwd: alphaRoot,
              status: 'live',
              lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
              resumeSessionId: RESUME_ID,
              // A leftover from before the tab was upgraded to an agent — it must not be typed
              // into the agent's stdin (that text would land in the CLI's input box).
              lastExec: AGENT_LAST_EXEC
            }
          ],
          activeTabId: 'pretype-agent'
        },
        null,
        2
      )
    )
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the revived agent runs its resume command and nothing else', async () => {
    test.slow()
    app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const revived = await waitRevived(page, alpha, 'pretype-agent', AGENT_TERM)

    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain(`--resume ${RESUME_ID}`)
    await expect
      .poll(() => readBuffer(page, revived.termId), { timeout: 20_000 })
      .toContain('AGENT_READY')
    // Anything that was going to be typed would land inside this real-world window (agent is
    // READY; a pre-type would echo within a round-trip). The stand-in echoes every SUBMITTED
    // line as `AGENT_GOT: …`, so the raw text alone is the stricter assertion — held throughout.
    await expectQuiet(async () => {
      const buffer = await readBuffer(page, revived.termId)
      expect(buffer).not.toContain('AGENT_NO_PRETYPE_MARK')
      expect(buffer).not.toContain('AGENT_GOT')
    }, 2500)
    // The payload rode along untouched (revive never rewrites what it didn't refresh).
    expect((await snapOf(page, alpha, 'pretype-agent'))?.lastExec).toBe(AGENT_LAST_EXEC)
  })
})

// ─── the agent-launch exec must not become a terminal's lastExec ───────────────────
test.describe('T-115 — an agent launch never pollutes lastExec', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let scriptPath = ''
  let tabId = ''
  let termId = ''
  const BEFORE = 'echo BEFORE_AGENT_MARK'
  const AFTER = 'echo AFTER_AGENT_MARK'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    scriptPath = await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT_ANNOUNCE })
    app = await launchApp(fixture)
    page = await bootPage(app)
    const tab = await openProjectTerminal(page, alpha)
    tabId = tab.id
    termId = tab.termId
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('typing an agent command upgrades the tab and leaves lastExec on the shell command', async () => {
    test.slow()
    await writeWhenReady(page, termId, `${BEFORE}\r`)
    await expect.poll(() => lastExecOf(page, alpha, tabId), { timeout: 20_000 }).toBe(BEFORE)

    // The launch exec fires ptyExec AND upgrades the tab — and it fires while the tab is still a
    // plain terminal, so only main's roster verdict in the payload can keep it out of the field.
    await writePty(page, termId, `${scriptPath}\r`)
    await expect
      .poll(async () => (await snapOf(page, alpha, tabId))?.kind ?? '', { timeout: 20_000 })
      .toBe('agent')
    await expect.poll(() => readBuffer(page, termId), { timeout: 20_000 }).toContain('AGENT_READY')
    // Any late ptyExec would land inside this real-world window — the field holds throughout.
    await expectQuiet(async () => {
      expect(await lastExecOf(page, alpha, tabId)).toBe(BEFORE)
    }, 1500)
    expect((await snapOf(page, alpha, tabId))?.lastCommand).toBe(scriptPath) // the AGENT field did move
  })

  test('the /exit downgrade KEEPS lastExec, and a later command overwrites it', async () => {
    test.slow()
    // Documented choice: `lastExec` is a SHELL fact (this zsh's last command, from before the
    // agent), unlike lastCommand/resumeSessionId which are AGENT facts the downgrade clears.
    await writePty(page, termId, '/exit\r')
    await expect
      .poll(async () => (await snapOf(page, alpha, tabId))?.kind ?? '', { timeout: 20_000 })
      .toBe('terminal')
    const downgraded = await snapOf(page, alpha, tabId)
    expect(downgraded?.lastExec).toBe(BEFORE)
    expect(downgraded?.lastCommand).toBeUndefined()

    // The guard doesn't wedge the field: the downgraded shell captures again.
    await writeWhenReady(page, termId, `${AFTER}\r`)
    await expect.poll(() => lastExecOf(page, alpha, tabId), { timeout: 20_000 }).toBe(AFTER)
  })
})
