// modules: git, editor
// Pomade T-223 e2e — Document history groups its rows under small foldable sub-headers: Current
// (unsaved edits, the saved file), Discarded, Local versions, Commits — each with its count, empty
// groups hidden. A fold is one choice for every document, remembered across restarts (a fold saved
// under the old name `changes` folds Current). Two ticked rows in different groups compare
// older-left by when each version was made.
// T-266: the saved file shows once, as `Saved · <time>` — it takes the place of the newest local
// version holding its text — and the row the editor holds carries the `current` mark.
// Fixture: Projects/alpha is a repo; docs/g.md has two commits, the newer one dated in the future
// (so it is newer than every local version); docs/other.md has one commit and nothing else.
// Set POMADE_T223_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage, relaunchApp } from './fixtures/app'
import { expectNotTruncated } from './fixtures/history'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { tabsOf, waitCaretRegistered } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { readViewState } from './fixtures/settings'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.POMADE_T223_SHOTS
const ALPHA = 'proj-alpha'
const DOC = 'Projects/alpha/docs/g.md'
const OTHER = 'Projects/alpha/docs/other.md'

const C1 = '# G\n\nFirst commit.\n'
const C2 = '# G\n\nFuture commit.\n'
const L1 = '# G\n\nLocal one.\n'
const L2 = '# G\n\nLocal two.\n'

const ENV = {
  POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS: '150',
  POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS: '2000'
}

let fx: Fixture
let alpha: string
let app: ElectronApplication
let page: Page

