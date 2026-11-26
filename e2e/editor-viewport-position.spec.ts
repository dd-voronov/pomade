// modules: editor, tabs
// Pomade T-185 e2e — a doc reopens where you were READING (the first visible line / viewport top,
// NOT the caret). The stored value is DocTab.viewport (a block-text anchor), captured at the save
// points (tab switch / close / quit) off the LIVE editor and restored FIRST-PAINT on reopen /
// restart / re-show.
//
// Coverage:
//   1. capture-on-switch + restore-on-restart (raw): scroll a doc, switch away (captures), relaunch,
//      switch back → the same line sits at the viewport top (exercises setActive capture + the
//      hidden-then-shown re-show restore across a real quit→relaunch).
//   2. reopen a closed tab (T-149) restores the reading position (raw).
//   3. a doc opened FRESH from the tree starts at the TOP (a new tab has no saved viewport).
//   4. restore-on-restart for the LIVE engine (the markdown default) — proves the outer-container
//      first-paint scroll.
//
// Revert proof (whole T-185 src change stashed, bundle rebuilt): tests 1, 2, 4 FAIL — capture never
// writes `viewport` (1's capture assertion) and nothing restores (after ≠ before, scrollTop 0). Test
// 3 stays green (a fresh tab is always at the top — it is a guard against accidentally applying a
// saved position to a fresh open, not a bug-specific assertion).

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

// A doc taller than the viewport, every line uniquely identifiable so the "top visible line" is an
// unambiguous oracle for the reading position.
const LONG = ['# Long reading-position doc', '']
  .concat(...Array.from({ length: 80 }, (_, i) => [`Paragraph number ${i + 1} of the reading-position document.`, '']))
  .join('\n')
const SHORT = '# Short doc\n\nJust a little content.\n'

interface SeedTab {
  id: string
  name: string
  mode: 'raw' | 'live' | 'rendered'
}

async function seed(fixture: Fixture, tabs: SeedTab[], activeId: string): Promise<void> {
  const root = fixture.workspaceRoot
  for (const t of tabs) {
    await fs.writeFile(join(root, 'Projects/alpha', t.name), t.name === SHORT_NAME ? SHORT : LONG)
  }
  const state = {
    openTabs: tabs.map((t) => ({
      id: t.id,
      projectId: PID,
      kind: 'doc',
      title: t.name,
      path: `Projects/alpha/${t.name}`,
      mode: t.mode,
      dirty: false
    })),
    activeTabId: activeId
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

const LONG_NAME = 'reading-long.md'
const SHORT_NAME = 'reading-short.md'

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

/** The text of the first NON-BLANK line/block at the top of the currently-visible editor pane's
 *  scroll container (raw `.cm-scroller`, live `live-scroll`, rendered `md-scroll`) — the
 *  reading-position oracle. Blank lines are skipped: the block anchor restores to a paragraph, and
 *  CodeMirror's ~5px scroll margin can leave a sliver of the empty line above it at the very top,
 *  which is not the reading position the anchor names. */
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
      if (!text) continue // skip blank lines (see the doc comment)
      const r = l.getBoundingClientRect()
      if (r.bottom > cr.top + 2 && r.top < bestTop) {
        bestTop = r.top
        best = l
      }
    }
    return (best?.textContent ?? '').trim()
  })
}

/** The stored anchor key = a block's plain text, whitespace-stripped + lowercased (caret-anchor.ts
 *  `anchorKey`). The restore oracle: the top non-blank line, normalized the same way, must equal the
 *  captured `viewport.key` — that ties "what is at the top after restore" to the anchor that was
 *  saved, without pixel-exact before/after fragility at a line boundary. */
function normKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

/** Scroll the visible pane's scroll container to `top` px and wait for it to settle. */
async function scrollTo(page: Page, top: number): Promise<void> {
  await page.evaluate((y) => {
    const panes = [...document.querySelectorAll('[data-testid="editor-pane"]')] as HTMLElement[]
    const pane = panes.find((p) => p.offsetParent !== null)
    const container =
      (pane?.querySelector('[data-testid="live-scroll"]') as HTMLElement | null) ??
      (pane?.querySelector('[data-testid="md-scroll"]') as HTMLElement | null) ??
      (pane?.querySelector('.cm-scroller') as HTMLElement | null)
    if (container) container.scrollTop = y
  }, top)
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(top - 200)
}

