// modules: core
// E-027 e2e — bundled apps (docs/HOST-API.md §8 "Bundled apps"). A packaged Pomade carries app
// builds and installs them at start; here `POMADE_BUNDLED_APPS` names a folder of fixture builds
// instead of the app bundle's Resources. The first start installs the app (commands linked, launch
// panel loaded) and says so in one notice; a second start does nothing. An update over an app whose
// keeper runs leaves the keeper able to spawn: its files stay in its own build folder.
// Starts a keeper and its sessions → heavy project.

import { execFileSync, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { connectKeeper, queueNotice, type KeeperClient } from 'pomade-kit/node'
import { keeperSocketPath } from 'pomade-kit/protocol'

import { collectRetiredBuilds } from '../src/main/app-install-core'
import { firstAppWindow, launchApp } from './fixtures/app'
import { HELLO_DIR } from './fixtures/hello-app'
import { alive } from './fixtures/keeper'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const NODE_MODULES = resolve(__dirname, '../node_modules')
const KEEPER_ENTRY = resolve(__dirname, 'fixtures/keeper/keeper.mjs')
const ELECTRON = resolve(NODE_MODULES, 'electron/dist/Electron.app/Contents/MacOS/Electron')
/** What a keeper needs at run time, shipped in the app's build as real apps ship it. */
const KEEPER_PACKAGES = ['pomade-kit', 'node-pty', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11', 'js-yaml', 'argparse']
const SHOTS = process.env.POMADE_T237_SHOTS

/** A build of the fixture app `id` at `version` in a new folder under `parent`. */
async function fixtureBuild(parent: string, id: string, version: string, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = join(parent, id)
  await fs.cp(HELLO_DIR, dir, { recursive: true })
  const manifest = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  await fs.mkdir(join(dir, 'cli'))
  await fs.writeFile(join(dir, 'cli', 'main.mjs'), `console.log('${id} ${version}')\n`)
  await fs.writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      id,
      name: 'Bundled fixture',
      version,
      shortcuts: [],
      events: {},
      commands: [{ name: id, entry: 'cli/main.mjs', title: 'The fixture command' }],
      ...extra
    })
  )
  return dir
}

