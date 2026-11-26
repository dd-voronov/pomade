// modules: editor, tabs
// Pomade T-101 (E-021) e2e — the exclamation-triangle scope mark on doc TABS.
//
// The shipped orange dot is replaced by a tiered warning triangle in its OWN slot: orange when the
// doc lives outside the active project, red when outside the workspace (an absolute path), plus a
// duplicate-open indicator (same icon, colour unchanged, extra tooltip line) when the same file is
// open as doc tabs in ≥2 different projects. The triangle NEVER replaces the blue (unsaved) or red
// (attention) dot — a tab can show a dot AND a triangle at once — and the active-tab underline
// stays accent-blue in every case. Tooltips stack, one line per active reason.
//
// Doc tabs are opened by driving tabs-store.openTab directly (the app's own open path), which lets
// a scenario place a single copy, cross-project copies, or an absolute path deterministically.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

const WORKSPACE_ID = '__workspace__'
// --accent (#4fb8d8) = the active-tab underline colour; asserted via computed box-shadow.
const ACCENT_RGB = 'rgb(79, 184, 216)'

function tabsOf(page: Page, pid: string): Promise<{ id: string; path?: string }[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({ id: t.id, path: t.path }))
  }, pid)
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

let counter = 0
/** Open a doc tab (workspace-relative OR absolute path) in `pid` via the store; returns its id. */
async function openDocTab(page: Page, pid: string, path: string): Promise<string> {
  const id = `sm-${++counter}`
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

function switchTo(page: Page, pid: string): Promise<void> {
  return page.evaluate(
    (p) => window.__pomadeStores.useWorkspaceStore.getState().setActiveProject(p),
    pid
  )
}

function setActiveTab(page: Page, pid: string, id: string): Promise<void> {
  return page.evaluate(
    ({ p, t }) => window.__pomadeStores.useTabsStore.getState().setActive(p, t),
    { p: pid, t: id }
  )
}

test.describe('T-101 scope marks on doc tabs', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string
  let beta: string

  const ALPHA_DOC = 'Projects/alpha/README.md'
  const BETA_DOC = 'Projects/beta/README.md'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta
  })

  test.beforeEach(async () => {
    await resetTabs(page, [alpha, beta, WORKSPACE_ID])
    await switchTo(page, alpha)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a doc from another project (in-workspace) shows an ORANGE triangle; underline stays blue; tooltip says Outside this project', async () => {
    // A SINGLE copy of a beta doc, opened in alpha ⇒ outside-project, no duplicate.
    const id = await openDocTab(page, alpha, BETA_DOC)
    await setActiveTab(page, alpha, id)

    const mark = page.getByTestId(`tab-scope-${id}`)
    await expect(mark).toBeVisible()
    await expect(mark).toHaveAttribute('data-tone', 'warning')

    // The active-tab underline is still accent-blue (the triangle lives in its own slot).
    const tabEl = page.getByTestId(`tab-${id}`)
    await expect(tabEl).toHaveAttribute('data-active', 'true')
    const boxShadow = await tabEl.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(boxShadow).toContain(ACCENT_RGB)

    // Hover → the themed tooltip, exactly one line (no duplicate reason for a single copy).
    const tip = page.getByTestId(`tab-scope-${id}-tooltip`)
    // Under load the first hover can land before the mark's pointer handlers are live: leave and
    // hover again until the tooltip shows.
    await expect(async () => {
      await page.mouse.move(0, 0)
      await mark.hover()
      await expect(tip).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 10_000 })
    await expect(tip).toHaveText('Outside this project')
    // Light background (tokens-driven), never black.
    const bg = await tip.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).not.toBe('rgb(0, 0, 0)')
  })

  test('an out-of-project doc that is ALSO unsaved shows BOTH the blue dirty dot and the orange triangle', async () => {
    const id = await openDocTab(page, alpha, BETA_DOC)
    // Mark it unsaved the way the editor would.
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().updateTab(p, t, { dirty: true }),
      { p: alpha, t: id }
    )

    const tabEl = page.getByTestId(`tab-${id}`)
    await expect(tabEl.locator('[aria-label="unsaved"]')).toBeVisible()
    await expect(page.getByTestId(`tab-scope-${id}`)).toBeVisible()
    await expect(page.getByTestId(`tab-scope-${id}`)).toHaveAttribute('data-tone', 'warning')
  })

  test('an out-of-project doc marked for attention shows BOTH the red attention dot and the orange triangle', async () => {
    const id = await openDocTab(page, alpha, BETA_DOC)
    // A second tab so `id` can be made INACTIVE (attention only shows on a non-active tab).
    const other = await openDocTab(page, alpha, ALPHA_DOC)
    await setActiveTab(page, alpha, other)
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().markUnread(p, t),
      { p: alpha, t: id }
    )

    await expect(page.getByTestId(`tab-attention-${id}`)).toBeVisible()
    await expect(page.getByTestId(`tab-scope-${id}`)).toBeVisible()
    await expect(page.getByTestId(`tab-scope-${id}`)).toHaveAttribute('data-tone', 'warning')
  })

  test('the same file open in two projects shows a triangle on BOTH; tooltip carries the duplicate line; closing one copy clears the survivor', async () => {
    // Both copies are IN-PROJECT (alpha's own doc + the Workspace project, rootPath ''), so
    // location alone would show NO triangle — the triangle here is purely the duplicate indicator.
    const inAlpha = await openDocTab(page, alpha, ALPHA_DOC)
    const inWs = await openDocTab(page, WORKSPACE_ID, ALPHA_DOC)

    // Alpha's copy: triangle present, tooltip is ONLY the duplicate line (in-project ⇒ no location line).
    await switchTo(page, alpha)
    await setActiveTab(page, alpha, inAlpha)
    const alphaMark = page.getByTestId(`tab-scope-${inAlpha}`)
    await expect(alphaMark).toBeVisible()
    await alphaMark.hover()
    await expect(page.getByTestId(`tab-scope-${inAlpha}-tooltip`)).toHaveText(
      '2+ copies open across projects'
    )

    // The Workspace project's copy: also shows a triangle.
    await switchTo(page, WORKSPACE_ID)
    await setActiveTab(page, WORKSPACE_ID, inWs)
    await expect(page.getByTestId(`tab-scope-${inWs}`)).toBeVisible()

    // Close the Workspace project's copy ⇒ alpha is the only copy again ⇒ its triangle clears.
    await page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().closeTab(p, t),
      { p: WORKSPACE_ID, t: inWs }
    )
    await switchTo(page, alpha)
    await expect(page.getByTestId(`tab-scope-${inAlpha}`)).toHaveCount(0)
  })

  test('duplication STACKS on the location line: an out-of-project copy shows both reasons', async () => {
    // Beta's doc open in beta (in-project) AND in alpha (out-of-project) ⇒ alpha's copy stacks
    // "Outside this project" + "2+ copies open across projects".
    const inBeta = await openDocTab(page, beta, BETA_DOC)
    const inAlpha = await openDocTab(page, alpha, BETA_DOC)
    expect(inBeta).toBeTruthy()

    await switchTo(page, alpha)
    await setActiveTab(page, alpha, inAlpha)
    const mark = page.getByTestId(`tab-scope-${inAlpha}`)
    await expect(mark).toBeVisible()
    await expect(mark).toHaveAttribute('data-tone', 'warning')
    await mark.hover()
    const tip = page.getByTestId(`tab-scope-${inAlpha}-tooltip`)
    await expect(tip).toContainText('Outside this project')
    await expect(tip).toContainText('2+ copies open across projects')
  })

  test('a doc with an ABSOLUTE path (outside the workspace) shows a RED triangle saying Outside the workspace', async () => {
    // T-102 (opening such files) is a parallel task; this proves the classify/colour path is ready
    // for it — an absolute stored path resolves to outside-workspace ⇒ the danger-red triangle.
    const id = await openDocTab(page, alpha, '/etc/hosts')
    await setActiveTab(page, alpha, id)

    const mark = page.getByTestId(`tab-scope-${id}`)
    await expect(mark).toBeVisible()
    await expect(mark).toHaveAttribute('data-tone', 'danger')
    await mark.hover()
    await expect(page.getByTestId(`tab-scope-${id}-tooltip`)).toHaveText('Outside the workspace')
  })
})
