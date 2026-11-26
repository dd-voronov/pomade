// modules: agents, terminal, tabs
// Pomade T-110 / T-151 e2e — a dedupe "Copy to another project" must not double-count the Projects panel
// attention counter. Repro (the Owner): copy XX.md A→B → B's counter 1 (correct). Copy the SAME doc
// to B AGAIN → the dedupe re-uses the existing (still-unread) tab, so B holds ONE tab; the counter
// must stay 1. Under T-151 the counter is a LIVE DERIVED tally of unread (dotted) tabs, so dedupe
// is inherent — the derivation counts the single dotted tab and structurally cannot double-count.
//
// State chains WITHIN this file (one app, one window) — tests append, never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'

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

/** The project's T-151 Projects panel attention counter — the LIVE DERIVED count of unread (dotted)
 *  tabs, exactly what the Projects panel renders. Read from the tab set (the store the badge derives). */
async function attn(page: Page, pid: string): Promise<number> {
  return (await tabsOf(page, pid)).filter((t) => t.attention).length
}

/** Count of attention-marked tabs in a project — identical to `attn` now (kept for readability). */
async function markedCount(page: Page, pid: string): Promise<number> {
  return (await tabsOf(page, pid)).filter((t) => t.attention).length
}

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

/** Right-click a DOC tab and COPY it to `toProjectId`. */
async function copyTabTo(page: Page, tabId: string, toProjectId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click({ button: 'right' })
  await page.getByTestId('menu-tab-copy-to').click()
  await expect(page.getByTestId('menu-tab-copy-to-submenu')).toBeVisible()
  await page.getByTestId(`menu-tab-copy-to-project-${toProjectId}`).click()
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
}

async function newTerminalIn(page: Page, projectId: string): Promise<string> {
  return page.evaluate(async (pid) => {
    const stores = window.__pomadeStores
    const project = stores.useWorkspaceStore.getState().projectById(pid)
    await stores.useTerminalsStore.getState().newTerminal(project)
    const tabs = stores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.find((t) => t.termId)?.termId as string
  }, projectId)
}

test.describe('T-110 / T-151 dedupe copy must not double-count the counter', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string
  let beta: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta

    // Give beta its own tab so arrivals land as BACKGROUND (attention-marked) tabs — the repro
    // condition (an empty target would make the copy the active tab, which never shows a dot).
    await page.getByTestId(`project-${beta}`).click()
    await newTerminalIn(page, beta)
    // Open alpha; beta's lone terminal is its (unread-free) active tab, so the derived counter
    // starts at 0 — no store to wipe under T-151.
    await page.getByTestId(`project-${alpha}`).click()
    expect(await attn(page, beta)).toBe(0)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('copy the SAME doc twice → counter 1, one marked tab (no double-bump)', async () => {
    const rel = 'Projects/alpha/README.md'
    const docTab = await openDoc(page, rel, alpha)

    // First copy: a new arrival — the copy lands dotted, so beta's derived count is 1 and the
    // Projects panel badge on beta's row reads 1.
    await copyTabTo(page, docTab, beta)
    await expect.poll(() => attn(page, beta)).toBe(1)
    expect(await markedCount(page, beta)).toBe(1)
    expect((await tabsOf(page, beta)).filter((t) => t.path === rel)).toHaveLength(1)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')

    // Second copy of the SAME doc: dedupe re-uses the already-dotted tab — no new dot, and the
    // derivation counts the single tab exactly once (the old event tally jumped to 2 here).
    await copyTabTo(page, docTab, beta)
    // Still 1 — cannot double-count; held for the window a wrongful bump would need.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(1)
      expect(await markedCount(page, beta)).toBe(1)
    }, 300)
    expect((await tabsOf(page, beta)).filter((t) => t.path === rel)).toHaveLength(1)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')
  })

  test('copying a DIFFERENT doc adds a second unread tab → counter 2, two marked tabs', async () => {
    const rel = 'Projects/alpha/notes.txt'
    const docTab = await openDoc(page, rel, alpha)
    await copyTabTo(page, docTab, beta)

    await expect.poll(() => attn(page, beta)).toBe(2)
    expect(await markedCount(page, beta)).toBe(2)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('2')
  })
})
