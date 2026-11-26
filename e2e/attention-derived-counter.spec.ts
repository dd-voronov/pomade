// modules: tabs, projects, terminal, agents, core
// Pomade T-151 e2e — the Projects panel attention counter is a LIVE DERIVED count of unread (dotted)
// tabs. These specs pin the parts of that contract the other attention suites don't cover:
//   • a MIXED-KIND unread set (doc + terminal + agent) counts each dotted tab once;
//   • the collapsed RAIL badges match per project and the aggregate SUMS across projects;
//   • counts SURVIVE A RESTART — tab.attention is persisted, and boot hydrates every project.
//
// Drives the real Electron app through the __pomadeStores hook, the established pattern.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { resetTabs } from './fixtures/stores'
import { FAKE_AGENT_ECHO_EXIT, seedFakeAgent } from './fixtures/fake-agent'

interface TabSnap {
  id: string
  kind: string
  path?: string
  attention?: boolean
}

function tabsOf(page: Page, pid: string): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      path: t.path,
      attention: t.attention
    }))
  }, pid)
}

async function attn(page: Page, pid: string): Promise<number> {
  return (await tabsOf(page, pid)).filter((t) => t.attention).length
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
const newAgentTab = (page: Page, pid: string): Promise<string> =>
  newTabVia(page, pid, 'tab-add-agent-claude-test')

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

/** Right-click a tab and click "Mark unread". */
async function markUnread(page: Page, tabId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click({ button: 'right' })
  await page.getByTestId('menu-tab-mark-unread').click()
  await expect(page.getByTestId(`tab-attention-${tabId}`)).toBeVisible()
}

test.describe('T-151 — derived counter: mixed kinds + collapsed rail aggregate', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string
  let beta: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('unread doc + terminal + agent count 3; the rail aggregate sums across projects', async () => {
    await page.getByTestId(`project-${alpha}`).click()
    await resetTabs(page, alpha)

    const term = await newTerminalTab(page, alpha)
    const agent = await newAgentTab(page, alpha)
    const doc = await openDoc(page, 'Projects/alpha/README.md', alpha) // becomes active

    // Mark all three unread: term + agent are inactive; the doc is active (its dot stays put).
    await markUnread(page, term)
    await markUnread(page, agent)
    await markUnread(page, doc)

    expect(await attn(page, alpha)).toBe(3)
    await expect(page.getByTestId(`project-attention-${alpha}`)).toHaveText('3')

    // Give Beta one unread tab (a background project) via the store, so the aggregate is a real sum.
    await page.evaluate(async (pid) => {
      const stores = window.__pomadeStores
      const project = stores.useWorkspaceStore.getState().projectById(pid)
      await stores.useTerminalsStore.getState().newTerminal(project)
      const tabs = stores.useTabsStore.getState().tabsByProject[pid] ?? []
      const last = tabs[tabs.length - 1]
      stores.useTabsStore.getState().updateTab(pid, last.id, { attention: true })
    }, beta)
    expect(await attn(page, beta)).toBe(1)

    // Collapse the Projects panel to the rail; per-project badges match and the aggregate sums (3 + 1).
    await page.evaluate(() =>
      window.__pomadeStores.useAppSettingsStore.getState().toggleProjectsPanelCollapsed()
    )
    await expect(page.getByTestId('projects-panel-rail')).toBeVisible()
    await expect(page.getByTestId(`rail-attention-${alpha}`)).toHaveText('3')
    await expect(page.getByTestId(`rail-attention-${beta}`)).toHaveText('1')
    await expect(page.getByTestId('projects-panel-rail-attention')).toHaveText('4')

    // Restore the expanded Projects panel.
    await page.evaluate(() =>
      window.__pomadeStores.useAppSettingsStore.getState().toggleProjectsPanelCollapsed()
    )
    await expect(page.getByTestId(`project-attention-${alpha}`)).toHaveText('3')
  })
})

test.describe('T-151 — unread counts survive a restart', () => {
  let fixture: Fixture

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('marks persist across a relaunch (two-run)', async () => {
    const alpha = fixture.projects.alpha

    // ── Run 1: mark two tabs unread, flush the persisted state, quit. ──────────────────────────
    let app = await launchApp(fixture)
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()
    await resetTabs(page, alpha)

    const t1 = await newTerminalTab(page, alpha)
    const d1 = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await newTerminalTab(page, alpha) // t2 — stays the active tab, unmarked

    // Mark the two inactive tabs unread → the active project's badge reads 2.
    await markUnread(page, t1)
    await markUnread(page, d1)
    await expect(page.getByTestId(`project-attention-${alpha}`)).toHaveText('2')

    // Force the debounced per-project state.save to disk before quitting (deterministic).
    await page.evaluate(() =>
      window.__pomadeStores.useTabsStore.getState().flush()
    )
    await app.close()

    // ── Run 2: relaunch the SAME workspace + userData — the badges come back. ───────────────────
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()

    // Boot hydrates every project, so the restored tab.attention flags rebuild the derived count —
    // the badge on alpha's row reads 2 again, whichever project/tab boots active.
    await expect(page.getByTestId(`project-attention-${alpha}`)).toHaveText('2')
    expect(await attn(page, alpha)).toBe(2)
    await app.close()
  })
})
