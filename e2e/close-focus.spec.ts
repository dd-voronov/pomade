// modules: tabs, terminal, editor
// Pomade T-189 / T-107 e2e — close-focus. Closing the ACTIVE tab returns to the PREVIOUSLY-ACTIVE
// tab of that project via the per-project MRU activation stack (T-189); only when that stack holds
// no surviving return target does the T-107 right-neighbour rule (fallback LEFT when it was the
// last tab) fire. Closing an INACTIVE tab never moves focus (T-118). Covered across every close
// path (× click, Cmd+W via the app menu, context-menu Close, and the unguarded "Close saved docs"
// bulk action, which keeps T-107 geometric focus). The second describe walks T-189's acceptance
// matrix (terminal→doc return, chain unwind, right-neighbour fallback).
//
// Drives the real Electron app; tab state is read/driven through the __pomadeStores hook, the
// established pattern from tabs.spec.ts / tab-hotkeys.spec.ts. Cmd+W can't be synthesized as a
// native accelerator, so its real menu item is clicked from the main process (see docs/contracts/test-hooks.md "Menu accelerators").

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { resetTabs } from './fixtures/stores'

/** Click a real application-menu item from the main process (Cmd+W lives on menu-close-tab). */
function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`menu item not found: ${itemId}`)
    item.click()
  }, id)
}

interface TabSnap {
  id: string
  kind: string
  dirty?: boolean
}

function tabsOf(page: Page, pid: string): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({ id: t.id, kind: t.kind, dirty: t.dirty }))
  }, pid)
}

function activeId(page: Page, pid: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[p],
    pid
  )
}

function setActive(page: Page, pid: string, tabId: string): Promise<void> {
  return page.evaluate(
    ({ p, t }) => window.__pomadeStores.useTabsStore.getState().setActive(p, t),
    { p: pid, t: tabId }
  )
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

// Build a run of N terminals left-to-right; each new one lands right of (and focuses) the prior,
// so the returned ids are the visual order [t0, t1, …]. The last one is left active.
async function buildTerminals(page: Page, pid: string, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await newTerminalTab(page, pid))
  return ids
}

