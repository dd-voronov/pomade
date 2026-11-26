// modules: tabs, git, filetree
// Pomade T-228 e2e — one preview-tab rule on every surface: a single click opens the project's
// preview tab, its title in italics; using the tab keeps it (the italics go); a double click never
// pins; a row's right-click "Open in a new tab" (and Enter) opens a tab that stays; the second press
// of a real double click that lands in the pane its first click opened is dropped — no selection,
// no caret, the preview stays a preview. Double clicks here are sent as a real mouse sends them
// (`humanDoubleClick`: two presses 150 ms apart), on the git fixture (e2e/fixtures/git-repos.ts).
// Set POMADE_T228_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createGitFixture, git, type GitFixture } from './fixtures/git-repos'
import { humanDoubleClick } from './fixtures/interactions'
import { activeIdOf, resetTabs, tabsOf } from './fixtures/stores'
import { showGitPanel } from './fixtures/panels'

const SHOTS = process.env.POMADE_T228_SHOTS
const ALPHA = 'proj-alpha'
const BACKLOG = 'Projects/alpha/docs/BACKLOG.md'

let fx: GitFixture
let app: ElectronApplication
let page: Page

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const compare = (): ReturnType<Page['locator']> => vis('[data-testid="compare-pane"]')
const tabEl = (id: string): ReturnType<Page['locator']> => page.getByTestId(`tab-${id}`)

async function activeTab(): Promise<string> {
  const id = await activeIdOf(page, ALPHA)
  expect(id).toBeTruthy()
  return id!
}

/** The preview slot, straight from the store. */
const previewId = (): Promise<string | undefined> =>
  page.evaluate((p) => window.__pomadeStores.useTabsStore.getState().previewTabByProject[p], ALPHA)

const titleStyle = (id: string): Promise<string> =>
  page.getByTestId(`tab-title-${id}`).evaluate((el) => getComputedStyle(el).fontStyle)

/** Text selected anywhere in the window, plus CodeMirror's drawn selections in the comparison. */
async function selectionInCompare(): Promise<{ text: string; drawn: number; focusedInside: boolean }> {
  return compare().evaluate((el) => ({
    text: window.getSelection()?.toString() ?? '',
    drawn: [...el.querySelectorAll('.cm-selectionBackground')].filter((b) => (b as HTMLElement).offsetWidth > 0).length,
    focusedInside: el.contains(document.activeElement)
  }))
}

async function openAlphaGit(): Promise<void> {
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', ALPHA)
  await showGitPanel(page)
  await expect(page.getByTestId('git-repo-view')).toBeVisible()
}

async function showFiles(): Promise<void> {
  if (!(await page.getByTestId('side-panel-files').isVisible())) await page.getByTestId('strip-files').click()
}

