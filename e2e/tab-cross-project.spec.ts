// modules: tabs, terminal, projects
// Pomade T-097 e2e — cross-project tab actions in the tab context menu:
// "Move to another project" (terminals/agents — the SAME tab and the SAME PTY change project)
// and "Open in another project" (docs — a COPY in the target, the original stays).
//
// The load-bearing assertions here are about identity, not about a tab existing:
//   • the moved terminal is the SAME SHELL PROCESS — a variable exported before the move is
//     still readable after it (a relaunched PTY would print nothing);
//   • the pane was never remounted — same `data-mount-id`, and the pre-move scrollback is
//     still in the very same xterm;
//   • the doc copy is a SECOND tab for the same path, deduped on a repeat action.

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
import { waitForPrompt, writePty } from './fixtures/stores'

const WORKSPACE_ID = '__workspace__'

interface TabSnap {
  id: string
  kind: string
  title: string
  path?: string
  projectId: string
  termId?: string
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
      termId: t.termId
    }))
  }, pid)
}

function activeId(page: Page, pid: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[p],
    pid
  )
}

function activeProjectId(page: Page): Promise<string> {
  return page.evaluate(
    () => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId
  )
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

/** Open a plain terminal in the ACTIVE project via the "+" menu; returns the new tab id. */
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
  // Commit the preview slot so this tab is a persistent one (see tabs.spec.ts).
  await page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().commitPreview(p),
    pid
  )
  return added.id
}

function termIdOf(page: Page, pid: string, tabId: string): Promise<string | undefined> {
  return tabsOf(page, pid).then((t) => t.find((x) => x.id === tabId)?.termId)
}

function ptyAlive(page: Page, termId: string): Promise<boolean> {
  return page.evaluate(
    (tid) => window.pomade.pty.list().then((l) => !!l.find((t) => t.termId === tid)?.alive),
    termId
  )
}

function readBuffer(page: Page, termId: string): Promise<string> {
  return page.evaluate(
    (tid) => window.pomade.pty.buffer(tid).then((b: string) => b ?? ''),
    termId
  )
}


/** What the USER sees in the live xterm (its rendered rows), not the pty ring buffer. */
function renderedText(page: Page, termId: string): Promise<string> {
  return page
    .locator(`[data-term-id="${termId}"] .xterm-rows > div`)
    .allTextContents()
    .then((rows) => rows.join('\n'))
}

/** Right-click `tabId` and MOVE it to `toProjectId` (T-103: the tab leaves the source). */
async function sendTabTo(page: Page, tabId: string, toProjectId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click({ button: 'right' })
  await page.getByTestId('menu-tab-move').click()
  await expect(page.getByTestId('menu-tab-move-submenu')).toBeVisible()
  await page.getByTestId(`menu-tab-move-project-${toProjectId}`).click()
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
}

/** T-103 — right-click a DOC `tabId` and COPY it to `toProjectId` (the original stays). */
async function copyTabTo(page: Page, tabId: string, toProjectId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click({ button: 'right' })
  await page.getByTestId('menu-tab-copy-to').click()
  await expect(page.getByTestId('menu-tab-copy-to-submenu')).toBeVisible()
  await page.getByTestId(`menu-tab-copy-to-project-${toProjectId}`).click()
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
}

