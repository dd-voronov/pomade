// modules: filetree, git
// Pomade T-315 e2e — unwatched folders (Settings ▸ File tree). Acceptance: a folder added to the
// list — writes into it reach no tree event, git-state broadcast or index patch, and the name index
// forgets what it held; a write beside it is heard; the tree still shows it, with the "not watched"
// mark, and reads it again on expand; removing it from the list makes its writes heard again, with
// no restart. A folder picked with Choose… is added, a listed folder that no longer exists stays,
// dimmed, and the list holds across a restart. The path matching itself is pinned in
// src/shared/skipped-paths.unit.test.ts.
// Set T315_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { commitAt, configRepo, git } from './fixtures/git-repos'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.T315_SHOTS

const fixtures: Fixture[] = []
let app: ElectronApplication | undefined

async function fixture(): Promise<Fixture> {
  const fx = await createFixtureWorkspace()
  fixtures.push(fx)
  await fs.mkdir(join(fx.workspaceRoot, 'logs', 'sub'), { recursive: true })
  await fs.writeFile(join(fx.workspaceRoot, 'logs', 'seed.log'), 'seed\n')
  await fs.writeFile(join(fx.workspaceRoot, 'logs', 'sub', 'deep.log'), 'deep\n')
  return fx
}

async function start(fx: Fixture): Promise<Page> {
  const launched = await launchAppPage(fx)
  app = launched.app
  await expect(launched.page.getByTestId('app-shell')).toBeVisible()
  await expect(launched.page.getByTestId('tree-node-welcome.md')).toBeVisible()
  return launched.page
}

async function stop(): Promise<void> {
  await app?.close()
  app = undefined
}

test.afterEach(async () => {
  await stop()
  for (const fx of fixtures.splice(0)) await fx.cleanup()
})

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await page.screenshot({ path: join(SHOTS, `T-315-${name}.png`) })
}

async function openFileTreeSettings(page: Page): Promise<void> {
  await page.getByTestId('projects-panel-settings').click()
  await page.getByTestId('settings-nav-filetree').click()
  await expect(page.getByTestId('unwatched-settings')).toBeVisible()
}

const closeSettings = (page: Page): Promise<void> => page.getByTestId('modal-close').click()

async function unwatchedInConfig(fx: Fixture): Promise<string[]> {
  const raw = await fs.readFile(join(fx.workspaceRoot, '.pomade/workspace.json'), 'utf8').catch(() => '{}')
  return (JSON.parse(raw) as { fileTree?: { unwatched?: string[] } }).fileTree?.unwatched ?? []
}

const findByName = (page: Page, name: string): Promise<string[]> =>
  page.evaluate((n) => window.pomade.fs.findByName(n), name)

interface Heard {
  fs: string[]
  git: number
}

/** Record every tree event path and git-state broadcast the renderer hears from now on. */
async function listen(page: Page): Promise<() => Promise<Heard>> {
  await page.evaluate(() => {
    const w = window as unknown as { __t315: Heard }
    w.__t315 = { fs: [], git: 0 }
    window.pomade.fs.onChanged((e) => {
      for (const c of e.changes ?? [{ path: '(overflow)', exists: true }]) w.__t315.fs.push(c.path)
    })
    window.pomade.git.onState(() => {
      w.__t315.git += 1
    })
  })
  return () => page.evaluate(() => (window as unknown as { __t315: Heard }).__t315)
}

const patches = (): Promise<number> =>
  app!.evaluate(() => (globalThis as unknown as { __pomadeNameIndex: { patches: number } }).__pomadeNameIndex.patches)

/** Wait for a quiet second: nothing heard and no index patch. */
async function settled(heard: () => Promise<Heard>): Promise<void> {
  await expect
    .poll(
      async () => {
        const before = JSON.stringify([await heard(), await patches()])
        await new Promise((r) => setTimeout(r, 1000))
        return before === JSON.stringify([await heard(), await patches()])
      },
      { timeout: 20_000 }
    )
    .toBe(true)
}

