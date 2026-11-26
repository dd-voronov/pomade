// modules: editor, tabs
// Pomade T-194 e2e — a raw⇄live⇄rendered mode toggle KEEPS the on-screen viewport (reading position)
// instead of following the caret, and the reading position is persisted on a debounce as you scroll.
//
// The design change from T-185: a toggle used to scroll the T-004 caret bridge's caret into view (so
// after scrolling away from the caret, a toggle jumped back to it, and a `:line` link re-jumped to
// its line on every later toggle). Now the toggle captures the OUTGOING engine's viewport top and
// uses it as the scroll source for the incoming engine; the caret bridge supplies only the SELECTION
// (baked in, not scrolled to). See docs/modules/editor/editing-modes.md.
//
// Coverage (the ticket's binding acceptance):
//   1. scroll WITHOUT clicking; toggle raw→live→rendered→raw → viewport kept at each hop; caret
//      never moved (selection start stays 0). Exercises both the mode toggle and the ⋯ rich-view
//      switch (both remount and both must keep the viewport).
//   2. place the caret near the top, scroll it FAR off-screen, toggle → viewport kept, the caret is
//      still at its text position (selection start > 0) and was NOT scrolled into view.
//   3. open via a `:line` jump, scroll away, toggle → stays at the scrolled position (no re-jump to
//      the link line); close + reopen (T-149) → reopens at the scrolled position, not the link line.
//   4. scroll, then quit/restart with NO tab switch → the debounced capture persisted the position
//      (proven directly: the stored viewport appears WITHOUT any save point), and restore lands it.
//
// Revert proof (whole T-194 src change reverted on a rebuilt bundle):
//   • tests 1/2/3 FAIL — the toggle follows the caret, so the top paragraph after a toggle is the
//     caret's paragraph (≈1), not the scrolled-to one; test 3's `:line` re-jumps on toggle.
//   • test 4's "viewport persisted with no save point" assertion FAILS — without the debounced scroll
//     listener nothing writes `viewport` until a tab switch / close / quit.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage, relaunchApp } from './fixtures/app'

const PID = 'proj-alpha'
const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

// A doc taller than the viewport, every paragraph uniquely numbered so the top-visible paragraph is
// an unambiguous oracle for the reading position. No frontmatter, so raw and live line up 1:1.
// Paragraph k sits on raw line 2k+1 (line 1 = heading, blank lines between).
const LONG = ['# Long reading-position doc', '']
  .concat(...Array.from({ length: 80 }, (_, i) => [`Paragraph number ${i + 1} of the reading-position document.`, '']))
  .join('\n')

const NAME = 'toggle-viewport.md'

interface SeedTab {
  id: string
  mode: 'raw' | 'live' | 'rendered'
  richView?: 'live' | 'rendered'
}

async function seed(fixture: Fixture, tabs: SeedTab[], activeId: string): Promise<void> {
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', NAME), LONG)
  const state = {
    openTabs: tabs.map((t) => ({
      id: t.id,
      projectId: PID,
      kind: 'doc',
      title: NAME,
      path: `Projects/alpha/${NAME}`,
      mode: t.mode,
      ...(t.richView ? { richView: t.richView } : {}),
      dirty: false
    })),
    activeTabId: activeId
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

async function open(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launchAppPage(fixture)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
  return { app, page }
}

/** The text of the first NON-BLANK block at the top of the visible editor's scroll container — the
 *  reading-position oracle. Blank lines skipped (a block anchor restores to a paragraph; a scroll
 *  margin can leave a sliver of the empty line above it). */
async function topLineText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-testid="editor-pane"]')] as HTMLElement[]
    const pane = panes.find((p) => p.offsetParent !== null)
    if (!pane) return ''
    const container =
      (pane.querySelector('[data-testid="live-scroll"]') as HTMLElement | null) ??
      (pane.querySelector('[data-testid="md-scroll"]') as HTMLElement | null) ??
      (pane.querySelector('.cm-scroller') as HTMLElement | null)
    if (!container) return ''
    const cr = container.getBoundingClientRect()
    const lines = [...pane.querySelectorAll('.cm-line, .ProseMirror > *')] as HTMLElement[]
    let best: HTMLElement | null = null
    let bestTop = Infinity
    for (const l of lines) {
      const text = (l.textContent ?? '').trim()
      if (!text) continue
      const r = l.getBoundingClientRect()
      if (r.bottom > cr.top + 2 && r.top < bestTop) {
        bestTop = r.top
        best = l
      }
    }
    return (best?.textContent ?? '').trim()
  })
}