async function scrollTop(page: Page): Promise<number> {
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

function viewportOf(page: Page, tabId: string): Promise<{ key: string } | null | undefined> {
  return page.evaluate(
    ({ id, pid }) =>
      (
        window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] as {
          id: string
          viewport?: { key: string }
        }[]
      ).find((t) => t.id === id)?.viewport,
    { id: tabId, pid: PID }
  ) as Promise<{ key: string } | null | undefined>
}

test.describe('T-185 — a doc reopens where you were reading', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('scroll + switch away captures the reading position, restart + switch back restores it (raw)', async () => {
    await seed(
      fixture,
      [
        { id: 'doc-long', name: LONG_NAME, mode: 'raw' },
        { id: 'doc-short', name: SHORT_NAME, mode: 'raw' }
      ],
      'doc-long'
    )
    let { app, page } = await open(fixture)
    await page.getByTestId('tab-doc-long').click()
    await expect(vis(page, '[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()

    await scrollTo(page, 700)
    expect(await topLineText(page)).toContain('Paragraph number')

    // Switch away → tabs-store.setActive captures the OUTGOING doc's viewport (a paragraph anchor).
    await page.getByTestId('tab-doc-short').click()
    await expect.poll(() => viewportOf(page, 'doc-long').then((v) => v?.key ?? '')).not.toBe('')
    const key = (await viewportOf(page, 'doc-long'))?.key ?? ''

    // Real quit → relaunch. doc-short is the active tab now; doc-long restores as a background tab.
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

    // First show of the restored (hidden-mounted) doc → re-show restore lands the captured block at top.
    await page.getByTestId('tab-doc-long').click()
    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(0)
    await expect.poll(() => topLineText(page).then(normKey)).toBe(key)
    await app.close()
  })

  test('reopening a closed tab restores its reading position (raw)', async () => {
    await seed(fixture, [{ id: 'doc-long', name: LONG_NAME, mode: 'raw' }], 'doc-long')
    const { app, page } = await open(fixture)
    await page.getByTestId('tab-doc-long').click()
    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()

    await scrollTo(page, 700)
    expect(await topLineText(page)).toContain('Paragraph number')

    // Close (captures the viewport into the reopen-stack entry), then reopen via the app menu.
    await page.evaluate((pid) => window.__pomadeStores.useTabsStore.getState().closeTab(pid, 'doc-long'), PID)
    await expect.poll(() => page.getByTestId('tab-doc-long').count()).toBe(0)
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('menu-reopen-closed-tab')?.click()
    })
    await expect(page.getByTestId('tab-doc-long')).toBeVisible()

    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()
    // The reopened tab carries the captured anchor; the restore lands that block at the top.
    const key = (await viewportOf(page, 'doc-long'))?.key ?? ''
    expect(key).not.toBe('')
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(0)
    await expect.poll(() => topLineText(page).then(normKey)).toBe(key)
    await app.close()
  })

  test('a doc opened fresh (no saved position) starts at the top', async () => {
    // The file exists on disk but no tab is seeded, so opening it mints a genuinely fresh tab.
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha', LONG_NAME), LONG)
    await fs.mkdir(join(fixture.workspaceRoot, '.pomade/state'), { recursive: true })
    await fs.writeFile(join(fixture.workspaceRoot, '.pomade/state', `${PID}.json`), JSON.stringify({ openTabs: [] }))
    const { app, page } = await open(fixture)

    await page.evaluate(
      ({ path, pid }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(pid, path, { real: true }),
      { path: `Projects/alpha/${LONG_NAME}`, pid: PID }
    )
    await expect(vis(page, '[data-testid="editor-pane"]')).toBeVisible()
    await expect.poll(() => topLineText(page)).toContain('Long reading-position doc')
    expect(await scrollTop(page)).toBeLessThan(10)
    await app.close()
  })

  test('restart restores the reading position for the LIVE engine', async () => {
    await seed(fixture, [{ id: 'doc-live', name: LONG_NAME, mode: 'live' }], 'doc-live')
    let { app, page } = await open(fixture)
    await page.getByTestId('tab-doc-live').click()
    await expect(vis(page, '[data-testid="live-editor"]')).toBeVisible()

    await scrollTo(page, 700)
    expect(await topLineText(page)).toContain('Paragraph number')

    // Real quit → relaunch. doc-live is the ONLY (active) tab → captured by the QUIT FLUSH and
    // restored FIRST-PAINT on the fresh, visible mount.
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

    // The quit flush persisted the reading position; the fresh mount lands that block at the top.
    const key = (await viewportOf(page, 'doc-live'))?.key ?? ''
    expect(key).not.toBe('')
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(0)
    await expect.poll(() => topLineText(page).then(normKey)).toBe(key)
    await app.close()
  })
})
