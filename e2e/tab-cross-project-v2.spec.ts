// modules: tabs, terminal
// Pomade T-103 e2e — cross-project actions v2 (extends T-097). The behaviours this file owns:
//   • the tab menu offers EXPLICIT Copy vs Move — docs get both, terminals/agents Move only;
//   • Copy makes a second tab for the same path (dedupes on repeat), Move (doc AND terminal)
//     makes the tab LEAVE the source strip;
//   • a copied/moved tab lands ATTENTION-MARKED and bumps the target project's Projects panel counter,
//     and opening it (project + tab) clears both;
//   • moving-out the ACTIVE tab focuses its RIGHT neighbour, not the last tab;
//   • "Reveal in Finder" is on every tab kind and fires the reveal IPC (doc → file, term → cwd).
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

const WORKSPACE_ID = '__workspace__'

interface TabSnap {
  id: string
  kind: string
  title: string
  path?: string
  projectId: string
  attention?: boolean
}

function tabsOf(page: Page, pid: string): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      path: t.path,
      projectId: t.projectId,
      attention: t.attention
    }))
  }, pid)
}

function activeId(page: Page, pid: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[p],
    pid
  )
}

/** The project's T-151 Projects panel attention counter — the LIVE DERIVED count of unread (dotted)
 *  tabs, exactly what the Projects panel renders. Read straight off the tab set. */
async function attn(page: Page, pid: string): Promise<number> {
  return (await tabsOf(page, pid)).filter((t) => t.attention).length
}

/** Clear every unread dot in every project (test baseline) — there is no counter store to reset
 *  under T-151, the count IS the dotted-tab set, so we clear the dots directly. */
async function clearAttention(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__pomadeStores.useTabsStore.getState()
    for (const [pid, tabs] of Object.entries(s.tabsByProject)) {
      for (const t of tabs) if (t.attention) s.updateTab(pid, t.id, { attention: undefined })
    }
  })
}

async function resetTabs(page: Page, pids: string[]): Promise<void> {
  for (const pid of pids) {
    await page.evaluate((p) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      for (const t of [...(s.tabsByProject[p] ?? [])]) s.closeTab(p, t.id)
    }, pid)
    await expect.poll(() => tabsOf(page, pid).then((t) => t.length)).toBe(0)
  }
}

