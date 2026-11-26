// modules: git, editor, filetree, tabs
// Pomade E-038 e2e — Document history: the panel docked in a doc pane (unsaved edits, discarded
// drafts, saved-not-committed, the commits that touched the file across a rename), a click → a
// comparison tab with take-old, Restore as one undoable unsaved edit in raw / live / rendered,
// Don't save → draft row → restore, a doc outside any repo, two picked rows → version ↔ version,
// and two tree files → Compare, plus the tree's "Show history" and Cmd+Shift+H.
// Fixture: Projects/alpha is a repo; docs/plan.md has three commits, then is renamed to
// docs/roadmap.md (a plain rename, uncommitted) and edited on disk. Projects/beta is no repo.
// Set POMADE_E038_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { expectNotTruncated } from './fixtures/history'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { activeIdOf, tabsOf, waitCaretRegistered } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.POMADE_E038_SHOTS
const ALPHA = 'proj-alpha'
const BETA = 'proj-beta'
const ROADMAP = 'Projects/alpha/docs/roadmap.md'
const FM = 'Projects/alpha/docs/fm.md'
const BETA_README = 'Projects/beta/README.md'

const V1 = '# Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n\nMiddle one stays.\n\nMiddle two stays.\n\nGamma paragraph.\n'
const V2 = V1.replace('Beta paragraph.', 'Beta paragraph, reworded.')
const V3 = `${V2}\nDelta paragraph.\n`
const SAVED = V3.replace('Gamma paragraph.', 'Gamma paragraph, final.')
const FM1 = '---\ntitle: One\n---\n\nBody one.\n'
const FM2 = '---\ntitle: Two\n---\n\nBody two.\n'

