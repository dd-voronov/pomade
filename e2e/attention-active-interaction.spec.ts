// modules: core, projects, tabs, editor, terminal
// Pomade T-111 e2e — the attention dot must clear when the user ACTS in an already-active unread
// tab. Repro (the Owner, terminals/agents): open a project whose unread tab is ALREADY its active
// tab → the red dot never clears; you must switch away and back. The activation-edge clear can't
// fire (no edge for an already-active tab). Fix: the first meaningful INTERACTION with the active
// pane (a terminal keystroke, an editor edit) clears the dot — but merely opening and leaving with
// NO interaction does not.
//
// State chains WITHIN this file (one app, one window) — tests append, never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchApp } from './fixtures/app'
import { waitForPrompt, writePty } from './fixtures/stores'
import { expectQuiet } from './fixtures/timing'



// Create a terminal in `projectId` via the store (works even when the project is hidden).
function newTerminalIn(page: Page, projectId: string): Promise<string> {
  return page.evaluate(async (pid) => {
    const stores = window.__pomadeStores
    const project = stores.useWorkspaceStore.getState().projectById(pid)
    const before = new Set(
      (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => t.termId)
    )
    await stores.useTerminalsStore.getState().newTerminal(project)
    const tabs = stores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.find((t) => t.termId && !before.has(t.termId))?.termId as string
  }, projectId)
}

const tabIdOf = (page: Page, pid: string, termId: string): Promise<string> =>
  page.evaluate(
    ({ p, tid }) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
      return tabs.find((t) => t.termId === tid)?.id as string
    },
    { p: pid, tid: termId }
  )

const tabHasAttention = (page: Page, pid: string, tabId: string): Promise<boolean> =>
  page.evaluate(
    ({ p, t }) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
      return !!tabs.find((x) => x.id === t)?.attention
    },
    { p: pid, t: tabId }
  )

const activeTabOf = (page: Page, pid: string): Promise<string | undefined> =>
  page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[p],
    pid
  )

