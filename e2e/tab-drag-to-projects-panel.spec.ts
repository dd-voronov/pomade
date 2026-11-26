// modules: core, projects, tabs, terminal
// Pomade T-104 e2e — drag a tab off the strip and drop it on a Projects panel project row = MOVE it to
// that project (learnt Finder-style gesture). Behaviours this file owns:
//   • a doc tab dragged onto another project row MOVES there (gone from source, present +
//     attention-marked in target, target counter bumped), and the source strip focuses the moved
//     tab's RIGHT neighbour (reuses T-103's move path);
//   • a LIVE terminal tab dragged onto another project row moves with the SAME PTY session intact
//     (pane never remounted, xterm never disposed, exported shell var survives);
//   • dropping on the tab's OWN (current) project row is a no-op;
//   • the drop-target highlight shows ONLY on a valid hovered project row during a TAB drag —
//     never on the current project, and never during the Projects panel's own project-reorder drag;
//   • the Workspace project row is a valid drop target too.
//
// Native HTML5 DnD is not driven by Playwright mouse gestures, so — like tabs.spec.ts (T-048/087)
// — we share ONE real DataTransfer across dragstart(on the tab) → dragover/drop(on the row) →
// dragend. The tab's dragstart handler writes the tab id AND the `application/x-pomade-tab` marker
// onto that DataTransfer, which is exactly what the Projects panel reads to recognise + route the drop.
//
// State chains WITHIN this file (one app, one window) — tests append, never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type JSHandle,
  type Page
} from '@playwright/test'

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
  attention?: boolean
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
      attention: t.attention,
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

function activeProjectIdOf(page: Page): Promise<string> {
  return page.evaluate(
    () => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId
  )
}

/** T-151 Projects panel attention counter — the LIVE DERIVED count of unread (dotted) tabs. */
async function attn(page: Page, pid: string): Promise<number> {
  return (await tabsOf(page, pid)).filter((t) => t.attention).length
}

/** Clear every unread dot in every project (test baseline) — no counter store under T-151. */
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


function renderedText(page: Page, termId: string): Promise<string> {
  return page
    .locator(`[data-term-id="${termId}"] .xterm-rows > div`)
    .allTextContents()
    .then((rows) => rows.join('\n'))
}

/** The FULL Finder-style gesture: drag `tabId` off the strip and DROP it on `projectId`'s row. */
async function dragTabOntoProject(page: Page, tabId: string, projectId: string): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const src = page.getByTestId(`tab-${tabId}`)
  const target = page.getByTestId(`project-${projectId}`)
  await src.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  await target.dispatchEvent('drop', { dataTransfer: dt })
  // No trailing `dragend` on the source: a successful move UNMOUNTS the source tab from the strip,
  // so dispatching on `tab-${tabId}` would hang. The drop handler already cleared the highlight;
  // the highlight test below exercises dragend explicitly on a tab that stays put.
}

/** Begin a tab drag and return the shared DataTransfer so a test can inspect hover states. */
async function beginTabDrag(page: Page, tabId: string): Promise<JSHandle<DataTransfer>> {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  await page.getByTestId(`tab-${tabId}`).dispatchEvent('dragstart', { dataTransfer: dt })
  return dt
}

