// modules: git, editor, filetree
// Pomade T-219 / T-230 e2e — a rename shows as a rename in Document history. Local history follows
// the file to its new name; the rename itself is one snapshot row "… · renamed from T-2.md" (or
// "moved from …" across folders) — "same text — only the name changed" when it holds what the
// version below it held. Every row opens what it says, even when its text is the document's. A
// version kept under the old name is labelled and opened under that name, and its Restore renames
// the document back (after a confirm; refused while another file holds the old name). A rename made
// outside Pomade (a terminal `mv`) is recognized when the old path's newest local version is
// exactly what arrived.
// Fixture: Projects/alpha is a repo with docs/T-2.md, docs/plain.md and docs/R-1.md committed.
// Set POMADE_T219_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { tabsOf, waitCaretRegistered } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.POMADE_T219_SHOTS
const ALPHA = 'proj-alpha'
const DOCS = 'Projects/alpha/docs'
const T2 = `${DOCS}/T-2.md`
const T3 = `${DOCS}/T-3.md`
const MOVED = `${DOCS}/archive/T-3.md`
const T4 = `${DOCS}/archive/T-4.md`
const PLAIN = `${DOCS}/plain.md`
const PLAIN2 = `${DOCS}/plain-renamed.md`
const R1 = `${DOCS}/R-1.md`
const R2 = `${DOCS}/R-2.md`

const ENV = {
  POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS: '150',
  POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS: '2000'
}

let fx: Fixture
let alpha: string
let app: ElectronApplication
let page: Page

