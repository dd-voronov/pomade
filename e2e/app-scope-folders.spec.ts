// modules: core, tabs, filetree
// Pomade T-291 (E-047) e2e — app scope folders: a hosted app puts a folder in a project's scope
// through the Host API (`project.addScopeFolder`). A file there opens unmarked in that project, and
// the folder is not in the file tree. While the app is unavailable its folders do not apply (the tab
// turns orange); back, they apply again with nothing to redo. Removing the app (`pomade apps
// remove`) deletes its folders from the project's state.
//
// The hello fixture app, copied with the project capabilities, is installed with `bin/pomade apps`
// against the test's own user data. Tests chain state within this file — append, never insert
// mid-file.

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp, launchAppPage } from './fixtures/app'
import { callIn, connectedFrame, HELLO_DIR, openHelloFromMenu } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

test.describe.configure({ mode: 'serial' })

const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const ARTIFACTS = resolve(__dirname, 'artifacts/app-scope-folders')

let fixture: Fixture
let app: ElectronApplication
let page: Page
let frame: Frame
let alpha: string
let buildDir: string
let outsideDir: string
let noteTab: string

const NOTES = 'Pomade-Notes/alpha'
const NOTE = `${NOTES}/T-1.md`

const pomade = (...args: string[]): string =>
  execFileSync(POMADE_BIN, args, { env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir }, encoding: 'utf8' })

/** Alpha's `appScopeFolders` as its state file holds them. */
async function storedFolders(): Promise<unknown> {
  const text = await fs.readFile(join(fixture.workspaceRoot, '.pomade/state', `${alpha}.json`), 'utf8').catch(() => '{}')
  return (JSON.parse(text) as { appScopeFolders?: unknown }).appScopeFolders ?? []
}

const noteMark = () => page.getByTestId(`tab-scope-${noteTab}`)

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  alpha = fixture.projects.alpha
  await fs.mkdir(join(fixture.workspaceRoot, NOTES), { recursive: true })
  await fs.writeFile(join(fixture.workspaceRoot, NOTE), '# T-1\n')
  outsideDir = await mkdtemp(join(tmpdir(), 'pomade-t291-out-'))
  buildDir = await mkdtemp(join(tmpdir(), 'pomade-t291-hello-'))
  await fs.cp(HELLO_DIR, buildDir, { recursive: true })
  const manifest = JSON.parse(await fs.readFile(join(buildDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  await fs.writeFile(
    join(buildDir, 'manifest.json'),
    JSON.stringify({ ...manifest, capabilities: ['project.read', 'project.write', 'files.read'] })
  )
  pomade('apps', 'install', buildDir)
  app = await launchApp(fixture)
  page = await firstAppWindow(app)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${alpha}`).click()
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  for (const dir of [buildDir, outsideDir]) if (dir) await fs.rm(dir, { recursive: true, force: true })
})

test('hello adds a folder outside alpha: a file there opens unmarked, and the tree does not show the folder', async () => {
  await openHelloFromMenu(page)
  frame = await connectedFrame(page.getByTestId('app-frame-hello'))
  // An absolute path inside the workspace is stored workspace-relative.
  expect(await callIn(frame, 'project.addScopeFolder', { projectId: alpha, path: `${join(fixture.workspaceRoot, NOTES)}/` })).toEqual({
    ok: true,
    value: { path: NOTES }
  })
  noteTab = await page.evaluate(
    ([p, path]) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, path) as string,
    [alpha, NOTE] as const
  )
  await expect(page.getByTestId(`tab-${noteTab}`)).toBeVisible()
  await expect(noteMark()).toHaveCount(0)
  await expect(page.locator(`[data-root-path="${NOTES}"]`)).toHaveCount(0)
  await expect(page.getByTestId(`tree-node-${NOTE}`)).toHaveCount(0)
  await expect.poll(storedFolders).toEqual([{ appId: 'hello', path: NOTES }])
  await fs.mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS, 'unmarked.png') })
})

test('adding again changes nothing; a folder outside the workspace that does not exist yet is accepted and removed again', async () => {
  const later = join(outsideDir, 'later')
  expect(await callIn(frame, 'project.addScopeFolder', { projectId: alpha, path: NOTES })).toEqual({ ok: true, value: { path: NOTES } })
  expect(await callIn(frame, 'project.addScopeFolder', { projectId: alpha, path: later })).toEqual({ ok: true, value: { path: later } })
  expect(await callIn(frame, 'project.getScopeFolders', { projectId: alpha })).toEqual({ ok: true, value: { paths: [NOTES, later] } })
  expect(await callIn(frame, 'project.removeScopeFolder', { projectId: alpha, path: later })).toEqual({ ok: true, value: {} })
  expect(await callIn(frame, 'project.removeScopeFolder', { projectId: alpha, path: later })).toEqual({ ok: true, value: {} })
  expect(await callIn(frame, 'project.getScopeFolders', { projectId: alpha })).toEqual({ ok: true, value: { paths: [NOTES] } })
  expect((await callIn(frame, 'project.addScopeFolder', { projectId: '__workspace__', path: NOTES })).error?.code).toBe('invalid-params')
  expect((await callIn(frame, 'project.addScopeFolder', { projectId: 'ghost', path: NOTES })).error?.code).toBe('not-found')
  expect((await callIn(frame, 'project.addScopeFolder', { projectId: alpha, path: '.pomade' })).error?.code).toBe('capability-denied')
  await expect.poll(storedFolders).toEqual([{ appId: 'hello', path: NOTES }])
})

test('the app unavailable: the tab turns orange; available again: unmarked', async () => {
  await page.getByTestId(`tab-${noteTab}`).click()
  // A broken update: the installed build's manifest no longer parses.
  await fs.writeFile(join(fixture.userDataDir, 'apps/hello/manifest.json'), '{')
  await expect(noteMark()).toHaveAttribute('data-tone', 'warning')
  await page.screenshot({ path: join(ARTIFACTS, 'app-unavailable-orange.png') })
  await expect.poll(storedFolders).toEqual([{ appId: 'hello', path: NOTES }])

  pomade('apps', 'install', buildDir)
  await expect(noteMark()).toHaveCount(0)
})

test('removing the app deletes its folders from alpha; the tab is orange', async () => {
  expect(pomade('apps', 'remove', 'hello')).toContain('Removed hello')
  await expect(noteMark()).toHaveAttribute('data-tone', 'warning')
  await expect.poll(storedFolders).toEqual([])

  // Installed again, it starts with no folders: the removal took them.
  pomade('apps', 'install', buildDir)
  await page.getByTestId(`tab-${noteTab}`).click()
  await expect(noteMark()).toHaveAttribute('data-tone', 'warning')
})

test('an app removed while Pomade is closed loses its folders at the next start', async () => {
  frame = await connectedFrame(page.getByTestId('app-frame-hello'))
  expect(await callIn(frame, 'project.addScopeFolder', { projectId: alpha, path: NOTES })).toEqual({ ok: true, value: { path: NOTES } })
  await expect(noteMark()).toHaveCount(0)
  await expect.poll(storedFolders).toEqual([{ appId: 'hello', path: NOTES }])

  await app.close()
  expect(pomade('apps', 'remove', 'hello')).toContain('Removed hello')
  const r = await launchAppPage(fixture)
  app = r.app
  page = r.page
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect.poll(storedFolders).toEqual([])
})