test.describe('T-097 cross-project tab actions', () => {
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
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the picker submenu is a FLAT list of every project incl. the Workspace project, current excluded', async () => {
    const termTab = await newTerminalTab(page, alpha)

    await page.getByTestId(`tab-${termTab}`).click({ button: 'right' })
    // Terminal/agent wording (the Owner's): the action MOVES the tab.
    await expect(page.getByTestId('menu-tab-move')).toHaveText(/Move to another project/)
    await page.getByTestId('menu-tab-move').click()

    const submenu = page.getByTestId('menu-tab-move-submenu')
    await expect(submenu).toBeVisible()
    // Workspace project first, then Projects panel order; the CURRENT project is absent.
    await expect(submenu.locator('[role="menuitem"]')).toHaveText(['Workspace', 'Beta'])
    await expect(page.getByTestId(`menu-tab-move-project-${WORKSPACE_ID}`)).toBeVisible()
    await expect(page.getByTestId(`menu-tab-move-project-${alpha}`)).toHaveCount(0)
    await page.keyboard.press('Escape')

    // A DOC tab (T-103) offers BOTH wordings: Copy AND Move, each with the same picker.
    const docTab = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await page.getByTestId(`tab-${docTab}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-copy-to')).toHaveText(/Copy to another project/)
    await expect(page.getByTestId('menu-tab-move')).toHaveText(/Move to another project/)
    await page.keyboard.press('Escape')
  })

  test('a LIVE terminal moves to another project: END of its strip, same shell session, pane never remounted', async () => {
    // Beta gets a terminal of its own first, so "END of the target strip" is observable.
    await page.getByTestId(`project-${beta}`).click()
    const betaTerm = await newTerminalTab(page, beta)
    await page.getByTestId(`project-${alpha}`).click()

    const moving = await newTerminalTab(page, alpha)
    const termId = (await termIdOf(page, alpha, moving)) as string
    expect(termId).toBeTruthy()
    await waitForPrompt(page, termId)

    // Put state INTO the shell process (a var) and a marker into its scrollback.
    await writePty(page, termId, 'T097=pomade-move\r')
    await writePty(page, termId, 'echo pre:$T097\r')
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 15_000 })
      .toContain('pre:pomade-move')
    await expect
      .poll(() => renderedText(page, termId), { timeout: 15_000 })
      .toContain('pre:pomade-move')

    const paneBody = page.locator(`[data-testid="pane-${moving}"] [data-mount-id]`)
    await expect(paneBody).toHaveAttribute('data-mount-id', /.+/)
    const mountIdBefore = await paneBody.getAttribute('data-mount-id')
    // A handle on the LIVE xterm's own screen element. `xterm.dispose()` detaches it, so
    // `isConnected` after the move is a precise "the same Terminal instance is still attached"
    // check — it catches a pane remount AND an xterm rebuild inside a surviving pane.
    const xtermScreen = await page
      .locator(`[data-term-id="${termId}"] .xterm-screen`)
      .elementHandle()
    expect(xtermScreen).toBeTruthy()

    await sendTabTo(page, moving, beta)

    // Gone from Alpha, LAST in Beta, same tab id + same termId, PTY untouched.
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([])
    await expect
      .poll(() => tabsOf(page, beta).then((t) => t.map((x) => x.id)))
      .toEqual([betaTerm, moving])
    expect((await tabsOf(page, beta)).find((t) => t.id === moving)?.projectId).toBe(beta)
    expect(await termIdOf(page, beta, moving)).toBe(termId)
    expect(await ptyAlive(page, termId)).toBe(true)
    // No project switch — the tab is simply there when the user goes to Beta.
    expect(await activeProjectId(page)).toBe(alpha)
    // The pane was never unmounted: same instance, still in the DOM — and the xterm inside it
    // is the very same Terminal (never disposed and rebuilt from the pty ring buffer).
    await expect(paneBody).toHaveAttribute('data-mount-id', mountIdBefore ?? '')
    expect(await xtermScreen?.evaluate((el) => el.isConnected)).toBe(true)

    // Go to Beta: T-103 — the moved tab lands ATTENTION-MARKED and does NOT steal focus
    // (betaTerm stays active). The moved tab is present with a red dot; opening it clears the dot
    // and shows it. Its xterm still holds the pre-move scrollback, and the SAME shell process
    // answers (the exported var survived — a relaunched PTY would print an empty `post:`).
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-${moving}`)).toBeVisible()
    expect(await activeId(page, beta)).toBe(betaTerm)
    await expect(page.getByTestId(`tab-attention-${moving}`)).toBeVisible()
    // Open the landed tab → its dot clears (activation edge) and its pane shows.
    await page.getByTestId(`tab-${moving}`).click()
    await expect(page.getByTestId(`tab-attention-${moving}`)).toHaveCount(0)
    expect(await activeId(page, beta)).toBe(moving)
    await expect(page.locator(`[data-testid="pane-${moving}"]`)).toHaveAttribute(
      'data-visible',
      'true'
    )
    await expect(paneBody).toHaveAttribute('data-mount-id', mountIdBefore ?? '')
    await expect.poll(() => renderedText(page, termId)).toContain('pre:pomade-move')

    await writePty(page, termId, 'echo post:$T097\r')
    await expect
      .poll(() => renderedText(page, termId), { timeout: 15_000 })
      .toContain('post:pomade-move')
  })

  test('moving the ACTIVE tab activates its neighbor in the source project', async () => {
    const t1 = await newTerminalTab(page, alpha)
    const t2 = await newTerminalTab(page, alpha)
    await page.getByTestId(`tab-${t1}`).click()
    expect(await activeId(page, alpha)).toBe(t1)

    await sendTabTo(page, t1, beta)

    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([t2])
    expect(await activeId(page, alpha)).toBe(t2)
    // Still Alpha on screen, with t2 now the visible pane.
    expect(await activeProjectId(page)).toBe(alpha)
    await expect(page.locator(`[data-testid="pane-${t2}"]`)).toHaveAttribute('data-visible', 'true')
  })

  test('a doc opens in another project as a COPY: original untouched, outside-dot shows, repeat re-uses', async () => {
    const rel = 'Projects/alpha/README.md'
    const docTab = await openDoc(page, rel, alpha)

    await copyTabTo(page, docTab, beta)

    // The copy is a DIFFERENT tab for the SAME path; the original is untouched.
    await expect.poll(() => tabsOf(page, beta).then((t) => t.length)).toBe(1)
    const copy = (await tabsOf(page, beta))[0]
    expect(copy.path).toBe(rel)
    expect(copy.id).not.toBe(docTab)
    expect(copy.projectId).toBe(beta)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([docTab])
    expect((await tabsOf(page, alpha))[0].path).toBe(rel)
    expect(await activeProjectId(page)).toBe(alpha)

    // Beta's root does NOT contain the path ⇒ the orange scope triangle shows on the copy (T-101).
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-scope-${copy.id}`)).toBeVisible()
    await expect(page.getByTestId(`tab-scope-${copy.id}`)).toHaveAttribute('data-tone', 'warning')
    // …the original in Alpha IS in-project, but the doc is now open across 2 projects, so it also
    // wears a triangle (the T-101 duplicate-open indicator).
    await page.getByTestId(`project-${alpha}`).click()
    await expect(page.getByTestId(`tab-scope-${docTab}`)).toBeVisible()

    // Repeating the action re-uses the existing tab (dedupe by path). T-103: it does NOT steal
    // focus (`other` stays beta's active tab); instead the re-used copy lands attention-marked.
    await page.getByTestId(`project-${beta}`).click()
    const other = await newTerminalTab(page, beta)
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().setActive(p, t),
      { p: beta, t: other }
    )
    await page.getByTestId(`project-${alpha}`).click()

    await copyTabTo(page, docTab, beta)
    // No duplicate for the path; still exactly two tabs (copy + other); `other` still active.
    expect((await tabsOf(page, beta)).filter((t) => t.path === rel).map((t) => t.id)).toEqual([
      copy.id
    ])
    expect(await tabsOf(page, beta).then((t) => t.length)).toBe(2)
    expect(await activeId(page, beta)).toBe(other)
    // The re-used copy is attention-marked as the arrival signal.
    expect((await tabsOf(page, beta)).find((t) => t.id === copy.id)?.projectId).toBe(beta)
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId(`tab-attention-${copy.id}`)).toBeVisible()
  })
})

// ─── The move survives a restart: the tab restores in the TARGET project ──────
test.describe('T-097 a moved tab persists in the target project', () => {
  let fixture: Fixture

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('a terminal moved Alpha → Beta comes back in Beta after a relaunch, and is gone from Alpha', async () => {
    const { alpha, beta } = fixture.projects

    const app1 = await launchApp(fixture)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await expect(page1.getByTestId('app-shell')).toBeVisible()
    await page1.getByTestId(`project-${alpha}`).click()

    const moving = await newTerminalTab(page1, alpha)
    await page1.getByTestId(`tab-${moving}`).click({ button: 'right' })
    await page1.getByTestId('menu-tab-rename').click()
    const input = page1.getByTestId(`tab-rename-input-${moving}`)
    await input.fill('nomad')
    await input.press('Enter')
    await expect.poll(() => tabsOf(page1, alpha).then((t) => t[0]?.title)).toBe('nomad')

    await sendTabTo(page1, moving, beta)
    await expect.poll(() => tabsOf(page1, beta).then((t) => t.map((x) => x.title))).toEqual([
      'nomad'
    ])

    // The (tuned) debounced per-project state writes (BOTH projects) must land before quitting.
    const stateOf = (pid: string): Promise<string> =>
      fs
        .readFile(join(fixture.workspaceRoot, '.pomade', 'state', `${pid}.json`), 'utf8')
        .catch(() => '')
    await expect.poll(() => stateOf(beta), { timeout: 15_000 }).toContain('nomad')
    await expect.poll(() => stateOf(alpha), { timeout: 15_000 }).not.toContain('nomad')
    await app1.close()

    const app2 = await launchApp(fixture)
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await expect(page2.getByTestId('app-shell')).toBeVisible()

    // Restored into Beta (dead, as every restored terminal is) and NOT into Alpha.
    await expect.poll(() => tabsOf(page2, beta).then((t) => t.map((x) => x.title))).toEqual([
      'nomad'
    ])
    expect((await tabsOf(page2, beta))[0].projectId).toBe(beta)
    await expect.poll(() => tabsOf(page2, alpha).then((t) => t.length)).toBe(0)

    await app2.close()
  })
})