test.beforeAll(async () => {
  fx = await createGitFixture()
  ;({ app, page } = await launchAppPage(fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('a single click opens the preview tab in italics; clicking into it keeps it and the italics go', async () => {
  await openAlphaGit()
  await resetTabs(page, ALPHA)
  await page.getByTestId(`git-change-${BACKLOG}`).click()
  await expect(compare()).toBeVisible()
  const id = await activeTab()
  await expect(tabEl(id)).toHaveAttribute('data-preview', 'true')
  await expect.poll(() => previewId()).toBe(id)
  expect(await titleStyle(id)).toBe('italic')
  await shot('01-preview-tab-italic')

  await compare().locator('.cm-merge-a .cm-content').click()
  await expect(tabEl(id)).not.toHaveAttribute('data-preview', 'true')
  expect(await previewId()).toBeUndefined()
  expect(await titleStyle(id)).toBe('normal')
  await shot('02-permanent-tab')
})

test('a tree file single click is a preview too; a real double click on the tree row still renames', async () => {
  await page.getByTestId(`project-${ALPHA}`).click()
  await resetTabs(page, ALPHA)
  const node = page.getByTestId('tree-node-Projects/alpha/notes.txt')
  await showFiles()
  await expect(node).toBeVisible()
  await node.click()
  await expect.poll(async () => (await tabsOf(page, ALPHA)).filter((t) => t.kind === 'doc')).toHaveLength(1)
  const id = await activeTab()
  await expect(tabEl(id)).toHaveAttribute('data-preview', 'true')
  expect(await titleStyle(id)).toBe('italic')

  await page.keyboard.press('Escape')
  await humanDoubleClick(page, node)
  await expect(page.getByTestId('name-prompt')).toBeVisible()
  await expect(page.getByTestId('name-input')).toHaveValue('notes.txt')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('name-prompt')).toHaveCount(0)
})

test('a double click on a Git panel row does not pin: the tab stays the preview, the next click replaces it', async () => {
  await openAlphaGit()
  await resetTabs(page, ALPHA)
  const squash = git(fx.alpha, 'log', '--format=%h', '-n', '1', '--grep', 'T-198').trim().slice(0, 7)
  const merge = git(fx.alpha, 'log', '--format=%h', '-n', '1', '--merges').trim().slice(0, 7)
  await humanDoubleClick(page, page.getByTestId(`git-commit-${squash}`))
  await expect(vis('[data-testid="commit-pane"]')).toBeVisible()
  const id = await activeTab()
  await expect(tabEl(id)).toHaveAttribute('data-preview', 'true')
  expect(await tabsOf(page, ALPHA)).toHaveLength(1)

  await page.getByTestId(`git-commit-${merge}`).click()
  await expect.poll(async () => (await tabsOf(page, ALPHA)).map((t) => t.kind)).toEqual(['commit'])
  await expect.poll(() => vis('[data-testid="commit-pane"]').getAttribute('data-hash').then((h) => h?.slice(0, 7))).toBe(merge)
  await expect(tabEl(await activeTab())).toHaveAttribute('data-preview', 'true')
})

test('a commit-tab file row: the double click\'s second press lands in the comparison it opened and is dropped', async () => {
  const commitId = await activeTab()
  await expect(tabEl(commitId)).toHaveAttribute('data-preview', 'true')
  const fileRow = vis('[data-testid="commit-pane"]').getByTestId('commit-file-terminal.md')
  await expect(fileRow).toBeVisible()
  await humanDoubleClick(page, fileRow)
  await expect(compare()).toBeVisible()
  const compareId = await activeTab()
  expect(compareId).not.toBe(commitId)
  // The first press used the commit tab (it stays); the comparison is the new preview, unused.
  await expect(tabEl(commitId)).not.toHaveAttribute('data-preview', 'true')
  await expect(tabEl(compareId)).toHaveAttribute('data-preview', 'true')
  await expect.poll(() => previewId()).toBe(compareId)
  const sel = await selectionInCompare()
  expect(sel.text).toBe('')
  expect(sel.drawn).toBe(0)
  expect(sel.focusedInside).toBe(false)
  // A later, deliberate click into the pane is a normal click (click count 1): it keeps the tab.
  await compare().locator('.cm-merge-b .cm-content').click()
  await expect(tabEl(compareId)).not.toHaveAttribute('data-preview', 'true')
})

test('Document history: the second press does not land in the editable "Now" side it opened', async () => {
  await openAlphaGit()
  await resetTabs(page, ALPHA)
  await page.evaluate((p) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, 'Projects/alpha/docs/BACKLOG.md', { mode: 'raw' }), ALPHA)
  await vis('[data-testid="doc-history-toggle"]').click()
  const panel = vis('[data-testid="doc-history"]')
  const commitRow = panel.locator('[data-testid^="history-row-"][data-kind="commit"]').first()
  await expect(commitRow).toBeVisible()
  // The row sits where the comparison's editable right side will be.
  await humanDoubleClick(page, commitRow)
  await expect(compare()).toBeVisible()
  await expect(compare().locator('.cm-merge-b .cm-content')).toHaveAttribute('contenteditable', 'true')
  const sel = await selectionInCompare()
  expect(sel.text).toBe('')
  expect(sel.drawn).toBe(0)
  expect(sel.focusedInside).toBe(false)
  expect((await tabsOf(page, ALPHA)).find((t) => t.kind === 'doc')?.dirty).toBeFalsy()
})

test('right-click ▸ Open in a new tab, and Enter, open tabs that stay; the commit file menu leads with it', async () => {
  await openAlphaGit()
  await resetTabs(page, ALPHA)
  const row = page.getByTestId(`git-change-${BACKLOG}`)
  await row.click({ button: 'right' })
  const menu = page.getByTestId('git-row-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in a new tab'])
  await shot('03-row-menu-open-in-new-tab')
  await menu.getByTestId('row-menu-open-new-tab').click()
  await expect(menu).toHaveCount(0)
  await expect(compare()).toBeVisible()
  const kept = await activeTab()
  await expect(tabEl(kept)).not.toHaveAttribute('data-preview', 'true')
  expect(await previewId()).toBeUndefined()
  expect(await tabsOf(page, ALPHA)).toHaveLength(1)

  // A History row: Enter opens a tab that stays, next to the one the menu opened.
  const squash = git(fx.alpha, 'log', '--format=%h', '-n', '1', '--grep', 'T-198').trim().slice(0, 7)
  await page.getByTestId(`git-commit-${squash}`).focus()
  await page.keyboard.press('Enter')
  await expect(vis('[data-testid="commit-pane"]')).toBeVisible()
  const commitId = await activeTab()
  await expect(tabEl(commitId)).not.toHaveAttribute('data-preview', 'true')
  expect(await tabsOf(page, ALPHA)).toHaveLength(2)

  // The commit tab's file menu: Open in a new tab first, then the version itself.
  await vis('[data-testid="commit-pane"]').getByTestId('commit-file-docs/BACKLOG.md').click({ button: 'right' })
  const fileMenu = page.getByTestId('commit-file-menu')
  await expect(fileMenu).toBeVisible()
  await expect(fileMenu.getByRole('menuitem')).toHaveText(['Open in a new tab', 'Open this version in a tab'])
  await shot('04-commit-file-menu')
  await fileMenu.getByTestId('row-menu-open-new-tab').click()
  await expect(compare()).toBeVisible()
  await expect(tabEl(await activeTab())).not.toHaveAttribute('data-preview', 'true')
  expect(await tabsOf(page, ALPHA)).toHaveLength(3)

  // A History row's own menu.
  await page.getByTestId(`git-commit-${squash}`).click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in a new tab'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})
