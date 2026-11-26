// modules: git, editor, tabs
// Pomade T-226 e2e — an earlier version of a document in its own editable tab. A History row's
// right-click menu (Open this version in a tab / Compare with your document / Restore / Copy hash),
// the version tab (`v.md @ <hash>`, a "Version" chip, the normal editor), its Save: a confirm, then
// the document holds the tab's text and the text it replaced is a local version in History; Cancel
// changes nothing; a document with unsaved edits in its own tab keeps them as a discarded draft. A
// comparison side opens its version too, and a commit's file row has the same "Open this version
// in a tab". A version tab asks before closing with edits and survives a restart.
// Fixture: Projects/alpha is a repo; docs/v.md has two commits and is untouched on disk (so its
// current text is in no local version yet); docs/w.md has one commit and a local version.
// Set POMADE_T226_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage, relaunchApp } from './fixtures/app'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { activeIdOf, tabsOf, waitCaretRegistered, type TabSnap } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.POMADE_T226_SHOTS
const ALPHA = 'proj-alpha'
const V = 'Projects/alpha/docs/v.md'
const W = 'Projects/alpha/docs/w.md'

const C1 = '# V\n\nThe first wording.\n'
const C2 = '# V\n\nThe second wording.\n'
const W1 = '# W\n\nCommitted.\n'
const W2 = '# W\n\nChanged on disk.\n'

const ENV = {
  POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS: '150',
  POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS: '2000'
}

let fx: Fixture
let alpha: string
let app: ElectronApplication
let page: Page
let c1: string
let c2: string

const abs = (rel: string): string => join(fx.workspaceRoot, rel)

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const panel = (): ReturnType<Page['locator']> => vis('[data-testid="doc-history"]')
const row = (id: string): ReturnType<Page['locator']> => panel().getByTestId(`history-row-${id}`)
const menu = (): ReturnType<Page['locator']> => page.getByTestId('history-menu')
const compare = (): ReturnType<Page['locator']> => vis('[data-testid="compare-pane"]')
const docPane = (path: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="editor-pane"][data-doc-path="${path}"]:not([data-version])`)
const versionPane = (path: string, label: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="editor-pane"][data-doc-path="${path}"][data-version="${label}"]`)

const paneText = async (pane: ReturnType<Page['locator']>): Promise<string> =>
  (await pane.locator('[data-testid="raw-editor"] .cm-content').evaluate((el) =>
    [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n')
  )).replace(/\n+$/, '')

const disk = (rel: string): Promise<string> => fs.readFile(abs(rel), 'utf8')

const snapshotTexts = (path: string): Promise<string[]> =>
  page.evaluate(async (p) => {
    const refs = await window.pomade.localHistory.list(p)
    return Promise.all(refs.map(async (r) => (await window.pomade.localHistory.read(p, r.id)) ?? ''))
  }, path)

const draftTexts = (path: string): Promise<string[]> =>
  page.evaluate(async (p) => (await window.pomade.recovery.drafts(p)).map((d) => d.content), path)

const versionTabs = async (): Promise<TabSnap[]> => (await tabsOf(page, ALPHA)).filter((t) => t.kind === 'doc' && !!t.version)

async function openDoc(path: string): Promise<string> {
  const id = await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: ALPHA, f: path }
  )
  await expect(docPane(path).locator('[data-testid="raw-editor"]')).toBeVisible()
  return id
}

async function showHistory(path: string): Promise<void> {
  await openDoc(path)
  if (!(await panel().isVisible())) await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel()).toBeVisible()
}

