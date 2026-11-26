// modules: git, editor
// Pomade E-044 e2e — local history: a snapshot each time a project text file's content changes on
// disk (another writer) or is saved in Pomade, kept in the workspace's dev store, shown in Document history
// interleaved with the commits by time, comparable and restorable like any row.
// Fixture: Projects/alpha is a repo (docs/ticket.md committed; .gitignore lists ignored.md and
// ignored-dir/); Projects/beta is no repo. The debounce is shrunk (POMADE_TEST_LOCAL_HISTORY_*).
// Set POMADE_E044_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage, relaunchApp } from './fixtures/app'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { tabsOf, waitCaretRegistered } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.POMADE_E044_SHOTS
const ALPHA = 'proj-alpha'
const BETA = 'proj-beta'
const TICKET = 'Projects/alpha/docs/ticket.md'
const BETA_README = 'Projects/beta/README.md'

const MID = 'Middle one stays.\n\nMiddle two stays.\n\nMiddle three stays.\n\nMiddle four stays.'
const doc = (alpha: string, beta: string, gamma: string): string =>
  `# Ticket\n\n${alpha}\n\n${MID}\n\n${beta}\n\n${MID}\n\n${gamma}\n`
const V0 = doc('Alpha paragraph.', 'Beta paragraph.', 'Gamma paragraph.')
const V1 = doc("Alpha paragraph, eleven o'clock wording.", 'Beta paragraph.', 'Gamma paragraph.')
const V2 = doc("Alpha paragraph, eleven o'clock wording.", 'Beta paragraph, noon.', 'Gamma paragraph.')
const V3 = doc('Alpha paragraph, rewritten by an agent.', 'Beta paragraph, noon.', 'Gamma paragraph, rewritten.')

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
const compare = (): ReturnType<Page['locator']> => vis('[data-testid="compare-pane"]')
const editor = (path: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="editor-pane"][data-doc-path="${path}"]`)

const list = (path: string): Promise<{ id: string; at: number; origin: string; size: number }[]> =>
  page.evaluate((p) => window.pomade.localHistory.list(p), path)
const readSnap = (path: string, id: string): Promise<string | null> =>
  page.evaluate(([p, i]) => window.pomade.localHistory.read(p, i), [path, id])
const count = async (path: string): Promise<number> => (await list(path)).length
/** The snapshots' contents, oldest first. */
async function contents(path: string): Promise<(string | null)[]> {
  const snaps = (await list(path)).reverse()
  return Promise.all(snaps.map((s) => readSnap(path, s.id)))
}

async function rowKinds(): Promise<string[]> {
  return panel().locator('[data-testid^="history-row-"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind ?? ''))
}
const snapshotRows = (): ReturnType<Page['locator']> => panel().locator('[data-testid^="history-row-"][data-kind="snapshot"]')

const rawText = async (path: string): Promise<string> =>
  (await editor(path).locator('[data-testid="raw-editor"] .cm-content').evaluate((el) =>
    [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n')
  )).replace(/\n+$/, '')

const sideText = (side: 'a' | 'b'): Promise<string> =>
  compare()
    .locator(`.cm-merge-${side} .cm-content`)
    .evaluate((el) => [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n'))
    .then((t) => t.replace(/\n+$/, ''))

async function docTab(path: string): Promise<{ id: string; dirty: boolean | undefined } | undefined> {
  const t = (await tabsOf(page, ALPHA)).concat(await tabsOf(page, BETA)).find((x) => x.kind === 'doc' && x.path === path)
  return t && { id: t.id, dirty: t.dirty }
}
const isDirty = async (path: string): Promise<boolean | undefined> => (await docTab(path))?.dirty

async function openDoc(projectId: string, path: string): Promise<string> {
  return page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: projectId, f: path }
  )
}

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  alpha = join(fx.workspaceRoot, 'Projects/alpha')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(alpha, '.gitignore'), 'ignored.md\nignored-dir/\n')
  await write(join(alpha, 'docs/ticket.md'), V0)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'Initial ticket')
  ;({ app, page } = await launchAppPage(fx, ENV))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await selectProject(ALPHA)
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('a file changed on disk at three moments gets three snapshots, kept in the workspace', async () => {
  await fs.writeFile(abs(TICKET), V1)
  await expect.poll(() => count(TICKET)).toBe(1)
  await fs.writeFile(abs(TICKET), V2)
  await expect.poll(() => count(TICKET)).toBe(2)
  // A commit between the second and third change: the History list interleaves it by time. Git
  // dates have a one-second resolution, so the commit sits a full second clear of both snapshots.
  await sleep(1300)
  git(alpha, 'add', '-A')
  commitAt(alpha, new Date().toISOString(), '-m', 'Noon wording')
  await sleep(1300)
  await fs.writeFile(abs(TICKET), V3)
  await expect.poll(() => count(TICKET)).toBe(3)
  expect(await contents(TICKET)).toEqual([V1, V2, V3])
  expect((await list(TICKET)).map((s) => s.origin)).toEqual(['disk', 'disk', 'disk'])
  // In the workspace — the dev build's store, nothing in user data.
  const files = await fs.readdir(join(fx.workspaceRoot, 'Apps/Pomade/dev/local-history/paths'))
  expect(files.length).toBeGreaterThanOrEqual(1)
})

test('Document history lists the snapshots newest first in their own group, above the commits', async () => {
  await openDoc(ALPHA, TICKET)
  await expect(editor(TICKET).locator('[data-testid="raw-editor"]')).toBeVisible()
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect(panel()).toBeVisible()
  // The saved file first — it stands for the newest change (V3, the disk's text) — then the two
  // earlier changes newest first, then the noon and initial commits.
  await expect.poll(rowKinds).toEqual(['saved', 'snapshot', 'snapshot', 'commit', 'commit'])
  await expect(panel().getByTestId('history-meta-saved')).toHaveText('not committed')
  const rows = snapshotRows()
  await expect(rows).toHaveCount(2)
  for (let i = 0; i < 2; i++) await expect(rows.nth(i)).toContainText(/[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} · changed on disk/)
  await expect(rows.first()).toContainText('local version')
  await expect(panel().locator('[data-testid^="history-row-"][data-kind="commit"]').first()).toContainText('Noon wording')
  await shot('01-history-snapshots')
})

test('comparing the first snapshot with the current document and taking one chunk restores only that chunk', async () => {
  await snapshotRows().last().click()
  await expect(compare()).toHaveAttribute('data-mode', 'version-current')
  await expect(compare().getByTestId('compare-label-left')).toContainText('Changed on disk')
  await expect.poll(() => sideText('a')).toBe(V1.replace(/\n$/, ''))
  await expect.poll(() => sideText('b')).toBe(V3.replace(/\n$/, ''))
  await shot('02-compare-snapshot')
  // Chunks: the Alpha paragraph (first) and the Gamma paragraph. Take the first only.
  await compare().getByTestId('compare-take-old').first().click()
  await expect.poll(() => sideText('b')).toBe(V3.replace('Alpha paragraph, rewritten by an agent.', "Alpha paragraph, eleven o'clock wording.").replace(/\n$/, ''))
  expect(await isDirty(TICKET)).toBe(true)
  expect(await fs.readFile(abs(TICKET), 'utf8')).toBe(V3)

  await page.getByTestId(`tab-${(await docTab(TICKET))!.id}`).click()
  await expect(panel()).toBeVisible()
  await expect.poll(() => rawText(TICKET)).toContain('Gamma paragraph, rewritten.')
  await editor(TICKET).locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => rawText(TICKET)).toBe(V3.replace(/\n$/, ''))
  await expect.poll(() => isDirty(TICKET)).toBe(false)
})

test('a save in Pomade is a snapshot marked "saved in Pomade", and the watcher does not add a second one', async () => {
  await editor(TICKET).locator('.cm-content').click()
  await waitCaretRegistered(page)
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type('\nSaved by hand.\n')
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => isDirty(TICKET)).toBe(false)
  await expect.poll(() => count(TICKET)).toBe(4)
  const snaps = await list(TICKET)
  expect(snaps[0].origin).toBe('saved')
  expect(await readSnap(TICKET, snaps[0].id)).toBe(await fs.readFile(abs(TICKET), 'utf8'))
  // The save is the Saved row; the changes on disk before it stay in Local versions.
  await expect(snapshotRows()).toHaveCount(3)
  await expect(snapshotRows().first()).toContainText('changed on disk')
  // The watcher's own event for that write lands in the same window: still one snapshot for it.
  await sleep(900)
  expect(await count(TICKET)).toBe(4)
  await shot('03-saved-in-pomade')
})

test('gitignored files, node_modules, binaries, empty and oversized files get no snapshots', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1)
  await write(join(alpha, 'ignored.md'), 'ignored by git\n')
  await write(join(alpha, 'ignored-dir/inside.md'), 'inside an ignored folder\n')
  await write(join(alpha, 'node_modules/pkg/readme.md'), 'a dependency doc\n')
  await fs.writeFile(join(alpha, 'nul.txt'), Buffer.from([104, 105, 0, 1, 2, 3, 0, 104]))
  await fs.writeFile(join(alpha, 'pic.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  await write(join(alpha, 'big.md'), big)
  await write(join(alpha, 'empty.md'), '')
  await sleep(500)
  // The positive control, written last: it is processed like the rest.
  await write(join(alpha, 'control.md'), 'control one\n')
  await expect.poll(() => count('Projects/alpha/control.md')).toBe(1)
  await sleep(800)
  for (const p of ['ignored.md', 'ignored-dir/inside.md', 'node_modules/pkg/readme.md', 'nul.txt', 'pic.png', 'big.md', 'empty.md']) {
    expect(await count(`Projects/alpha/${p}`), p).toBe(0)
  }
  // The same content written again is not a new version.
  await write(join(alpha, 'control.md'), 'control one\n')
  await sleep(700)
  expect(await count('Projects/alpha/control.md')).toBe(1)
  await write(join(alpha, 'control.md'), 'control two\n')
  await expect.poll(() => count('Projects/alpha/control.md')).toBe(2)
})

test('a doc outside git: snapshots only, comparable and restorable', async () => {
  await selectProject(BETA)
  await fs.writeFile(abs(BETA_README), '# Beta\n\nFirst change.\n')
  await expect.poll(() => count(BETA_README)).toBe(1)
  await fs.writeFile(abs(BETA_README), '# Beta\n\nSecond change.\n')
  await expect.poll(() => count(BETA_README)).toBe(2)
  await openDoc(BETA, BETA_README)
  await expect(editor(BETA_README).locator('[data-testid="raw-editor"]')).toBeVisible()
  await vis('[data-testid="doc-history-toggle"]').click()
  await expect.poll(rowKinds).toEqual(['saved', 'snapshot'])
  await expect(panel().getByTestId('history-meta-saved')).toHaveText(/^local version · \d+ B$/)
  await expect(panel().getByTestId('history-no-repo')).toBeVisible()
  await shot('04-history-no-repo')

  // Restore the older snapshot: one unsaved edit, Cmd+Z undoes it.
  const older = snapshotRows().last()
  await older.hover()
  await older.getByRole('button', { name: 'Restore' }).click()
  await expect.poll(() => rawText(BETA_README)).toBe('# Beta\n\nFirst change.')
  await expect.poll(() => isDirty(BETA_README)).toBe(true)
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => rawText(BETA_README)).toBe('# Beta\n\nSecond change.')
  await expect.poll(() => isDirty(BETA_README)).toBe(false)
})

test('snapshots older than 7 days are pruned at launch; the size cap prunes oldest first', async () => {
  // Age one of the ticket's snapshots to 8 days ago, directly in the store, and relaunch.
  await app.close()
  const pathsDir = join(fx.workspaceRoot, 'Apps/Pomade/dev/local-history/paths')
  type Rec = { path: string; entries: { at: number; hash: string; size: number; origin: string }[] }
  const readRec = async (path: string): Promise<{ file: string; rec: Rec }> => {
    const found = await Promise.all(
      (await fs.readdir(pathsDir)).map(async (n) => {
        const file = join(pathsDir, n)
        return { file, rec: JSON.parse(await fs.readFile(file, 'utf8')) as Rec }
      })
    )
    return found.filter((f) => f.rec.path === path)[0]
  }
  const { file, rec } = await readRec(TICKET)
  expect(rec.entries).toHaveLength(4)
  rec.entries[0].at = Date.now() - 8 * 24 * 3600 * 1000
  rec.entries[1].at = Date.now() - 6 * 24 * 3600 * 1000
  await fs.writeFile(file, JSON.stringify(rec))
  ;({ app, page } = await launchAppPage(fx, { ...ENV, POMADE_TEST_LOCAL_HISTORY_PRUNE_DELAY_MS: '200' }))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect.poll(() => count(TICKET)).toBe(3)
  const kept = (await list(TICKET)).map((s) => s.at)
  expect(kept.every((t) => Date.now() - t <= 7 * 24 * 3600 * 1000)).toBe(true)
  expect(await readSnap(TICKET, (await list(TICKET))[2].id)).toBe(V2)

  // The cap: relaunch with a cap that holds only a few of the distinct contents. The oldest
  // snapshot (the ticket's second change, aged to 6 days) goes first; the newest one stays.
  const paths = [TICKET, 'Projects/alpha/control.md', BETA_README]
  const all = async (): Promise<{ path: string; id: string; at: number; size: number }[]> =>
    (await Promise.all(paths.map(async (path) => (await list(path)).map((s) => ({ path, ...s }))))).flat()
  const before = await all()
  expect(before).toHaveLength(7)
  const newest = before.reduce((a, b) => (b.at > a.at ? b : a))
  const oldest = before.reduce((a, b) => (b.at < a.at ? b : a))
  expect(oldest.path).toBe(TICKET)
  const total = before.reduce((n, s) => n + s.size, 0)
  const cap = Math.floor(total / 2)
  ;({ app, page } = await relaunchApp(app, fx, {
    ...ENV,
    POMADE_TEST_LOCAL_HISTORY_PRUNE_DELAY_MS: '200',
    POMADE_TEST_LOCAL_HISTORY_CAP_BYTES: String(cap)
  }))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect.poll(async () => (await all()).reduce((n, s) => n + s.size, 0), { timeout: 15_000 }).toBeLessThanOrEqual(cap)
  const after = await all()
  expect(after.length).toBeLessThan(before.length)
  expect(after.some((s) => s.id === oldest.id)).toBe(false)
  expect(after.some((s) => s.id === newest.id)).toBe(true)
  // Oldest first: everything that went is older than everything that stayed.
  const gone = before.filter((b) => !after.some((a) => a.id === b.id && a.path === b.path))
  expect(Math.max(...gone.map((g) => g.at))).toBeLessThan(Math.min(...after.map((a) => a.at)))
})
