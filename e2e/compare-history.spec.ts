// modules: git, editor, tabs
// Pomade T-224 e2e — Document history inside the comparison tab: each side's label is a version
// chip whose list (the document's History rows) puts a version on that side, in place — the tab's
// title, sides and mode follow, and the list closes after its pick. Picking the other side's
// version swaps the sides; the live document is right-only — disabled in the left list, and the
// left's version cannot swap it there from the right list.
// Fixture: Projects/alpha is a repo; docs/plan.md has two commits, then two disk changes kept as
// local versions (the newer one stands in the Saved row, the older one is a Local versions row).
// Set POMADE_TEST_T224_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { tabsOf } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.POMADE_TEST_T224_SHOTS
const ALPHA = 'proj-alpha'
const PLAN = 'Projects/alpha/docs/plan.md'

const C1 = '# Plan\n\nAlpha paragraph.\n\nBeta paragraph.\n'
const C2 = C1.replace('Beta paragraph.', 'Beta paragraph, reworded.')
const L1 = `${C2}\nGamma paragraph.\n`
const L2 = L1.replace('Alpha paragraph.', 'Alpha paragraph, final.')

const ENV = {
  POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS: '150',
  POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS: '2000'
}

let fx: Fixture
let app: ElectronApplication
let page: Page
let c1: string
let c2: string
let cmpId: string

const trim = (s: string): string => s.replace(/\n+$/, '')

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const compare = (): ReturnType<Page['locator']> => vis('[data-testid="compare-pane"]')
const chip = (side: 'left' | 'right'): ReturnType<Page['locator']> => compare().getByTestId(`compare-chip-${side}`)
const list = (): ReturnType<Page['locator']> => page.getByTestId('compare-versions')
const version = (id: string): ReturnType<Page['locator']> => list().getByTestId(`compare-version-${id}`)
const localVersion = (): ReturnType<Page['locator']> => list().locator('[data-testid^="compare-version-snapshot-"]')

