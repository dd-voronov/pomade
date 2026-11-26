// modules: filetree
// T-273 e2e — the file tree under constant writes. A file appended to every 50 ms (a log an agent
// or a build writes) changes no listing, so the tree reads no folder for it — nor for a file the tree
// hides (an ignored item, here `hidden.log`) written as often; and the stream never holds
// the tree's refresh off — a file created elsewhere meanwhile shows within ~1.5 s. Create, delete,
// rename and a new folder still show while the writer runs. Folder reads are counted through the
// main-process test hook `__pomadeTreeReads` (docs/contracts/test-hooks.md). Specs chain state
// within this file — append, never insert mid-file.
// LIGHT partition: no terminal panes.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { DEFAULT_TREE_IGNORE } from '../src/shared/types'
import { launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

let fixture: Fixture
let app: ElectronApplication
let page: Page
let writers: ReturnType<typeof setInterval>[] = []

const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const row = (path: string) => page.getByTestId(`tree-node-${path}`)

const clearReads = (): Promise<void> =>
  app.evaluate(() => {
    globalThis.__pomadeTreeReads = []
  })
const reads = (): Promise<string[]> =>
  app.evaluate(() => [...(globalThis.__pomadeTreeReads ?? [])])

test.describe('T-273 the file tree under constant writes', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(abs('busy'), { recursive: true })
    await fs.writeFile(abs('busy/agent.log'), 'start\n')
    await fs.mkdir(abs('calm'), { recursive: true })
    await fs.writeFile(abs('calm/old.md'), 'old\n')
    await fs.writeFile(abs('calm/keep.md'), 'keep\n')
    await fs.writeFile(abs('calm/hidden.log'), 'start\n')
    // `hidden.log` is one of the workspace's ignored items: the tree never lists it.
    const configPath = abs('.pomade/workspace.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    config.fileTree = { ignore: [...DEFAULT_TREE_IGNORE, 'hidden.log'], unwatched: [] }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId('filetree-root')).toBeVisible()
    await row('busy').click()
    await expect(row('busy/agent.log')).toBeVisible()
    await row('calm').click()
    await expect(row('calm/old.md')).toBeVisible()
    await expect(row('calm/hidden.log')).toHaveCount(0)
    let n = 0
    writers = [
      setInterval(() => void fs.appendFile(abs('busy/agent.log'), `line ${n++}\n`), 50),
      setInterval(() => void fs.appendFile(abs('calm/hidden.log'), `line ${n++}\n`), 50)
    ]
  })

  test.afterAll(async () => {
    for (const w of writers) clearInterval(w)
    await app?.close()
    await fixture?.cleanup()
  })

  test('appends alone, to a listed or a hidden file, make the tree read no folder', async () => {
    // Past the registration settle (re-reads at 300 ms and 1.2 s after the watch registered).
    await sleep(2500)
    await clearReads()
    await sleep(3000)
    expect(await reads()).toEqual([])
  })

  test('a file created in another folder shows within ~1.5 s while the writer runs', async () => {
    const t0 = Date.now()
    await fs.writeFile(abs('calm/new.md'), 'new\n')
    await expect(row('calm/new.md')).toBeVisible({ timeout: 1500 })
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  test('delete, rename and a new folder still show while the writer runs', async () => {
    await fs.rm(abs('calm/old.md'))
    await expect(row('calm/old.md')).toHaveCount(0, { timeout: 1500 })
    await fs.rename(abs('calm/new.md'), abs('calm/renamed.md'))
    await expect(row('calm/renamed.md')).toBeVisible({ timeout: 1500 })
    await expect(row('calm/new.md')).toHaveCount(0)
    await fs.mkdir(abs('calm/made'))
    await expect(row('calm/made')).toBeVisible({ timeout: 1500 })
    await fs.writeFile(abs('busy/sibling.md'), 'beside the log\n')
    await expect(row('busy/sibling.md')).toBeVisible({ timeout: 1500 })
    await expect(row('busy/agent.log')).toBeVisible()
    await expect(row('calm/keep.md')).toBeVisible()
  })
})
