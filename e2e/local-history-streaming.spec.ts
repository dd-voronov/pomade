// modules: git, core
// Pomade T-274 e2e — local history skips streaming files. A script rewriting files in many bursts:
// an always-listed `.md` keeps every burst, a `.ts` open in the Editor keeps every burst, any other
// `.ts` keeps the first 12 within the hour and none after, a never-listed `.log` keeps none. The two
// extension lists live in Settings ▸ General ▸ Local history, apply at once and persist across a
// restart. Fixture: Projects/beta is no repo (nothing is git-ignored). The debounce is shrunk.
// Set POMADE_T274_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage, relaunchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.POMADE_T274_SHOTS
const BETA = 'proj-beta'
const NOTES = 'Projects/beta/notes.md'
const GEN = 'Projects/beta/src/gen.ts'
const OPEN = 'Projects/beta/src/open.ts'
const LOG = 'Projects/beta/out/server.log'
const BURSTS = 15

const ENV = {
  POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS: '150',
  POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS: '2000'
}

let fx: Fixture
let app: ElectronApplication
let page: Page

const abs = (rel: string): string => join(fx.workspaceRoot, rel)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const count = (path: string): Promise<number> =>
  page.evaluate((p) => window.pomade.localHistory.list(p), path).then((l) => l.length)

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function openSettings(): Promise<void> {
  await page.getByTestId('projects-panel-settings').click()
  await expect(page.getByTestId('settings-general')).toBeVisible()
  await page.getByTestId('settings-local-history').scrollIntoViewIfNeeded()
}

const entries = (prefix: string): Promise<string[]> =>
  page
    .getByTestId(`${prefix}-list`)
    .locator(`[data-testid^="${prefix}-entry-"]`)
    .allTextContents()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  for (const p of [NOTES, GEN, OPEN, LOG]) {
    await fs.mkdir(join(abs(p), '..'), { recursive: true })
    await fs.writeFile(abs(p), 'start\n')
  }
  ;({ app, page } = await launchAppPage(fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${BETA}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('a script rewriting files in 15 bursts: .md and the open .ts keep all, another .ts keeps 12, .log none', async () => {
  const dirsBefore = await app.evaluate(() => globalThis.__pomadeDocWatch?.dirs ?? 0)
  await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: BETA, f: OPEN }
  )
  await expect(page.locator(`[data-testid="editor-pane"][data-doc-path="${OPEN}"]`)).toBeVisible()
  // The renderer has declared the doc open once main watches its folder.
  await expect
    .poll(() => app.evaluate(() => globalThis.__pomadeDocWatch?.dirs ?? 0))
    .toBeGreaterThan(dirsBefore)

  for (let i = 1; i <= BURSTS; i++) {
    for (const p of [NOTES, GEN, OPEN, LOG]) await fs.writeFile(abs(p), `burst ${i}\n`)
    // One burst = one quiet window: wait until it has been kept before the next one starts.
    await expect.poll(() => count(NOTES)).toBe(i)
    await expect.poll(() => count(OPEN)).toBe(i)
    await sleep(250)
  }
  // The later bursts of gen.ts were looked at (same windows as notes.md) and kept nothing.
  await sleep(1000)
  expect(await count(NOTES)).toBe(BURSTS)
  expect(await count(OPEN)).toBe(BURSTS)
  expect(await count(GEN)).toBe(12)
  expect(await count(LOG)).toBe(0)

  // History of gen.ts lists those 12 (its file on disk, burst 15, is the saved row on top).
  await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: BETA, f: GEN }
  )
  const gen = page.locator(`[data-testid="editor-pane"][data-doc-path="${GEN}"]`)
  await expect(gen.locator('[data-testid="raw-editor"]')).toBeVisible()
  await page.locator('[data-testid="doc-history-toggle"]:visible').click()
  const panel = page.locator('[data-testid="doc-history"]:visible')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-testid^="history-row-"][data-kind="snapshot"]')).toHaveCount(12)
  await shot('T-274-history-gen-ts')
})

test('Settings ▸ General ▸ Local history: the two lists, edits apply at once and persist across a restart', async () => {
  await openSettings()
  expect(await entries('lh-always')).toEqual(['.md', '.txt'])
  expect(await entries('lh-never')).toEqual(['.log', '.jsonl', '.ndjson'])
  await shot('T-274-settings-local-history-default')

  // Typed without the dot, in capitals: stored as `.csv`.
  await page.getByTestId('lh-never-add-input').fill('CSV')
  await page.getByTestId('lh-never-add-submit').click()
  await page.getByTestId('lh-always-add-input').fill('.yaml')
  await page.getByTestId('lh-always-add-input').press('Enter')
  await page.getByTestId('lh-always-remove-.txt').click()
  // Not an extension: stays in the input, not added.
  await page.getByTestId('lh-always-add-input').fill('a/b')
  await page.getByTestId('lh-always-add-submit').click()
  await expect(page.getByTestId('lh-always-add-input')).toHaveValue('a/b')
  expect(await entries('lh-always')).toEqual(['.md', '.yaml'])
  expect(await entries('lh-never')).toEqual(['.log', '.jsonl', '.ndjson', '.csv'])
  await shot('T-274-settings-local-history-edited')
  await page.getByTestId('modal-close').click()

  // Without a restart: a .csv now gets no versions; a control file in the same burst does.
  await fs.writeFile(abs('Projects/beta/table.csv'), 'a,b\n1,2\n')
  await fs.writeFile(abs('Projects/beta/control.ts'), 'export const a = 1\n')
  await expect.poll(() => count('Projects/beta/control.ts')).toBe(1)
  await sleep(500)
  expect(await count('Projects/beta/table.csv')).toBe(0)

  ;({ app, page } = await relaunchApp(app, fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await openSettings()
  expect(await entries('lh-always')).toEqual(['.md', '.yaml'])
  expect(await entries('lh-never')).toEqual(['.log', '.jsonl', '.ndjson', '.csv'])

  await page.getByTestId('lh-never-reset').click()
  expect(await entries('lh-never')).toEqual(['.log', '.jsonl', '.ndjson'])
  await page.getByTestId('modal-close').click()
})
