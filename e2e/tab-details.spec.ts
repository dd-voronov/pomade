// modules: tabs, terminal, agents
// Pomade T-150 e2e — "Show tab details": the per-tab admin/debug popup that shows a tab's RAW
// persisted JSON (the exact Tab object in ProjectState.openTabs, rendered from the LIVE tabs-store)
// and lets it be edited as free JSON. Save is STATE-ONLY, CHANGED-FIELDS-ONLY, and validated
// against the per-kind key allowlist + field-type map co-located with the Tab types.
//
// Two describes, each its own Electron app + throwaway fixture (file-independence rule). The first
// covers the menu, the JSON content, a title edit, changed-fields-only, key deletion, every reject
// path, and the "changed underneath" hint using docs/terminals + a fake agent tab (no session
// store needed). The SECOND drives the real session-attribution harness (fake agent CLI + an
// isolated claude-style store) to prove the §3 hard requirement: a manually edited resumeSessionId
// STICKS (nothing re-asserts a stale cached value), while a genuinely NEW session still overwrites
// it — the desired self-update.

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
import { resetTabs } from './fixtures/stores'
import { FAKE_AGENT_ECHO_EXIT, FAKE_AGENT_RESUME_SIMPLE } from './fixtures/fake-agent'
import { expectQuiet, quietWindow, TEST_POLL_MS } from './fixtures/timing'

// ── shared helpers ─────────────────────────────────────────────────────────────
interface TabSnap {
  id: string
  kind: string
  title: string
  status?: string
  termId?: string
  resumeSessionId?: string
  lastExec?: string
  color?: string
}

function tabsOf(page: Page, pid: string): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      status: t.status,
      termId: t.termId,
      resumeSessionId: t.resumeSessionId,
      lastExec: t.lastExec,
      color: t.color
    }))
  }, pid)
}

async function snapOf(page: Page, pid: string, tabId: string): Promise<TabSnap | undefined> {
  return (await tabsOf(page, pid)).find((t) => t.id === tabId)
}

/** The full persisted tab object as the store holds it (for file/field assertions). */
function fullTab(page: Page, pid: string, tabId: string): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(
    ({ p, t }) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
      const tab: object | undefined = tabs.find((x) => x.id === t)
      return tab as Record<string, unknown> | undefined
    },
    { p: pid, t: tabId }
  )
}

/** Directly patch a tab through the store — a stand-in for a background/self-update landing while
 *  the popup is open (the real sources are the shell's cwd/exec markers and the session watcher). */
function storeUpdateTab(page: Page, pid: string, tabId: string, patch: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    ({ p, t, patch }) =>
      window.__pomadeStores.useTabsStore.getState().updateTab(p, t, patch),
    { p: pid, t: tabId, patch }
  )
}

/** The tab's persisted openTabs entry, straight off disk (proves a field reached the state file). */
async function persistedTab(
  fixture: Fixture,
  pid: string,
  tabId: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(join(fixture.workspaceRoot, '.pomade', 'state', `${pid}.json`), 'utf8')
    const state = JSON.parse(raw) as { openTabs?: Record<string, unknown>[] }
    return state.openTabs?.find((t) => t.id === tabId)
  } catch {
    return undefined
  }
}


