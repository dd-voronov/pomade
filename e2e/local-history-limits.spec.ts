// modules: git, core
// Pomade T-234 e2e — local history's limits in Settings ▸ General ▸ Local history. Acceptance: a lower
// space cap prunes the oldest local versions first (after a confirm that previews them; cancel keeps
// everything); Delete versions now removes exactly one group's versions older than the chosen age and
// leaves the other group; the preview's count is what goes. The workspace's store and the drafts are
// seeded before launch, aged by days; a seeded record claims its content's size (blobs stay tiny), so
// tens of MB cost nothing on disk. The plan math is pinned in local-history.unit.test.ts.
// Set T234_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { blobHash } from '../src/shared/local-history'
import { recoveryFileName } from '../src/shared/recovery'
import { launchAppPage } from './fixtures/app'
import { readSettingsJson } from './fixtures/settings'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.T234_SHOTS
const STORE = 'Apps/Pomade/dev/local-history'
const DAY = 24 * 60 * 60 * 1000
const MB = 1024 * 1024

let fx: Fixture
let app: ElectronApplication | undefined
let page: Page

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.getByTestId('settings-local-history').screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function windowShot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

interface Seeded {
  path: string
  ageDays: number
  sizeMb: number
}

/** One version per path, `ageDays` old, claiming `sizeMb` of distinct content. */
async function seedStore(versions: readonly Seeded[]): Promise<void> {
  const dir = join(fx.workspaceRoot, STORE)
  await fs.mkdir(join(dir, 'blobs'), { recursive: true })
  await fs.mkdir(join(dir, 'paths'), { recursive: true })
  const now = Date.now()
  for (const v of versions) {
    const content = `# ${v.path}\n`
    const hash = blobHash(content)
    await fs.writeFile(join(dir, 'blobs', `${hash}.txt`), content)
    const entries = [{ at: now - v.ageDays * DAY, hash, size: v.sizeMb * MB, origin: 'disk' }]
    await fs.writeFile(join(dir, 'paths', recoveryFileName(v.path)), JSON.stringify({ path: v.path, entries }))
  }
}

/** Discarded drafts of `workspace`, `ageDays` old each. */
async function seedDrafts(workspace: string, drafts: readonly { id: string; path: string; ageDays: number }[]): Promise<void> {
  const dir = join(fx.userDataDir, 'recovery/drafts')
  await fs.mkdir(dir, { recursive: true })
  const now = Date.now()
  for (const d of drafts) {
    const draft = {
      id: d.id,
      workspace,
      path: d.path,
      tabId: `tab-${d.id}`,
      title: d.path,
      content: `unsaved text of ${d.id}\n`,
      discardedAt: now - d.ageDays * DAY,
      reason: 'close'
    }
    await fs.writeFile(join(dir, recoveryFileName(`${workspace}\n${d.id}`)), JSON.stringify(draft))
  }
}

async function start(): Promise<void> {
  ;({ app, page } = await launchAppPage(fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('projects-panel-settings').click()
  await expect(page.getByTestId('settings-general')).toBeVisible()
  await page.getByTestId('lh-purge').scrollIntoViewIfNeeded()
}

/** The paths among `paths` that still have local versions. */
async function withVersions(paths: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    if ((await page.evaluate((path) => window.pomade.localHistory.list(path), p)).length > 0) out.push(p)
  }
  return out
}

const draftIds = (): Promise<string[]> =>
  page.evaluate(async () => (await window.pomade.recovery.drafts()).map((d) => d.id).sort())

test.beforeEach(async () => {
  fx = await createFixtureWorkspace()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  await fx?.cleanup()
})

const CAP_SEED: Seeded[] = [
  { path: 'Projects/beta/a.md', ageDays: 5, sizeMb: 20 },
  { path: 'Projects/beta/b.md', ageDays: 4, sizeMb: 20 },
  { path: 'Projects/beta/c.md', ageDays: 3, sizeMb: 20 },
  { path: 'Projects/beta/d.md', ageDays: 2, sizeMb: 20 },
  { path: 'Projects/beta/e.md', ageDays: 1, sizeMb: 20 },
  { path: 'Projects/beta/f.md', ageDays: 0.01, sizeMb: 20 }
]
const capPaths = CAP_SEED.map((v) => v.path)

test('a lower space cap previews, then prunes the oldest local versions first; cancel keeps them', async () => {
  await seedStore(CAP_SEED)
  await start()
  const cap = page.getByTestId('setting-lh-cap')
  await expect(cap).toHaveValue('256')
  await expect(page.getByTestId('lh-usage')).toContainText('Now: 120.0 MB.')
  await shot('T-234-settings-local-history')

  // 120 MB over 64: the three oldest (60 MB) go, so the rest (60 MB) fit.
  await cap.selectOption('64')
  const dialog = page.getByTestId('confirm-dialog')
  await expect(dialog).toContainText('Lower the space to 64 MB?')
  await expect(dialog).toContainText('3 versions, 60.0 MB will be deleted now')
  await windowShot('T-234-confirm-cap')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(cap).toHaveValue('256')
  // Esc closes only the confirm, not Settings under it.
  await cap.selectOption('64')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId('settings-modal')).toBeVisible()
  await expect(cap).toHaveValue('256')
  expect(await withVersions(capPaths)).toEqual(capPaths)

  await cap.selectOption('64')
  await page.getByTestId('confirm-ok').click()
  await expect(cap).toHaveValue('64')
  await expect.poll(() => withVersions(capPaths)).toEqual(capPaths.slice(3))
  await expect(page.getByTestId('lh-usage')).toContainText('Now: 60.0 MB.')
  expect((await readSettingsJson(fx.workspaceRoot))['localHistoryCapMb']).toBe(64)

  // Raising the cap deletes nothing and asks nothing.
  await cap.selectOption('1024')
  await expect(cap).toHaveValue('1024')
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  await expect.poll(async () => (await readSettingsJson(fx.workspaceRoot))['localHistoryCapMb']).toBe(1024)
  expect(await withVersions(capPaths)).toEqual(capPaths.slice(3))
})