const abs = (rel: string): string => join(fx.workspaceRoot, rel)

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const panel = (): ReturnType<Page['locator']> => vis('[data-testid="doc-history"]')
const group = (g: string): ReturnType<Page['locator']> => panel().getByTestId(`history-group-${g}`)
const editor = (path: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="editor-pane"][data-doc-path="${path}"]`)
const compare = (): ReturnType<Page['locator']> => vis('[data-testid="compare-pane"]')
const sideText = (side: 'a' | 'b'): Promise<string> =>
  compare()
    .locator(`.cm-merge-${side} .cm-content`)
    .evaluate((el) => [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n'))
    .then((t) => t.replace(/\n+$/, ''))

const snapCount = async (path: string): Promise<number> =>
  (await page.evaluate((p) => window.pomade.localHistory.list(p), path)).length

/** The groups in list order, each with its row kinds (a folded group lists none). */
async function groups(): Promise<[string, string, string[]][]> {
  return panel()
    .locator('[data-testid^="history-group-"][data-testid$="-toggle"]')
    .evaluateAll((heads) =>
      heads.map((h) => {
        const section = h.parentElement as HTMLElement
        const g = (section.dataset.testid ?? '').replace('history-group-', '')
        const count = section.querySelector(`[data-testid="history-group-${g}-count"]`)?.textContent ?? ''
        const kinds = [...section.querySelectorAll('[data-testid^="history-row-"]')].map((r) => (r as HTMLElement).dataset.kind ?? '')
        return [g, count, kinds] as [string, string, string[]]
      })
    )
}

const folded = async (): Promise<string[]> =>
  ((await readViewState(fx.workspaceRoot)).docHistoryFolded as string[] | undefined) ?? []

async function openDoc(path: string): Promise<void> {
  await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: ALPHA, f: path }
  )
  await expect(editor(path).locator('[data-testid="raw-editor"]')).toBeVisible()
}

async function typeAtEnd(path: string, text: string): Promise<void> {
  await editor(path).locator('.cm-content').click()
  await waitCaretRegistered(page)
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type(text)
}

const docTab = async (path: string): Promise<{ id: string } | undefined> =>
  (await tabsOf(page, ALPHA)).find((t) => t.kind === 'doc' && t.path === path)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  alpha = join(fx.workspaceRoot, 'Projects/alpha')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(alpha, 'docs/g.md'), C1)
  await write(join(alpha, 'docs/other.md'), '# Other\n')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'First commit')
  await write(join(alpha, 'docs/g.md'), C2)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2030-01-01T09:00:00', '-m', 'Future commit')
  ;({ app, page } = await launchAppPage(fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', ALPHA)
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

const mark = (): Promise<string[]> =>
  panel()
    .locator('[data-testid^="history-current-"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid ?? ''))

test('rows sit in groups — Current, Discarded, Local versions, Commits — each with its count', async () => {
  await fs.writeFile(abs(DOC), L1)
  await expect.poll(() => snapCount(DOC)).toBe(1)
  await fs.writeFile(abs(DOC), L2)
  await expect.poll(() => snapCount(DOC)).toBe(2)

  // A discarded draft: edits closed with Don't save.
  await openDoc(DOC)
  await typeAtEnd(DOC, '\nThrown away.\n')
  await vis('[data-testid="doc-close"]').click()
  await vis('[data-testid="guard-discard"]').click()
  await expect.poll(() => docTab(DOC)).toBeUndefined()

  // Saved, not committed: one Saved row, marked current, stands for the disk and the newest local
  // version (L2) — Local versions keeps only L1.
  await openDoc(DOC)
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel()).toBeVisible()
  await expect.poll(groups).toEqual([
    ['current', '1', ['saved']],
    ['discarded', '1', ['draft']],
    ['local', '1', ['snapshot']],
    ['commits', '2', ['commit', 'commit']]
  ])
  await expect(group('current').getByTestId('history-group-current-toggle')).toContainText('Current')
  await expect(panel().getByTestId('history-title-saved')).toHaveText(/^Saved · \w{3} \d{1,2} \d{2}:\d{2}$/)
  await expect(panel().getByTestId('history-meta-saved')).toHaveText('not committed')
  await expectNotTruncated(panel().getByTestId('history-meta-saved'))
  await expect.poll(mark).toEqual(['history-current-saved'])
  await expect(panel().getByTestId('history-current-saved')).toHaveText('current')
  await page.mouse.move(0, 0)
  await shot('00-current-saved')

  // Typing moves the mark to Unsaved edits; the Saved row offers Restore.
  await typeAtEnd(DOC, '\nUnsaved line.\n')
  await expect.poll(groups).toEqual([
    ['current', '2', ['unsaved', 'saved']],
    ['discarded', '1', ['draft']],
    ['local', '1', ['snapshot']],
    ['commits', '2', ['commit', 'commit']]
  ])
  await expect.poll(mark).toEqual(['history-current-unsaved'])
  await panel().getByTestId('history-row-saved').hover()
  await expect(panel().getByTestId('history-restore-saved')).toBeVisible()
  await shot('00-current-dirty')
  await expect(group('local').getByTestId('history-group-local-toggle')).toHaveAttribute('aria-expanded', 'true')
  await shot('01-groups')
})

test('a group folds and unfolds from its header; the fold is saved', async () => {
  await group('local').getByTestId('history-group-local-toggle').click()
  await expect.poll(groups).toEqual([
    ['current', '2', ['unsaved', 'saved']],
    ['discarded', '1', ['draft']],
    ['local', '1', []],
    ['commits', '2', ['commit', 'commit']]
  ])
  await expect(group('local').getByTestId('history-group-local-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(folded).toEqual(['local'])
  await page.mouse.move(0, 0)
  // The chevron's turn (and the hover fade) has finished before the review screenshot.
  await expect.poll(() => group('local').evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0)
  await shot('02-groups-local-folded')
})

test('two ticked rows in different groups compare by time: the older version on the left', async () => {
  await group('local').getByTestId('history-group-local-toggle').click()
  await expect.poll(folded).toEqual([])
  // The local version (L1) is above the commits in the list, but older than the future commit.
  const older = group('local').locator('[data-testid^="history-row-"]').last()
  await older.click({ modifiers: [MOD] })
  const future = group('commits').locator('[data-testid^="history-row-"]').first()
  await future.click({ modifiers: [MOD] })
  await expect(panel().getByTestId('history-pick-bar')).toBeVisible()
  await panel().getByTestId('history-compare-picked').click()
  await expect.poll(() => sideText('a')).toBe(L1.replace(/\n$/, ''))
  await expect.poll(() => sideText('b')).toBe(C2.replace(/\n$/, ''))
})

test('the fold is remembered across a restart, for every document; a saved `changes` fold folds Current', async () => {
  await page.getByTestId(`tab-${(await docTab(DOC))!.id}`).click()
  await group('commits').getByTestId('history-group-commits-toggle').click()
  await expect.poll(folded).toEqual(['commits'])
  // A fold saved before the group was renamed.
  await page.evaluate(() => window.pomade.app.setSettings({ docHistoryFolded: ['changes', 'commits'] }))
  await expect.poll(folded).toEqual(['changes', 'commits'])
  await editor(DOC).locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(async () => (await tabsOf(page, ALPHA)).find((t) => t.path === DOC)?.dirty).toBe(false)

  ;({ app, page } = await relaunchApp(app, fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  await openDoc(OTHER)
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel()).toBeVisible()
  // docs/other.md is the same as its one commit: the Saved row says so; both groups folded as left.
  await expect.poll(groups).toEqual([
    ['current', '1', []],
    ['commits', '1', []]
  ])
  await group('current').getByTestId('history-group-current-toggle').click()
  await expect.poll(groups).toEqual([
    ['current', '1', ['saved']],
    ['commits', '1', []]
  ])
  await expect.poll(folded).toEqual(['commits'])
  const head = git(alpha, 'log', '-1', '--format=%H', '--', 'docs/other.md').trim().slice(0, 7)
  await expect(panel().getByTestId('history-meta-saved')).toHaveText(`same as ${head}`)
  await expectNotTruncated(panel().getByTestId('history-meta-saved'))
  await expect.poll(mark).toEqual(['history-current-saved'])
  await page.mouse.move(0, 0)
  await shot('03-current-committed')
  await group('commits').getByTestId('history-group-commits-toggle').click()
  await expect.poll(groups).toEqual([
    ['current', '1', ['saved']],
    ['commits', '1', ['commit']]
  ])
  await expect.poll(folded).toEqual([])
})