async function newTabVia(page: Page, pid: string, testid: string): Promise<string> {
  const before = new Set((await tabsOf(page, pid)).map((t) => t.id))
  const menu = page.getByTestId('tab-add-menu')
  const item = page.getByTestId(testid)
  await expect(async () => {
    if (!(await menu.isVisible().catch(() => false))) {
      await page.getByTestId('tab-add').click()
    }
    await expect(item).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await item.click()
  await expect.poll(() => tabsOf(page, pid).then((t) => t.length)).toBeGreaterThan(before.size)
  const added = (await tabsOf(page, pid)).find((t) => !before.has(t.id))
  if (!added) throw new Error('no new tab')
  return added.id
}

const newTerminalTab = (page: Page, pid: string): Promise<string> =>
  newTabVia(page, pid, 'tab-add-terminal')

async function openDoc(page: Page, rel: string, pid: string): Promise<string> {
  const before = new Set((await tabsOf(page, pid)).map((t) => t.id))
  await page.getByTestId(`tree-node-${rel}`).click()
  await expect.poll(() => tabsOf(page, pid).then((t) => t.length)).toBeGreaterThan(before.size)
  const added = (await tabsOf(page, pid)).find((t) => !before.has(t.id))
  if (!added) throw new Error('doc did not open')
  await page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().commitPreview(p),
    pid
  )
  return added.id
}

// ── details-popup helpers ───────────────────────────────────────────────────────
async function openDetails(page: Page, tabId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click({ button: 'right' })
  await expect(page.getByTestId('tab-context-menu')).toBeVisible()
  await page.getByTestId('menu-tab-details').click()
  await expect(page.getByTestId('tab-details')).toBeVisible()
  await expect(page.getByTestId('tab-details-textarea')).toBeVisible()
}

async function detailsObj(page: Page): Promise<Record<string, unknown>> {
  return JSON.parse(await page.getByTestId('tab-details-textarea').inputValue())
}

async function fillDetails(page: Page, obj: Record<string, unknown>): Promise<void> {
  await page.getByTestId('tab-details-textarea').fill(JSON.stringify(obj, null, 2))
}

async function fillDetailsRaw(page: Page, raw: string): Promise<void> {
  await page.getByTestId('tab-details-textarea').fill(raw)
}

const saveDetails = (page: Page): Promise<void> => page.getByTestId('tab-details-save').click()

// ═══ Suite 1: menu, JSON content, edits, deletes, rejects, hint ═══════════════════
test.describe('T-150 — show tab details popup', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const scriptPath = join(fixture.workspaceRoot, 'fake-agent.sh')
    await fs.writeFile(scriptPath, FAKE_AGENT_ECHO_EXIT, { mode: 0o755 })
    await fs.chmod(scriptPath, 0o755)
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade', 'agents.json'),
      JSON.stringify({ commands: { 'claude-test': scriptPath }, hidden: [] }, null, 2)
    )
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // §1 — the item is present on EVERY kind, in a separated section at the BOTTOM, and the popup
  // shows the exact stored JSON for that tab.
  test('the item shows for every kind (bottom section) and the popup carries the tab’s exact JSON', async () => {
    test.slow()
    await resetTabs(page, alpha)

    // Doc — item present and it is the LAST menu item; the popup JSON carries path + mode.
    const docId = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-details')).toBeVisible()
    const items = page.getByTestId('tab-context-menu').getByRole('menuitem')
    await expect(items.last()).toHaveText('Show tab details')
    await page.getByTestId('menu-tab-details').click()
    await expect(page.getByTestId('tab-details')).toBeVisible()
    const docJson = await detailsObj(page)
    expect(docJson.kind).toBe('doc')
    expect(docJson.path).toBe('Projects/alpha/README.md')
    expect(docJson.mode).toBeDefined()
    expect(docJson.id).toBe(docId)
    await page.keyboard.press('Escape') // Esc = cancel
    await expect(page.getByTestId('tab-details')).toHaveCount(0)

    // Terminal — item present; the popup JSON carries termId + cwd + status.
    const termId = await newTerminalTab(page, alpha)
    await openDetails(page, termId)
    const termJson = await detailsObj(page)
    expect(termJson.kind).toBe('terminal')
    expect(typeof termJson.termId).toBe('string')
    expect(termJson.cwd).toBeDefined()
    expect(termJson.status).toBe('live')
    // Scrim click cancels too.
    await page.mouse.click(4, 4)
    await expect(page.getByTestId('tab-details')).toHaveCount(0)

    // Agent — the item is offered as well.
    const agentId = await newTabVia(page, alpha, 'tab-add-agent-claude-test')
    await page.getByTestId(`tab-${agentId}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-details')).toBeVisible()
    await page.getByTestId('menu-tab-details').click()
    const agentJson = await detailsObj(page)
    expect(agentJson.kind).toBe('agent')
    expect(typeof agentJson.termId).toBe('string')
    await page.getByTestId('tab-details-cancel').click()
    await expect(page.getByTestId('tab-details')).toHaveCount(0)
  })

  // §2 — edit title → Save → strip repaints; the state file carries it after debounce.
  test('editing title repaints the strip and persists to the state file', async () => {
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/notes.txt', alpha)

    await openDetails(page, docId)
    const obj = await detailsObj(page)
    obj.title = 'Renamed via details'
    await fillDetails(page, obj)
    await saveDetails(page)
    await expect(page.getByTestId('tab-details')).toHaveCount(0)

    // The strip repaints from the store immediately.
    await expect(page.getByTestId(`tab-title-${docId}`)).toHaveText('Renamed via details')
    expect((await snapOf(page, alpha, docId))?.title).toBe('Renamed via details')
    // …and it reaches the .pomade state file after the 500ms debounce.
    await expect
      .poll(() => persistedTab(fixture, alpha, docId).then((t) => t?.title), { timeout: 5_000 })
      .toBe('Renamed via details')
  })

  // §4 — changed-fields-only: an edit to ONE field is applied; a concurrent update to ANOTHER
  // field (landing while the popup is open) survives the Save.
  test('changed-fields-only: concurrent updates to untouched fields survive Save', async () => {
    await resetTabs(page, alpha)
    const termId = await newTerminalTab(page, alpha)
    // Seed an EXISTING field so the popup shows it at open — the discriminating case: a naive
    // "apply the whole parsed object" Save would re-assert its at-open value and clobber the
    // concurrent edit below. Changed-fields-only must leave it alone.
    await storeUpdateTab(page, alpha, termId, { color: 'red' })
    await expect.poll(() => snapOf(page, alpha, termId).then((t) => t?.color)).toBe('red')

    await openDetails(page, termId)
    const obj = await detailsObj(page)
    expect(obj.color).toBe('red')
    // Edit ONLY the title in the textarea (color left at its at-open value, red).
    obj.title = 'edited-title'
    await fillDetails(page, obj)

    // Concurrently, straight through the store: an EDIT to an existing field (color red→blue) and
    // an ADD of a new one (lastExec). Neither was touched in the textarea.
    await storeUpdateTab(page, alpha, termId, { color: 'blue', lastExec: 'npm run build' })

    await saveDetails(page)
    await expect(page.getByTestId('tab-details')).toHaveCount(0)

    const snap = await snapOf(page, alpha, termId)
    expect(snap?.title).toBe('edited-title') // the manual edit applied
    expect(snap?.color).toBe('blue') // concurrent EDIT survived (a full-replace Save reverts to red)
    expect(snap?.lastExec).toBe('npm run build') // concurrent ADD survived
    await expect
      .poll(() => persistedTab(fixture, alpha, termId).then((t) => t?.title), { timeout: 5_000 })
      .toBe('edited-title')
    expect((await persistedTab(fixture, alpha, termId))?.color).toBe('blue')
  })

  // §5 — deleting a key clears that field (store + file); the dependent behavior treats it absent.
  test('deleting a key clears the field in store and file', async () => {
    await resetTabs(page, alpha)
    const termId = await newTerminalTab(page, alpha)
    // Seed a lastExec so the popup shows it at open (a deletable field present in the snapshot).
    await storeUpdateTab(page, alpha, termId, { lastExec: 'echo seeded' })
    await expect.poll(() => snapOf(page, alpha, termId).then((t) => t?.lastExec)).toBe('echo seeded')

    await openDetails(page, termId)
    const obj = await detailsObj(page)
    expect(obj.lastExec).toBe('echo seeded')
    delete obj.lastExec
    await fillDetails(page, obj)
    await saveDetails(page)
    await expect(page.getByTestId('tab-details')).toHaveCount(0)

    // Gone from the store…
    await expect.poll(() => snapOf(page, alpha, termId).then((t) => t?.lastExec)).toBeUndefined()
    // …and from the persisted file (JSON.stringify drops the undefined key).
    await expect
      .poll(() => persistedTab(fixture, alpha, termId).then((t) => (t ? 'lastExec' in t : true)), {
        timeout: 5_000
      })
      .toBe(false)
  })

  // §6 — every reject path keeps the popup OPEN with the text intact and shows an error.
  test('reject paths: invalid JSON, unknown key, wrong type, changed id, changed kind', async () => {
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await openDetails(page, docId)
    const error = page.getByTestId('tab-details-error')

    // (a) invalid JSON.
    await fillDetailsRaw(page, '{ this is not json')
    await saveDetails(page)
    await expect(error).toBeVisible()
    await expect(error).toContainText(/invalid json/i)
    await expect(page.getByTestId('tab-details')).toBeVisible()
    await expect(page.getByTestId('tab-details-textarea')).toHaveValue('{ this is not json')

    // (b) unknown key (a typo the allowlist must catch). The textarea currently holds the invalid
    // string, so re-seed each reject case from a fresh valid base read off the store.
    let obj = (await fullTab(page, alpha, docId)) as Record<string, unknown>
    obj.resumeSesionId = 'typo'
    await fillDetails(page, obj)
    await saveDetails(page)
    await expect(error).toContainText('resumeSesionId')
    await expect(error).toContainText(/allowed keys/i)
    await expect(page.getByTestId('tab-details')).toBeVisible()

    // (c) wrong type — a string for the boolean `dirty`.
    obj = (await fullTab(page, alpha, docId)) as Record<string, unknown>
    obj.dirty = 'yes'
    await fillDetails(page, obj)
    await saveDetails(page)
    await expect(error).toContainText('dirty')
    await expect(error).toContainText(/must be a boolean/i)

    // (d) changed id — immutable.
    obj = (await fullTab(page, alpha, docId)) as Record<string, unknown>
    obj.id = 'a-different-id'
    await fillDetails(page, obj)
    await saveDetails(page)
    await expect(error).toContainText('immutable')
    await expect(page.getByTestId('tab-details')).toBeVisible()

    // (e) changed kind — immutable.
    obj = (await fullTab(page, alpha, docId)) as Record<string, unknown>
    obj.kind = 'terminal'
    await fillDetails(page, obj)
    await saveDetails(page)
    await expect(error).toContainText('immutable')
    await expect(page.getByTestId('tab-details')).toBeVisible()

    // Nothing was applied by any rejected Save — the tab is untouched.
    expect((await snapOf(page, alpha, docId))?.kind).toBe('doc')
    expect((await snapOf(page, alpha, docId))?.id).toBe(docId)

    // A correcting Save (restore the valid object) then closes the popup.
    await fillDetails(page, (await fullTab(page, alpha, docId)) as Record<string, unknown>)
    await saveDetails(page)
    await expect(page.getByTestId('tab-details')).toHaveCount(0)
  })

  // §7 — a "changed underneath" hint appears when the underlying tab updates while the popup is
  // open; the textarea is NOT reloaded (view-only awareness).
  test('a "changed underneath" hint appears without reloading the textarea', async () => {
    await resetTabs(page, alpha)
    const termId = await newTerminalTab(page, alpha)
    await openDetails(page, termId)

    // No hint at open.
    await expect(page.getByTestId('tab-details-hint')).toHaveCount(0)
    const before = await page.getByTestId('tab-details-textarea').inputValue()

    // A background update to the underlying object.
    await storeUpdateTab(page, alpha, termId, { color: 'blue' })

    await expect(page.getByTestId('tab-details-hint')).toBeVisible()
    // The textarea is untouched — the user's view is not yanked out from under them.
    await expect(page.getByTestId('tab-details-textarea')).toHaveValue(before)
    await page.getByTestId('tab-details-cancel').click()
    await expect(page.getByTestId('tab-details')).toHaveCount(0)
  })
})

// ═══ Suite 2: §3 — edits stick on a LIVE agent; a genuinely new session still self-updates ═══
// The real session-attribution harness (session-capture.spec's stand-in CLI + an isolated
// claude-style store). Proves the hard requirement: a manually edited resumeSessionId is not
// re-asserted by any stale cached value, while a new session started IN the tab overwrites it.
test.describe('T-150 — a manual resumeSessionId edit sticks (no stale re-assert)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let scriptPath = ''
  let storeDir = ''
  const FIRST_ID = '11111111-1111-4111-8111-111111111111'
  const EDIT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const NEW_ID = '22222222-2222-4222-8222-222222222222'

  function encodeCwd(abs: string): string {
    return abs.replace(/[^a-zA-Z0-9]/g, '-')
  }
  function readBuffer(termId: string): Promise<string> {
    return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
  }
  async function physCwd(termId: string): Promise<string> {
    const cwd = await page.evaluate((tid) => window.pomade.pty.cwd(tid), termId)
    return cwd ? fs.realpath(cwd) : cwd
  }
  async function writeClaudeSession(sessionId: string): Promise<void> {
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
  async function typeSubmit(tabId: string, text: string): Promise<void> {
    await page.getByTestId(`tab-${tabId}`).click()
    await page.getByTestId(`terminal-${tabId}`).click({ position: { x: 60, y: 60 } })
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }
  function agentTabsCount(): Promise<number> {
    return page.evaluate(
      (pid) =>
        (window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []).filter(
          (t) => t.kind === 'agent'
        ).length,
      alpha
    )
  }
  function resumeIdOf(tabId: string): Promise<string | undefined> {
    return snapOf(page, alpha, tabId).then((t) => t?.resumeSessionId)
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    scriptPath = join(fixture.workspaceRoot, 'fake-agent.sh')
    await fs.writeFile(scriptPath, FAKE_AGENT_RESUME_SIMPLE, { mode: 0o755 })
    await fs.chmod(scriptPath, 0o755)
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

  test('edit resumeSessionId → Save → it persists and is NOT rewritten; a new session still captures', async () => {
    test.slow()
    // Launch a fake agent and bind it to FIRST_ID via a real first-prompt submit.
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    await expect.poll(() => agentTabsCount(), { timeout: 15_000 }).toBe(1)
    const agent = (await tabsOf(page, alpha)).find((t) => t.kind === 'agent')!
    const tabId = agent.id
    const termId = agent.termId as string
    await expect.poll(() => readBuffer(termId), { timeout: 15_000 }).toContain('AGENT_READY')

    const cwd = await physCwd(termId)
    expect(cwd).not.toBe('')
    storeDir = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(cwd))

    await typeSubmit(tabId, 'first prompt — bind me')
    await writeClaudeSession(FIRST_ID)
    await expect.poll(() => resumeIdOf(tabId), { timeout: 15_000 }).toBe(FIRST_ID)

    // Edit resumeSessionId by hand (the motivating repair case: fix a wrong/missing id).
    await openDetails(page, tabId)
    const obj = await detailsObj(page)
    expect(obj.resumeSessionId).toBe(FIRST_ID)
    obj.resumeSessionId = EDIT_ID
    await fillDetails(page, obj)
    await saveDetails(page)
    await expect(page.getByTestId('tab-details')).toHaveCount(0)

    // It applies and reaches disk…
    await expect.poll(() => resumeIdOf(tabId), { timeout: 10_000 }).toBe(EDIT_ID)
    await expect
      .poll(() => persistedTab(fixture, alpha, tabId).then((t) => t?.resumeSessionId), { timeout: 5_000 })
      .toBe(EDIT_ID)

    // …and STAYS put: no bind window is open, so nothing re-asserts main's stale cached FIRST_ID.
    // Held well past several (tuned) watcher poll intervals.
    await expectQuiet(async () => {
      expect(await resumeIdOf(tabId)).toBe(EDIT_ID)
      expect((await persistedTab(fixture, alpha, tabId))?.resumeSessionId).toBe(EDIT_ID)
    }, quietWindow(TEST_POLL_MS, 5))

    // The desired self-update still works: starting a genuinely NEW session (/clear + a fresh
    // prompt) captures and overwrites the id normally — event-driven capture is untouched.
    await typeSubmit(tabId, '/clear')
    await typeSubmit(tabId, 'first prompt of the new session')
    await writeClaudeSession(NEW_ID)
    await expect.poll(() => resumeIdOf(tabId), { timeout: 15_000 }).toBe(NEW_ID)
  })
})