/** Right-click a row and wait for its menu. */
async function rightClick(id: string): Promise<void> {
  await expect(async () => {
    await row(id).click({ button: 'right', timeout: 2000 })
    await expect(menu()).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
}

const menuItems = (): Promise<string[]> =>
  menu()
    .locator('[role="menuitem"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid ?? ''))

async function typeAtEnd(pane: ReturnType<Page['locator']>, text: string): Promise<void> {
  await pane.locator('.cm-content').click()
  await waitCaretRegistered(page)
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type(text)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  alpha = join(fx.workspaceRoot, 'Projects/alpha')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(alpha, 'docs/v.md'), C1)
  await write(join(alpha, 'docs/w.md'), W1)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'First wording')
  c1 = git(alpha, 'rev-parse', 'HEAD').trim()
  await write(join(alpha, 'docs/v.md'), C2)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-12T09:00:00', '-m', 'Second wording')
  c2 = git(alpha, 'rev-parse', 'HEAD').trim()
  ;({ app, page } = await launchAppPage(fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', ALPHA)
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('a row’s right-click menu: open in a tab, compare, restore, copy hash — per kind', async () => {
  // w.md gets a local version (changed on disk) and an unsaved edit.
  await fs.writeFile(abs(W), W2)
  await expect.poll(async () => (await snapshotTexts(W)).length).toBe(1)
  await showHistory(W)
  await typeAtEnd(docPane(W), '\nUnsaved.\n')

  await rightClick(`commit-${c1.slice(0, 7)}`)
  expect(await menuItems()).toEqual(['history-menu-open-tab', 'history-menu-compare', 'history-menu-restore', 'history-menu-copy-hash'])
  await shot('01-commit-row-menu')
  await page.getByTestId('history-menu-copy-hash').click()
  await expect(menu()).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.pomade.app.clipboardRead())).toBe(c1)

  // The local version holds the disk's text: the Saved row stands for it and opens it in a tab.
  await expect(panel().locator('[data-testid^="history-row-snapshot-"]')).toHaveCount(0)
  await rightClick('saved')
  expect(await menuItems()).toEqual(['history-menu-open-tab', 'history-menu-compare', 'history-menu-restore'])
  await page.keyboard.press('Escape')
  await expect(menu()).toHaveCount(0)
  await expect(panel()).toBeVisible() // Escape closed the menu only

  await rightClick('unsaved')
  expect(await menuItems()).toEqual(['history-menu-compare'])
  // "Compare with the saved file" = the click: a comparison tab.
  await page.getByTestId('history-menu-compare').click()
  await expect(compare()).toBeVisible()
  await expect(compare()).toHaveAttribute('data-path', W)

  // Discard w.md's edits so the next tests start clean.
  await openDoc(W)
  await vis('[data-testid="doc-close"]').click()
  await vis('[data-testid="guard-discard"]').click()
})

test('Open this version in a tab: an editable tab `v.md @ <hash>` in the document’s view', async () => {
  await showHistory(V)
  await rightClick(`commit-${c1.slice(0, 7)}`)
  await page.getByTestId('history-menu-open-tab').click()

  const label = c1.slice(0, 7)
  const pane = versionPane(V, label)
  await expect(pane).toBeVisible()
  await expect(pane.locator('[data-testid="raw-editor"]')).toBeVisible() // the document's view (raw)
  expect(await paneText(pane)).toBe(C1.replace(/\n$/, ''))
  await expect(pane.getByTestId('editor-version')).toHaveText(`Version ${label}`)
  const [vt] = await versionTabs()
  expect(vt.title).toBe(`v.md @ ${label}`)
  expect(vt.path).toBe(V)
  expect(await activeIdOf(page, ALPHA)).toBe(vt.id)
  await expect(page.locator(`[data-testid="tab-${vt.id}"]`)).toContainText(`v.md @ ${label}`)
  // It is not the document's tab: the document still has its own, and opening the doc focuses that.
  const docId = await openDoc(V)
  expect(docId).not.toBe(vt.id)
  // Opening the same version again focuses the open version tab.
  await showHistory(V)
  await rightClick(`commit-${c1.slice(0, 7)}`)
  await page.getByTestId('history-menu-open-tab').click()
  await expect.poll(() => activeIdOf(page, ALPHA)).toBe(vt.id)
  expect(await versionTabs()).toHaveLength(1)
  await expect(pane.locator('[data-testid="doc-save"]')).toHaveText('Save') // replacing needs no edit
  await shot('02-version-tab')
})

test('Save asks first; Cancel changes nothing', async () => {
  const pane = versionPane(V, c1.slice(0, 7))
  await typeAtEnd(pane, '\nEdited in the version tab.')
  await expect(pane.getByTestId('editor-dirty')).toBeVisible()
  await pane.getByTestId('doc-save').click()
  const confirm = vis('[data-testid="replace-version-confirm"]')
  await expect(confirm).toBeVisible()
  await expect(confirm.getByTestId('replace-version-text')).toHaveText(
    'Replace v.md with this version? The current text stays in History.'
  )
  await expect(confirm.getByTestId('replace-version-dirty')).toHaveCount(0)
  await shot('03-replace-confirm')
  await confirm.getByTestId('replace-version-cancel').click()
  await expect(confirm).toHaveCount(0)
  expect(await disk(V)).toBe(C2)
  await expect(pane.getByTestId('editor-dirty')).toBeVisible()
  expect(await snapshotTexts(V)).toEqual([])
})

test('Replace: the document holds the tab’s text, and the replaced text is a local version', async () => {
  const pane = versionPane(V, c1.slice(0, 7))
  const next = `${C1}\nEdited in the version tab.\n`
  await pane.locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+s`)
  const confirm = vis('[data-testid="replace-version-confirm"]')
  await expect(confirm).toBeVisible()
  await confirm.getByTestId('replace-version-ok').click()
  await expect(confirm).toHaveCount(0)

  await expect.poll(() => disk(V)).toBe(next)
  await expect(pane.getByTestId('editor-dirty')).toHaveCount(0)
  await expect(pane.getByTestId('doc-save')).toHaveText('Saved')
  // The text it replaced (never seen by local history before) is kept, and so is the new one.
  await expect.poll(() => snapshotTexts(V)).toEqual([next, C2])
  // The document's own (clean) tab shows the new text.
  await openDoc(V)
  await expect.poll(() => paneText(docPane(V))).toBe(next.replace(/\n+$/, ''))
  await expect(docPane(V).getByTestId('editor-dirty')).toHaveCount(0)
  // History lists the replaced text as a local version; the new text is the Saved row.
  await showHistory(V)
  await expect(panel().getByTestId('history-group-local-count')).toHaveText('1')
  const rows = panel().locator('[data-testid^="history-row-snapshot-"]')
  await rows.first().click()
  await expect(compare()).toBeVisible()
  await expect
    .poll(() =>
      compare()
        .locator('.cm-merge-a .cm-content')
        .evaluate((el) => [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n'))
        .then((t) => t.replace(/\n+$/, ''))
    )
    .toBe(C2.replace(/\n+$/, ''))
  await shot('04-history-after-replace')
})

test('a document with unsaved edits in its tab: the confirm says so, and its edits become a draft', async () => {
  await openDoc(V)
  await typeAtEnd(docPane(V), '\nThe document’s own unsaved line.')
  const docEdits = await paneText(docPane(V))
  await expect(docPane(V).getByTestId('editor-dirty')).toBeVisible()

  const pane = versionPane(V, c1.slice(0, 7))
  const [vt] = await versionTabs()
  await page.locator(`[data-testid="tab-${vt.id}"]`).click()
  await typeAtEnd(pane, ' Again.')
  await pane.getByTestId('doc-save').click()
  const confirm = vis('[data-testid="replace-version-confirm"]')
  await expect(confirm.getByTestId('replace-version-dirty')).toHaveText(
    'v.md has unsaved edits in its tab. They are kept in History as a discarded draft, and the tab shows this version.'
  )
  await shot('05-replace-confirm-dirty-doc')
  await confirm.getByTestId('replace-version-ok').click()

  const next = `${C1}\nEdited in the version tab. Again.`
  await expect.poll(() => disk(V)).toBe(next)
  await expect.poll(async () => (await draftTexts(V)).map((t) => t.replace(/\n+$/, ''))).toContain(docEdits)
  await openDoc(V)
  await expect.poll(() => paneText(docPane(V))).toBe(next)
  await expect(docPane(V).getByTestId('editor-dirty')).toHaveCount(0)
})

test('a comparison side opens its version in a tab; the live side does not offer it', async () => {
  await showHistory(V)
  await row(`commit-${c2.slice(0, 7)}`).click()
  await expect(compare()).toBeVisible()
  await expect(compare().getByTestId('compare-label-left-open')).toBeVisible()
  await expect(compare().getByTestId('compare-label-right-open')).toHaveCount(0)
  await shot('06-compare-open-in-tab')
  await compare().getByTestId('compare-label-left-open').click()
  const pane = versionPane(V, c2.slice(0, 7))
  await expect(pane).toBeVisible()
  expect(await paneText(pane)).toBe(C2.replace(/\n$/, ''))
  expect((await versionTabs()).map((t) => t.title).sort()).toEqual([`v.md @ ${c1.slice(0, 7)}`, `v.md @ ${c2.slice(0, 7)}`].sort())
})

test('a commit’s file row: Open this version in a tab', async () => {
  await openDoc(W) // raw: the version tab opens in the document's view
  await page.evaluate(
    ({ p, repo, hash }) =>
      window.__pomadeStores.useTabsStore
        .getState()
        .openTab({ id: `commit-${hash}`, projectId: p, kind: 'commit', title: 'commit', repo, hash } as never),
    { p: ALPHA, repo: 'Projects/alpha', hash: c1 }
  )
  const file = vis('[data-testid="commit-file-docs/w.md"]')
  await expect(file).toBeVisible()
  await file.click({ button: 'right' })
  await expect(page.getByTestId('commit-file-menu')).toBeVisible()
  await shot('07-commit-file-menu')
  await page.getByTestId('commit-file-menu-open-tab').click()
  const pane = versionPane(W, c1.slice(0, 7))
  await expect(pane).toBeVisible()
  await expect(pane.locator('[data-testid="raw-editor"]')).toBeVisible()
  await expect.poll(() => paneText(pane)).toBe(W1.replace(/\n+$/, ''))
})

test('closing a version tab with edits asks; the tab survives a restart', async () => {
  const pane = versionPane(W, c1.slice(0, 7))
  await typeAtEnd(pane, '\nNot saved.')
  await pane.getByTestId('doc-close').click()
  const guard = vis('[data-testid="close-guard"]')
  await expect(guard).toBeVisible()
  await guard.getByTestId('guard-cancel').click()
  await expect(pane).toBeVisible()

  ;({ app, page } = await relaunchApp(app, fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  const tabs = (await versionTabs()).map((t) => t.title).sort()
  expect(tabs).toEqual([`v.md @ ${c1.slice(0, 7)}`, `v.md @ ${c2.slice(0, 7)}`, `w.md @ ${c1.slice(0, 7)}`].sort())
  const wt = (await versionTabs()).find((t) => t.path === W) as TabSnap
  await page.locator(`[data-testid="tab-${wt.id}"]`).click()
  const restored = versionPane(W, c1.slice(0, 7))
  await expect(restored).toBeVisible()
  // Its unsaved edits came back with it (a recovery copy of its own, not the document's).
  await expect.poll(() => paneText(restored)).toContain('Not saved.')
  await expect(restored.getByTestId('editor-dirty')).toBeVisible()
  expect(await disk(W)).toBe(W2)
  await openDoc(W)
  expect(await paneText(docPane(W))).toBe(W2.replace(/\n+$/, ''))
})
