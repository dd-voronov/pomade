// modules: editor, core
// Pomade T-090 e2e — the editor header's name field is an expandable PATH display.
// Collapsed (default) it shows the file name, as before. Clicking it expands every open pane to
// an informative path: project-relative for a doc inside this pane's project, workspace-relative
// for one inside the workspace but outside that project (absolute for one outside the workspace —
// not reachable yet, so not covered here). The state is ONE global AppSetting, persisted, so it
// survives a relaunch. Right-clicking the field opens the editor's own no-selection context menu
// for THIS doc.
//
// New file ⇒ its own parallel worker; doc tabs are seeded via .pomade/state (the app's own
// restore path), which is also what makes the relaunch assertion meaningful.

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
import { readViewState } from './fixtures/settings'

const PID = 'proj-alpha'
// A doc NESTED inside the active project: project-relative and workspace-relative paths differ,
// which is the whole point of the first tier.
const DEEP_WS_REL = 'Projects/alpha/docs/deep/note.md'
const DEEP_PROJ_REL = 'docs/deep/note.md'
// A doc inside the workspace but OUTSIDE the active project — shown workspace-relative.
const BETA_WS_REL = 'Projects/beta/README.md'
// A path far wider than the header, for the "clips on the LEFT" geometry check.
const LONG_DIR = 'docs/a-fairly-long-folder-name/another-quite-long-folder-name/and-one-more-level'
const LONG_WS_REL = `Projects/alpha/${LONG_DIR}/a-document-with-a-long-name.md`
const LONG_PROJ_REL = `${LONG_DIR}/a-document-with-a-long-name.md`

function docTab(id: string, path: string): Record<string, unknown> {
  return {
    id,
    projectId: PID,
    kind: 'doc',
    title: path.slice(path.lastIndexOf('/') + 1),
    path,
    // Raw keeps these panes cheap and deterministic (no Milkdown mount); the header is
    // mode-independent.
    mode: 'raw',
    dirty: false
  }
}

async function seedState(root: string): Promise<void> {
  const state = {
    openTabs: [
      docTab('doc-deep', DEEP_WS_REL),
      docTab('doc-beta', BETA_WS_REL),
      docTab('doc-long', LONG_WS_REL)
    ],
    activeTabId: 'doc-deep'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

/** The header's out-of-project rule: the absolute path, home-relativised to `~` under home. */
function homeRelative(abs: string, home: string): string {
  return home && (abs === home || abs.startsWith(`${home}/`)) ? `~${abs.slice(home.length)}` : abs
}

function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => window.pomade.app.clipboardRead())
}