/** The paragraph NUMBER at the top of the viewport (from "Paragraph number N …"), or 0 for the
 *  heading / no paragraph. The reading-position oracle: block identity, robust to the pixel-level
 *  height differences between the three engines (assert "approximately kept" as a small delta). */
async function topPara(page: Page): Promise<number> {
  const t = await topLineText(page)
  const m = t.match(/Paragraph number (\d+)/)
  return m ? Number(m[1]) : 0
}

async function scrollToPx(page: Page, top: number): Promise<void> {
  // Re-set inside the retry: a pending `:line` jump re-issues its centering scroll on the next
  // animation frame, which can undo a single set — setting again each attempt wins the race.
  await expect(async () => {
    await page.evaluate((y) => {
      const panes = [...document.querySelectorAll('[data-testid="editor-pane"]')] as HTMLElement[]
      const pane = panes.find((p) => p.offsetParent !== null)
      const container =
        (pane?.querySelector('[data-testid="live-scroll"]') as HTMLElement | null) ??
        (pane?.querySelector('[data-testid="md-scroll"]') as HTMLElement | null) ??
        (pane?.querySelector('.cm-scroller') as HTMLElement | null)
      if (container) container.scrollTop = y
    }, top)
    expect(await scrollTopPx(page)).toBeGreaterThan(top - 200)
    // A virtualized editor re-renders its viewport a frame after the scroll; until it has, every
    // rendered line sits above the container and the top line reads empty. Under load that frame
    // lands late — wait for it, so the caller measures the scrolled view, not the stale one.
    expect(await topLineText(page)).not.toBe('')
  }).toPass()
}

async function scrollTopPx(page: Page): Promise<number> {
  return page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-testid="editor-pane"]')] as HTMLElement[]
    const pane = panes.find((p) => p.offsetParent !== null)
    const container =
      (pane?.querySelector('[data-testid="live-scroll"]') as HTMLElement | null) ??
      (pane?.querySelector('[data-testid="md-scroll"]') as HTMLElement | null) ??
      (pane?.querySelector('.cm-scroller') as HTMLElement | null)
    return container?.scrollTop ?? 0
  })
}

/** The visible editor's current selection start (the e2e hook EditorPane exposes). -1 when no
 *  controller. Proves the caret was (or was not) carried across a toggle. */
async function selectionFrom(page: Page): Promise<number> {
  return page.evaluate(
    () => window.__pomadeEditorSelectionFrom?.() ?? -2
  )
}

function viewportKey(page: Page, tabId: string): Promise<string> {
  return page.evaluate(
    ({ id, pid }) =>
      (
        window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] as {
          id: string
          viewport?: { key: string }
        }[]
      ).find((t) => t.id === id)?.viewport?.key ?? '',
    { id: tabId, pid: PID }
  )
}