test.describe('T-111 dot clears on interaction with an already-active unread tab', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string
  let beta: string
  let betaTerm: string
  let betaTab: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta

    // Beta gets ONE terminal — it becomes beta's ACTIVE tab. That is the repro shape: the unread
    // tab is already the active tab when the project opens.
    await page.getByTestId(`project-${alpha}`).click()
    betaTerm = await newTerminalIn(page, beta)
    await waitForPrompt(page, betaTerm)
    betaTab = await tabIdOf(page, beta, betaTerm)

    // Clean baseline: open beta (clears counter, tab is active/dotless), back to alpha.
    await page.getByTestId(`project-${beta}`).click()
    await page.getByTestId(`project-${alpha}`).click()
    expect(await tabHasAttention(page, beta, betaTab)).toBe(false)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('project opens with its unread ACTIVE tab → dot present, then a keystroke clears it (no tab switch)', async () => {
    // BEL while beta is hidden → its (hidden) active tab gets the dot.
    await writePty(page, betaTerm, "printf '\\a'\r")
    await expect.poll(() => tabHasAttention(page, beta, betaTab), { timeout: 10_000 }).toBe(true)

    // Open beta: the tab was ALREADY active, so no activation edge fires — the dot is STUCK.
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()
    expect(await activeTabOf(page, beta)).toBe(betaTab)

    // Type into the pane — the first keystroke is the "user acted" signal (xterm.onData) and
    // clears the dot, with NO tab switch. The active tab is unchanged.
    const pane = page.locator(`[data-term-id="${betaTerm}"]`)
    await pane.click({ position: { x: 40, y: 40 } })
    await page.keyboard.type('x')
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toHaveCount(0)
    expect(await tabHasAttention(page, beta, betaTab)).toBe(false)
    expect(await activeTabOf(page, beta)).toBe(betaTab)
    // Tidy the line so the shell state stays clean for later tests.
    await page.keyboard.press('Backspace')
  })

  test('open with unread ACTIVE tab, immediately switch away with NO interaction → dot still there on return', async () => {
    // Re-arm: hide beta, BEL its active tab again.
    await page.getByTestId(`project-${alpha}`).click()
    await writePty(page, betaTerm, "printf '\\a'\r")
    await expect.poll(() => tabHasAttention(page, beta, betaTab), { timeout: 10_000 }).toBe(true)

    // Open beta (dot stuck, no edge), then leave IMMEDIATELY without interacting.
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()

    // Back to beta → the dot is STILL there: opening + leaving without action must not clear it.
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()
    expect(await tabHasAttention(page, beta, betaTab)).toBe(true)

    // Now a keystroke clears it (leaves the scenario clean for the next test).
    const pane = page.locator(`[data-term-id="${betaTerm}"]`)
    await pane.click({ position: { x: 40, y: 40 } })
    await page.keyboard.type('x')
    await page.keyboard.press('Backspace')
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toHaveCount(0)
  })

  test('activation-edge clear still works: mark an INACTIVE tab, switch to it → dot clears', async () => {
    // Add a second terminal to beta; it becomes the active tab, leaving the first inactive.
    const term2 = await newTerminalIn(page, beta)
    await waitForPrompt(page, term2)
    const tab2 = await tabIdOf(page, beta, term2)
    await page.getByTestId(`tab-${tab2}`).click()
    expect(await activeTabOf(page, beta)).toBe(tab2)

    // Hide beta, BEL the now-INACTIVE first tab → it gets the dot.
    await page.getByTestId(`project-${alpha}`).click()
    await writePty(page, betaTerm, "printf '\\a'\r")
    await expect.poll(() => tabHasAttention(page, beta, betaTab), { timeout: 10_000 }).toBe(true)

    // Open beta; the dot persists (betaTab is not the active tab). Switching TO it (activation
    // edge) clears the dot — the untouched T-056/T-061 path.
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()
    await page.getByTestId(`tab-${betaTab}`).click()
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toHaveCount(0)
    expect(await tabHasAttention(page, beta, betaTab)).toBe(false)
  })

  test('doc case: a manual-marked ACTIVE doc tab clears on editor input', async () => {
    await page.getByTestId(`project-${alpha}`).click()

    // Open a plain-text doc (raw editor) — it becomes alpha's active tab.
    const rel = 'Projects/alpha/notes.txt'
    await page.getByTestId(`tree-node-${rel}`).click()
    const docTab = await page.evaluate((p) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      s.commitPreview(p)
      const tabs = s.tabsByProject[p] ?? []
      return tabs.find((t) => t.path === 'Projects/alpha/notes.txt')?.id as string
    }, alpha)
    expect(docTab).toBeTruthy()

    // Manually mark the ACTIVE doc tab unread — the dot stays (no activation edge on the active
    // tab). This is the doc analogue of the terminal repro.
    await page.getByTestId(`tab-${docTab}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-mark-unread').click()
    await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
    await expect(page.getByTestId(`tab-attention-${docTab}`)).toBeVisible()
    expect(await activeTabOf(page, alpha)).toBe(docTab)

    // Editor input (a real keystroke → markDirty) clears the dot, with no tab switch.
    await page.locator('[data-testid="raw-editor"] .cm-content:visible').first().click()
    await page.keyboard.type('z')
    await expect(page.getByTestId(`tab-attention-${docTab}`)).toHaveCount(0)
    expect(await activeTabOf(page, alpha)).toBe(docTab)
  })
})

// ── T-123 ──────────────────────────────────────────────────────────────────────
// The unread dot must clear ONLY on GENUINE user input. T-111 wired the clear to `xterm.onData`
// on the false premise it "fires only for the focused terminal"; in fact `onData` also fires for
// the terminal's OWN auto-replies to escape queries the running app prints (CPR, DSR, DA, focus
// reports under mode 1004, …) — plus T-116's replay burst re-answering the ring buffer on attach.
// A Claude agent TUI queries constantly, so Mark unread self-cleared in under a second, even on an
// inactive/fresh tab, with no keystroke and no focus. Fix: the clear is wired to
// `coreService.onUserInput` (xterm's own userInput flag: keystrokes + paste), NOT to raw onData.
//
// Fresh fixture/app so these specs don't inherit the T-111 chain's end-state.
const clearMarkViaStore = (page: Page, pid: string, tabId: string): Promise<void> =>
  page.evaluate(
    ({ p, t }) => window.__pomadeStores.useTabsStore.getState().clearTabAttention(p, t),
    { p: pid, t: tabId }
  )

test.describe('T-123 dot survives terminal auto-replies; only genuine user input clears it', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string
  let beta: string
  let betaTerm: string
  let betaTab: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta

    // Beta gets one terminal — its active tab. Then open+leave beta so the counter is clean.
    await page.getByTestId(`project-${alpha}`).click()
    betaTerm = await newTerminalIn(page, beta)
    await waitForPrompt(page, betaTerm)
    betaTab = await tabIdOf(page, beta, betaTerm)
    await page.getByTestId(`project-${beta}`).click()
    await page.getByTestId(`project-${alpha}`).click()
    expect(await tabHasAttention(page, beta, betaTab)).toBe(false)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a CPR auto-reply on an ACTIVE, visible marked terminal does NOT clear the dot', async () => {
    await page.getByTestId(`project-${beta}`).click()
    expect(await activeTabOf(page, beta)).toBe(betaTab)

    // Mark the ACTIVE tab unread (dot shows on the active tab, per T-111).
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().markUnread(p, t),
      { p: beta, t: betaTab }
    )
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    // Provoke an xterm auto-reply: the shell prints a CPR query (ESC[6n) → xterm answers via
    // onData with NO user acting. Pre-fix this fired the clear; post-fix onData only forwards.
    // Real-world round-trip window (printf → CPR query → xterm auto-reply → onData) — the dot
    // must survive it throughout, not merely after it.
    await writePty(page, betaTerm, "printf '\\033[6n'\r")
    await expectQuiet(async () => {
      expect(await tabHasAttention(page, beta, betaTab)).toBe(true)
    }, 1200)
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    await clearMarkViaStore(page, beta, betaTab)
  })

  test('a CPR auto-reply on a HIDDEN, inactive marked terminal does NOT clear the dot', async () => {
    // Hide beta (alpha active) — beta's pane stays mounted (display:none) and still processes pty
    // output, so it still auto-replies. Mark the now-hidden tab.
    await page.getByTestId(`project-${alpha}`).click()
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().markUnread(p, t),
      { p: beta, t: betaTab }
    )
    expect(await tabHasAttention(page, beta, betaTab)).toBe(true)

    // A query to the hidden pty → the hidden xterm replies via onData. The dot must survive.
    await writePty(page, betaTerm, "printf '\\033[6n'\r")
    // Real-world round-trip window — the hidden tab's dot survives throughout.
    await expectQuiet(async () => {
      expect(await tabHasAttention(page, beta, betaTab)).toBe(true)
    }, 1200)

    // Reveal beta: the dot is still there (revealing without acting never clears it).
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    await clearMarkViaStore(page, beta, betaTab)
  })

  test('a mode-1004 focus report emitted by revealing the pane does NOT clear the dot', async () => {
    // Enable mode-1004 focus reporting (what a Claude TUI turns on). Now xterm.focus() — which the
    // pane's re-show effect calls on reveal — emits a focus report (ESC[I) via onData.
    await page.getByTestId(`project-${beta}`).click()
    // The sentinel is computed by the shell, so only the command's OUTPUT (not its echo) carries
    // it: once xterm has rendered it, xterm has parsed the mode-set bytes that precede it.
    await writePty(page, betaTerm, "printf '\\033[?1004h'; echo FOCUS_MODE_$((6*7))\r")
    await expect(page.locator(`[data-term-id="${betaTerm}"] .xterm-rows`)).toContainText('FOCUS_MODE_42')

    // Hide beta, mark the hidden tab.
    await page.getByTestId(`project-${alpha}`).click()
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().markUnread(p, t),
      { p: beta, t: betaTab }
    )
    expect(await tabHasAttention(page, beta, betaTab)).toBe(true)

    // Reveal beta → the re-show effect focuses the xterm → ESC[I emitted under 1004 → onData.
    // Pre-fix this cleared the dot the instant the project opened; post-fix it survives.
    await page.getByTestId(`project-${beta}`).click()
    // Real-world window (re-show effect → xterm.focus() → ESC[I under 1004 → onData) — the dot
    // survives it throughout.
    await expectQuiet(async () => {
      expect(await tabHasAttention(page, beta, betaTab)).toBe(true)
    }, 1200)
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    // Disable 1004 again and clear the mark so later controls start clean.
    await writePty(page, betaTerm, "printf '\\033[?1004l'\r")
    await clearMarkViaStore(page, beta, betaTab)
  })

  test('CONTROL: a real keystroke into the focused marked terminal clears the dot', async () => {
    await page.getByTestId(`project-${beta}`).click()
    expect(await activeTabOf(page, beta)).toBe(betaTab)
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().markUnread(p, t),
      { p: beta, t: betaTab }
    )
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    const pane = page.locator(`[data-term-id="${betaTerm}"]`)
    await pane.click({ position: { x: 40, y: 40 } })
    await page.keyboard.type('x')
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toHaveCount(0)
    expect(await tabHasAttention(page, beta, betaTab)).toBe(false)
    await page.keyboard.press('Backspace')
  })

  test('CONTROL: the "Paste to input" menu action clears the dot', async () => {
    await page.getByTestId(`project-${beta}`).click()
    // Seed the (in-memory, test-mode) clipboard, then mark the active tab.
    await page.evaluate(
      () => window.pomade.app.clipboardWrite('pomade-paste')
    )
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().markUnread(p, t),
      { p: beta, t: betaTab }
    )
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    // Right-click the terminal → "Paste to input". This writes to the pty directly (bypassing
    // xterm), so the clear is the explicit call added to pasteIntoPty — an unambiguous user action.
    await page.locator(`[data-term-id="${betaTerm}"]`).click({ button: 'right' })
    await page.getByTestId('terminal-menu-paste').click()
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toHaveCount(0)
    expect(await tabHasAttention(page, beta, betaTab)).toBe(false)
  })

  // ── T-123 ROUND 2 ─────────────────────────────────────────────────────────────
  // r1 (the specs above) moved the clear from onData to xterm's `coreService.onUserInput`. That
  // is immune to the auto-reply storm — but xterm sets the SAME internal `userInput` flag for
  // MOUSE-MOTION reports under any-motion tracking (mode 1003 + SGR 1006), which a Claude TUI
  // enables. So passive pointer motion over the focused agent pane fired onUserInput → cleared the
  // dot ~1 redraw after marking (the Owner's 0.1.4 finding: the ACTIVE agent tab self-clears). Fix:
  // drop onUserInput; clear on `onKey` (keystrokes) + the DOM paste listener only — neither fires
  // for mouse motion/click/wheel. This test enables mode 1003+1006 and moves the mouse over the
  // pane with NO keystroke; pre-fix (onUserInput) the move cleared the dot, post-fix it survives.
  test('r2: mouse MOTION over a mode-1003 marked active terminal does NOT clear the dot', async () => {
    await page.getByTestId(`project-${beta}`).click()
    expect(await activeTabOf(page, beta)).toBe(betaTab)

    // Enable any-motion mouse tracking (mode 1003) + SGR 1006 encoding, as a Claude TUI does.
    // Shell-computed sentinel (output only, never the echo): once xterm has rendered it, xterm has
    // parsed the mode-set bytes that precede it.
    await writePty(page, betaTerm, "printf '\\033[?1003h\\033[?1006h'; echo MOUSE_MODE_$((6*7))\r")
    await expect(page.locator(`[data-term-id="${betaTerm}"] .xterm-rows`)).toContainText('MOUSE_MODE_42')

    // Mark the ACTIVE, focused tab unread.
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().markUnread(p, t),
      { p: beta, t: betaTab }
    )
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    // Move the pointer across the pane — no click, no keystroke — so xterm emits motion reports.
    const pane = page.locator(`[data-term-id="${betaTerm}"]`)
    const box = present(await pane.boundingBox(), 'terminal pane box')
    await page.mouse.move(box.x + 30, box.y + 30)
    await page.mouse.move(box.x + 70, box.y + 50)
    await page.mouse.move(box.x + 110, box.y + 80)

    // Post-fix: motion reports never reach the clear (onKey/paste only), so the dot survives —
    // held for the real-world report round-trip window.
    await expectQuiet(async () => {
      expect(await tabHasAttention(page, beta, betaTab)).toBe(true)
    }, 1200)
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toBeVisible()

    // A real keystroke still clears it — genuine input works.
    await pane.click({ position: { x: 40, y: 40 } })
    await page.keyboard.type('x')
    await expect(page.getByTestId(`tab-attention-${betaTab}`)).toHaveCount(0)
    expect(await tabHasAttention(page, beta, betaTab)).toBe(false)

    // Disable 1003/1006 and tidy the shell line for any later spec.
    await writePty(page, betaTerm, "printf '\\033[?1003l\\033[?1006l'\r")
    await page.keyboard.press('Backspace')
  })
})