test.describe('T-090 editor header path display', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  /** The name field of the VISIBLE pane (hidden panes keep their own header). */
  const title = (): ReturnType<Page['locator']> =>
    page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-title"]')

  const openTab = async (tabId: string): Promise<void> => {
    await page.getByTestId(`tab-${tabId}`).click()
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const root = fixture.workspaceRoot
    await fs.mkdir(join(root, 'Projects/alpha/docs/deep'), { recursive: true })
    await fs.writeFile(join(root, DEEP_WS_REL), '# Deep note\n\nNested a few levels down.\n')
    await fs.mkdir(join(root, 'Projects/alpha', LONG_DIR), { recursive: true })
    await fs.writeFile(join(root, LONG_WS_REL), '# Long\n')

    await seedState(root)
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${PID}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('collapsed by default: the file name only, with the full path in the tooltip', async () => {
    await openTab('doc-deep')
    await expect(title()).toHaveText('note.md')
    await expect(title()).toHaveAttribute('data-expanded', 'false')
    // The tooltip carries the informative string in both states, so a clipped path is always
    // readable on hover.
    await expect(title()).toHaveAttribute('title', DEEP_PROJ_REL)
  })

  test('click expands to the path FROM THE PROJECT ROOT', async () => {
    await openTab('doc-deep')
    await title().click()
    await expect(title()).toHaveText(DEEP_PROJ_REL)
    await expect(title()).toHaveAttribute('data-expanded', 'true')
    // Project-relative, NOT workspace-relative: the project's own root is not repeated.
    expect(await title().textContent()).not.toContain('Projects/alpha')
  })

  test('ONE global toggle: a doc outside the active project shows its ~-relative FULL path (T-101)', async () => {
    // No second click — the expanded state set above must already apply to this pane.
    await openTab('doc-beta')
    // T-101 superseded T-090's workspace-relative tier: an out-of-project doc now shows the full
    // absolute path, home-relativised to `~` when it lives under home. This fixture lives in the
    // OS temp dir (not under home), so the full absolute path is shown as-is — computed here with
    // the same rule so the assertion holds whatever the temp dir turns out to be.
    const home = await page.evaluate(() => window.pomade.env.home as string)
    const abs = join(fixture.workspaceRoot, BETA_WS_REL)
    const expected = homeRelative(abs, home)
    await expect(title()).toHaveText(expected)
    await expect(title()).toHaveAttribute('data-expanded', 'true')
    await expect(title()).toHaveAttribute('title', expected)
    // …and the out-of-project scope triangle now sits in the header (orange = outside project).
    const scope = page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-scope"]')
    await expect(scope).toBeVisible()
    await expect(scope).toHaveAttribute('data-tone', 'warning')
  })

  test('a path too long for the header clips on the LEFT and never pushes the controls out', async () => {
    await openTab('doc-long')
    await expect(title()).toHaveText(LONG_PROJ_REL)
    // The full string stays available on hover, however much of it is clipped.
    await expect(title()).toHaveAttribute('title', LONG_PROJ_REL)

    const geom = await title().evaluate((el) => {
      const inner = el.querySelector('bdi') as HTMLElement
      const box = el.getBoundingClientRect()
      const text = inner.getBoundingClientRect()
      const actions = el
        .closest('header')!
        .querySelector('[data-testid="doc-close"]')!
        .getBoundingClientRect()
      return {
        overflowing: el.scrollWidth > el.clientWidth + 1,
        clippedLeftBy: box.left - text.left,
        tailGap: box.right - text.right,
        closeWidth: actions.width
      }
    })
    // Overflowing, with the string's START off the left edge and its END (the file name — the
    // informative part) parked at the right edge: i.e. the ellipsis is on the LEFT.
    expect(geom.overflowing).toBe(true)
    expect(geom.clippedLeftBy).toBeGreaterThan(10)
    expect(geom.tailGap).toBeLessThan(8)
    // The × button (last of the right-side controls) keeps its size.
    expect(geom.closeWidth).toBeGreaterThan(10)
  })

  test('clicking again collapses — everywhere', async () => {
    await openTab('doc-beta')
    await title().click()
    await expect(title()).toHaveText('README.md')
    await openTab('doc-deep')
    await expect(title()).toHaveText('note.md')
    await expect(title()).toHaveAttribute('data-expanded', 'false')
  })

  test('right-click on the name field opens the no-selection menu for THIS doc', async () => {
    await openTab('doc-deep')
    await title().click({ button: 'right' })

    const menu = page.getByTestId('editor-context-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('data-variant', 'no-selection')
    await expect(page.getByTestId('menu-duplicate-file')).toBeVisible()
    await expect(page.getByTestId('menu-copy-file-to')).toBeVisible()
    await expect(page.getByTestId('menu-copy-path')).toBeVisible()
    await expect(page.getByTestId('menu-copy-full-path')).toBeVisible()
    // The header carries no spellcheck context, and none must flash in from main's push.
    await expect(page.getByTestId('menu-spell-add')).toHaveCount(0)
    await expect(page.getByTestId('menu-spell-empty')).toHaveCount(0)

    // The actions act on the doc whose header was clicked.
    await page.getByTestId('menu-copy-path').click()
    expect(await readClipboard(page)).toBe(DEEP_WS_REL)
    await expect(menu).toHaveCount(0)

    await title().click({ button: 'right' })
    await page.getByTestId('menu-copy-full-path').click()
    expect(await readClipboard(page)).toBe(join(fixture.workspaceRoot, DEEP_WS_REL))
  })

  test('the expanded choice is persisted — a relaunched app still shows paths', async () => {
    // Two Electron sessions back-to-back: legitimately slow under full-suite load.
    test.slow()
    await openTab('doc-deep')
    await title().click()
    await expect(title()).toHaveText(DEEP_PROJ_REL)
    // The view-state write must land before teardown — poll the file for the setting.
    await expect
      .poll(async () => (await readViewState(fixture.workspaceRoot)).editorHeaderShowPath, {
        timeout: 10_000
      })
      .toBe(true)
    await app.close()

    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${PID}`).click()

    await expect(title()).toHaveText(DEEP_PROJ_REL, { timeout: 10_000 })
    await expect(title()).toHaveAttribute('data-expanded', 'true')
  })
})