test.describe('T-189 / T-107 — close-focus: MRU previous, right-neighbour fallback', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
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

  test('Cmd+W on the active tab returns to the PREVIOUSLY-ACTIVE tab (MRU), not the neighbour', async () => {
    await resetTabs(page, alpha)
    // Four tabs, then two deliberate switches (t3→t0→t1) so t1's MRU predecessor is t0 — a tab
    // that is NEITHER t1's right neighbour (t2) NOR the last tab (t3). Closing t1 must land on t0,
    // the discriminator between the T-189 MRU rule and the T-107 right-neighbour it replaces.
    const [t0, t1, t2, t3] = await buildTerminals(page, alpha, 4)
    await setActive(page, alpha, t0)
    await setActive(page, alpha, t1)
    expect(await activeId(page, alpha)).toBe(t1)

    await clickMenuItem(app, 'menu-close-tab')

    await expect(page.getByTestId(`tab-${t1}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(t0) // MRU previous, NOT the right neighbour (t2)
    // The other three survive, order intact.
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([t0, t2, t3])
  })

  test('closing the last active tab (× click) returns to its MRU predecessor (the left neighbour)', async () => {
    await resetTabs(page, alpha)
    const [t0, t1, t2] = await buildTerminals(page, alpha, 3)
    // Building leaves the newest (t2, the last tab) active; its MRU predecessor is t1 (built just
    // before it), which here is also the only survivor to its left.
    expect(await activeId(page, alpha)).toBe(t2)

    await page.getByTestId(`close-${t2}`).click()

    await expect(page.getByTestId(`tab-${t2}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(t1) // MRU predecessor (also the left neighbour)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([t0, t1])
  })

  test('context-menu Close on the active tab returns to the PREVIOUSLY-ACTIVE tab (MRU)', async () => {
    await resetTabs(page, alpha)
    const [t0, t1, t2, t3] = await buildTerminals(page, alpha, 4)
    await setActive(page, alpha, t0)
    await setActive(page, alpha, t1)

    await page.getByTestId(`tab-${t1}`).click({ button: 'right' })
    await expect(page.getByTestId('tab-context-menu')).toBeVisible()
    await page.getByTestId('menu-tab-close').click()

    await expect(page.getByTestId(`tab-${t1}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(t0) // MRU previous, NOT the right neighbour (t2)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([t0, t2, t3])
  })

  // T-118 — STRENGTHENED. The original version closed the leftmost tab while its RIGHT neighbour
  // was the active one, so the buggy guard pre-focus (it activated the closing tab, after which
  // T-107's right-neighbour rule fired) happened to land on the tab the assertion expected: the
  // test passed on broken code. Now the closed tab is a MIDDLE one and the active tab sits to its
  // LEFT, so the pre-focus path is discriminated (it would move focus to t3).
  test('closing an INACTIVE idle terminal (× click) never moves focus', async () => {
    await resetTabs(page, alpha)
    const [t0, t1, t2, t3] = await buildTerminals(page, alpha, 4)
    await setActive(page, alpha, t0)
    expect(await activeId(page, alpha)).toBe(t0)

    // Close a MIDDLE (inactive) tab — an idle terminal, i.e. a real registered guard that resolves
    // SILENTLY. The active tab must not move (pre-fix: focus jumped to t3, t2's right neighbour).
    await page.getByTestId(`close-${t2}`).click()

    await expect(page.getByTestId(`tab-${t2}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(t0) // unchanged
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([t0, t1, t3])
  })

  test('Close saved docs focuses the right-neighbour survivor when the active clean doc is closed', async () => {
    await resetTabs(page, alpha)
    // Order: [term0, cleanDoc(active), dirtyDoc, term1]. "Close saved docs" removes only the
    // clean doc (the active one); the dirty doc survives to the right of the vacated slot, so
    // focus must land on it — NOT on the last tab (term1), which the old jump-to-last would pick.
    const term0 = await newTerminalTab(page, alpha)
    const cleanDoc = await openDoc(page, 'Projects/alpha/README.md', alpha)
    const dirtyDoc = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    // Make dirtyDoc genuinely dirty (its editor is focused as the just-opened tab).
    const cm = page.locator('[data-testid="raw-editor"]:visible .cm-content')
    await cm.click()
    await page.keyboard.type('DIRTY EDIT ')
    await expect(page.locator('[data-testid="editor-dirty"]:visible')).toBeVisible()
    const term1 = await newTerminalTab(page, alpha)
    // Focus the clean doc, so the tab being closed is the active one.
    await setActive(page, alpha, cleanDoc)
    expect(await activeId(page, alpha)).toBe(cleanDoc)

    await page.evaluate(
      (p) => window.__pomadeStores.useTabsStore.getState().closeSavedDocs(p),
      alpha
    )

    await expect(page.getByTestId(`tab-${cleanDoc}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(dirtyDoc) // right-neighbour survivor, NOT term1
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([term0, dirtyDoc, term1])
  })

  // ── T-118 — a SILENT close must never move focus, whichever pane's guard handles it ──────────
  // The close guards used to focus their tab unconditionally before deciding whether to prompt, so
  // closing an inactive tab that resolves silently (clean doc / idle terminal) first made it the
  // ACTIVE tab and then T-107's right-neighbour rule moved the user's focus off the tab they were
  // working in. The pre-focus now happens only on the PROMPTING branch.

  test('closing an INACTIVE CLEAN doc (× click) never moves focus', async () => {
    await resetTabs(page, alpha)
    // Order: [term0(active), cleanDoc, docRight]. Closing cleanDoc must leave focus on term0;
    // pre-fix the guard's pre-focus made docRight (cleanDoc's right neighbour) active.
    const term0 = await newTerminalTab(page, alpha)
    const cleanDoc = await openDoc(page, 'Projects/alpha/README.md', alpha)
    const docRight = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    await setActive(page, alpha, term0)
    expect(await activeId(page, alpha)).toBe(term0)

    await page.getByTestId(`close-${cleanDoc}`).click()

    await expect(page.getByTestId(`tab-${cleanDoc}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(term0) // unchanged
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([term0, docRight])
  })

  test('closing an INACTIVE DIRTY doc still prompts on its own (focused) pane; Cancel keeps it', async () => {
    await resetTabs(page, alpha)
    // Order: [term0(active), dirtyDoc, term1]. A prompting close DOES focus its tab (T-044) —
    // the dialog lives in the pane, and a hidden pane is display:none.
    const term0 = await newTerminalTab(page, alpha)
    const dirtyDoc = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    const cm = page.locator('[data-testid="raw-editor"]:visible .cm-content')
    await cm.click()
    await page.keyboard.type('GUARD EDIT ')
    await expect(page.locator('[data-testid="editor-dirty"]:visible')).toBeVisible()
    const term1 = await newTerminalTab(page, alpha)
    await setActive(page, alpha, term0)
    expect(await activeId(page, alpha)).toBe(term0)

    await page.getByTestId(`close-${dirtyDoc}`).click()

    // Focused (so the modal is on screen) and prompting.
    expect(await activeId(page, alpha)).toBe(dirtyDoc)
    await expect(page.locator('[data-testid="close-guard"]:visible')).toBeVisible()
    await page.locator('[data-testid="guard-cancel"]:visible').click()
    await expect(page.locator('[data-testid="close-guard"]')).toHaveCount(0)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([term0, dirtyDoc, term1])
    expect((await tabsOf(page, alpha)).find((t) => t.id === dirtyDoc)?.dirty).toBe(true)
  })

  test('batch "Close to the right" still closes through the guards and ends on the anchor', async () => {
    await resetTabs(page, alpha)
    // Anchor term0 is INACTIVE while the batch runs (active = cleanDoc, which the batch closes) —
    // the per-tab silent closes must not disturb the batch, which ends by focusing the anchor.
    const term0 = await newTerminalTab(page, alpha)
    const cleanDoc = await openDoc(page, 'Projects/alpha/README.md', alpha)
    const term1 = await newTerminalTab(page, alpha)
    await setActive(page, alpha, cleanDoc)

    await page.getByTestId(`tab-${term0}`).click({ button: 'right' })
    await expect(page.getByTestId('tab-context-menu')).toBeVisible()
    await page.getByTestId('menu-tab-close-right').click()

    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id))).toEqual([term0])
    expect(await activeId(page, alpha)).toBe(term0)
    await expect(page.getByTestId(`tab-${cleanDoc}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${term1}`)).toHaveCount(0)
  })

  // ── T-189 acceptance matrix — MRU chain unwind + right-neighbour fallback ────────────────────
  // The motivating flow: jump from a terminal/doc to a linked doc's new tab, read it, close it, and
  // land back where you came from — not on some unrelated right neighbour.

  test('a doc opened from a terminal returns to that terminal on close (MRU, not the neighbour)', async () => {
    await resetTabs(page, alpha)
    // [t0, doc, t1] with t0 active before the doc opened: the doc's MRU predecessor is t0 (to its
    // LEFT) while its right neighbour is t1 — so MRU (t0) and the T-107 fallback (t1) disagree.
    const t0 = await newTerminalTab(page, alpha)
    const t1 = await newTerminalTab(page, alpha)
    await setActive(page, alpha, t0)
    const doc = await openDoc(page, 'Projects/alpha/README.md', alpha)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([t0, doc, t1])
    expect(await activeId(page, alpha)).toBe(doc)

    await page.getByTestId(`close-${doc}`).click()

    await expect(page.getByTestId(`tab-${doc}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(t0) // back to the terminal, NOT its right neighbour t1
  })

  test('chain T → D1 → D2 unwinds most-recent-first on successive closes', async () => {
    await resetTabs(page, alpha)
    // [t, d1, d2, r] with r a right-side survivor never re-activated, so each close discriminates
    // the MRU pick (d1, then t) from the T-107 right neighbour (r).
    const t = await newTerminalTab(page, alpha)
    const r = await newTerminalTab(page, alpha)
    await setActive(page, alpha, t)
    const d1 = await openDoc(page, 'Projects/alpha/README.md', alpha)
    const d2 = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    expect((await tabsOf(page, alpha)).map((x) => x.id)).toEqual([t, d1, d2, r])
    expect(await activeId(page, alpha)).toBe(d2)

    await page.getByTestId(`close-${d2}`).click()
    await expect(page.getByTestId(`tab-${d2}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(d1) // MRU previous, NOT the right neighbour r

    await page.getByTestId(`close-${d1}`).click()
    await expect(page.getByTestId(`tab-${d1}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(t) // unwinds to the terminal, NOT r
    expect((await tabsOf(page, alpha)).map((x) => x.id)).toEqual([t, r])
  })

  test('when the MRU stack holds no surviving return target, focus falls back to the right neighbour', async () => {
    const beta = fixture.projects.beta
    await page.getByTestId(`project-${beta}`).click()
    await resetTabs(page, beta)
    const m = await openDoc(page, 'Projects/beta/README.md', beta)

    await page.getByTestId(`project-${alpha}`).click()
    await resetTabs(page, alpha)
    const a = await newTerminalTab(page, alpha)

    // Move m from beta into alpha as a BACKGROUND arrival (alpha already has an active tab, a): it
    // lands at the end of alpha's strip WITHOUT stealing focus and — never activated in alpha — is
    // NOT recorded in alpha's MRU stack. So when the active tab `a` is closed, the stack yields no
    // surviving return target and the T-107 right-neighbour rule takes over.
    await page.evaluate(
      ({ b, mm, al }) => window.__pomadeStores.useTabsStore.getState().moveTabToProject(b, mm, al),
      { b: beta, mm: m, al: alpha }
    )
    await expect
      .poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id)))
      .toEqual([a, m])
    expect(await activeId(page, alpha)).toBe(a) // background arrival did not steal focus

    await page.getByTestId(`close-${a}`).click()

    await expect(page.getByTestId(`tab-${a}`)).toHaveCount(0)
    expect(await activeId(page, alpha)).toBe(m) // T-107 fallback: m is a's (only) neighbour
  })
})