test('Delete versions now removes exactly one group older than the age, as previewed, and leaves the other', async () => {
  const local: Seeded[] = [
    { path: 'Projects/beta/old.md', ageDays: 4, sizeMb: 2 },
    { path: 'Projects/beta/older.md', ageDays: 5, sizeMb: 3 },
    { path: 'Projects/beta/new.md', ageDays: 1, sizeMb: 1 }
  ]
  const paths = local.map((v) => v.path)
  await seedStore(local)
  await seedDrafts(fx.workspaceRoot, [
    { id: 'd-old', path: 'Projects/beta/old.md', ageDays: 5 },
    { id: 'd-mid', path: 'Projects/beta/new.md', ageDays: 2.5 },
    { id: 'd-new', path: 'Projects/beta/new.md', ageDays: 0.5 }
  ])
  // Another workspace's draft is never this workspace's to delete.
  await seedDrafts('/elsewhere/workspace', [{ id: 'd-foreign', path: 'x.md', ageDays: 5 }])
  await start()
  expect(await draftIds()).toEqual(['d-mid', 'd-new', 'd-old'])

  // Local versions older than 3 days: old.md and older.md.
  await page.getByTestId('lh-purge-group').selectOption('local')
  await page.getByTestId('lh-purge-age').selectOption('3')
  await expect(page.getByTestId('lh-purge-preview')).toHaveText('2 versions, 5.0 MB')
  await page.getByTestId('lh-purge').click()
  const dialog = page.getByTestId('confirm-dialog')
  await expect(dialog).toContainText('Delete local versions?')
  await expect(dialog).toContainText('2 versions, 5.0 MB will be deleted: Local versions older than 3 days, in this workspace.')
  await windowShot('T-234-confirm-purge')
  await page.getByTestId('confirm-ok').click()
  await expect.poll(() => withVersions(paths)).toEqual(['Projects/beta/new.md'])
  await expect(page.getByTestId('lh-purge-preview')).toHaveText('Nothing to delete')
  await expect(page.getByTestId('lh-purge')).toBeDisabled()
  expect(await draftIds()).toEqual(['d-mid', 'd-new', 'd-old'])

  // Discarded older than 2 days: d-old and d-mid; the local version stays.
  await page.getByTestId('lh-purge-group').selectOption('discarded')
  await page.getByTestId('lh-purge-age').selectOption('2')
  await expect(page.getByTestId('lh-purge-preview')).toContainText('2 versions, ')
  await shot('T-234-settings-purge-discarded')
  await page.getByTestId('lh-purge').click()
  await expect(dialog).toContainText('Delete discarded versions?')
  await expect(dialog).toContainText('Discarded older than 2 days, in this workspace.')
  await page.getByTestId('confirm-ok').click()
  await expect.poll(draftIds).toEqual(['d-new'])
  expect(await withVersions(paths)).toEqual(['Projects/beta/new.md'])
  const left = await fs.readdir(join(fx.userDataDir, 'recovery/drafts'))
  expect(left).toContain(recoveryFileName('/elsewhere/workspace\nd-foreign'))

  // Any age: everything left in the group.
  await page.getByTestId('lh-purge-group').selectOption('local')
  await page.getByTestId('lh-purge-age').selectOption('0')
  await expect(page.getByTestId('lh-purge-preview')).toHaveText('1 version, 1.0 MB')
  await page.getByTestId('lh-purge').click()
  await expect(dialog).toContainText('all Local versions, in this workspace.')
  await page.getByTestId('confirm-ok').click()
  await expect.poll(() => withVersions(paths)).toEqual([])
  await expect(page.getByTestId('lh-usage')).toContainText('Now: 0 B.')
})