test('an unwatched folder’s writes reach no tree event, git-state broadcast or index patch; removing it makes them heard again', async () => {
  test.slow() // several quiet windows
  const fx = await fixture()
  git(fx.workspaceRoot, 'init', '-q', '-b', 'main')
  configRepo(fx.workspaceRoot)
  git(fx.workspaceRoot, 'add', '-A')
  commitAt(fx.workspaceRoot, '2026-11-01T09:00:00', '-m', 'Fixture')
  const page = await start(fx)
  const heard = await listen(page)
  await expect.poll(() => findByName(page, 'seed.log')).toEqual(['logs/seed.log'])

  // Typed with a trailing slash: stored tidied.
  await openFileTreeSettings(page)
  await expect(page.getByTestId('unwatched-empty')).toBeVisible()
  await page.getByTestId('unwatched-add-input').fill('logs/')
  await page.getByTestId('unwatched-add-submit').click()
  await expect(page.getByTestId('unwatched-entry-logs')).toBeVisible()
  await expect(page.getByTestId('unwatched-entry-logs')).not.toHaveAttribute('data-dimmed', 'true')
  await shot(page, 'settings-file-tree')
  await expect.poll(() => unwatchedInConfig(fx)).toEqual(['logs'])
  await closeSettings(page)

  // The tree keeps the folder, marked; the name index forgets what it held.
  const row = page.getByTestId('tree-node-logs')
  await expect(row).toHaveAttribute('data-unwatched', 'true')
  await expect(page.getByTestId('tree-unwatched-logs')).toBeVisible()
  await expect.poll(() => findByName(page, 'seed.log')).toEqual([])
  await expect.poll(() => findByName(page, 'deep.log')).toEqual([])

  await settled(heard)
  const base = { heard: await heard(), patches: await patches() }
  for (let i = 0; i < 100; i++) await fs.writeFile(join(fx.workspaceRoot, 'logs', `churn${i}.log`), `${i}\n`)
  for (let i = 0; i < 100; i++) await fs.writeFile(join(fx.workspaceRoot, 'logs', 'sub', `churn-sub${i}.log`), `${i}\n`)
  await new Promise((r) => setTimeout(r, 2000))
  expect(await heard()).toEqual(base.heard)
  expect(await patches()).toBe(base.patches)
  expect(await findByName(page, 'churn7.log')).toEqual([])

  // Control: a write beside it is heard by the tree, the index and git state.
  await fs.writeFile(join(fx.workspaceRoot, 'control.md'), '# control\n')
  await expect.poll(async () => (await heard()).fs).toContain('control.md')
  await expect.poll(async () => (await heard()).git).toBeGreaterThan(base.heard.git)
  await expect.poll(patches).toBeGreaterThan(base.patches)

  // The tree reads the folder on expand, not live: a file added while it is open shows on the
  // next expand.
  await row.click()
  await expect(page.getByTestId('tree-node-logs/seed.log')).toBeVisible()
  await expect(page.getByTestId('tree-node-logs/churn7.log')).toBeVisible()
  await shot(page, 'tree-unwatched-folder')
  await fs.writeFile(join(fx.workspaceRoot, 'logs', 'while-open.log'), 'x\n')
  await new Promise((r) => setTimeout(r, 1500))
  await expect(page.getByTestId('tree-node-logs/while-open.log')).toHaveCount(0)
  await row.click()
  await row.click()
  await expect(page.getByTestId('tree-node-logs/while-open.log')).toBeVisible()

  // Removed from the list: no restart, its writes are heard again and the index walks it in.
  await openFileTreeSettings(page)
  await page.getByTestId('unwatched-remove-logs').click()
  await expect(page.getByTestId('unwatched-empty')).toBeVisible()
  await expect.poll(() => unwatchedInConfig(fx)).toEqual([])
  await closeSettings(page)
  await expect(row).not.toHaveAttribute('data-unwatched', 'true')
  await expect(page.getByTestId('tree-unwatched-logs')).toHaveCount(0)
  await expect.poll(() => findByName(page, 'churn7.log')).toEqual(['logs/churn7.log'])
  await expect.poll(() => findByName(page, 'churn-sub7.log')).toEqual(['logs/sub/churn-sub7.log'])
  const gitBefore = (await heard()).git
  await fs.writeFile(join(fx.workspaceRoot, 'logs', 'after.log'), 'after\n')
  await expect.poll(async () => (await heard()).fs).toContain('logs/after.log')
  await expect.poll(async () => (await heard()).git).toBeGreaterThan(gitBefore)
  await expect.poll(() => findByName(page, 'after.log')).toEqual(['logs/after.log'])
  await expect(page.getByTestId('tree-node-logs/after.log')).toBeVisible()
})

test('Choose… adds a picked folder; a listed folder that no longer exists stays, dimmed; the list holds across a restart', async () => {
  test.slow() // two app starts
  const fx = await fixture()
  const page = await start(fx)

  await openFileTreeSettings(page)
  const picked = join(fx.workspaceRoot, 'logs', 'sub')
  await app!.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, picked)
  await page.getByTestId('unwatched-pick').click()
  await expect(page.getByTestId('unwatched-entry-logs/sub')).toBeVisible()

  // A path out of the workspace is refused: the draft stays in the input, nothing is added.
  await page.getByTestId('unwatched-add-input').fill('../elsewhere')
  await page.getByTestId('unwatched-add-submit').click()
  await expect(page.getByTestId('unwatched-add-input')).toHaveValue('../elsewhere')
  await page.getByTestId('unwatched-add-input').fill('exports/old')
  await page.getByTestId('unwatched-add-submit').click()
  await expect(page.getByTestId('unwatched-entry-exports/old')).toHaveAttribute('data-dimmed', 'true')
  await expect(page.getByTestId('unwatched-entry-logs/sub')).not.toHaveAttribute('data-dimmed', 'true')
  await expect.poll(() => unwatchedInConfig(fx)).toEqual(['logs/sub', 'exports/old'])
  await shot(page, 'settings-missing-dimmed')
  await closeSettings(page)

  await stop()
  const again = await start(fx)
  await again.getByTestId('tree-node-logs').click()
  await expect(again.getByTestId('tree-node-logs/sub')).toHaveAttribute('data-unwatched', 'true')
  await expect(again.getByTestId('tree-node-logs')).not.toHaveAttribute('data-unwatched', 'true')
  await expect.poll(() => findByName(again, 'seed.log')).toEqual(['logs/seed.log'])
  expect(await findByName(again, 'deep.log')).toEqual([])
  await openFileTreeSettings(again)
  await expect(again.getByTestId('unwatched-entry-exports/old')).toHaveAttribute('data-dimmed', 'true')
})
