// modules: core, projects, tabs, editor, terminal
// Pomade T-117 e2e — "Move to another project" DEDUPES doc tabs by path, like Copy always has.
// Repro (the Owner, screenshot-proven): copy XX.md A→B (counter 1), then MOVE the same doc to B →
// B ended up with TWO tabs of one file and counter 2. The four dedupe outcomes this file pins:
//   • CLEAN moved tab onto an existing copy → the copy is RE-USED (its id survives), the source
//     tab leaves, and the counter bumps only when that copy was unmarked (T-110's rule);
//   • DIRTY moved tab onto a CLEAN copy → the moved tab REPLACES the copy in its slot, carrying
//     its unsaved buffer (no silent data loss);
//   • BOTH dirty → both tabs are kept (buffers can't be merged — documented limit);
//   • a different doc, and terminals, move exactly as before (no dedupe possible).
//
// Each test rebuilds its own state (both projects reset, beta given a resident ACTIVE tab so
// arrivals land as BACKGROUND marked tabs, counters zeroed) — tests append, never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'

interface TabSnap {
  id: string
  kind: string
  path?: string
  dirty?: boolean
  attention?: boolean
}

function tabsOf(page: Page, pid: string): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      path: t.path,
      dirty: t.dirty,
      attention: t.attention
    }))
  }, pid)
}

/** The project's T-151 Projects panel attention counter — the LIVE DERIVED count of unread (dotted)
 *  tabs, exactly what the Projects panel renders. Read straight off the tab set. */
async function attn(page: Page, pid: string): Promise<number> {
  return (await tabsOf(page, pid)).filter((t) => t.attention).length
}

/** Clear every unread dot in every project (test baseline) — no counter store to reset under
 *  T-151; the count IS the dotted-tab set, so we clear the dots directly. */
async function clearAttention(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = window.__pomadeStores.useTabsStore.getState()
    for (const [pid, tabs] of Object.entries(s.tabsByProject)) {
      for (const t of tabs) if (t.attention) s.updateTab(pid, t.id, { attention: undefined })
    }
  })
}