const abs = (rel: string): string => join(fx.workspaceRoot, rel)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const panel = (): ReturnType<Page['locator']> => vis('[data-testid="doc-history"]')
const editor = (path: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="editor-pane"][data-doc-path="${path}"]`)
const snapshotRows = (): ReturnType<Page['locator']> => panel().locator('[data-testid^="history-row-"][data-kind="snapshot"]')
const meta = (row: ReturnType<Page['locator']>): ReturnType<Page['locator']> => row.locator('[data-testid^="history-meta-"]')
const toast = (text: string): ReturnType<Page['locator']> => page.getByTestId('toast').filter({ hasText: text }).last()
const SAME_TEXT_TOAST = 'Same text as your document'
const cmpPane = (): ReturnType<Page['locator']> => vis('[data-testid="compare-pane"]')

async function rowMenu(row: ReturnType<Page['locator']>, item: string): Promise<void> {
  await row.click({ button: 'right' })
  await page.getByTestId(item).click()
}

/** A click on the row opens a comparison tab of its version and the document; back to the doc. */
async function expectComparison(docPath: string, leftLabel: string | RegExp): Promise<void> {
  await expect(cmpPane()).toHaveAttribute('data-mode', 'version-current')
  await expect(cmpPane().getByTestId('compare-label-left')).toContainText(leftLabel)
  await page.getByTestId(`tab-${(await docTab(docPath))!.id}`).click()
  await expect(panel()).toBeVisible()
}

type Snap = { id: string; at: number; origin: string; from?: string }
const list = (path: string): Promise<Snap[]> => page.evaluate((p) => window.pomade.localHistory.list(p), path)
const shape = async (path: string): Promise<[string, string | null][]> =>
  (await list(path)).map((s) => [s.origin, s.from ?? null])

const compareTabs = async (): Promise<number> => (await tabsOf(page, ALPHA)).filter((t) => t.kind === 'compare').length
const docTab = async (path: string): Promise<{ id: string; dirty?: boolean } | undefined> =>
  (await tabsOf(page, ALPHA)).find((t) => t.kind === 'doc' && t.path === path && !t.version)
const versionTitles = async (): Promise<string[]> =>
  (await tabsOf(page, ALPHA)).filter((t) => t.kind === 'doc' && !!t.version).map((t) => t.title)

async function openDoc(path: string): Promise<void> {
  await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: ALPHA, f: path }
  )
  await expect(editor(path).locator('[data-testid="raw-editor"]')).toBeVisible()
}

async function renameInTree(path: string, name: string): Promise<void> {
  await page.getByTestId(`tree-node-${path}`).click({ button: 'right' })
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('name-input').fill(name)
  await page.getByTestId('name-submit').click()
}

async function saveTyped(path: string, text: string): Promise<void> {
  await editor(path).locator('.cm-content').click()
  await waitCaretRegistered(page)
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type(text)
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(async () => (await docTab(path))?.dirty).toBe(false)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  alpha = join(fx.workspaceRoot, 'Projects/alpha')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(alpha, 'docs/T-2.md'), '# T-2\n\nFirst wording.\n')
  await write(join(alpha, 'docs/plain.md'), '# Plain\n\nNever changed.\n')
  await write(join(alpha, 'docs/R-1.md'), '# R\n')
  await fs.mkdir(join(alpha, 'docs/archive'), { recursive: true })
  await write(join(alpha, 'docs/archive/.keep'), '')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'Add tickets')
  ;({ app, page } = await launchAppPage(fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', ALPHA)
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('a rename in the tree carries the local versions and adds one "renamed from" row', async () => {
  await openDoc(T2)
  await saveTyped(T2, '\nSaved before the rename.\n')
  await expect.poll(() => shape(T2)).toEqual([['saved', null]])
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel()).toBeVisible()

  await page.getByTestId(`tree-node-${DOCS}`).click()
  await renameInTree(T2, 'T-3.md')
  await expect(editor(T3)).toBeVisible()
  await expect.poll(() => shape(T3)).toEqual([
    ['renamed', T2],
    ['saved', null]
  ])
  expect(await list(T2)).toEqual([])
  // The watcher's own events for the rename add nothing more.
  await sleep(900)
  expect(await list(T3)).toHaveLength(2)

  await expect(snapshotRows()).toHaveCount(2)
  const rename = snapshotRows().first()
  await expect(rename).toHaveAttribute('data-origin', 'renamed')
  await expect(rename).toContainText(/[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} · renamed from T-2\.md/)
  await expect(meta(rename)).toHaveText('same text — only the name changed')
  await expect(snapshotRows().nth(1)).toContainText('saved in Pomade')
  await shot('01-rename-row')
})

test('the rename row opens a comparison even with the same text as the document — click and Compare', async () => {
  const before = await compareTabs()
  await snapshotRows().first().click()
  await expectComparison(T3, 'Renamed from T-2.md')
  expect(await compareTabs()).toBe(before + 1)
  await rowMenu(snapshotRows().first(), 'history-menu-compare')
  await expectComparison(T3, 'Renamed from T-2.md')
  await expect(page.getByTestId('toast').filter({ hasText: SAME_TEXT_TOAST })).toHaveCount(0)
  await shot('02-rename-same-text-compares')
})

test('a version from before the rename is labelled and opened under the old name', async () => {
  const older = snapshotRows().nth(1)
  await expect(meta(older)).toContainText('· as T-2.md')
  await older.click()
  await expectComparison(T3, /^T-2\.md · Saved in Pomade · /)
  await rowMenu(older, 'history-menu-open-tab')
  await expect.poll(versionTitles).toEqual([expect.stringMatching(/^T-2\.md @ [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/)])
  await page.getByTestId(`tab-${(await docTab(T3))!.id}`).click()
  await rowMenu(snapshotRows().first(), 'history-menu-open-tab')
  await expect.poll(async () => (await versionTitles()).length).toBe(2)
  expect((await versionTitles()).every((t) => t.startsWith('T-2.md @ '))).toBe(true)
  await shot('03-version-tab-old-name')
  for (const t of (await tabsOf(page, ALPHA)).filter((x) => x.kind === 'doc' && !!x.version)) {
    await page.evaluate(({ p, id }) => window.__pomadeStores.useTabsStore.getState().closeTab(p, id), { p: ALPHA, id: t.id })
  }
  await page.getByTestId(`tab-${(await docTab(T3))!.id}`).click()
  await expect(panel()).toBeVisible()
})

test('after an edit the rename row compares with the edited document', async () => {
  await saveTyped(T3, '\nWritten after the rename.\n')
  // The save's own version is the Saved row (T-266): the rename row tops Local versions.
  await expect(panel().getByTestId('history-meta-saved')).toBeVisible()
  await expect.poll(async () => (await list(T3)).length).toBe(3)
  await expect(snapshotRows()).toHaveCount(2)
  await expect(snapshotRows().first()).toHaveAttribute('data-origin', 'renamed')
  await snapshotRows().first().click()
  await expectComparison(T3, 'Renamed from T-2.md')
  await rowMenu(snapshotRows().first(), 'history-menu-compare')
  await expectComparison(T3, 'Renamed from T-2.md')
  await expect(page.getByTestId('toast').filter({ hasText: SAME_TEXT_TOAST })).toHaveCount(0)
})

test('a move into another folder reads "moved from"', async () => {
  await page.getByTestId(`tree-node-${T3}`).click({ button: 'right' })
  await page.getByTestId('menu-cut').click()
  await page.getByTestId(`tree-node-${DOCS}/archive`).click({ button: 'right' })
  await page.getByTestId('menu-paste').click()
  await expect(editor(MOVED)).toBeVisible()
  await expect.poll(() => shape(MOVED)).toEqual([
    ['renamed', T3],
    ['saved', null],
    ['renamed', T2],
    ['saved', null]
  ])
  await expect(snapshotRows().first()).toContainText(`moved from ${DOCS}/`)
  await expect(meta(snapshotRows().first())).toHaveText('same text — only the name changed')
})

test('a rename made in a terminal (mv) is recognized from the old name\'s newest version', async () => {
  await fs.rename(abs(MOVED), abs(T4))
  await expect.poll(() => shape(T4)).toEqual([
    ['renamed', MOVED],
    ['renamed', T3],
    ['saved', null],
    ['renamed', T2],
    ['saved', null]
  ])
  expect(await list(MOVED)).toEqual([])
})

test('a file with no local version yet: the rename keeps its text as the first version under the new name', async () => {
  expect(await list(PLAIN)).toEqual([])
  await renameInTree(PLAIN, 'plain-renamed.md')
  await expect.poll(() => shape(PLAIN2)).toEqual([['renamed', PLAIN]])
  await openDoc(PLAIN2)
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(snapshotRows()).toHaveCount(1)
  await expect(snapshotRows().first()).toContainText('renamed from plain.md')
  await expect(meta(snapshotRows().first())).toContainText('local version ·')
  // Its text is the document's: a click still compares.
  await snapshotRows().first().click()
  await expectComparison(PLAIN2, 'Renamed from plain.md')
  await shot('03b-rename-first-version')
})

test('Restore of a version kept under the old name renames the document back and restores its text', async () => {
  const v1 = '# R\n\nFirst text.\n'
  await openDoc(R1)
  await saveTyped(R1, '\nFirst text.\n')
  expect(await fs.readFile(abs(R1), 'utf8')).toBe(v1)
  await vis('[data-testid="doc-history-toggle"]').click()
  await renameInTree(R1, 'R-2.md')
  await expect(editor(R2)).toBeVisible()
  await expect.poll(() => shape(R2)).toEqual([
    ['renamed', R1],
    ['saved', null]
  ])
  await saveTyped(R2, 'Second text.\n')
  await expect.poll(async () => (await list(R2)).length).toBe(3)
  await expect(snapshotRows()).toHaveCount(2)
  const rename = snapshotRows().first()
  await expect(rename).toHaveAttribute('data-origin', 'renamed')

  // Another file holds the old name: refused, nothing moves. It is empty, so local history never
  // keeps it as a version of R-1.md — on a loaded machine its quiet window could otherwise close
  // before the file is removed, and the restore below would no longer land as a rename.
  await write(abs(R1), '')
  await rowMenu(rename, 'history-menu-restore')
  await expect(toast('Can’t restore under R-1.md — a file with that name is already there.')).toBeVisible()
  await expect(page.getByTestId('restore-under-confirm')).toHaveCount(0)
  expect(await docTab(R2)).toBeTruthy()
  await fs.rm(abs(R1))

  // Cancel leaves everything as it was.
  await rowMenu(rename, 'history-menu-restore')
  await expect(page.getByTestId('restore-under-text')).toHaveText('Restore R-2.md as it was, under its earlier name R-1.md?')
  await shot('04-restore-under-confirm')
  await page.getByTestId('restore-under-cancel').click()
  await expect(page.getByTestId('restore-under-confirm')).toHaveCount(0)
  expect(await docTab(R2)).toBeTruthy()
  await expect(fs.access(abs(R1))).rejects.toThrow()

  await rowMenu(rename, 'history-menu-restore')
  await page.getByTestId('restore-under-ok').click()
  // The tab, the tree and local history follow the rename back; the text is an unsaved edit.
  await expect(editor(R1)).toBeVisible()
  await expect.poll(async () => (await docTab(R1))?.dirty).toBe(true)
  expect(await docTab(R2)).toBeUndefined()
  await expect(page.getByTestId(`tree-node-${R1}`)).toBeVisible()
  await expect(page.getByTestId(`tree-node-${R2}`)).toHaveCount(0)
  await expect(fs.access(abs(R2))).rejects.toThrow()
  await expect(toast('Renamed back to R-1.md')).toBeVisible()
  await expect.poll(() => shape(R1)).toEqual([
    ['renamed', R2],
    ['saved', null],
    ['renamed', R1],
    ['saved', null]
  ])
  expect(await list(R2)).toEqual([])
  await editor(R1).locator('.cm-content').click()
  await waitCaretRegistered(page)
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(async () => (await docTab(R1))?.dirty).toBe(false)
  expect(await fs.readFile(abs(R1), 'utf8')).toBe(v1)
  // The save is the Saved row; the rename back tops Local versions.
  await expect.poll(async () => (await list(R1))[0]?.origin).toBe('saved')
  await expect(snapshotRows().first()).toContainText('renamed from R-2.md')
  await shot('05-restored-under-old-name')
})