/** The merge view's side text: its lines, trailing empty lines dropped. */
const sideText = (side: 'a' | 'b'): Promise<string> =>
  compare()
    .locator(`.cm-merge-${side} .cm-content`)
    .evaluate((el) => [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n'))
    .then(trim)

const compareTabs = async (): Promise<{ id: string; title: string }[]> =>
  (await tabsOf(page, ALPHA)).filter((t) => t.kind === 'compare').map((t) => ({ id: t.id, title: t.title }))

const snapshotCount = (path: string): Promise<number> =>
  page.evaluate(async (p) => (await window.pomade.localHistory.list(p)).length, path)

/** Open a chip's list; the list re-renders as History loads, so the open is retried. */
async function openList(side: 'left' | 'right'): Promise<void> {
  await chip(side).click()
  await expect(list()).toBeVisible()
  await expect(list().locator('[data-side]')).toHaveAttribute('data-side', side)
  await expect(list().getByText('Loading…')).toHaveCount(0)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  const alpha = join(fx.workspaceRoot, 'Projects/alpha')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(alpha, 'docs/plan.md'), C1)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'Initial plan')
  await write(join(alpha, 'docs/plan.md'), C2)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-12T09:00:00', '-m', 'Reword beta')
  c1 = git(alpha, 'rev-parse', '--short=7', 'HEAD~1').trim()
  c2 = git(alpha, 'rev-parse', '--short=7', 'HEAD').trim()
  ;({ app, page } = await launchAppPage(fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', ALPHA)
  // Two disk changes, each kept as a local version.
  await fs.writeFile(join(alpha, 'docs/plan.md'), L1)
  await expect.poll(() => snapshotCount(PLAN)).toBe(1)
  await fs.writeFile(join(alpha, 'docs/plan.md'), L2)
  await expect.poll(() => snapshotCount(PLAN)).toBe(2)

  // The comparison to work in: the doc's History, the newer commit ↔ the document.
  await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: ALPHA, f: PLAN }
  )
  await vis('[data-testid="doc-history-toggle"]').click()
  // The list re-renders as the local versions land; a click taken just before it is lost.
  await expect(async () => {
    await vis(`[data-testid="history-row-commit-${c2}"]`).click({ timeout: 2000 })
    await expect(compare()).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await expect(compare()).toHaveAttribute('data-mode', 'version-current')
  await expect.poll(() => sideText('a')).toBe(trim(C2))
  cmpId = (await compareTabs())[0].id
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('a commit on the left and a local version on the right, each from its chip; the tab changes in place', async () => {
  await expect(list()).toHaveCount(0)
  await shot('01-closed')

  await openList('left')
  await expect(version(`commit-${c2}`)).toHaveAttribute('data-on', 'true')
  await expect(version('saved').getByTestId('compare-version-mark-saved')).toHaveText('right')
  await shot('02-left-list')
  await version(`commit-${c1}`).click()
  await expect(list()).toHaveCount(0)
  await expect.poll(() => sideText('a')).toBe(trim(C1))
  await expect(compare().getByTestId('compare-label-left')).toContainText(`${c1} · Oct 10`)
  await expect(compare()).toHaveAttribute('data-mode', 'version-current')

  await openList('right')
  await expect(version('saved')).toHaveAttribute('data-on', 'true')
  await expect(localVersion()).toHaveCount(1)
  await shot('03-right-list')
  await localVersion().click()
  await expect(list()).toHaveCount(0)
  await expect.poll(() => sideText('b')).toBe(trim(L1))
  await expect.poll(() => sideText('a')).toBe(trim(C1))
  // A fixed version on the right: version ↔ version, nothing to save.
  await expect(compare()).toHaveAttribute('data-mode', 'version-version')
  await expect(compare().getByTestId('compare-save')).toHaveCount(0)
  await expect(compare().getByTestId('compare-take-old')).toHaveCount(0)
  // In place: the same tab, its title follows.
  const tabs = await compareTabs()
  expect(tabs.map((t) => t.id)).toEqual([cmpId])
  expect(tabs[0].title).toMatch(/^plan\.md · Oct 10 ↔ \w{3} \d+ \d\d:\d\d$/)
  await shot('04-after-picks')
})

test('picking the other side’s version swaps the sides', async () => {
  await openList('right')
  await expect(version(`commit-${c1}`).getByTestId(`compare-version-mark-commit-${c1}`)).toHaveText('left')
  await version(`commit-${c1}`).click()
  await expect(list()).toHaveCount(0)
  await expect.poll(() => sideText('a')).toBe(trim(L1))
  await expect.poll(() => sideText('b')).toBe(trim(C1))
  await expect(compare()).toHaveAttribute('data-mode', 'version-version')
})

test('the live document is right-only: disabled in the left list, and no swap moves it left', async () => {
  // The Saved row is what the editor holds: on the right it is the live document.
  await openList('right')
  await version('saved').click()
  await expect(list()).toHaveCount(0)
  await expect(compare()).toHaveAttribute('data-mode', 'version-current')
  await expect.poll(() => sideText('b')).toBe(trim(L2))
  await expect(compare().getByTestId('compare-save')).toBeVisible()

  await openList('left')
  await expect(version('saved')).toHaveAttribute('aria-disabled', 'true')
  await version('saved').hover()
  await expect(page.getByText('Your document can only be on the right')).toBeVisible()
  await shot('05-left-list-live-disabled')
  // A disabled option (Playwright will not click one): the click reaches it and does nothing.
  await version('saved').dispatchEvent('click')
  await expect(list()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list()).toHaveCount(0)
  await expect.poll(() => sideText('a')).toBe(trim(L1))

  // The left's version picked on the right would put the document on the left.
  await openList('right')
  await expect(localVersion()).toHaveAttribute('aria-disabled', 'true')
  await localVersion().dispatchEvent('click')
  await expect(list()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list()).toHaveCount(0)
  await expect.poll(() => sideText('a')).toBe(trim(L1))
  await expect(compare()).toHaveAttribute('data-mode', 'version-current')
})