test.describe('T-104 drag tab onto Projects panel project row = Move', () => {
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

  test('drag a doc tab onto another project row moves it there: attention-marked, counter bumped, source focus to the right neighbour', async () => {
    // Beta keeps a tab of its own so the arrival lands in the BACKGROUND (a dot can show) and Beta
    // is not the active project (so its Projects panel counter can bump).
    await page.getByTestId(`project-${beta}`).click()
    const betaTerm = await newTerminalTab(page, beta)
    await page.getByTestId(`project-${alpha}`).click()
    await clearAttention(page)

    // Two docs in Alpha [d1, d2]; activate the FIRST so its right neighbour is d2.
    const d1 = await openDoc(page, 'Projects/alpha/README.md', alpha)
    const d2 = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    await page.getByTestId(`tab-${d1}`).click()
    expect(await activeId(page, alpha)).toBe(d1)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([d1, d2])

    await dragTabOntoProject(page, d1, beta)

    // Gone from Alpha; focus moved to the RIGHT neighbour d2 (T-103 rule), not the last tab.
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([d2])
    expect(await activeId(page, alpha)).toBe(d2)

    // Present in Beta at the END, attention-marked, counter bumped; no project switch.
    await expect
      .poll(() => tabsOf(page, beta).then((t) => t.map((x) => x.id)))
      .toEqual([betaTerm, d1])
    const landed = (await tabsOf(page, beta)).find((t) => t.id === d1)!
    expect(landed.projectId).toBe(beta)
    expect(landed.path).toBe('Projects/alpha/README.md')
    expect(landed.attention).toBe(true)
    expect(await activeId(page, beta)).toBe(betaTerm)
    expect(await attn(page, beta)).toBe(1)
    expect(await activeProjectIdOf(page)).toBe(alpha)
  })

  test('drag a LIVE terminal tab onto another project row moves it with the same PTY session intact', async () => {
    await page.getByTestId(`project-${beta}`).click()
    const betaTerm = await newTerminalTab(page, beta)
    await page.getByTestId(`project-${alpha}`).click()

    const moving = await newTerminalTab(page, alpha)
    const termId = (await termIdOf(page, alpha, moving)) as string
    expect(termId).toBeTruthy()
    await waitForPrompt(page, termId)

    // Put state into the shell process and a marker into its scrollback.
    await writePty(page, termId, 'T104=pomade-drag\r')
    await writePty(page, termId, 'echo pre:$T104\r')
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('pre:pomade-drag')

    const paneBody = page.locator(`[data-testid="pane-${moving}"] [data-mount-id]`)
    await expect(paneBody).toHaveAttribute('data-mount-id', /.+/)
    const mountIdBefore = await paneBody.getAttribute('data-mount-id')
    const xtermScreen = await page.locator(`[data-term-id="${termId}"] .xterm-screen`).elementHandle()
    expect(xtermScreen).toBeTruthy()

    await dragTabOntoProject(page, moving, beta)

    // Gone from Alpha, LAST in Beta, same tab id + termId, PTY alive, pane never remounted.
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([])
    await expect
      .poll(() => tabsOf(page, beta).then((t) => t.map((x) => x.id)))
      .toEqual([betaTerm, moving])
    expect(await termIdOf(page, beta, moving)).toBe(termId)
    expect(await ptyAlive(page, termId)).toBe(true)
    await expect(paneBody).toHaveAttribute('data-mount-id', mountIdBefore ?? '')
    expect(await xtermScreen?.evaluate((el) => el.isConnected)).toBe(true)

    // Go to Beta, open the landed tab: the SAME shell process answers (exported var survived).
    await page.getByTestId(`project-${beta}`).click()
    await page.getByTestId(`tab-${moving}`).click()
    await writePty(page, termId, 'echo post:$T104\r')
    await expect
      .poll(() => renderedText(page, termId), { timeout: 15_000 })
      .toContain('post:pomade-drag')
  })

  test('dropping on the tab OWN (current) project row is a no-op', async () => {
    const d1 = await openDoc(page, 'Projects/alpha/README.md', alpha)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([d1])

    // Drop the tab back onto Alpha's own row (Alpha is the active project).
    await dragTabOntoProject(page, d1, alpha)

    // Nothing moved: still in Alpha, no attention, no counter change.
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([d1])
    expect((await tabsOf(page, alpha)).find((t) => t.id === d1)?.attention).toBeFalsy()
    expect(await attn(page, alpha)).toBe(0)
    expect(await tabsOf(page, beta).then((t) => t.length)).toBe(0)
  })

  test('the drop-target highlight shows only on a valid hovered row during a tab drag; never the current project; cleared on dragend', async () => {
    const d1 = await openDoc(page, 'Projects/alpha/README.md', alpha)

    const dt = await beginTabDrag(page, d1)
    const alphaRow = page.getByTestId(`project-${alpha}`)
    const betaRow = page.getByTestId(`project-${beta}`)
    const wsRow = page.getByTestId(`project-${WORKSPACE_ID}`)

    // Hovering a valid OTHER project highlights it.
    await betaRow.dispatchEvent('dragover', { dataTransfer: dt })
    await expect(betaRow).toHaveAttribute('data-tab-drop-target', 'true')

    // Hovering the CURRENT project's own row highlights nothing (and clears the previous one).
    await alphaRow.dispatchEvent('dragover', { dataTransfer: dt })
    await expect(alphaRow).not.toHaveAttribute('data-tab-drop-target', 'true')
    await expect(betaRow).not.toHaveAttribute('data-tab-drop-target', 'true')

    // The Workspace project row is a valid target too.
    await wsRow.dispatchEvent('dragover', { dataTransfer: dt })
    await expect(wsRow).toHaveAttribute('data-tab-drop-target', 'true')

    // Ending the drag clears the highlight.
    await page.getByTestId(`tab-${d1}`).dispatchEvent('dragend', { dataTransfer: dt })
    await expect(wsRow).not.toHaveAttribute('data-tab-drop-target', 'true')
  })

  test("the Projects panel's own project-reorder drag never shows the tab-drop highlight (and still reorders)", async () => {
    // A Projects panel project drag sets only text/plain (no tab marker), so isTabDrag is false: hovering
    // one project row over another must NOT light the tab-drop target. And the reorder itself must
    // still work — the tab-drop wiring must coexist with it, not break it.
    const order = (): Promise<string[]> =>
      page.evaluate(() =>
        [...window.__pomadeStores.useWorkspaceStore.getState().projects]
          .sort((a, b) => a.order - b.order)
          .map((p) => p.id)
      )
    expect(await order()).toEqual([alpha, beta])

    const dt = await page.evaluateHandle(() => new DataTransfer())
    const alphaRow = page.getByTestId(`project-${alpha}`)
    const betaRow = page.getByTestId(`project-${beta}`)
    const box = (await betaRow.boundingBox())!
    // Drop on the LOWER half of Beta so Alpha lands AFTER it → order flips to [beta, alpha].
    const clientX = Math.round(box.x + box.width / 2)
    const clientY = Math.round(box.y + box.height * 0.75)
    await alphaRow.dispatchEvent('dragstart', { dataTransfer: dt })
    await betaRow.dispatchEvent('dragover', { dataTransfer: dt, clientX, clientY })
    // The core T-104 guarantee: a reorder drag never lights the tab-drop target.
    await expect(betaRow).not.toHaveAttribute('data-tab-drop-target', 'true')
    await betaRow.dispatchEvent('drop', { dataTransfer: dt, clientX, clientY })
    await alphaRow.dispatchEvent('dragend', { dataTransfer: dt })

    // Reorder still works.
    await expect.poll(order).toEqual([beta, alpha])

    // Restore the original order so later tests / other files see [alpha, beta].
    const dt2 = await page.evaluateHandle(() => new DataTransfer())
    const box2 = (await page.getByTestId(`project-${alpha}`).boundingBox())!
    await page.getByTestId(`project-${beta}`).dispatchEvent('dragstart', { dataTransfer: dt2 })
    await page.getByTestId(`project-${alpha}`).dispatchEvent('dragover', {
      dataTransfer: dt2,
      clientX: Math.round(box2.x + box2.width / 2),
      clientY: Math.round(box2.y + box2.height * 0.75)
    })
    await page.getByTestId(`project-${alpha}`).dispatchEvent('drop', {
      dataTransfer: dt2,
      clientX: Math.round(box2.x + box2.width / 2),
      clientY: Math.round(box2.y + box2.height * 0.75)
    })
    await page.getByTestId(`project-${beta}`).dispatchEvent('dragend', { dataTransfer: dt2 })
    await expect.poll(order).toEqual([alpha, beta])
  })

  test('drag a doc tab onto the Workspace project row moves it there', async () => {
    const d1 = await openDoc(page, 'Projects/alpha/README.md', alpha)

    await dragTabOntoProject(page, d1, WORKSPACE_ID)

    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([])
    const wsTabs = await tabsOf(page, WORKSPACE_ID)
    expect(wsTabs.map((t) => t.id)).toEqual([d1])
    expect(wsTabs[0].projectId).toBe(WORKSPACE_ID)
    expect(await activeProjectIdOf(page)).toBe(alpha)
  })
})
