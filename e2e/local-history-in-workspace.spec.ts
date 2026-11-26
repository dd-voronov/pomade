// modules: git, editor
// Pomade T-314 e2e — local history lives in the workspace: `Apps/Pomade/local-history/` (the stable
// Pomade) or `Apps/Pomade/dev/local-history/` (a dev build), keyed by workspace-relative path.
// Acceptance: the stable Pomade keeps a file's versions in `Apps/Pomade/local-history/` and
// Document history shows them from there, a dev build's store staying absent; a copy of the
// workspace at another path shows the same versions; the store follows a workspace switch; the
// store's own writes reach no tree listener, name-index patch or git-state broadcast (skipped by
// path).
// Set T314_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { blobHash } from '../src/shared/local-history'
import { recoveryFileName } from '../src/shared/recovery'
import { launchAppPage } from './fixtures/app'
import { commitAt, configRepo, git } from './fixtures/git-repos'
import { tempDir } from './fixtures/temp'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.T314_SHOTS
const BETA = 'proj-beta'
const README = 'Projects/beta/README.md'
const STABLE_STORE = 'Apps/Pomade/local-history'
const DEV_STORE = 'Apps/Pomade/dev/local-history'
const FIRST = '# Beta\n\nFirst draft.\n'
const SECOND = '# Beta\n\nSecond draft.\n'
const STABLE = { POMADE_TEST_BUILD_FLAVOR: 'stable' }
const ENV = { POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS: '150', POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS: '2000' }

const fixtures: Fixture[] = []
const extraDirs: string[] = []
let app: ElectronApplication | undefined

async function fixture(): Promise<Fixture> {
  const fx = await createFixtureWorkspace()
  fixtures.push(fx)
  return fx
}

async function start(fx: Fixture, env: Record<string, string> = {}): Promise<Page> {
  const launched = await launchAppPage(fx, { ...ENV, ...env })
  app = launched.app
  await expect(launched.page.getByTestId('app-shell')).toBeVisible()
  return launched.page
}

async function stop(): Promise<void> {
  await app?.close()
  app = undefined
}

test.afterEach(async () => {
  await stop()
  for (const fx of fixtures.splice(0)) await fx.cleanup()
  for (const d of extraDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

const list = (page: Page, path: string): Promise<{ id: string; origin: string }[]> =>
  page.evaluate((p) => window.pomade.localHistory.list(p), path)

async function contents(page: Page, path: string): Promise<(string | null)[]> {
  const snaps = await list(page, path)
  return Promise.all(snaps.map((s) => page.evaluate(([p, i]) => window.pomade.localHistory.read(p, i), [path, s.id])))
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.screenshot({ path: join(SHOTS, `T-314-${name}.png`) })
}

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

/** README's two versions, kept by the running Pomade from two writes on disk. */
async function writeTwoVersions(fx: Fixture, page: Page): Promise<void> {
  await fs.writeFile(join(fx.workspaceRoot, README), FIRST)
  await expect.poll(() => contents(page, README)).toEqual([FIRST])
  await fs.writeFile(join(fx.workspaceRoot, README), SECOND)
  await expect.poll(() => contents(page, README)).toEqual([SECOND, FIRST])
}

async function showHistory(page: Page): Promise<void> {
  await page.getByTestId(`project-${BETA}`).click()
  await page.evaluate((p) => window.__pomadeStores.useTabsStore.getState().openDocByPath('proj-beta', p, { mode: 'raw' }), README)
  await page.locator('[data-testid="doc-history-toggle"]:visible').click()
  await expect(page.locator('[data-testid="doc-history"]:visible')).toBeVisible()
}

const snapshotRows = (page: Page): ReturnType<Page['locator']> =>
  page.locator('[data-testid="doc-history"]:visible [data-testid^="history-row-"][data-kind="snapshot"]')

test('the stable Pomade keeps a file’s versions in Apps/Pomade/local-history; Document history shows them', async () => {
  const fx = await fixture()
  const page = await start(fx, STABLE)
  await writeTwoVersions(fx, page)
  await showHistory(page)
  // The newest version holds the disk's text, so the Saved row stands for it: one snapshot row.
  await expect(snapshotRows(page)).toHaveCount(1)
  await shot(page, 'history-stable-store')

  const store = join(fx.workspaceRoot, STABLE_STORE)
  expect((await fs.readdir(join(store, 'paths'))).sort()).toEqual([recoveryFileName(README)])
  expect(await fs.readFile(join(store, 'blobs', `${blobHash(FIRST)}.txt`), 'utf8')).toBe(FIRST)
  expect(await fs.readFile(join(store, '.gitignore'), 'utf8')).toBe('*\n')
  expect(await exists(join(fx.workspaceRoot, DEV_STORE))).toBe(false)
})

test('a workspace opened at another path still shows its files’ local versions', async () => {
  test.slow() // two app starts
  const fx = await fixture()
  const page = await start(fx)
  await writeTwoVersions(fx, page)
  await stop()

  // The workspace copied to another place, opened by a Pomade with fresh user data (another Mac).
  const moved: Fixture = {
    ...fx,
    workspaceRoot: join(await tempDir('pomade-ws-moved-'), 'workspace'),
    userDataDir: await tempDir('pomade-ud-moved-')
  }
  extraDirs.push(join(moved.workspaceRoot, '..'), moved.userDataDir)
  await fs.cp(fx.workspaceRoot, moved.workspaceRoot, { recursive: true })
  const there = await start(moved)
  await expect.poll(() => contents(there, README)).toEqual([SECOND, FIRST])
  await showHistory(there)
  // The newest version holds the disk's text, so the Saved row stands for it: one snapshot row.
  await expect(snapshotRows(there)).toHaveCount(1)
  await shot(there, 'history-moved-workspace')
})

test('the store follows a workspace switch: a change is kept in the active workspace’s store only', async () => {
  test.slow() // a workspace switch
  const a = await fixture()
  const b = await fixture()
  const page = await start(a)
  await fs.writeFile(join(a.workspaceRoot, README), '# Beta\n\nChanged in A.\n')
  await expect.poll(() => contents(page, README)).toEqual(['# Beta\n\nChanged in A.\n'])

  await app!.evaluate(({}, t) => {
    process.env.POMADE_PICK_ROOT = t
  }, b.workspaceRoot)
  await app!.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-change-workspace')?.click()
  })
  await expect.poll(() => page.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().root)).toBe(b.workspaceRoot)
  expect(await list(page, README)).toEqual([])
  await fs.writeFile(join(b.workspaceRoot, README), '# Beta\n\nChanged in B.\n')
  await expect.poll(() => contents(page, README)).toEqual(['# Beta\n\nChanged in B.\n'])

  // The store's own writes are never snapshotted: well past the quiet window, each store still
  // holds README's record alone.
  await new Promise((r) => setTimeout(r, 1500))
  const paths = (root: string): Promise<string[]> => fs.readdir(join(root, DEV_STORE, 'paths'))
  expect(await paths(a.workspaceRoot)).toHaveLength(1)
  expect(await paths(b.workspaceRoot)).toHaveLength(1)
  expect(await exists(join(a.workspaceRoot, STABLE_STORE))).toBe(false)
})

