// modules: tabs
// Pomade T-148 e2e — the tab strip's full-name hover tooltip.
//
// Hovering a tab whose display name is TRUNCATED (the tab is capped at max-width:200px and the
// title span ellipsizes) shows the design-system Tooltip carrying the tab's COMPLETE name — the
// exact string it renders (`tab.title`): a file name, a custom rename, or a default terminal/agent
// title. It appears ONLY when the span actually overflows (`scrollWidth > clientWidth`, measured
// live at hover), so a name that fully fits shows no title tooltip. Instant, name-only, wrapped so
// a long name renders un-clipped inside the tip.
//
// Coverage: a truncated DOC tab, a truncated TERMINAL tab, and a truncated (renamed) AGENT tab all
// show the full name; a fully-fitting doc tab shows NO title tooltip; and the tip renders the whole
// name with no internal clipping (its own scrollWidth ≤ clientWidth).
//
// Tabs are created through the app's OWN paths — docs via the store's openTab (real long-named
// files on disk), terminals/agents via the "+" menu (real ptys) — then a long realistic name is
// set with updateTab. State is read/reset through the __pomadeStores hook, the tab suites' pattern.

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
import { FAKE_AGENT_ECHO_EXIT, seedFakeAgent } from './fixtures/fake-agent'
import { expectQuiet } from './fixtures/timing'

// Real, realistically-long names (mirroring the repo's own dated session/handoff docs and a
// verbose renamed shell) — these DO overflow the 200px tab; the short one does NOT.
const LONG_DOC = '2026-08-19-session-attribution-window-and-rebind-machine.md'
const LONG_TERMINAL_TITLE = 'dev server — Projects/pomade (npm run dev, watch + typecheck)'
const LONG_AGENT_TITLE = 'claude-test — refactor session-attribution bind window machine'
const SHORT_DOC = 'todo.md'

function tabsOf(page: Page, pid: string): Promise<{ id: string }[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({ id: t.id }))
  }, pid)
}

let counter = 0
/** Open a real doc tab (workspace-relative path) via the store; title = the file's base name. */
async function openDocTab(page: Page, pid: string, path: string): Promise<string> {
  const id = `tt-${++counter}`
  await page.evaluate(
    ({ pid, path, id }) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      s.openTab({
        id,
        projectId: pid,
        kind: 'doc',
        title: path.slice(path.lastIndexOf('/') + 1) || path,
        path,
        mode: 'raw',
        dirty: false
      })
    },
    { pid, path, id }
  )
  return id
}

/** Add a terminal/agent tab through the "+" menu (real pty); returns its tab id. */
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

/** Give a tab a user-set title (mirrors an inline rename), marking it renamed so nothing overwrites. */
async function renameTab(page: Page, pid: string, tabId: string, title: string): Promise<void> {
  await page.evaluate(
    ({ p, t, title }) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      s.updateTab(p, t, { title, renamed: true })
    },
    { p: pid, t: tabId, title }
  )
}

/** Geometry of a title span: does it overflow (ellipsize)? */
function titleOverflow(page: Page, tabId: string): Promise<{ scroll: number; client: number }> {
  return page
    .getByTestId(`tab-title-${tabId}`)
    .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
}

test.describe('T-148 tab strip full-name tooltip (truncated only)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  let longDocId: string
  let shortDocId: string
  let termId: string
  let agentId: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
    // Real files on disk so the doc panes load cleanly (the tooltip reads the tab strip only).
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha', LONG_DOC), '# Long\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha', SHORT_DOC), '# todo\n')

    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    await page.getByTestId(`project-${alpha}`).click()

    // Two doc tabs — one long (truncates), one short (fits).
    longDocId = await openDocTab(page, alpha, `Projects/alpha/${LONG_DOC}`)
    shortDocId = await openDocTab(page, alpha, `Projects/alpha/${SHORT_DOC}`)

    // A real terminal tab, renamed to a long title.
    termId = await newTabVia(page, alpha, 'tab-add-terminal')
    await renameTab(page, alpha, termId, LONG_TERMINAL_TITLE)

    // A real agent tab (fake-agent harness), renamed to a long title.
    agentId = await newTabVia(page, alpha, 'tab-add-agent-claude-test')
    await renameTab(page, alpha, agentId, LONG_AGENT_TITLE)

    // Sanity: the long tabs truncate, the short one does not.
    await expect(page.getByTestId(`tab-title-${longDocId}`)).toBeVisible()
    const long = await titleOverflow(page, longDocId)
    expect(long.scroll).toBeGreaterThan(long.client)
    const short = await titleOverflow(page, shortDocId)
    expect(short.scroll).toBeLessThanOrEqual(short.client)
  })

  test.beforeEach(async () => {
    // Clear any lingering hover so each test measures a fresh mouseenter.
    await page.mouse.move(0, 0)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a truncated DOC tab shows the full name on hover, rendered un-clipped', async () => {
    await page.getByTestId(`tab-title-${longDocId}`).hover()
    const tip = page.getByTestId(`tab-title-tooltip-${longDocId}`)
    await expect(tip).toBeVisible()
    await expect(tip).toHaveText(LONG_DOC)
    // The whole name fits INSIDE the tip (it wraps, never clips): its own content is not overflowed.
    const fit = await tip.evaluate((el) => ({
      sw: el.scrollWidth,
      cw: el.clientWidth,
      sh: el.scrollHeight,
      ch: el.clientHeight
    }))
    expect(fit.sw).toBeLessThanOrEqual(fit.cw)
    expect(fit.sh).toBeLessThanOrEqual(fit.ch)
    // Light, tokens-driven background (never black), like every on-system tooltip.
    const bg = await tip.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).not.toBe('rgb(0, 0, 0)')
  })

  test('a truncated TERMINAL tab shows its full name on hover', async () => {
    await page.getByTestId(`tab-title-${termId}`).hover()
    const tip = page.getByTestId(`tab-title-tooltip-${termId}`)
    await expect(tip).toBeVisible()
    await expect(tip).toHaveText(LONG_TERMINAL_TITLE)
  })

  test('a truncated (renamed) AGENT tab shows its full name on hover', async () => {
    await page.getByTestId(`tab-title-${agentId}`).hover()
    const tip = page.getByTestId(`tab-title-tooltip-${agentId}`)
    await expect(tip).toBeVisible()
    await expect(tip).toHaveText(LONG_AGENT_TITLE)
  })

  test('a fully-fitting name shows NO title tooltip on hover', async () => {
    await page.getByTestId(`tab-title-${shortDocId}`).hover()
    // Any (wrong) tooltip would mount within a beat — it never does, held throughout.
    await expectQuiet(async () => {
      await expect(page.getByTestId(`tab-title-tooltip-${shortDocId}`)).toHaveCount(0)
    }, 150)
  })
})
