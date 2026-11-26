// modules: git, tabs
// Pomade T-233 e2e — a deleted file's row menu says what opens. In a commit tab a file the commit
// deleted offers "Open the deletion in a new tab" (the comparison, a tab that stays — not the
// preview) and no "Open this version in a tab" (the file is not in that commit); a file the commit
// modified keeps both items. In Changes a deleted file offers "View last committed version" (the
// deleted-file view, an overlay with Restore file — not a tab); a new file keeps "Open in a new tab".
// On the git fixture (e2e/fixtures/git-repos.ts): obsolete.md deleted by the squash commit, keep.md
// deleted in the working tree.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'

import { launchAppPage } from './fixtures/app'
import { createGitFixture, git, type GitFixture } from './fixtures/git-repos'
import { activeIdOf, resetTabs, tabsOf } from './fixtures/stores'
import { showGitPanel } from './fixtures/panels'

const ALPHA = 'proj-alpha'

let fx: GitFixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const tabEl = (id: string): ReturnType<Page['locator']> => page.getByTestId(`tab-${id}`)
const previewId = (): Promise<string | undefined> =>
  page.evaluate((p) => window.__pomadeStores.useTabsStore.getState().previewTabByProject[p], ALPHA)

test.beforeAll(async () => {
  fx = await createGitFixture()
  ;({ app, page } = await launchAppPage(fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', ALPHA)
  await showGitPanel(page)
  await expect(page.getByTestId('git-repo-view')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('a commit tab: a deleted file offers only the deletion, opened in a tab that stays', async () => {
  await resetTabs(page, ALPHA)
  const squash = git(fx.alpha, 'log', '--format=%h', '-n', '1', '--grep', 'T-198').trim().slice(0, 7)
  await page.getByTestId(`git-commit-${squash}`).click()
  const pane = vis('[data-testid="commit-pane"]')
  await expect(pane).toBeVisible()
  const menu = page.getByTestId('commit-file-menu')

  await pane.getByTestId('commit-file-obsolete.md').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Open the deletion in a new tab'])
  await expect(menu.getByTestId('commit-file-menu-open-tab')).toHaveCount(0)
  await menu.getByTestId('row-menu-open-new-tab').click()
  const compare = vis('[data-testid="compare-pane"]')
  await expect(compare).toBeVisible()
  await expect(compare.getByTestId('compare-label-right')).toContainText('not in this version')
  const id = (await activeIdOf(page, ALPHA))!
  await expect(tabEl(id)).not.toHaveAttribute('data-preview', 'true')
  expect(await previewId()).toBeUndefined()

  // A file the commit modified keeps both items.
  await tabEl((await tabsOf(page, ALPHA)).find((t) => t.kind === 'commit')!.id).click()
  await pane.getByTestId('commit-file-docs/BACKLOG.md').click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in a new tab', 'Open this version in a tab'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('Changes: a deleted file offers its last committed version, a new file keeps Open in a new tab', async () => {
  await resetTabs(page, ALPHA)
  const menu = page.getByTestId('git-row-menu')

  await page.getByTestId('git-change-Projects/alpha/keep.md').click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['View last committed version'])
  await menu.getByTestId('row-menu-open-new-tab').click()
  await expect(page.getByTestId('deleted-file-overlay')).toBeVisible()
  await expect(page.getByTestId('deleted-file-title')).toHaveText('keep.md · deleted')
  await expect(page.getByTestId('deleted-file-restore')).toBeVisible()
  expect(await tabsOf(page, ALPHA)).toHaveLength(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('deleted-file-overlay')).toHaveCount(0)

  await page.getByTestId('git-change-Projects/alpha/draft.md').click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in a new tab'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})