/** Kill keepers and the sessions' process groups. */
function killAll(keepers: Iterable<number>, sessions: Iterable<number>): void {
  for (const p of [...keepers, ...[...sessions].map((s) => -s)]) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

/** A screenshot into POMADE_T237_SHOTS, when set. */
async function shot(target: Locator, name: string): Promise<void> {
  if (SHOTS) await target.screenshot({ path: join(SHOTS, name) })
}

/** Note `pid` (when the process has one) in `into`. */
function track(into: Set<number>, pid: number | null | undefined): void {
  if (pid) into.add(pid)
}

/** No notice from Pomade at this start: a probe notice queued before the start is drained with
 *  anything Pomade queued before its window opened, so once the probe shows, it is the only toast. */
async function expectOnlyProbe(page: Page): Promise<void> {
  const toast = page.getByTestId('notice-toast')
  await expect(toast.getByTestId('notice-toast-title')).toHaveText('probe')
  await expect(toast).toHaveCount(1)
}

const builds = (ud: string): Promise<string[]> => fs.readdir(join(ud, 'apps', '.builds')).then((n) => n.filter((x) => !x.startsWith('.')).sort())

test.describe('E-027 bundled apps', () => {
  test.describe('install at start', () => {
    let fixture: Fixture
    let app: ElectronApplication | null = null
    let page: Page
    let tmp: string
    let bundled: string
    let pomadeHome: string

    async function launch(): Promise<void> {
      app = await launchApp(fixture, { POMADE_BUNDLED_APPS: bundled, POMADE_HOME: pomadeHome })
      page = await firstAppWindow(app)
      await expect(page.getByTestId('app-shell')).toBeVisible()
    }

    test.beforeAll(async () => {
      fixture = await createFixtureWorkspace()
      tmp = await tempDir('pomade-bundled-')
      bundled = join(tmp, 'bundled-apps')
      pomadeHome = join(tmp, 'home')
      await fs.mkdir(bundled)
      await fixtureBuild(bundled, 'bundled-fx', '0.1.0', { startOnLaunch: true, outsideWorkspace: ['~/.claude/', '~/.zshrc'] })
      await launch()
    })

    test.afterAll(async () => {
      await app?.close()
      await fixture?.cleanup()
      await fs.rm(tmp, { recursive: true, force: true })
    })

    test('the first start installs the app: commands linked, launch panel loaded, one notice', async () => {
      const ud = fixture.userDataDir
      expect(JSON.parse(await fs.readFile(join(ud, 'apps', 'bundled-fx', 'manifest.json'), 'utf8'))).toMatchObject({ version: '0.1.0' })
      expect((await fs.lstat(join(ud, 'apps', 'bundled-fx'))).isSymbolicLink()).toBe(true)
      // Its key, its command shim, its launch panel — as any install.
      await expect.poll(() => fs.stat(join(ud, 'app-keys', 'bundled-fx')).then(() => true, () => false)).toBe(true)
      await expect.poll(() => fs.readdir(join(pomadeHome, 'bin')).catch(() => [] as string[])).toContain('bundled-fx')
      expect(execFileSync(join(pomadeHome, 'bin', 'bundled-fx'), { encoding: 'utf8' }).trim()).toBe('bundled-fx 0.1.0')
      await expect(page.getByTestId('panel-frame-app-bundled-fx-panel')).toHaveCount(1)
      await expect(page.getByTestId('strip-app-bundled-fx-panel')).toBeVisible()

      // One toast from Pomade: the paths outside the workspace the app uses (shown once, at
      // install) in front, the install notice behind it.
      const toast = page.getByTestId('notice-toast')
      await expect(toast).toHaveCount(1)
      await expect(toast.getByTestId('notice-toast-source')).toHaveText('Pomade')
      await expect(toast.getByTestId('notice-toast-title')).toHaveText('Outside the workspace')
      await expect(toast.getByTestId('notice-toast-body')).toHaveText('Bundled fixture uses ~/.claude/, ~/.zshrc')
      await expect(toast.getByTestId('notice-toast-more')).toHaveText('1 more from Pomade')
      await shot(toast, 'bundled-notice-light.png')
      await toast.getByTestId('notice-toast-more').click()
      await expect(page.getByTestId('notices-panel')).toBeVisible()
      const rows = page.getByTestId('notice-row')
      await expect(rows.filter({ hasText: 'An app installed with Pomade' })).toContainText('Installed: Bundled fixture 0.1.0')
      await expect(rows.filter({ hasText: 'Outside the workspace' })).toContainText('Bundled fixture uses ~/.claude/, ~/.zshrc')
      await shot(page.getByTestId('notices-panel'), 'bundled-notices-panel-light.png')
    })

    test('a second start does nothing: no reinstall, no notice', async () => {
      const ud = fixture.userDataDir
      const before = await fs.readlink(join(ud, 'apps', 'bundled-fx'))
      await app?.close()
      await queueNotice({ title: 'probe' }, { source: 'e2e-probe', userData: ud })
      await launch()
      await expect(page.getByTestId('panel-frame-app-bundled-fx-panel')).toHaveCount(1)
      await expectOnlyProbe(page)
      expect(await fs.readlink(join(ud, 'apps', 'bundled-fx'))).toBe(before)
      expect(await builds(ud)).toEqual([before.split('/').pop()])
    })

    test('an app the user removed is not put back by the same build', async () => {
      const ud = fixture.userDataDir
      await app?.close()
      app = null
      execFileSync(POMADE_BIN, ['apps', 'remove', 'bundled-fx'], { env: { ...process.env, POMADE_USER_DATA: ud } })
      await queueNotice({ title: 'probe' }, { source: 'e2e-probe', userData: ud })
      await launch()
      await expectOnlyProbe(page)
      await expect(page.getByTestId('strip-app-bundled-fx-panel')).toHaveCount(0)
      await expect(fs.lstat(join(ud, 'apps', 'bundled-fx'))).rejects.toThrow()
    })
  })

  test.describe('update over a running keeper', () => {
    const APP_ID = 'bundled-kp'
    let fixture: Fixture
    let app: ElectronApplication | null = null
    let tmp: string
    let ud: string
    const keeperPids = new Set<number>()
    let owner: KeeperClient | null = null
    const sessionPids = new Set<number>()

    async function ownerClient(): Promise<KeeperClient> {
      const r = await connectKeeper({ socketPath: keeperSocketPath(ud, APP_ID), app: APP_ID, role: 'owner' })
      if (r.status !== 'connected') throw new Error(`owner connect: ${JSON.stringify(r)}`)
      keeperPids.add(r.keeper.keeper.pid)
      return r.keeper
    }

    test.beforeAll(async () => {
      fixture = await createFixtureWorkspace()
      ud = fixture.userDataDir
      tmp = await tempDir('pomade-bundled-kp-')
      // v1: installed by hand, with a keeper and the packages it loads at run time.
      const v1 = await fixtureBuild(join(tmp), APP_ID, '0.1.0', { outsideWorkspace: ['~/.claude/'] })
      await fs.mkdir(join(v1, 'backend'))
      await fs.copyFile(KEEPER_ENTRY, join(v1, 'backend', 'keeper.mjs'))
      for (const pkg of KEEPER_PACKAGES) {
        await fs.mkdir(join(v1, 'node_modules', pkg, '..'), { recursive: true })
        execFileSync('cp', ['-c', '-R', join(NODE_MODULES, pkg), join(v1, 'node_modules', pkg)])
      }
      const out = execFileSync(POMADE_BIN, ['apps', 'install', v1], { env: { ...process.env, POMADE_USER_DATA: ud }, encoding: 'utf8' })
      // The install summary names the paths outside the workspace the app uses.
      expect(out).toContain('  Outside the workspace: ~/.claude/\n')
    })

    test.afterAll(async () => {
      owner?.close()
      await app?.close()
      killAll(keeperPids, sessionPids)
      await fixture?.cleanup()
      await fs.rm(tmp, { recursive: true, force: true })
    })

    test("a bundled update leaves the running keeper able to spawn; its build goes once it is done", async () => {
      // The keeper runs from the installed app, as its backend would start it: in the app's folder.
      const dir = join(ud, 'apps', APP_ID)
      const child = spawn(ELECTRON, [join(dir, 'backend', 'keeper.mjs')], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SHELL: '/bin/sh', POMADE_APP_ID: APP_ID, POMADE_KEEPER_SOCKET: keeperSocketPath(ud, APP_ID) }
      })
      child.unref()
      track(keeperPids, child.pid)
      await expect.poll(async () => (await connectKeeper({ socketPath: keeperSocketPath(ud, APP_ID), app: 'e2e', timeoutMs: 500 })).status, { timeout: 15000 }).toBe('connected')
      owner = await ownerClient()
      const one = await owner.spawn({ id: 'one', title: 'One', command: 'sleep 600', cwd: fixture.workspaceRoot })
      track(sessionPids, one.pid)
      const firstBuild = (await fs.realpath(dir)).split('/').pop()

      // v2 ships no keeper and no packages: an update that changes the build's layout.
      const bundled = join(tmp, 'bundled-apps')
      await fs.mkdir(bundled)
      await fixtureBuild(bundled, APP_ID, '0.2.0', { outsideWorkspace: ['~/.claude/', '~/.codex/'] })
      app = await launchApp(fixture, { POMADE_BUNDLED_APPS: bundled, POMADE_HOME: join(tmp, 'home') })
      const page = await firstAppWindow(app)
      await expect(page.getByTestId('app-shell')).toBeVisible()
      expect(JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ version: '0.2.0' })
      // An update shows only the paths outside the workspace the installed build did not declare.
      await expect(page.getByTestId('notice-toast-title')).toHaveText('Outside the workspace')
      await expect(page.getByTestId('notice-toast-body')).toHaveText('Bundled fixture now also uses ~/.codex/')
      await page.getByTestId('notice-toast-more').click()
      await expect(page.getByTestId('notice-row').filter({ hasText: 'An app updated with Pomade' })).toContainText(
        'Updated: Bundled fixture 0.1.0 → 0.2.0'
      )

      // The keeper spawns a new session after the update; the first one still runs.
      const two = await owner.spawn({ id: 'two', title: 'Two', command: 'sleep 600', cwd: fixture.workspaceRoot })
      track(sessionPids, two.pid)
      expect(alive(two.pid)).toBe(true)
      expect(alive(one.pid)).toBe(true)
      // Its build is kept while it runs: collecting retired builds passes it over.
      expect(await collectRetiredBuilds(ud)).not.toContain(firstBuild)
      expect(await builds(ud)).toContain(firstBuild)

      // Once the keeper is gone, the next start deletes that build.
      owner.close()
      owner = null
      killAll(keeperPids, sessionPids)
      await expect.poll(() => [...keeperPids].some((p) => alive(p))).toBe(false)
      await app.close()
      app = await launchApp(fixture, { POMADE_BUNDLED_APPS: bundled, POMADE_HOME: join(tmp, 'home') })
      await expect((await firstAppWindow(app)).getByTestId('app-shell')).toBeVisible()
      await expect.poll(() => builds(ud), { timeout: 15000 }).toEqual([(await fs.readlink(dir)).split('/').pop()])
    })
  })
})
