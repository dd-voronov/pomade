// modules: tabs, terminal, editor
// Pomade T-149 e2e — reopen closed tab (per-project undo-close stack).
//
// The thing under test: every explicit close pushes the tab (its full object + strip index) onto
// its project's reopen stack — LIFO, cap 10, PERSISTED in ProjectState.reopenStack. "Reopen closed
// tab" pops the top and brings it back with the app-restart revive semantics (a doc from disk, a
// terminal as a fresh shell with its scrollback REPLAYED and last command pre-typed, an agent via
// --resume), at its ORIGINAL index, active. The snapshot forget is DEFERRED: a tab's scrollback is
// kept while it sits on any reopen stack and forgotten only when it permanently leaves (cap
// eviction), and the stack — with working replay — survives an app restart.
//
// Three entry points: the Tab-Panel kebab item, a new empty-space (end-zone) context menu, and
// Cmd+Shift+T. State chains WITHIN each describe — tests append, never insert.

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
import { readBuffer, writeWhenReady } from './fixtures/stores'
import { FAKE_AGENT_MOUSE, seedFakeAgent } from './fixtures/fake-agent'

const DIVIDER = 'session restored'

// The same TUI-shaped stand-in agent the scrollback specs use (startup queries + mode enables,
// a farewell that prints a resume line). Kept in sync deliberately — an independent copy.

async function bootPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return page
}

/** Click a real application-menu item from the main process (Cmd+Shift+T = menu-reopen-closed-tab). */
function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`menu item not found: ${itemId}`)
    item.click()
  }, id)
}

