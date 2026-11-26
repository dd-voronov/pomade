// modules: projects, tabs, terminal, agents
// Pomade E-011 / T-151 e2e — project attention counter.
// Drives the real Electron app. Attention is exercised by making a pty EMIT the notification
// bytes agents emit at turn end (a standalone BEL, an OSC 9 sequence) via `printf` in a hidden
// project's terminal, then asserting the Projects panel's red counter. T-151 redefined that counter: it
// is now a LIVE DERIVED tally of a project's unread (dotted) tabs — no active-project gating, no
// reset on open; repeated events on one tab stay a single unread; counts survive restart. These
// specs pin that contract. P-018 removed E-011's flag
// injection (the pty masquerades as Apple_Terminal, so agents notify flag-free); echo
// stand-ins for claude/codex (agents.json overrides + fakes on PATH) now prove launch
// commands and manual launches stay CLEAN — no flags, no zsh wrapper functions.
//
// State chains WITHIN this file (one app, one window) — tests append, never insert mid-file.

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
import { promptCount, readBuffer, waitForPrompt, writePty } from './fixtures/stores'
import { FAKE_AGENT_ECHO_ARGV, FAKE_AGENT_WRAP_ECHO } from './fixtures/fake-agent'
import { expectQuiet } from './fixtures/timing'



// Attention count for a project — the T-151 LIVE DERIVED count of unread (dotted) tabs, exactly
// what the Projects panel badge renders. Read straight off the persisted tab set.
function attn(page: Page, projectId: string): Promise<number> {
  return page.evaluate(
    (pid) =>
      (window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? [])
        .filter((t) => t.attention).length,
    projectId
  )
}

// Clear every unread dot in a project (test baseline) — the count IS the dotted-tab set under
// T-151, so we zero it by clearing the dots directly (there is no counter store to reset).
async function clearDots(page: Page, projectId: string): Promise<void> {
  await page.evaluate((pid) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    for (const t of s.tabsByProject[pid] ?? []) {
      if (t.attention) s.updateTab(pid, t.id, { attention: undefined })
    }
  }, projectId)
}

// Create a plain terminal in `projectId` via the store (works even when the project is hidden),
// returning its termId.
function newTerminalIn(page: Page, projectId: string): Promise<string> {
  return page.evaluate(async (pid) => {
    const stores = window.__pomadeStores
    const project = stores.useWorkspaceStore.getState().projectById(pid)
    const before = new Set(
      (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => t.termId)
    )
    await stores.useTerminalsStore.getState().newTerminal(project)
    const tabs = stores.useTabsStore.getState().tabsByProject[pid] ?? []
    const created = tabs.find((t) => t.termId && !before.has(t.termId))
    return created?.termId as string
  }, projectId)
}

// Launch a built-in agent (claude/codex) via the store into `projectId`; return its termId +
// the exact command the renderer built (so we can assert the injected flag on it).
function startBuiltinAgent(
  page: Page,
  projectId: string,
  agentId: string
): Promise<{ termId: string; lastCommand?: string }> {
  return page.evaluate(
    async ({ pid, aid }) => {
      const stores = window.__pomadeStores
      const project = stores.useWorkspaceStore.getState().projectById(pid)
      const roster = await window.pomade.agents.roster()
      const agent = roster.find((a) => a.id === aid)
      const before = new Set(
        (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => t.termId)
      )
      await stores.useTerminalsStore.getState().startAgent(project, agent)
      const tabs = stores.useTabsStore.getState().tabsByProject[pid] ?? []
      const created = tabs.find((t) => t.termId && !before.has(t.termId))
      return { termId: created?.termId as string, lastCommand: created?.lastCommand as string | undefined }
    },
    { pid: projectId, aid: agentId }
  )
}