function setActive(page: Page, pid: string, tabId: string): Promise<void> {
  return page.evaluate(
    ({ p, t }) => window.__pomadeStores.useTabsStore.getState().setActive(p, t),
    { p: pid, t: tabId }
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

async function openDoc(page: Page, rel: string, pid: string): Promise<string> {
  const before = new Set((await tabsOf(page, pid)).map((t) => t.id))
  await page.getByTestId(`tree-node-${rel}`).click()
  await expect.poll(() => tabsOf(page, pid).then((t) => t.length)).toBeGreaterThan(before.size)
  const added = (await tabsOf(page, pid)).find((t) => !before.has(t.id))
  if (!added) throw new Error('doc did not open')
  // Commit the preview slot so this doc keeps its own persistent tab (see tabs.spec openDoc).
  await page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().commitPreview(p),
    pid
  )
  return added.id
}

async function newTerminalTab(page: Page, pid: string): Promise<string> {
  const before = new Set((await tabsOf(page, pid)).map((t) => t.id))
  const menu = page.getByTestId('tab-add-menu')
  const item = page.getByTestId('tab-add-terminal')
  await expect(async () => {
    if (!(await menu.isVisible().catch(() => false))) await page.getByTestId('tab-add').click()
    await expect(item).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await item.click()
  await expect.poll(() => tabsOf(page, pid).then((t) => t.length)).toBeGreaterThan(before.size)
  const added = (await tabsOf(page, pid)).find((t) => !before.has(t.id))
  if (!added) throw new Error('no new tab')
  return added.id
}

/** Right-click a tab and MOVE it to `toProjectId` (the same store path the Projects panel drop uses). */
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

/** Type into the VISIBLE raw editor and wait for its dirty dot. */
async function dirtyVisibleDoc(page: Page, text: string): Promise<void> {
  const cm = page.locator('[data-testid="raw-editor"]:visible .cm-content')
  await cm.click()
  await page.keyboard.type(text)
  await expect(page.locator('[data-testid="editor-dirty"]:visible')).toBeVisible()
}

test.describe('T-117 — move dedupes doc tabs by path', () => {
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
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  /**
   * Clean slate: both strips empty, beta holding ONE resident (active) doc tab of its own so every
   * arrival lands as a BACKGROUND attention-marked tab (the repro condition — an arrival into an
   * empty target becomes its active tab and carries no dot), alpha active, all unread dots cleared.
   * Returns beta's resident tab id.
   */
  async function freshBeta(): Promise<string> {
    await resetTabs(page, [alpha, beta])
    await page.getByTestId(`project-${beta}`).click()
    const resident = await openDoc(page, 'Projects/beta/data.csv', beta)
    await page.getByTestId(`project-${alpha}`).click()
    await clearAttention(page)
    return resident
  }

  test('copy then MOVE the same doc → ONE tab in the target (the copy is re-used), counter 1', async () => {
    const resident = await freshBeta()
    const rel = 'Projects/alpha/README.md'
    const docTab = await openDoc(page, rel, alpha)

    // Copy first: a fresh arrival — one marked tab in beta, counter 1.
    await copyTabTo(page, docTab, beta)
    await expect.poll(() => attn(page, beta)).toBe(1)
    const copyId = (await tabsOf(page, beta)).find((t) => t.path === rel)?.id
    expect(copyId).toBeTruthy()

    // Now MOVE the same doc there. Pre-T-117 this appended a SECOND tab and bumped again.
    await moveTabTo(page, docTab, beta)

    // The source tab left alpha…
    await expect.poll(() => tabsOf(page, alpha).then((ts) => ts.some((t) => t.id === docTab))).toBe(
      false
    )
    // …and beta still shows exactly ONE tab for that path — the SAME (re-used) copy.
    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs.filter((t) => t.path === rel)).toHaveLength(1)
    expect(betaTabs.map((t) => t.id)).toEqual([resident, copyId])
    // Already marked ⇒ no new arrival signal ⇒ no re-bump (held for the window a buggy bump
    // would need to land).
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(1)
      expect((await tabsOf(page, beta)).filter((t) => t.attention)).toHaveLength(1)
    }, 300)

    // T-151 — opening the target project does NOT clear the counter (the copy is still unread);
    // the badge stays at 1 until the tab is read. Reading the re-used copy then drops it to 0.
    await page.getByTestId(`project-${beta}`).click()
    expect(await attn(page, beta)).toBe(1)
    await page.getByTestId(`tab-${copyId}`).click()
    await expect.poll(() => attn(page, beta)).toBe(0)
  })

  test('move onto an UNMARKED existing copy → it gets marked and the counter bumps ONCE', async () => {
    const resident = await freshBeta()
    const rel = 'Projects/alpha/README.md'
    const docTab = await openDoc(page, rel, alpha)
    await copyTabTo(page, docTab, beta)
    const copyId = present((await tabsOf(page, beta)).find((t) => t.path === rel), 'the copy in beta').id

    // Read the copy (activation edge clears its dot), then leave it in the background, and zero
    // the counter — so the move below is measured against an UNMARKED, non-active tab.
    await setActive(page, beta, copyId)
    await setActive(page, beta, resident)
    await clearAttention(page)
    expect((await tabsOf(page, beta)).find((t) => t.id === copyId)?.attention).toBeFalsy()

    await moveTabTo(page, docTab, beta)

    await expect.poll(() => attn(page, beta)).toBe(1) // exactly one bump
    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs.filter((t) => t.path === rel)).toHaveLength(1)
    expect(betaTabs.find((t) => t.id === copyId)?.attention).toBe(true)
    expect(betaTabs.map((t) => t.id)).toEqual([resident, copyId])
    expect((await tabsOf(page, alpha)).some((t) => t.id === docTab)).toBe(false)
    // No second bump afterwards — held.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(1)
    }, 300)
  })

  test('DIRTY source onto a CLEAN copy → one tab, and it is the MOVED tab with its buffer intact', async () => {
    const resident = await freshBeta()
    const rel = 'Projects/alpha/notes.txt'
    const docTab = await openDoc(page, rel, alpha)
    await copyTabTo(page, docTab, beta)
    const copyId = present((await tabsOf(page, beta)).find((t) => t.path === rel), 'the copy in beta').id

    // Unsaved work in the SOURCE tab (the copy in beta is a clean view of the file on disk).
    await dirtyVisibleDoc(page, 'MOVED DIRTY EDIT ')

    await moveTabTo(page, docTab, beta)

    // One tab for that path, and it is the MOVED tab (it took the clean copy's slot).
    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs.filter((t) => t.path === rel)).toHaveLength(1)
    expect(betaTabs.map((t) => t.id)).toEqual([resident, docTab])
    expect(betaTabs.find((t) => t.id === docTab)?.dirty).toBe(true)
    expect(betaTabs.some((t) => t.id === copyId)).toBe(false)
    expect((await tabsOf(page, alpha)).some((t) => t.id === docTab)).toBe(false)
    // The replaced tab was already marked, so the replacement adds no NEW unread signal — held.
    await expectQuiet(async () => {
      expect(await attn(page, beta)).toBe(1)
    }, 300)

    // The unsaved buffer really rode along: open it in beta and read the editor.
    await page.getByTestId(`project-${beta}`).click()
    await setActive(page, beta, docTab)
    await expect(page.locator('[data-testid="raw-editor"]:visible .cm-content')).toContainText(
      'MOVED DIRTY EDIT'
    )
  })

  test('BOTH dirty → both tabs are kept (buffers cannot be merged — documented limit)', async () => {
    const resident = await freshBeta()
    const rel = 'Projects/alpha/notes.txt'
    const docTab = await openDoc(page, rel, alpha)
    await copyTabTo(page, docTab, beta)
    const copyId = present((await tabsOf(page, beta)).find((t) => t.path === rel), 'the copy in beta').id

    // Dirty the copy in beta, then park beta's focus back on its resident tab.
    await page.getByTestId(`project-${beta}`).click()
    await setActive(page, beta, copyId)
    await dirtyVisibleDoc(page, 'BETA EDIT ')
    await setActive(page, beta, resident)
    // Dirty the source in alpha too.
    await page.getByTestId(`project-${alpha}`).click()
    await setActive(page, alpha, docTab)
    await dirtyVisibleDoc(page, 'ALPHA EDIT ')

    await moveTabTo(page, docTab, beta)

    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs.filter((t) => t.path === rel)).toHaveLength(2)
    expect(betaTabs.map((t) => t.id)).toEqual([resident, copyId, docTab])
    expect(betaTabs.filter((t) => t.path === rel).every((t) => t.dirty)).toBe(true)
  })

  test('a DIFFERENT doc still moves in as a NEW tab at the end, marked, and bumps', async () => {
    await freshBeta()
    const readme = 'Projects/alpha/README.md'
    const notes = 'Projects/alpha/notes.txt'
    const readmeTab = await openDoc(page, readme, alpha)
    await copyTabTo(page, readmeTab, beta)
    await expect.poll(() => attn(page, beta)).toBe(1)
    const notesTab = await openDoc(page, notes, alpha)

    await moveTabTo(page, notesTab, beta)

    await expect.poll(() => attn(page, beta)).toBe(2) // a genuinely-new arrival bumps
    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs).toHaveLength(3)
    expect(betaTabs[betaTabs.length - 1]?.id).toBe(notesTab) // landed at the END, id preserved
    expect(betaTabs.find((t) => t.id === notesTab)?.attention).toBe(true)
    expect((await tabsOf(page, alpha)).some((t) => t.id === notesTab)).toBe(false)
  })

  test('terminals are unaffected: two moved terminals stay two tabs and bump twice', async () => {
    await freshBeta()
    const t0 = await newTerminalTab(page, alpha)
    await moveTabTo(page, t0, beta)
    await expect.poll(() => attn(page, beta)).toBe(1)
    const t1 = await newTerminalTab(page, alpha)
    await moveTabTo(page, t1, beta)
    await expect.poll(() => attn(page, beta)).toBe(2)

    const betaTabs = await tabsOf(page, beta)
    expect(betaTabs.filter((t) => t.kind === 'terminal').map((t) => t.id)).toEqual([t0, t1])
    expect((await tabsOf(page, alpha)).filter((t) => t.kind === 'terminal')).toHaveLength(0)
  })
})