async function newTerminalTab(page: Page, pid: string): Promise<string> {
  const before = new Set((await tabsOf(page, pid)).map((t) => t.id))
  const menu = page.getByTestId('tab-add-menu')
  const item = page.getByTestId('tab-add-terminal')
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

/** Right-click a tab and MOVE it to `toProjectId`. */
async function moveTabTo(page: Page, tabId: string, toProjectId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click({ button: 'right' })
  await page.getByTestId('menu-tab-move').click()
  await expect(page.getByTestId('menu-tab-move-submenu')).toBeVisible()
  await page.getByTestId(`menu-tab-move-project-${toProjectId}`).click()
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
}

/** Right-click a DOC tab and COPY it to `toProjectId`. */
async function copyTabTo(page: Page, tabId: string, toProjectId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click({ button: 'right' })
  await page.getByTestId('menu-tab-copy-to').click()
  await expect(page.getByTestId('menu-tab-copy-to-submenu')).toBeVisible()
  await page.getByTestId(`menu-tab-copy-to-project-${toProjectId}`).click()
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
}

/** Absolute paths handed to Finder (recorded, not revealed, under NODE_ENV=test). */
function revealed(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

test.describe('T-103 cross-project actions v2', () => {
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
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.beforeEach(async () => {
    await page.getByTestId(`project-${alpha}`).click()
    await resetTabs(page, [alpha, beta, WORKSPACE_ID])
    await clearAttention(page)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('doc tab menu shows BOTH Copy and Move; terminal tab shows Move only', async () => {
    const docTab = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await page.getByTestId(`tab-${docTab}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-copy-to')).toBeVisible()
    await expect(page.getByTestId('menu-tab-move')).toBeVisible()
    await page.keyboard.press('Escape')

    const termTab = await newTerminalTab(page, alpha)
    await page.getByTestId(`tab-${termTab}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-move')).toBeVisible()
    await expect(page.getByTestId('menu-tab-copy-to')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('Copy makes a second tab for the same path; the original stays; repeat dedupes', async () => {
    // Beta already has a tab so the arrival is a background (non-active) tab.
    await page.getByTestId(`project-${beta}`).click()
    const betaTerm = await newTerminalTab(page, beta)
    await page.getByTestId(`project-${alpha}`).click()

    const rel = 'Projects/alpha/README.md'
    const docTab = await openDoc(page, rel, alpha)
    await copyTabTo(page, docTab, beta)

    // A SECOND tab for the same path in beta; the original in alpha is untouched.
    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs.map((t) => t.id)).toEqual([betaTerm, expect.any(String)])
    const copy = betaTabs.find((t) => t.path === rel)!
    expect(copy.id).not.toBe(docTab)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([docTab])

    // Repeat → re-uses the existing tab (no duplicate for the path).
    await copyTabTo(page, docTab, beta)
    expect((await tabsOf(page, beta)).filter((t) => t.path === rel)).toHaveLength(1)
    expect(await tabsOf(page, beta).then((t) => t.length)).toBe(2)
  })

  test('Move (doc) makes the tab LEAVE the source strip', async () => {
    const rel = 'Projects/alpha/notes.txt'
    const docTab = await openDoc(page, rel, alpha)

    await moveTabTo(page, docTab, beta)

    // Gone from alpha, present in beta with the same path.
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([])
    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs.map((t) => t.path)).toEqual([rel])
    expect(betaTabs[0].projectId).toBe(beta)
  })

  test('after a move the landed tab is attention-marked and the target counter increments; the badge persists until the tab is read', async () => {
    // Beta has its own tab first, so the arrival does NOT become active (a dot can show).
    await page.getByTestId(`project-${beta}`).click()
    const betaTerm = await newTerminalTab(page, beta)
    await page.getByTestId(`project-${alpha}`).click()
    await clearAttention(page)

    const moving = await newTerminalTab(page, alpha)
    await moveTabTo(page, moving, beta)

    // The landed tab carries the red dot; beta's active tab is unchanged (betaTerm); the derived
    // Projects panel counter shows 1, even though beta is not the active project.
    expect((await tabsOf(page, beta)).find((t) => t.id === moving)?.attention).toBe(true)
    expect(await activeId(page, beta)).toBe(betaTerm)
    expect(await attn(page, beta)).toBe(1)
    expect(await activeProjectIdOf(page)).toBe(alpha)

    // T-151 — opening the target project does NOT clear the counter: the tab is still unread, so
    // the badge stays at 1 (and the tab keeps its dot).
    await page.getByTestId(`project-${beta}`).click()
    expect(await attn(page, beta)).toBe(1)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')
    await expect(page.getByTestId(`tab-attention-${moving}`)).toBeVisible()

    // Reading the landed tab (activation edge) clears its dot AND drops the counter to 0.
    await page.getByTestId(`tab-${moving}`).click()
    await expect(page.getByTestId(`tab-attention-${moving}`)).toHaveCount(0)
    expect((await tabsOf(page, beta)).find((t) => t.id === moving)?.attention).toBeFalsy()
    expect(await attn(page, beta)).toBe(0)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveCount(0)
  })

  test('a copied doc also lands attention-marked and raises the derived counter', async () => {
    await page.getByTestId(`project-${beta}`).click()
    await newTerminalTab(page, beta)
    await page.getByTestId(`project-${alpha}`).click()
    await clearAttention(page)

    const docTab = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await copyTabTo(page, docTab, beta)

    const copy = (await tabsOf(page, beta)).find((t) => t.path === 'Projects/alpha/README.md')!
    expect(copy.attention).toBe(true)
    expect(await attn(page, beta)).toBe(1)
    await expect(page.getByTestId(`project-attention-${beta}`)).toHaveText('1')
  })

  test('moving-out the ACTIVE tab focuses the RIGHT neighbor, not the last tab', async () => {
    const t1 = await newTerminalTab(page, alpha)
    const t2 = await newTerminalTab(page, alpha)
    const t3 = await newTerminalTab(page, alpha)
    // Order is [t1, t2, t3] (each opens right of the active, previous one). Activate t1.
    await page.getByTestId(`tab-${t1}`).click()
    expect(await activeId(page, alpha)).toBe(t1)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([t1, t2, t3])

    await moveTabTo(page, t1, beta)

    // Right neighbour t2 gets focus — NOT the last tab t3 (the T-097 leftover bug).
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([t2, t3])
    expect(await activeId(page, alpha)).toBe(t2)
  })

  test('Reveal in Finder is on doc and terminal tabs and fires the reveal IPC', async () => {
    const before = (await revealed(app)).length

    // Doc → reveals the FILE.
    const docTab = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await page.getByTestId(`tab-${docTab}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-reveal').click()
    await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
    await expect
      .poll(() => revealed(app).then((r) => r.length))
      .toBeGreaterThan(before)
    expect((await revealed(app)).at(-1)).toMatch(/Projects\/alpha\/README\.md$/)

    // Terminal → reveals its CWD (the project root).
    const termTab = await newTerminalTab(page, alpha)
    const mid = (await revealed(app)).length
    await page.getByTestId(`tab-${termTab}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-reveal').click()
    await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
    await expect
      .poll(() => revealed(app).then((r) => r.length))
      .toBeGreaterThan(mid)
    expect((await revealed(app)).at(-1)).toMatch(/Projects\/alpha$/)
  })
})

function activeProjectIdOf(page: Page): Promise<string> {
  return page.evaluate(
    () => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId
  )
}