test.describe('E-011 / T-151 — derived project attention counter', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let binDir: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()

    // Echo stand-ins for the built-in agents' launch commands.
    const echoClaude = join(fixture.workspaceRoot, 'echo-claude.sh')
    const echoCodex = join(fixture.workspaceRoot, 'echo-codex.sh')
    await fs.writeFile(echoClaude, FAKE_AGENT_ECHO_ARGV, { mode: 0o755 })
    await fs.writeFile(echoCodex, FAKE_AGENT_ECHO_ARGV, { mode: 0o755 })
    await fs.chmod(echoClaude, 0o755)
    await fs.chmod(echoCodex, 0o755)
    // Point the built-in claude/codex roster commands at the echo stand-ins.
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { claude: echoClaude, codex: echoCodex }, hidden: [] }, null, 2)
    )

    // Fake `claude`/`codex` on PATH so the shim wrapper's `command claude` resolves to a script
    // that echoes its (Pomade-injected) argv — no real agent binaries required.
    binDir = join(fixture.workspaceRoot, 'bin')
    await fs.mkdir(binDir, { recursive: true })
    for (const name of ['claude', 'codex']) {
      const p = join(binDir, name)
      await fs.writeFile(p, FAKE_AGENT_WRAP_ECHO, { mode: 0o755 })
      await fs.chmod(p, 0o755)
    }

    app = await launchApp(fixture, { PATH: `${binDir}:${process.env.PATH ?? ''}` })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // A live terminal in Beta stays hidden while Alpha is the open project. Repeated attention
  // events on that ONE tab produce a SINGLE unread — the counter is the dotted-tab count, not an
  // event tally.
  test('repeated attention events on one hidden tab count as a single unread', async () => {
    const { alpha, beta } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    const betaTerm = await newTerminalIn(page, beta)
    await waitForPrompt(page, betaTerm)
    await clearDots(page, beta) // clean baseline
    expect(await attn(page, beta)).toBe(0)

    // Standalone BEL → the hidden tab dots; Beta's derived count becomes 1 and the badge appears.
    await writePty(page, betaTerm, "printf '\\a'\r")
    await expect.poll(() => attn(page, beta), { timeout: 10_000 }).toBe(1)
    const badge = page.getByTestId(`project-attention-${beta}`)
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('1')

    // OSC 9 notification on the SAME tab → still 1 (the derivation counts the one dotted tab).
    await writePty(page, betaTerm, "printf '\\033]9;done\\007'\r")
    // Real-world pty round-trip window (not interval-derived) — the count holds at 1 throughout.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(1)
    }, 1000)

    // Another BEL on the same tab → still 1.
    await writePty(page, betaTerm, "printf '\\a'\r")
    // Real-world pty round-trip window — still exactly 1, held throughout.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(1)
    }, 1000)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')
  })

  // T-151 — opening the project does NOT reset the counter; the count tracks the dotted tabs and
  // only drops as they are read (activation edge).
  test('opening the project does not clear the counter; reading the unread tab does', async () => {
    const { beta } = fixture.projects
    // Beta still has one unread tab (betaTerm) from the previous test.
    expect(await attn(page, beta)).toBe(1)
    const betaTerm = await page.evaluate((pid) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
      return tabs.find((t) => t.kind !== 'doc' && t.status === 'live' && t.attention)?.termId as string
    }, beta)

    // Opening Beta leaves the badge at 1 (dots survive open; no activation edge fired).
    await page.getByTestId(`project-${beta}`).click()
    expect(await attn(page, beta)).toBe(1)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')

    // Add a second tab (becomes active); the still-dotted betaTerm is now inactive — count stays 1.
    const other = await newTerminalIn(page, beta)
    await waitForPrompt(page, other)
    expect(await attn(page, beta)).toBe(1)

    // Reading betaTerm (activation edge) clears its dot → count 0, badge gone.
    const betaTermTab = await tabIdOf(beta, betaTerm)
    await page.getByTestId(`tab-${betaTermTab}`).click()
    await expect.poll(() => attn(page, beta)).toBe(0)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveCount(0)
  })

  // T-151 — a bell dotting an INACTIVE tab of the OPEN project DOES raise the counter (the old
  // contract suppressed events in the active project; the derived count includes it).
  test('a bell dotting an inactive tab in the OPEN project shows 1', async () => {
    const { beta } = fixture.projects
    // Beta is the open project (from the previous test). Clean baseline.
    await clearDots(page, beta)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveCount(0)

    // An INACTIVE live terminal in the open project.
    const inactiveTerm = await page.evaluate((pid) => {
      const store = window.__pomadeStores.useTabsStore.getState()
      const active = store.activeTabByProject[pid]
      const tabs = store.tabsByProject[pid] ?? []
      return tabs.find((t) => t.kind !== 'doc' && t.status === 'live' && t.id !== active)?.termId as string
    }, beta)
    expect(inactiveTerm).toBeTruthy()

    // BEL on that inactive tab → it dots, and the badge on the OPEN project appears with 1.
    await writePty(page, inactiveTerm, "printf '\\a'\r")
    await expect.poll(() => attn(page, beta), { timeout: 10_000 }).toBe(1)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')
  })

  // A natural pty exit in a hidden project dots that tab → the counter rises.
  test('pty exit in a hidden project raises the counter', async () => {
    const { alpha, beta } = fixture.projects
    await clearDots(page, beta)
    const betaTerm = await page.evaluate((pid) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
      return tabs.find((t) => t.kind !== 'doc' && t.status === 'live')?.termId as string
    }, beta)
    // Hide Beta (open Alpha), then let Beta's shell exit on its own.
    await page.getByTestId(`project-${alpha}`).click()
    expect(await attn(page, beta)).toBe(0)
    await writePty(page, betaTerm, 'exit\r')
    await expect.poll(() => attn(page, beta), { timeout: 10_000 }).toBe(1)
  })

  // OSC 0 window-title updates end in BEL too, but must NOT dot the tab (no count change).
  test('OSC title updates do not raise the counter (but a real bell still does)', async () => {
    const { alpha, beta } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click() // hide Beta
    const betaTerm = await newTerminalIn(page, beta)
    await waitForPrompt(page, betaTerm)
    await clearDots(page, beta)
    expect(await attn(page, beta)).toBe(0)

    // Title OSC → no dot, no count.
    await writePty(page, betaTerm, "printf '\\033]0;a new title\\007'\r")
    // Real-world pty round-trip window — a title OSC may never dot, held throughout.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(0)
    }, 1000)

    // A genuine BEL on the SAME terminal still counts (proves the terminal is live + scanned).
    await writePty(page, betaTerm, "printf '\\a'\r")
    await expect.poll(() => attn(page, beta), { timeout: 10_000 }).toBe(1)
  })

  // P-018: the launch command Pomade builds for a built-in agent is the roster command,
  // CLEAN — no injected notification flags (the Apple_Terminal masquerade replaces them).
  test('agent launch command carries no injected flags (claude + codex)', async () => {
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    const claude = await startBuiltinAgent(page, alpha, 'claude')
    expect(claude.lastCommand).not.toContain('--settings')
    // The echo stand-in prints its argv — poll it to prove the process ran with NO flags.
    await expect
      .poll(() => readBuffer(page, claude.termId), { timeout: 10_000 })
      .toContain('ARGV:')
    expect(await readBuffer(page, claude.termId)).not.toContain('preferredNotifChannel')

    const codex = await startBuiltinAgent(page, alpha, 'codex')
    expect(codex.lastCommand).not.toContain('tui.notifications')
    await expect
      .poll(() => readBuffer(page, codex.termId), { timeout: 10_000 })
      .toContain('ARGV:')
    expect(await readBuffer(page, codex.termId)).not.toContain('tui.notifications')
  })

  // P-018: typing `claude`/`codex` by hand hits PATH directly — the E-011 shim wrapper
  // functions are gone, so nothing rewrites the command or appends flags.
  test('manually typed claude/codex run unwrapped (no flags appended)', async () => {
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    const term = await newTerminalIn(page, alpha)
    await waitForPrompt(page, term)

    // Pin our fake claude/codex ahead of anything the user's real startup files put on PATH,
    // so the bare command resolves to the echo stand-in (not a real agent that would prompt).
    const prompts = await promptCount(page, term)
    await writePty(page, term, `export PATH="${binDir}:$PATH"\r`)
    await expect.poll(() => promptCount(page, term), { timeout: 10_000 }).toBeGreaterThan(prompts)

    // No wrapper function may shadow the binaries any more.
    await writePty(page, term, 'whence -w claude codex\r')
    await expect
      .poll(() => readBuffer(page, term), { timeout: 10_000 })
      .toContain('claude: command')
    expect(await readBuffer(page, term)).toContain('codex: command')

    await writePty(page, term, 'claude\r')
    await expect.poll(() => readBuffer(page, term), { timeout: 10_000 }).toContain('WRAP:')
    expect(await readBuffer(page, term)).not.toContain('--settings')
    expect(await readBuffer(page, term)).not.toContain('preferredNotifChannel')

    await writePty(page, term, 'codex\r')
    await expect
      .poll(() => readBuffer(page, term).then((b) => b.split('WRAP:').length - 1), {
        timeout: 10_000
      })
      .toBe(2)
    expect(await readBuffer(page, term)).not.toContain('tui.notifications')
  })

  // T-056 — per-tab attention dot. A terminal that raises attention while it is NOT the active
  // tab shows a red dot on its tab; the dot persists across a project switch (unlike the Projects panel
  // bubble, which clears on open) and clears only when THAT tab is activated. The active tab
  // never accumulates a dot.
  test('per-tab attention dot: set on a hidden tab, persists across open, clears on activation', async () => {
    const { alpha, beta } = fixture.projects

    // The tab id backing a termId (search the given project), and its persisted `attention`
    // flag (read from the store).
    const tabIdFor = (pid: string, termId: string): Promise<string> =>
      page.evaluate(
        ({ p, tid }) => {
          const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
          return tabs.find((t) => t.termId === tid)?.id as string
        },
        { p: pid, tid: termId }
      )
    const tabAttn = (pid: string, tabId: string): Promise<boolean> =>
      page.evaluate(
        ({ p, t }) => {
          const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
          return !!tabs.find((x) => x.id === t)?.attention
        },
        { p: pid, t: tabId }
      )

    // Two terminals in Beta: A (will get the dot) and B (Beta's active tab). Alpha stays open so
    // Beta is hidden throughout the setup.
    await page.getByTestId(`project-${alpha}`).click()
    const termA = await newTerminalIn(page, beta)
    await waitForPrompt(page, termA)
    const termB = await newTerminalIn(page, beta)
    await waitForPrompt(page, termB)
    const tabA = await tabIdFor(beta, termA)
    const tabB = await tabIdFor(beta, termB)

    // Clean baseline: open Beta, activate A then B, wipe every stray dot (incl. leftovers from
    // earlier tests), back to Alpha. B stays the active tab.
    await page.getByTestId(`project-${beta}`).click()
    await page.getByTestId(`tab-${tabA}`).click()
    await page.getByTestId(`tab-${tabB}`).click()
    await clearDots(page, beta)
    await page.getByTestId(`project-${alpha}`).click()
    expect(await tabAttn(beta, tabA)).toBe(false)

    // BEL on the hidden, non-active tab A → its tab flag is set.
    await writePty(page, termA, "printf '\\a'\r")
    await expect.poll(() => tabAttn(beta, tabA), { timeout: 10_000 }).toBe(true)

    // T-151 — switching to Beta does NOT clear the counter; the badge AGREES with the dots: A is
    // the only unread tab, so it reads 1. The dot on A persists (A is not the active tab — B is);
    // the active tab B never accumulated a dot.
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')
    await expect(page.getByTestId(`tab-attention-${tabA}`)).toBeVisible()
    await expect(page.getByTestId(`tab-attention-${tabB}`)).toHaveCount(0)

    // Activating tab A clears its dot.
    await page.getByTestId(`tab-${tabA}`).click()
    await expect(page.getByTestId(`tab-attention-${tabA}`)).toHaveCount(0)
    expect(await tabAttn(beta, tabA)).toBe(false)

    // A is now the active tab: a BEL on it never produces a dot.
    await writePty(page, termA, "printf '\\a'\r")
    // Real-world pty round-trip window — the active tab may never dot, held throughout.
    await expectQuiet(async () => {
      expect(await tabAttn(beta, tabA)).toBe(false)
    }, 1000)
    await expect(page.getByTestId(`tab-attention-${tabA}`)).toHaveCount(0)
  })

  // ── P-018 round-5 fixes (appended; state chains from the tests above) ─────────────────

  // The tab id backing a termId, and its persisted attention flag — read via the store so a
  // HIDDEN project's tabs are assertable without switching to it (switching would clear the
  // visible tab's dot and contaminate the scenario).
  const tabIdOf = (pid: string, termId: string): Promise<string> =>
    page.evaluate(
      ({ p, tid }) => {
        const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
        return tabs.find((t) => t.termId === tid)?.id as string
      },
      { p: pid, tid: termId }
    )
  const tabHasAttention = (pid: string, tabId: string): Promise<boolean> =>
    page.evaluate(
      ({ p, t }) => {
        const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
        return !!tabs.find((x) => x.id === t)?.attention
      },
      { p: pid, t: tabId }
    )

  let rc5TermC = ''
  let rc5TabC = ''

  // Round-5 report #2 / T-151 — attention on an INACTIVE tab of the ACTIVE project sets the tab
  // dot with NO project switch involved, and the OPEN project's counter now includes it.
  test('same-project inactive tab gets the dot; open-project counter shows it', async () => {
    const { beta } = fixture.projects
    await page.getByTestId(`project-${beta}`).click()

    rc5TermC = await newTerminalIn(page, beta)
    await waitForPrompt(page, rc5TermC)
    const termD = await newTerminalIn(page, beta)
    await waitForPrompt(page, termD)
    rc5TabC = await tabIdOf(beta, rc5TermC)
    const tabD = await tabIdOf(beta, termD)
    // Clean baseline: visit C then D, then wipe every stray dot; D stays the active tab.
    await page.getByTestId(`tab-${rc5TabC}`).click()
    await page.getByTestId(`tab-${tabD}`).click()
    await clearDots(page, beta)
    expect(await tabHasAttention(beta, rc5TabC)).toBe(false)

    // BEL on the inactive tab C → its dot appears; and under T-151 the OPEN project's badge shows
    // it (the old contract suppressed an event in the active project).
    await writePty(page, rc5TermC, "printf '\\a'\r")
    await expect(page.getByTestId(`tab-attention-${rc5TabC}`)).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => attn(page, beta)).toBe(1)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')

    // Activating C clears its dot → the badge drops to 0.
    await page.getByTestId(`tab-${rc5TabC}`).click()
    await expect(page.getByTestId(`tab-attention-${rc5TabC}`)).toHaveCount(0)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveCount(0)
  })

  // Round-5 report #1 — plain terminals emit no turn-end byte, so a LONG (≥2s) foreground
  // command FINISHING (the shim's busy→idle transition) is itself an attention event;
  // instant commands stay silent. Asserted via the store while the project stays hidden.
  test('a long command finishing raises attention; instant commands do not', async () => {
    const { alpha, beta } = fixture.projects
    // C is beta's active tab (activated at the end of the previous test). Hide beta.
    await page.getByTestId(`project-${alpha}`).click()
    expect(await attn(page, beta)).toBe(0)

    // Instant command → no attention from its completion.
    await writePty(page, rc5TermC, 'true\r')
    // Real-world window (instant command completes within it; LONG_COMMAND_ATTENTION_MS=2000
    // means its completion may never count) — no attention, held throughout.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(0)
      expect(await tabHasAttention(beta, rc5TabC)).toBe(false)
    }, 1500)

    // Long command → attention exactly when it finishes: counter +1 AND the tab dot, even
    // though C is beta's (hidden) active tab — only the ACTIVE project's active tab is exempt.
    await writePty(page, rc5TermC, 'sleep 2.5\r')
    // While the long command still runs (first 1s of 2.5) nothing may count — held throughout.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(0) // still running — nothing yet
    }, 1000)
    await expect.poll(() => attn(page, beta), { timeout: 10_000 }).toBe(1)
    expect(await tabHasAttention(beta, rc5TabC)).toBe(true)
  })
})