let fx: Fixture
let alpha: string
let app: ElectronApplication
let page: Page
let c1: string
let c2: string
let c3: string

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const panel = (): ReturnType<Page['locator']> => vis('[data-testid="doc-history"]')
const row = (id: string): ReturnType<Page['locator']> => panel().getByTestId(`history-row-${id}`)
const compare = (): ReturnType<Page['locator']> => vis('[data-testid="compare-pane"]')
const editor = (path: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="editor-pane"][data-doc-path="${path}"]`)

// Local-history snapshot rows (E-044) appear on every save; local-history.spec.ts covers them, so
// the kinds checked here leave them out.
async function rowKinds(): Promise<string[]> {
  const kinds = await panel().locator('[data-testid^="history-row-"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind ?? ''))
  return kinds.filter((k) => k !== 'snapshot')
}

/** The merge view's side text: its lines, trailing empty lines dropped. */
const sideText = (side: 'a' | 'b'): Promise<string> =>
  compare()
    .locator(`.cm-merge-${side} .cm-content`)
    .evaluate((el) => [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n'))
    .then((t) => t.replace(/\n+$/, ''))

const rawText = async (path: string): Promise<string> =>
  (await editor(path).locator('[data-testid="raw-editor"] .cm-content').evaluate((el) =>
    [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n')
  )).replace(/\n+$/, '')

async function docTab(path: string): Promise<{ id: string; dirty: boolean | undefined } | undefined> {
  const t = (await tabsOf(page, ALPHA)).concat(await tabsOf(page, BETA)).find((x) => x.kind === 'doc' && x.path === path)
  return t && { id: t.id, dirty: t.dirty }
}
const isDirty = async (path: string): Promise<boolean | undefined> => (await docTab(path))?.dirty

async function openDoc(projectId: string, path: string, mode: 'raw' | 'rendered' | 'live' = 'raw'): Promise<string> {
  return page.evaluate(
    ({ p, f, m }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: m }),
    { p: projectId, f: path, m: mode }
  )
}

async function setMode(projectId: string, tabId: string, mode: 'raw' | 'rendered' | 'live'): Promise<void> {
  await page.evaluate(
    ({ p, t, m }) => window.__pomadeStores.useTabsStore.getState().setDocMeta(p, t, { mode: m }),
    { p: projectId, t: tabId, m: mode }
  )
}

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
}

/** Restore a row: hover it (the button shows on hover), click Restore. */
async function restore(id: string): Promise<void> {
  const button = panel().getByTestId(`history-restore-${id}`)
  // The list re-renders as the save's snapshot row lands; a hover taken just before it is lost.
  await expect(async () => {
    await row(id).hover()
    await button.click({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  alpha = join(fx.workspaceRoot, 'Projects/alpha')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(alpha, 'docs/plan.md'), V1)
  await write(join(alpha, 'docs/fm.md'), FM1)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'Initial plan')
  await write(join(alpha, 'docs/plan.md'), V2)
  await write(join(alpha, 'docs/fm.md'), FM2)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-11T09:00:00', '-m', 'Reword beta')
  await write(join(alpha, 'docs/plan.md'), V3)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-12T09:00:00', '-m', 'Add delta')
  // A plain rename (what the tree's Rename does), not `git mv`: git sees a deletion and a new file.
  await fs.rename(join(alpha, 'docs/plan.md'), join(alpha, 'docs/roadmap.md'))
  await write(join(alpha, 'docs/roadmap.md'), SAVED)
  await write(join(alpha, 'docs/ver-15-july.md'), 'Version A\n\nfifteen\n')
  await write(join(alpha, 'docs/ver-18-july.md'), 'Version A\n\neighteen\n')
  const short = (rev: string): string => git(alpha, 'rev-parse', '--short=7', rev).trim()
  c3 = short('HEAD')
  c2 = short('HEAD~1')
  c1 = short('HEAD~2')
  ;({ app, page } = await launchAppPage(fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await selectProject(ALPHA)
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('History lists unsaved, saved-not-committed and every commit across the rename', async () => {
  await openDoc(ALPHA, ROADMAP)
  await expect(editor(ROADMAP).locator('[data-testid="raw-editor"]')).toBeVisible()
  // Clean: no Unsaved row yet.
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel()).toBeVisible()
  await expect(panel().getByTestId('history-show-all')).toBeVisible()
  await expect.poll(rowKinds).toEqual(['saved', 'commit', 'commit', 'commit'])
  await shot('01-history-clean')

  // Typing makes the Unsaved row appear on top.
  await editor(ROADMAP).locator('.cm-content').click()
  await waitCaretRegistered(page)
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type('\nEpsilon paragraph.\n')
  await expect.poll(rowKinds).toEqual(['unsaved', 'saved', 'commit', 'commit', 'commit'])
  await expect(row('unsaved')).toContainText('Unsaved edits')
  await expect(row('saved')).toContainText('Saved · ')
  await expect(row('saved')).toContainText('renamed from plan.md · not committed')
  await expectNotTruncated(panel().getByTestId('history-meta-saved'))
  await expect(row('unsaved').getByTestId('history-current-unsaved')).toBeVisible()
  await expect(panel().getByTestId('history-current-saved')).toHaveCount(0)
  await expect(row(`commit-${c3}`)).toContainText('Add delta')
  await expect(row(`commit-${c2}`)).toContainText('Reword beta')
  // The file's first commit is found across the rename.
  await expect(row(`commit-${c1}`)).toContainText('Initial plan')
  await shot('02-history-rows')
})

test('a commit row opens a comparison; take old changes only that chunk, unsaved', async () => {
  const before = await rawText(ROADMAP)
  expect(before).toBe(`${SAVED.replace(/\n$/, '')}\n\nEpsilon paragraph.`)
  await row(`commit-${c1}`).click()
  await expect(compare()).toHaveAttribute('data-mode', 'version-current')
  await expect.poll(() => sideText('a')).toBe(V1.replace(/\n$/, ''))
  await expect.poll(() => sideText('b')).toBe(before)
  await expect(compare().getByTestId('compare-label-left')).toContainText(`${c1} · Oct 10`)
  await expect(compare().getByTestId('compare-take-old').first()).toBeVisible()
  await shot('03-compare-from-history')

  // The first chunk is the Beta paragraph: only it goes back to the old text.
  await compare().getByTestId('compare-take-old').first().click()
  await expect.poll(() => sideText('b')).toBe(before.replace('Beta paragraph, reworded.', 'Beta paragraph.'))
  expect(await isDirty(ROADMAP)).toBe(true)
  expect(await fs.readFile(join(fx.workspaceRoot, ROADMAP), 'utf8')).toBe(SAVED)

  // Back to the doc: the same buffer, panel still there; Cmd+Z there returns to before.
  await page.getByTestId(`tab-${(await docTab(ROADMAP))!.id}`).click()
  await expect(panel()).toBeVisible()
  await expect.poll(() => rawText(ROADMAP)).toBe(before.replace('Beta paragraph, reworded.', 'Beta paragraph.'))
  await editor(ROADMAP).locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => rawText(ROADMAP)).toBe(before)
})

test('Restore puts the whole version in as one unsaved edit; Cmd+Z undoes it — raw, live, rendered', async () => {
  const tab = (await docTab(ROADMAP))!
  // Settle on a clean buffer: save the typing.
  await editor(ROADMAP).locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => isDirty(ROADMAP)).toBe(false)
  const saved = (await fs.readFile(join(fx.workspaceRoot, ROADMAP), 'utf8')).replace(/\n$/, '')
  expect(saved).toBe(`${SAVED.replace(/\n$/, '')}\n\nEpsilon paragraph.`)
  await expect.poll(rowKinds).toEqual(['saved', 'commit', 'commit', 'commit'])

  // Raw.
  await restore(`commit-${c1}`)
  await expect.poll(() => rawText(ROADMAP)).toBe(V1.replace(/\n$/, ''))
  await expect.poll(() => isDirty(ROADMAP)).toBe(true)
  expect(await fs.readFile(join(fx.workspaceRoot, ROADMAP), 'utf8')).toBe(`${saved}\n`)
  await expect.poll(rowKinds).toEqual(['unsaved', 'saved', 'commit', 'commit', 'commit'])
  await shot('04-restored-raw')
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => rawText(ROADMAP)).toBe(saved)
  await expect.poll(() => isDirty(ROADMAP)).toBe(false)

  // Live.
  await setMode(ALPHA, tab.id, 'live')
  await expect(editor(ROADMAP)).toHaveAttribute('data-mode', 'live')
  await restore(`commit-${c2}`)
  await expect(editor(ROADMAP).locator('.cm-content')).toContainText('Beta paragraph, reworded.')
  await expect(editor(ROADMAP).locator('.cm-content')).not.toContainText('Gamma paragraph, final.')
  await expect.poll(() => isDirty(ROADMAP)).toBe(true)
  await page.keyboard.press(`${MOD}+z`)
  await expect(editor(ROADMAP).locator('.cm-content')).toContainText('Gamma paragraph, final.')
  await expect(editor(ROADMAP).locator('.cm-content')).toContainText('Epsilon paragraph.')
  await expect.poll(() => isDirty(ROADMAP)).toBe(false)

  // Rendered.
  await setMode(ALPHA, tab.id, 'rendered')
  await expect(editor(ROADMAP)).toHaveAttribute('data-mode', 'rendered')
  await expect(editor(ROADMAP).locator('[data-testid="rendered-editor"] .ProseMirror')).toContainText('Gamma paragraph, final.')
  await restore(`commit-${c1}`)
  const pm = editor(ROADMAP).locator('[data-testid="rendered-editor"] .ProseMirror')
  await expect(pm).toContainText('Gamma paragraph.')
  await expect(pm).not.toContainText('Gamma paragraph, final.')
  await expect(editor(ROADMAP)).toHaveAttribute('data-mode', 'rendered')
  await expect.poll(() => isDirty(ROADMAP)).toBe(true)
  await shot('05-restored-rendered')
  await page.keyboard.press(`${MOD}+z`)
  await expect(pm).toContainText('Gamma paragraph, final.')
  await expect(pm).toContainText('Epsilon paragraph.')
  await expect.poll(() => isDirty(ROADMAP)).toBe(false)
  await setMode(ALPHA, tab.id, 'raw')
})

test('a restored version whose frontmatter differs goes through raw, so Cmd+Z still undoes it whole', async () => {
  const id = await openDoc(ALPHA, FM, 'rendered')
  await expect(editor(FM)).toHaveAttribute('data-mode', 'rendered')
  await expect(editor(FM).locator('[data-testid="rendered-editor"] .ProseMirror')).toContainText('Body two.')
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel().locator('[data-testid^="history-row-"][data-kind="commit"]')).toHaveCount(2)
  const fmCommits = await panel().locator('[data-testid^="history-row-"][data-kind="commit"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid ?? ''))
  expect(fmCommits).toHaveLength(2)
  await restore(fmCommits[1].replace('history-row-', ''))
  await expect(editor(FM)).toHaveAttribute('data-mode', 'raw')
  await expect.poll(() => rawText(FM)).toBe(FM1.replace(/\n$/, ''))
  await expect.poll(() => isDirty(FM)).toBe(true)
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => rawText(FM)).toBe(FM2.replace(/\n$/, ''))
  await expect.poll(() => isDirty(FM)).toBe(false)
  await page.evaluate(({ p, t }) => window.__pomadeStores.useTabsStore.getState().closeTab(p, t), { p: ALPHA, t: id })
})

test('Show all commits toggles the list source; the file\'s commits stay listed', async () => {
  const id = (await docTab(ROADMAP))!.id
  await page.getByTestId(`tab-${id}`).click()
  const all = panel().getByTestId('history-show-all')
  await expect(all).toHaveAttribute('aria-pressed', 'false')
  await all.click()
  await expect(all).toHaveAttribute('aria-pressed', 'true')
  await expect(panel().locator('[data-testid^="history-row-"][data-kind="commit"]')).toHaveCount(3)
  await all.click()
  await expect(all).toHaveAttribute('aria-pressed', 'false')
  await expect(panel().locator('[data-testid^="history-row-"][data-kind="commit"]')).toHaveCount(3)
  // The API answers a file moved with `git mv` through git's own rename source.
  const staged = await page.evaluate(
    (p) => window.pomade.git.fileLog('Projects/alpha', p, { all: false, skip: 0, via: 'Projects/alpha/docs/plan.md' }),
    ROADMAP
  )
  expect(staged.renamedFrom).toBe('Projects/alpha/docs/plan.md')
  expect(staged.commits.map((c) => c.path)).toEqual(Array(3).fill('Projects/alpha/docs/plan.md'))
})

test('two picked rows open version ↔ version, read-only', async () => {
  const id = (await docTab(ROADMAP))!.id
  await page.getByTestId(`tab-${id}`).click()
  await expect(panel()).toBeVisible()
  await expect(panel().getByTestId('history-hint')).toBeVisible()
  await row(`commit-${c1}`).hover()
  await panel().getByTestId(`history-pick-commit-${c1}`).check()
  await expect(panel().getByTestId('history-compare-picked')).toHaveCount(0)
  await row(`commit-${c3}`).hover()
  await panel().getByTestId(`history-pick-commit-${c3}`).check()
  await shot('06-two-picked')
  await panel().getByTestId('history-compare-picked').click()
  await expect(compare()).toHaveAttribute('data-mode', 'version-version')
  await expect.poll(() => sideText('a')).toBe(V1.replace(/\n$/, ''))
  await expect.poll(() => sideText('b')).toBe(V3.replace(/\n$/, ''))
  await expect(compare().getByTestId('compare-take-old')).toHaveCount(0)
  await expect(compare().locator('.cm-merge-b .cm-content')).toHaveAttribute('contenteditable', 'false')
  await expect.poll(async () => (await tabsOf(page, ALPHA)).map((t) => t.title)).toContain('plan.md · Oct 10 ↔ Oct 12')

  // The saved-not-committed row against HEAD: the last commit ↔ the file on disk.
  await page.getByTestId(`tab-${id}`).click()
  await row('saved').hover()
  await panel().getByTestId('history-pick-saved').check()
  await row(`commit-${c3}`).hover()
  await panel().getByTestId(`history-pick-commit-${c3}`).check()
  await panel().getByTestId('history-compare-picked').click()
  await expect.poll(() => sideText('a')).toBe(V3.replace(/\n$/, ''))
  await expect.poll(() => sideText('b')).toBe(`${SAVED.replace(/\n$/, '')}\n\nEpsilon paragraph.`)
})

test('a doc outside any repo: unsaved edits, the saved file and drafts; Don\'t save keeps a draft that restores', async () => {
  await selectProject(BETA)
  await openDoc(BETA, BETA_README)
  await expect(editor(BETA_README).locator('[data-testid="raw-editor"]')).toBeVisible()
  await editor(BETA_README).locator('.cm-content').click()
  await waitCaretRegistered(page)
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type('\nLost paragraph.\n')
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect.poll(rowKinds).toEqual(['unsaved', 'saved'])
  await expect(panel().getByTestId('history-meta-saved')).toHaveText(/^local version · \d+ B$/)
  await expectNotTruncated(panel().getByTestId('history-meta-saved'))
  await expect(panel().getByTestId('history-no-repo')).toHaveText('Git history appears when this file is in a repository.')
  await expect(panel().getByTestId('history-show-all')).toHaveCount(0)
  await shot('07-history-no-repo')

  // Close with Don't save: the edits become a discarded draft.
  await vis('[data-testid="doc-close"]').click()
  await vis('[data-testid="guard-discard"]').click()
  await expect.poll(() => docTab(BETA_README)).toBeUndefined()

  await openDoc(BETA, BETA_README)
  await expect(editor(BETA_README).locator('[data-testid="raw-editor"]')).toBeVisible()
  await expect.poll(() => rawText(BETA_README)).not.toContain('Lost paragraph.')
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect.poll(rowKinds).toEqual(['saved', 'draft'])
  await expect(panel().locator('[data-testid^="history-row-"][data-kind="draft"]')).toContainText(/Discarded draft · [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}/)
  await expect(panel().getByTestId('history-no-repo')).toBeVisible()
  await shot('08-history-draft')

  const draftId = ((await panel().locator('[data-testid^="history-row-"][data-kind="draft"]').getAttribute('data-testid')) ?? '').replace('history-row-', '')
  await restore(draftId)
  await expect.poll(() => rawText(BETA_README)).toContain('Lost paragraph.')
  await expect.poll(() => isDirty(BETA_README)).toBe(true)
  await expect.poll(rowKinds).toEqual(['unsaved', 'saved', 'draft'])
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => rawText(BETA_README)).not.toContain('Lost paragraph.')
  await expect.poll(() => isDirty(BETA_README)).toBe(false)
})

test('a draft opens a comparison with the current document', async () => {
  const draft = panel().locator('[data-testid^="history-row-"][data-kind="draft"]')
  await draft.click()
  await expect(compare()).toHaveAttribute('data-mode', 'version-current')
  await expect(compare().getByTestId('compare-label-left')).toContainText('Discarded draft')
  await expect.poll(() => sideText('a')).toContain('Lost paragraph.')
  await expect.poll(() => sideText('b')).not.toContain('Lost paragraph.')
})

test('a file in no commit yet: the Saved row says new file · not committed, whole', async () => {
  const newFile = 'Projects/alpha/docs/ver-15-july.md'
  await selectProject(ALPHA)
  await openDoc(ALPHA, newFile)
  await expect(editor(newFile).locator('[data-testid="raw-editor"]')).toBeVisible()
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel()).toBeVisible()
  await expect(panel().getByTestId('history-meta-saved')).toHaveText('new file · not committed')
  await expectNotTruncated(panel().getByTestId('history-meta-saved'))
  await expect(panel()).not.toContainText('Loading')
  await shot('08-history-new-file')
})

test('two selected files → Compare opens the file ↔ file comparison; Show history; Cmd+Shift+H', async () => {
  await selectProject(ALPHA)
  await page.getByTestId('tree-node-Projects/alpha/docs').click()
  const a = page.getByTestId('tree-node-Projects/alpha/docs/ver-15-july.md')
  const b = page.getByTestId('tree-node-Projects/alpha/docs/ver-18-july.md')
  await expect(a).toBeVisible()
  await a.click()
  await b.click({ modifiers: [MOD] })
  await b.click({ button: 'right' })
  await expect(page.getByTestId('menu-compare')).toBeVisible()
  await shot('09-tree-compare-menu')
  await page.getByTestId('menu-compare').click()
  await expect(compare()).toHaveAttribute('data-mode', 'file-file')
  await expect(compare().getByTestId('compare-label-left')).toContainText('ver-15-july.md')
  await expect(compare().getByTestId('compare-label-right')).toContainText('ver-18-july.md')
  await expect.poll(() => sideText('a')).toBe('Version A\n\nfifteen')
  await expect.poll(() => sideText('b')).toBe('Version A\n\neighteen')
  await expect.poll(async () => (await tabsOf(page, ALPHA)).map((t) => t.title)).toContain('ver-15-july.md ↔ ver-18-july.md')
  await shot('10-file-compare')

  // A single file's menu has no Compare, but Show history.
  await a.click()
  await a.click({ button: 'right' })
  await expect(page.getByTestId('menu-compare')).toHaveCount(0)
  await page.getByTestId('menu-show-history').click()
  await expect(editor('Projects/alpha/docs/ver-15-july.md')).toBeVisible()
  await expect(panel()).toBeVisible()

  // The shortcut toggles the panel on the active doc, and opens it from a comparison tab.
  await page.keyboard.press(`${MOD}+Shift+H`)
  await expect(panel()).toHaveCount(0)
  await page.keyboard.press(`${MOD}+Shift+H`)
  await expect(panel()).toBeVisible()
  const cmpId = (await tabsOf(page, ALPHA)).find((t) => t.kind === 'compare' && t.title.startsWith('ver-15'))!.id
  await page.getByTestId(`tab-${cmpId}`).click()
  await page.keyboard.press(`${MOD}+Shift+H`)
  await expect(editor('Projects/alpha/docs/ver-18-july.md')).toBeVisible()
  await expect(panel()).toBeVisible()
  expect(await activeIdOf(page, ALPHA)).toBe((await docTab('Projects/alpha/docs/ver-18-july.md'))!.id)
})