function stateFile(fixture: Fixture, projectId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`)
}

async function seedProjectState(fixture: Fixture, projectId: string, state: unknown): Promise<void> {
  await fs.mkdir(join(fixture.workspaceRoot, '.pomade', 'state'), { recursive: true })
  await fs.writeFile(stateFile(fixture, projectId), JSON.stringify(state, null, 2))
}

async function readState(fixture: Fixture, projectId: string): Promise<{
  openTabs?: { id: string }[]
  reopenStack?: { tab: { id: string; kind: string }; index: number }[]
}> {
  try {
    return JSON.parse(await fs.readFile(stateFile(fixture, projectId), 'utf8'))
  } catch {
    return {}
  }
}

function snapshotPath(fixture: Fixture, tabId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback', tabId)
}
async function snapshotOf(fixture: Fixture, tabId: string): Promise<string | null> {
  try {
    return await fs.readFile(snapshotPath(fixture, tabId), 'utf8')
  } catch {
    return null
  }
}
async function scrollbackDir(fixture: Fixture): Promise<string[]> {
  try {
    return (await fs.readdir(join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback'))).sort()
  } catch {
    return []
  }
}

// ── store oracles via the __pomadeStores hook ─────────────────────────────────────────
interface TabInfo {
  id: string
  kind: string
  title: string
  status?: string
  termId?: string
  mode?: string
  color?: string
  cwd?: string
}

function tabsInfo(page: Page, pid: string): Promise<TabInfo[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      status: t.status,
      termId: t.termId,
      mode: t.mode,
      color: t.color,
      cwd: t.cwd
    }))
  }, pid)
}

function reopenStackIds(page: Page, pid: string): Promise<string[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.reopenStackByProject[p] ?? []).map((e) => e.tab.id)
  }, pid)
}

function activeId(page: Page, pid: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[p],
    pid
  )
}

function readReplay(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.replay(tid), termId)
}
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

async function snapOf(page: Page, pid: string, tabId: string): Promise<TabInfo | undefined> {
  return (await tabsInfo(page, pid)).find((t) => t.id === tabId)
}

/** Poll until `tabId` is live on a termId OTHER than `deadTermId` (a revive completed). */
async function waitRevived(
  page: Page,
  pid: string,
  tabId: string,
  deadTermId: string
): Promise<TabInfo> {
  await expect
    .poll(
      async () => {
        const s = await snapOf(page, pid, tabId)
        return s?.status === 'live' && s.termId !== deadTermId
      },
      { timeout: 60_000 }
    )
    .toBe(true)
  const snap = await snapOf(page, pid, tabId)
  if (!snap) throw new Error(`tab ${tabId} vanished`)
  return snap
}

// ── setup helpers ──────────────────────────────────────────────────────────────────────
async function openTerminal(page: Page, pid: string): Promise<TabInfo> {
  const before = new Set((await tabsInfo(page, pid)).map((t) => t.id))
  const menu = page.getByTestId('tab-add-menu')
  const item = page.getByTestId('tab-add-terminal')
  await expect(async () => {
    if (!(await menu.isVisible().catch(() => false))) await page.getByTestId('tab-add').click()
    await expect(item).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await item.click()
  await expect
    .poll(() => tabsInfo(page, pid).then((t) => t.length), { timeout: 20_000 })
    .toBeGreaterThan(before.size)
  const added = (await tabsInfo(page, pid)).find((t) => !before.has(t.id))
  if (!added) throw new Error('terminal did not open')
  return added
}

/** Open a doc tab straight through the store (deterministic mode/color, real workspace path). */
async function openDoc(
  page: Page,
  pid: string,
  path: string,
  title: string,
  mode: string,
  color?: string
): Promise<string> {
  return page.evaluate(
    ({ p, path, title, mode, color }) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      const id = 'doc-' + Math.random().toString(36).slice(2, 10)
      const tab: Record<string, unknown> = {
        id,
        projectId: p,
        kind: 'doc',
        title,
        path,
        mode,
        dirty: false
      }
      if (color) tab.color = color
      s.openTab(tab)
      return id
    },
    { p: pid, path, title, mode, color }
  )
}

function closeTabViaX(page: Page, tabId: string): Promise<void> {
  return page.getByTestId(`close-${tabId}`).click()
}

async function clickReopenKebab(page: Page): Promise<void> {
  await page.getByTestId('bulk-actions').click()
  await expect(page.getByTestId('bulk-menu')).toBeVisible()
  await page.getByTestId('bulk-reopen-closed-tab').click()
}

// ═══ §1 + §7 — reopen a doc at its original index; the item's enablement tracks the stack ═══
test.describe('T-149 §1/§7 — a closed doc reopens at its index; the item enables with the stack', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the kebab item is DISABLED while the stack is empty', async () => {
    test.slow()
    await openTerminal(page, alpha) // one tab so the strip + actions render
    await page.getByTestId('bulk-actions').click()
    await expect(page.getByTestId('bulk-reopen-closed-tab')).toBeDisabled()
    await page.getByTestId('bulk-scrim').click() // close the kebab
    await expect(page.getByTestId('bulk-menu')).toBeHidden()
  })

  test('closing a doc enables the item; reopen restores it at its index, active, same mode/color', async () => {
    test.slow()
    // Strip so far: [term0]. Open docA (lands right of the active term ⇒ index 1), then term2.
    const docId = await openDoc(page, alpha, 'Projects/alpha/README.md', 'README.md', 'rendered', 'teal')
    await openTerminal(page, alpha)
    const before = await tabsInfo(page, alpha)
    const idxBefore = before.findIndex((t) => t.id === docId)
    expect(idxBefore).toBe(1)

    await closeTabViaX(page, docId)
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === docId)))
      .toBe(false)
    // §7 — the stack now has an entry, so the item is enabled.
    expect(await reopenStackIds(page, alpha)).toContain(docId)
    await page.getByTestId('bulk-actions').click()
    await expect(page.getByTestId('bulk-reopen-closed-tab')).toBeEnabled()
    await page.getByTestId('bulk-scrim').click()
    await expect(page.getByTestId('bulk-menu')).toBeHidden()

    await clickReopenKebab(page)
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === docId)))
      .toBe(true)
    const after = await tabsInfo(page, alpha)
    const restored = after.find((t) => t.id === docId)
    expect(after.findIndex((t) => t.id === docId)).toBe(1) // §1 original index (clamped)
    expect(restored?.title).toBe('README.md')
    expect(restored?.mode).toBe('rendered')
    expect(restored?.color).toBe('teal')
    expect(await activeId(page, alpha)).toBe(docId) // §1 active
    // The entry left the stack.
    expect(await reopenStackIds(page, alpha)).not.toContain(docId)
  })
})

// ═══ §2 — a closed terminal reopens as a fresh shell, scrollback replayed, last-exec pre-typed ══
test.describe('T-149 §2 — a reopened terminal replays its scrollback and pre-types its last command', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''
  const MARK = 'REOPEN_TERM_MARK'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('reopen brings a NEW shell with the old scrollback above a divider and the command pre-typed', async () => {
    test.slow()
    const tab = await openTerminal(page, alpha)
    const deadTerm = tab.termId!
    await writeWhenReady(page, deadTerm, `echo ${MARK}\r`)
    await expect.poll(() => readBuffer(page, deadTerm), { timeout: 20_000 }).toContain(MARK)
    // Ensure the debounced snapshot has landed with the mark before closing (same pattern the
    // scrollback specs use — the on-disk file is what a same-session reopen replays).
    await expect
      .poll(async () => (await snapshotOf(fixture, tab.id)) ?? '', { timeout: 20_000 })
      .toContain(MARK)

    await closeTabViaX(page, tab.id)
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === tab.id)))
      .toBe(false)
    // Deferred forget — the snapshot is kept for the reopen.
    expect(await snapshotOf(fixture, tab.id)).toContain(MARK)

    await clickReopenKebab(page)
    const revived = await waitRevived(page, alpha, tab.id, deadTerm)
    expect(revived.termId).not.toBe(deadTerm) // fresh shell

    // The replay paint: old scrollback, exactly one divider, then the fresh live shell.
    await expect.poll(() => readReplay(page, revived.termId!), { timeout: 20_000 }).toContain(DIVIDER)
    const paint = await readReplay(page, revived.termId!)
    expect(paint).toContain(MARK)
    expect(occurrences(paint, DIVIDER)).toBe(1)
    expect(paint.indexOf(MARK)).toBeLessThan(paint.indexOf(DIVIDER))

    // Last-exec pre-type: `echo REOPEN_TERM_MARK` was typed (unsubmitted) into the fresh shell, so
    // its line-editor echo lands in the LIVE ring (which never contains the replayed base).
    await expect
      .poll(() => readBuffer(page, revived.termId!), { timeout: 20_000 })
      .toContain(`echo ${MARK}`)
    // Old cwd carried across the reopen (same object rode the stack).
    expect(revived.cwd).toBe('Projects/alpha')
  })
})

// ═══ §3 — an agent reopens via --resume; an invalid session becomes an honest dead pane ═══
test.describe('T-149 §3 — agent reopen resumes, or keeps a dead pane on an invalid session', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''
  const GOOD = 'good-agent-tab'
  const GOOD_TERM = 'good-agent-gone'
  const BAD = 'bad-agent-tab'
  const BAD_TERM = 'bad-agent-gone'
  const RESUME_ID = 'acacacac-acac-4cac-8cac-acacacacacac'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    await seedFakeAgent(fixture, { script: FAKE_AGENT_MOUSE })
    const launchCwd = join(fixture.workspaceRoot, 'Projects/alpha')
    // The provider store is keyed on the REALPATH of the launch cwd (E-025). Seed the GOOD tab's
    // transcript there so validateSession passes; the BAD tab gets none.
    const storeDir = join(
      fixture.workspaceRoot,
      'Agents/claude-test/projects',
      (await fs.realpath(launchCwd)).replace(/[^a-zA-Z0-9]/g, '-')
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
    const agentTab = (id: string, termId: string, resumeSessionId: string): unknown => ({
      id,
      projectId: alpha,
      kind: 'agent',
      title: 'claude-test',
      termId,
      agentId: 'claude-test',
      cwd: launchCwd,
      cwdAtLaunch: launchCwd,
      status: 'live',
      lastCommand: join(fixture.workspaceRoot, 'fake-agent.sh'),
      resumeSessionId,
      bindState: 'bound'
    })
    // Both agents sit on the reopen stack ONLY (never in openTabs), so nothing revives at boot —
    // the reopen is what drives the resume. BAD is on top (reopened first).
    await seedProjectState(fixture, alpha, {
      openTabs: [],
      reopenStack: [
        { tab: agentTab(GOOD, GOOD_TERM, RESUME_ID), index: 0 },
        { tab: agentTab(BAD, BAD_TERM, 'deadbeef-dead-4bee-8bee-deadbeefdead'), index: 0 }
      ]
    })
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('an invalid session reopens as a dead pane, tab kept', async () => {
    test.slow()
    await clickReopenKebab(page) // pops BAD (top)
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === BAD)))
      .toBe(true)
    // validateSession fails (no transcript) ⇒ markDead; the tab stays, its dead pane shows.
    await expect.poll(() => snapOf(page, alpha, BAD).then((s) => s?.status), { timeout: 60_000 }).toBe(
      'dead'
    )
    await expect(page.getByTestId(`terminal-dead-${BAD}`)).toBeVisible()
  })

  test('a valid session reopens and resumes via --resume', async () => {
    test.slow()
    await clickReopenKebab(page) // pops GOOD
    const revived = await waitRevived(page, alpha, GOOD, GOOD_TERM)
    await expect
      .poll(() => readBuffer(page, revived.termId!), { timeout: 20_000 })
      .toContain(`--resume ${RESUME_ID}`)
    await expect
      .poll(() => readBuffer(page, revived.termId!), { timeout: 20_000 })
      .toContain('AGENT_READY')
  })
})

// ═══ §4 — LIFO order, and the cap evicts (and forgets) the oldest ═══
test.describe('T-149 §4 — LIFO reopen order and the 10-deep cap', () => {
  test.describe('LIFO: close A then B, reopen gives B then A', () => {
    let fixture: Fixture
    let app: ElectronApplication | undefined
    let page: Page
    let alpha = ''

    test.beforeAll(async () => {
      fixture = await createFixtureWorkspace()
      alpha = fixture.projects.alpha
      app = await launchApp(fixture)
      page = await bootPage(app)
      await page.getByTestId(`project-${alpha}`).click()
    })

    test.afterAll(async () => {
      await app?.close()
      await fixture?.cleanup()
    })

    test('reopen resurrects most-recent-first', async () => {
      test.slow()
      const a = await openDoc(page, alpha, 'Projects/alpha/README.md', 'A.md', 'raw')
      const b = await openDoc(page, alpha, 'Projects/alpha/notes.txt', 'B.txt', 'raw')
      await closeTabViaX(page, a) // push A
      await closeTabViaX(page, b) // push B (top)
      expect(await reopenStackIds(page, alpha)).toEqual([a, b])

      await clickReopenKebab(page) // B first
      expect(await activeId(page, alpha)).toBe(b)
      await clickReopenKebab(page) // then A
      expect(await activeId(page, alpha)).toBe(a)
      expect(await reopenStackIds(page, alpha)).toEqual([])
    })
  })

  test.describe('cap: the 11th close evicts the oldest and forgets its snapshot', () => {
    let fixture: Fixture
    let app: ElectronApplication | undefined
    let page: Page
    let alpha = ''

    test.beforeAll(async () => {
      fixture = await createFixtureWorkspace()
      alpha = fixture.projects.alpha
      app = await launchApp(fixture)
      page = await bootPage(app)
      await page.getByTestId(`project-${alpha}`).click()
    })

    test.afterAll(async () => {
      await app?.close()
      await fixture?.cleanup()
    })

    test('the evicted terminal is unrecoverable and its scrollback file is gone', async () => {
      test.slow()
      // The OLDEST close is a terminal that produced scrollback — its snapshot is the file that
      // must be swept on eviction. Then ten cheap docs fill the rest of the 11 closes.
      const term = await openTerminal(page, alpha)
      await writeWhenReady(page, term.termId!, 'echo EVICT_ME_MARK\r')
      await expect
        .poll(async () => (await snapshotOf(fixture, term.id)) ?? '', { timeout: 20_000 })
        .toContain('EVICT_ME_MARK')

      await closeTabViaX(page, term.id) // close #1 (bottom of the stack)
      expect(await scrollbackDir(fixture)).toEqual([term.id]) // still kept (deferred forget)

      const docIds: string[] = []
      for (let i = 0; i < 10; i++) {
        const id = await openDoc(page, alpha, 'Projects/alpha/README.md', `d${i}.md`, 'raw')
        docIds.push(id)
      }
      for (const id of docIds) await closeTabViaX(page, id) // closes #2..#11

      // The stack is capped at 10 and no longer contains the terminal (evicted as the oldest).
      const stack = await reopenStackIds(page, alpha)
      expect(stack).toHaveLength(10)
      expect(stack).not.toContain(term.id)
      expect(stack).toEqual(docIds) // exactly the ten docs, oldest→newest

      // Eviction forgets the terminal's snapshot (the id left both openTabs and the stack).
      await expect.poll(() => scrollbackDir(fixture), { timeout: 20_000 }).toEqual([])

      // Ten reopens recover the ten docs; the terminal is never among them.
      for (let i = 0; i < 10; i++) await clickReopenKebab(page)
      const back = new Set((await tabsInfo(page, alpha)).map((t) => t.id))
      for (const id of docIds) expect(back.has(id)).toBe(true)
      expect(back.has(term.id)).toBe(false)
      // Stack drained; the item is disabled again.
      expect(await reopenStackIds(page, alpha)).toEqual([])
    })
  })
})

// ═══ §5 — the stack (with working replay) survives an app restart ═══
test.describe('T-149 §5 — a closed terminal reopens WITH scrollback after a restart', () => {
  let fixture: Fixture
  let alpha = ''
  let tabId = ''
  let termRun1 = ''
  const MARK = 'RESTART_REOPEN_MARK'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('run 1 — open a terminal, produce output, close it (onto the persisted stack), quit', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    const term = await openTerminal(page, alpha)
    tabId = term.id
    termRun1 = term.termId!
    await writeWhenReady(page, termRun1, `echo ${MARK}\r`)
    await expect
      .poll(async () => (await snapshotOf(fixture, tabId)) ?? '', { timeout: 20_000 })
      .toContain(MARK)
    await closeTabViaX(page, tabId)
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === tabId)))
      .toBe(false)
    // The (tuned) debounced state.save must persist the stack entry — poll it onto disk.
    await expect
      .poll(async () => ((await readState(fixture, alpha)).reopenStack ?? []).some((e) => e.tab.id === tabId), {
        timeout: 15_000
      })
      .toBe(true)
    await app.close()
    const state = await readState(fixture, alpha)
    expect((state.reopenStack ?? []).some((e) => e.tab.id === tabId)).toBe(true)
    // The boot GC of the NEXT run must not sweep this — verified by run 2's replay.
    expect(await snapshotOf(fixture, tabId)).toContain(MARK)
  })

  test('run 2 — relaunch, reopen, and the revived terminal replays its scrollback', async () => {
    test.slow()
    const app = await launchApp(fixture)
    const page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
    // The boot GC ran; the stacked tab's snapshot survived it (the gcSnapshots reopenStack fix).
    expect(await snapshotOf(fixture, tabId)).toContain(MARK)
    // The stack rehydrated from disk.
    await expect
      .poll(() => reopenStackIds(page, alpha), { timeout: 20_000 })
      .toContain(tabId)

    await clickReopenKebab(page)
    const revived = await waitRevived(page, alpha, tabId, termRun1)
    await expect.poll(() => readReplay(page, revived.termId!), { timeout: 20_000 }).toContain(MARK)
    const paint = await readReplay(page, revived.termId!)
    expect(occurrences(paint, DIVIDER)).toBe(1)
    expect(paint.indexOf(MARK)).toBeLessThan(paint.indexOf(DIVIDER))
    await app.close()
  })
})

// ═══ §6 — the three entry points: empty-space menu, per-tab menu untouched, Cmd+Shift+T ═══
test.describe('T-149 §6 — empty-space context menu, per-tab menu, and the accelerator', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('right-clicking the empty strip opens the strip menu with all five items', async () => {
    test.slow()
    await openTerminal(page, alpha) // ensure a strip + an end zone with room
    await page.getByTestId('tabstrip-end-zone').click({ button: 'right' })
    const menu = page.getByTestId('strip-context-menu')
    await expect(menu).toBeVisible()
    for (const id of [
      'strip-reopen-closed-tab',
      'strip-stop-terminals',
      'strip-exit-agents',
      'strip-close-all-docs',
      'strip-close-saved-docs'
    ]) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    // Empty stack ⇒ Reopen is disabled here too.
    await expect(page.getByTestId('strip-reopen-closed-tab')).toBeDisabled()
    await page.getByTestId('strip-menu-scrim').click()
    await expect(menu).toBeHidden()
  })

  test('right-clicking a TAB still opens the per-tab menu (no regression)', async () => {
    test.slow()
    const tabs = await tabsInfo(page, alpha)
    const t = tabs[0]
    await page.getByTestId(`tab-${t.id}`).click({ button: 'right' })
    await expect(page.getByTestId('tab-context-menu')).toBeVisible()
    await expect(page.getByTestId('strip-context-menu')).toBeHidden()
    // Dismiss via a CORNER click on the scrim — its center is under the taller per-tab menu after
    // T-150's "Show tab details" section, so a center-click would hit a menu item.
    await page.getByTestId('tab-menu-scrim').click({ position: { x: 5, y: 5 } })
  })

  test('the strip menu reopens a closed tab; Cmd+Shift+T (menu item) does too', async () => {
    test.slow()
    // Close a doc, reopen it via the STRIP menu.
    const d1 = await openDoc(page, alpha, 'Projects/alpha/README.md', 'sm.md', 'raw')
    await closeTabViaX(page, d1)
    await page.getByTestId('tabstrip-end-zone').click({ button: 'right' })
    await expect(page.getByTestId('strip-reopen-closed-tab')).toBeEnabled()
    await page.getByTestId('strip-reopen-closed-tab').click()
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === d1)))
      .toBe(true)

    // Close it again and reopen through the real app-menu item (the Cmd+Shift+T route).
    await closeTabViaX(page, d1)
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === d1)))
      .toBe(false)
    await clickMenuItem(app!, 'menu-reopen-closed-tab')
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === d1)))
      .toBe(true)
    expect(await activeId(page, alpha)).toBe(d1)
  })
})