test.describe('T-194 — a mode toggle keeps the on-screen viewport', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('scroll without clicking; toggle raw→live→rendered→raw keeps the viewport, caret never moves', async () => {
    await seed(fixture, [{ id: 'doc-t', mode: 'raw', richView: 'live' }], 'doc-t')
    const { app, page } = await open(fixture)
    await page.getByTestId('tab-doc-t').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()

    // Scroll WITHOUT ever clicking into the editor — the caret stays at the document start.
    await scrollToPx(page, 700)
    // The editor re-renders its visible lines a frame after the scroll — poll, don't race it.
    await expect.poll(() => topPara(page)).toBeGreaterThan(3)
    const anchor = await topPara(page)
    expect(await selectionFrom(page)).toBe(0)

    // raw → live (mode toggle).
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'live')
    await expect(vis(page, '[data-testid="live-editor"]')).toBeVisible()
    await expect.poll(() => topPara(page)).toBeGreaterThan(anchor - 4)
    expect(Math.abs((await topPara(page)) - anchor)).toBeLessThanOrEqual(4)

    // live → rendered (⋯ rich-view switch — also a remount).
    await vis(page, '[data-testid="doc-actions"]').click()
    await vis(page, '[data-testid="action-rich-view"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'rendered')
    await expect(vis(page, '[data-testid="rendered-editor"]')).toBeVisible()
    await expect.poll(() => topPara(page)).toBeGreaterThan(anchor - 5)
    expect(Math.abs((await topPara(page)) - anchor)).toBeLessThanOrEqual(5)

    // rendered → raw (mode toggle).
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()
    await expect.poll(() => topPara(page)).toBeGreaterThan(anchor - 5)
    expect(Math.abs((await topPara(page)) - anchor)).toBeLessThanOrEqual(5)

    // The caret never moved: it is still at the very top (the heading), not dragged to the scrolled
    // viewport (whose paragraph sits at source offset ≫ 50). It started unclicked at offset 0; after
    // the round-trip it rests at the heading's text start (offset 2, just past the `# ` markup).
    expect(await selectionFrom(page)).toBeLessThan(50)
    await app.close()
  })

  test('caret placed near the top then scrolled off-screen: toggle keeps the viewport, caret stays put', async () => {
    await seed(fixture, [{ id: 'doc-t', mode: 'raw', richView: 'live' }], 'doc-t')
    const { app, page } = await open(fixture)
    await page.getByTestId('tab-doc-t').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // Place the caret in an early paragraph (near the top), then scroll it FAR off-screen.
    await vis(page, '[data-testid="raw-editor"] .cm-content').getByText('Paragraph number 2 of').click()
    expect(await selectionFrom(page)).toBeGreaterThan(0)
    await scrollToPx(page, 1600)
    // The editor re-renders its visible lines a frame after the scroll — poll, don't race it.
    await expect.poll(() => topPara(page)).toBeGreaterThan(20)
    const anchor = await topPara(page) // the caret's paragraph (2) is far above the viewport now

    // Toggle: the viewport is kept (top paragraph ≈ the scrolled-to one), NOT scrolled to the caret.
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'live')
    await expect(vis(page, '[data-testid="live-editor"]')).toBeVisible()
    await expect.poll(() => topPara(page)).toBeGreaterThan(anchor - 5)
    expect(Math.abs((await topPara(page)) - anchor)).toBeLessThanOrEqual(5)

    // The caret was still carried across as the SELECTION (its text position), just not scrolled to.
    expect(await selectionFrom(page)).toBeGreaterThan(0)
    await app.close()
  })

  test('`:line` is one-shot: after scrolling away, a toggle does not re-jump; reopen restores the scrolled spot', async () => {
    await seed(fixture, [{ id: 'doc-t', mode: 'raw', richView: 'live' }], 'doc-t')
    const { app, page } = await open(fixture)
    await page.getByTestId('tab-doc-t').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()

    // A `:line` jump into the already-open tab (the T-170 openDocByPath → jumpTo handoff, exactly
    // what a terminal `path:41` Cmd+click drives) — the raw jump places the caret on line 41 and
    // centers it (gutter shows 41).
    await page.evaluate(
      ({ pid, path }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(pid, path, { line: 41 }),
      { pid: PID, path: `Projects/alpha/${NAME}` }
    )
    await expect(vis(page, '[data-testid="raw-editor"] .cm-lineNumbers .cm-activeLineGutter')).toHaveText('41')

    // Scroll far past the link line to a distinct paragraph. The one-shot `:line` jump may still
    // re-center line 41 a few frames late under load: scroll again until the position HOLDS
    // across several animation frames (the jump fires once, so a held position is final).
    await expect(async () => {
      await scrollToPx(page, 1500)
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            let n = 0
            const tick = (): void => {
              if (++n >= 5) done()
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          })
      )
      expect(await topPara(page)).toBeGreaterThan(25)
    }).toPass()
    const scrolled = await topPara(page)

    // Toggle: stays at the scrolled position — it does NOT re-jump to the link line (para ~20).
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'live')
    await expect(vis(page, '[data-testid="live-editor"]')).toBeVisible()
    await expect.poll(() => topPara(page)).toBeGreaterThan(scrolled - 6)
    expect(Math.abs((await topPara(page)) - scrolled)).toBeLessThanOrEqual(6)

    // Close (captures the scrolled viewport into the reopen-stack entry), reopen via the app menu →
    // it reopens at the SCROLLED position, not the link line and not the top.
    await page.evaluate((pid) => window.__pomadeStores.useTabsStore.getState().closeTab(pid, 'doc-t'), PID)
    await expect.poll(() => page.getByTestId('tab-doc-t').count()).toBe(0)
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('menu-reopen-closed-tab')?.click()
    })
    await expect(page.getByTestId('tab-doc-t')).toBeVisible()
    await expect(vis(page, '[data-testid="editor-pane"]')).toBeVisible()
    await expect.poll(() => scrollTopPx(page)).toBeGreaterThan(0)
    await expect.poll(() => topPara(page)).toBeGreaterThan(scrolled - 8)
    expect(Math.abs((await topPara(page)) - scrolled)).toBeLessThanOrEqual(8)
    await app.close()
  })

  test('debounced scroll persistence: scrolling writes the viewport with no save point, and it restores on restart', async () => {
    await seed(fixture, [{ id: 'doc-t', mode: 'live' }], 'doc-t')
    let { app, page } = await open(fixture)
    await page.getByTestId('tab-doc-t').click()
    await expect(vis(page, '[data-testid="live-editor"]')).toBeVisible()

    // No save point yet (no tab switch / close / quit) — the stored viewport is still empty.
    expect(await viewportKey(page, 'doc-t')).toBe('')

    // Scroll and just WAIT: ~500ms after the scroll settles, the debounced listener persists the
    // reading position onto the tab. This is the only save-point-free path to a stored viewport, so
    // it isolates the T-194 debounce (revert-proof: without the listener this key stays empty here).
    await scrollToPx(page, 900)
    // The editor re-renders its visible lines a frame after the scroll — poll, don't race it.
    await expect.poll(() => topPara(page)).toBeGreaterThan(3)
    const scrolled = await topPara(page)
    await expect.poll(() => viewportKey(page, 'doc-t'), { timeout: 5000 }).not.toBe('')
    const key = await viewportKey(page, 'doc-t')

    // Quit → relaunch (no tab switch was ever made). The persisted position restores first-paint.
    ;({ app, page } = await relaunchApp(app, fixture))
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__pomadeStores.useAppSettingsStore.getState().hydrated
        )
      )
      .toBe(true)
    await page.getByTestId(`project-${PID}`).click()
    await expect(vis(page, '[data-testid="live-editor"]')).toBeVisible()
    await expect.poll(() => scrollTopPx(page)).toBeGreaterThan(0)
    await expect.poll(() => topPara(page)).toBeGreaterThan(scrolled - 6)
    expect(await viewportKey(page, 'doc-t')).not.toBe('')
    expect(key).not.toBe('')
    await app.close()
  })
})