test('writes into the store reach no tree listener, no name-index patch and no git-state broadcast', async () => {
  const fx = await fixture()
  git(fx.workspaceRoot, 'init', '-q', '-b', 'main')
  configRepo(fx.workspaceRoot)
  git(fx.workspaceRoot, 'add', '-A')
  commitAt(fx.workspaceRoot, '2026-11-01T09:00:00', '-m', 'Fixture')
  // The store folder exists before start, so only the store's own files change below.
  const store = join(fx.workspaceRoot, DEV_STORE)
  await fs.mkdir(join(store, 'blobs'), { recursive: true })
  await fs.writeFile(join(store, '.gitignore'), '*\n')
  const page = await start(fx)
  await expect(page.getByTestId('tree-node-welcome.md')).toBeVisible()

  await page.evaluate(() => {
    const w = window as unknown as { __t314: { fs: string[]; git: number } }
    w.__t314 = { fs: [], git: 0 }
    window.pomade.fs.onChanged((e) => {
      for (const c of e.changes ?? [{ path: '(overflow)', exists: true }]) w.__t314.fs.push(c.path)
    })
    window.pomade.git.onState(() => {
      w.__t314.git += 1
    })
  })
  const heard = (): Promise<{ fs: string[]; git: number }> =>
    page.evaluate(() => (window as unknown as { __t314: { fs: string[]; git: number } }).__t314)
  const patches = (): Promise<number> =>
    app!.evaluate(() => (globalThis as unknown as { __pomadeNameIndex: { patches: number } }).__pomadeNameIndex.patches)
  // Start-up settles: a quiet second with nothing heard and no index patch.
  await expect
    .poll(async () => {
      const before = JSON.stringify([await heard(), await patches()])
      await new Promise((r) => setTimeout(r, 1000))
      return before === JSON.stringify([await heard(), await patches()])
    })
    .toBe(true)
  const base = { heard: await heard(), patches: await patches() }

  for (let i = 0; i < 200; i++) await fs.writeFile(join(store, 'blobs', `churn${i}.txt`), `${i}\n`)
  await new Promise((r) => setTimeout(r, 2000))
  expect(await heard()).toEqual(base.heard)
  expect(await patches()).toBe(base.patches)
  expect(await page.evaluate(() => window.pomade.fs.findByName('churn7.txt'))).toEqual([])

  // Control: a write beside the store is heard by the tree, the index and git state.
  await fs.writeFile(join(fx.workspaceRoot, 'Apps/Pomade/control.md'), '# control\n')
  await expect.poll(async () => (await heard()).fs).toContain('Apps/Pomade/control.md')
  await expect.poll(async () => (await heard()).git).toBeGreaterThan(base.heard.git)
  await expect.poll(patches).toBeGreaterThan(base.patches)
})

