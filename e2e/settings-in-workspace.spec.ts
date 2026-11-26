// modules: core
// Pomade T-313 e2e — app settings live in the workspace: preferences in `.pomade/settings.json`,
// view state in `.pomade/state/view.json`; `<userData>/app.json` keeps only `workspaceRoot`.
// Acceptance: the UI shows the settings both files hold, a `settings` key left in app.json is
// ignored, and a start writes nothing; a settings change lands in settings.json and a layout change
// only in view.json; switching workspace switches settings, a workspace without them gets the
// defaults.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'
import { readSettingsJson, readViewState, settingsJsonPath, viewStatePath } from './fixtures/settings'

const PREFERENCES = {
  markdownDefaultMode: 'raw',
  terminalAutoCopy: false,
  terminalFont: 'jetbrains-mono',
  mutedNoticeSources: ['pomade-git']
}
const VIEW_STATE = {
  compareChangesOnly: true,
  layout: { projectsPanelWidth: 312, fileTreeWidth: 288, projectsPanelCollapsed: false, fileTreeCollapsed: false }
}

const fixtures: Fixture[] = []
let app: ElectronApplication | undefined

async function fixture(): Promise<Fixture> {
  const fx = await createFixtureWorkspace()
  fixtures.push(fx)
  return fx
}

const appJsonPath = (fx: Fixture): string => join(fx.userDataDir, 'app.json')


async function start(fx: Fixture, env: Record<string, string> = {}): Promise<Page> {
  const launched = await launchAppPage(fx, env)
  app = launched.app
  await expect(launched.page.getByTestId('app-shell')).toBeVisible()
  await expect
    .poll(() => launched.page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().hydrated))
    .toBe(true)
  return launched.page
}

async function stop(): Promise<void> {
  await app?.close()
  app = undefined
}

function storeSetting<K extends string>(page: Page, key: K): Promise<unknown> {
  return page.evaluate((k) => (window.__pomadeStores.useAppSettingsStore.getState() as unknown as Record<string, unknown>)[k], key)
}

/** Content and mtime of each settings file, to prove a start wrote nothing. */
async function snapshot(fx: Fixture): Promise<string[]> {
  const out: string[] = []
  for (const p of [appJsonPath(fx), settingsJsonPath(fx.workspaceRoot), viewStatePath(fx.workspaceRoot)]) {
    const st = await fs.stat(p)
    out.push(`${p} ${st.mtimeMs} ${await fs.readFile(p, 'utf8')}`)
  }
  return out
}

test.afterEach(async () => {
  await stop()
  for (const fx of fixtures.splice(0)) await fx.cleanup()
})

test('the UI shows the settings both files hold; a settings key in app.json is ignored; a start writes nothing', async () => {
  test.slow() // two app starts
  const fx = await fixture()
  await fs.writeFile(settingsJsonPath(fx.workspaceRoot), JSON.stringify(PREFERENCES, null, 2))
  await fs.mkdir(join(fx.workspaceRoot, '.pomade/state'), { recursive: true })
  await fs.writeFile(viewStatePath(fx.workspaceRoot), JSON.stringify(VIEW_STATE, null, 2))
  const appJson = JSON.stringify({ workspaceRoot: fx.workspaceRoot, settings: { markdownDefaultMode: 'rendered', terminalAutoCopy: true } })
  await fs.writeFile(appJsonPath(fx), appJson)

  const page = await start(fx)
  expect(await fs.readFile(appJsonPath(fx), 'utf8')).toBe(appJson)
  expect(await storeSetting(page, 'layout')).toEqual(VIEW_STATE.layout)
  expect(await storeSetting(page, 'compareChangesOnly')).toBe(true)
  await page.getByTestId('projects-panel-settings').click()
  await expect(page.getByTestId('setting-md-default-mode')).toHaveValue('raw')
  await expect(page.getByTestId('setting-terminal-auto-copy')).not.toBeChecked()
  await expect(page.getByTestId('setting-terminal-font')).toHaveValue('jetbrains-mono')
  await page.getByTestId('modal-close').click()

  const before = await snapshot(fx)
  await stop()
  const again = await start(fx)
  expect(await storeSetting(again, 'markdownDefaultMode')).toBe('raw')
  expect(await snapshot(fx)).toEqual(before)
})

test('a settings change lands in settings.json; a layout change lands in view.json and leaves settings.json alone', async () => {
  const fx = await fixture()
  const page = await start(fx)

  await page.getByTestId('projects-panel-settings').click()
  await page.getByTestId('setting-terminal-auto-copy').uncheck()
  await expect.poll(async () => (await readSettingsJson(fx.workspaceRoot)).terminalAutoCopy).toBe(false)
  await page.getByTestId('modal-close').click()
  expect((await readViewState(fx.workspaceRoot)).layout).toBeUndefined()

  const prefsBefore = await fs.stat(settingsJsonPath(fx.workspaceRoot))
  const prefsText = await fs.readFile(settingsJsonPath(fx.workspaceRoot), 'utf8')
  // Drag end (live width set, then one persist) and a collapse — the two layout write paths.
  await page.evaluate(async () => {
    const s = window.__pomadeStores.useAppSettingsStore.getState()
    s.setFileTreeWidth(333)
    await s.persistLayout()
    await s.setProjectsPanelCollapsed(true)
  })
  await expect
    .poll(async () => (await readViewState(fx.workspaceRoot)).layout)
    .toMatchObject({ fileTreeWidth: 333, projectsPanelCollapsed: true })
  expect(await fs.readFile(settingsJsonPath(fx.workspaceRoot), 'utf8')).toBe(prefsText)
  expect((await fs.stat(settingsJsonPath(fx.workspaceRoot))).mtimeMs).toBe(prefsBefore.mtimeMs)
  // state/ is gitignored, settings.json is not.
  expect(await fs.readFile(join(fx.workspaceRoot, '.pomade/.gitignore'), 'utf8')).toBe('state/\n')
})

test('switching workspace switches settings; a workspace without settings.json gets the defaults', async () => {
  test.slow() // two workspace switches
  const a = await fixture()
  const b = await fixture()
  await fs.writeFile(
    settingsJsonPath(a.workspaceRoot),
    JSON.stringify({ markdownDefaultMode: 'raw', terminalAutoCopy: false }, null, 2)
  )
  const page = await start(a)
  expect(await storeSetting(page, 'markdownDefaultMode')).toBe('raw')

  const switchTo = async (root: string): Promise<void> => {
    await app!.evaluate(({}, t) => {
      process.env.POMADE_PICK_ROOT = t
    }, root)
    await app!.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('menu-change-workspace')?.click()
    })
    await expect.poll(() => page.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().root)).toBe(root)
  }

  await switchTo(b.workspaceRoot)
  await expect.poll(() => storeSetting(page, 'markdownDefaultMode')).toBe('rendered')
  expect(await storeSetting(page, 'terminalAutoCopy')).toBe(true)
  // Reading the defaults writes nothing into B.
  await expect(fs.access(settingsJsonPath(b.workspaceRoot))).rejects.toThrow()

  await switchTo(a.workspaceRoot)
  await expect.poll(() => storeSetting(page, 'markdownDefaultMode')).toBe('raw')
  expect(await storeSetting(page, 'terminalAutoCopy')).toBe(false)
})
