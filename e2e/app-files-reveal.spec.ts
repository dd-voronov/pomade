// modules: core, filetree
// T-275 e2e — `files.reveal` (docs/HOST-API.md §4 `files.read`) in a real Pomade, driven through the
// raw-protocol conformance fixture (e2e/fixtures/apps/hello, copied with a manifest that declares
// `files.read`; a second copy declares only `project.read`).
//   - a folder: the Files panel shows (from the Git panel, from a collapsed side panel), its ancestors
//     and the folder itself are expanded, the folder is selected and in view;
//   - a file: selected, its folder expanded;
//   - a path outside the target project's folder is shown in the Workspace project; `projectId` names
//     the project whose panel shows it;
//   - a missing path is `not-found`, an escape `outside-workspace`, `.pomade` `capability-denied`;
//     without `files.read` the call is `capability-denied`.
// Screenshots go to POMADE_T275_SHOTS when set, else e2e/artifacts/app-files-reveal/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeProjectOf, callIn, HELLO_DIR, openHelloFromMenu, setActiveProject } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { showGitPanel } from './fixtures/panels'
import { tempDir } from './fixtures/temp'

const SHOTS = process.env['POMADE_T275_SHOTS'] || resolve(__dirname, 'artifacts/app-files-reveal')
const WORKSPACE = '__workspace__'

/** A copy of the hello fixture under its own id with the given capabilities. */
async function helloCopy(id: string, capabilities: string[]): Promise<string> {
  const dir = await tempDir(`pomade-${id}-`)
  await fs.cp(HELLO_DIR, dir, { recursive: true })
  const manifest = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id, name: id, capabilities }))
  return dir
}

/** The hello copy `appId`'s frame once its handshake has completed. */
async function frameOf(page: Page, appId: string): Promise<Frame> {
  const prefix = `pomade-app://${appId}/`
  await expect.poll(() => page.frames().some((f) => f.url().startsWith(prefix))).toBe(true)
  const frame = page.frames().find((f) => f.url().startsWith(prefix)) as Frame
  await expect
    .poll(() => frame.evaluate(() => window.__hello?.status ?? 'loading'))
    .toBe('connected')
  return frame
}

test.describe('T-275 files.reveal', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dirs: string[] = []
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  const node = (path: string): ReturnType<Page['locator']> => page.getByTestId(`tree-node-${path}`)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(abs('Apps/hello/jobs/run-1'), { recursive: true })
    await fs.writeFile(abs('Apps/hello/jobs/a.txt'), 'a\n')
    await fs.writeFile(abs('Apps/hello/jobs/run-1/out.log'), 'out\n')
    await fs.mkdir(abs('Projects/alpha/docs/deep/er'), { recursive: true })
    await fs.writeFile(abs('Projects/alpha/docs/deep/er/spec.md'), '# Spec\n')
    await fs.writeFile(abs('Projects/beta/notes.md'), '# Notes\n')
    const readDir = await helloCopy('hello-reveal', ['project.read', 'files.read'])
    const noReadDir = await helloCopy('hello-noread', ['project.read'])
    dirs = [readDir, noReadDir]
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${readDir};${noReadDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await openHelloFromMenu(page, 'hello-reveal')
    frame = await frameOf(page, 'hello-reveal')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
  })

  test('a folder outside the project: the Workspace project shows Files with the folder expanded, selected and in view', async () => {
    await showGitPanel(page)
    await expect(page.getByTestId('side-panel-git')).toBeVisible()
    expect(await activeProjectOf(page)).toBe(fixture.projects.alpha)

    expect(await callIn(frame, 'files.reveal', { path: 'Apps/hello/jobs' })).toEqual({ ok: true, value: {} })

    await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
    await expect(page.getByTestId('side-panel-files')).toBeVisible()
    await expect(page.getByTestId('side-panel-git')).toBeHidden()
    const jobs = node('Apps/hello/jobs')
    await expect(jobs).toHaveAttribute('data-selected', 'true')
    await expect(jobs).toBeInViewport()
    // Expanded: its children are listed.
    await expect(node('Apps/hello/jobs/a.txt')).toBeVisible()
    await expect(node('Apps/hello/jobs/run-1')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/T-275-folder-in-workspace.png` })
  })

  test('a file in the active project selects it, expanded down to its folder, from a collapsed side panel showing Git', async () => {
    await setActiveProject(page, fixture.projects.alpha)
    await showGitPanel(page)
    await page.evaluate(() =>
      window.__pomadeStores.useAppSettingsStore.getState()
        .setFileTreeCollapsed(true)
    )
    await expect(page.getByTestId('filetree-expand')).toBeVisible()

    const path = 'Projects/alpha/docs/deep/er/spec.md'
    expect(await callIn(frame, 'files.reveal', { path })).toEqual({ ok: true, value: {} })

    expect(await activeProjectOf(page)).toBe(fixture.projects.alpha)
    await expect(page.getByTestId('filetree-expand')).toHaveCount(0)
    await expect(page.getByTestId('side-panel-git')).toBeHidden()
    await expect(node(path)).toHaveAttribute('data-selected', 'true')
    await expect(node(path)).toBeInViewport()
    await expect(node('Projects/alpha/docs/deep')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/T-275-file-in-project.png` })
  })

  test('projectId names the project whose panel shows it; a path outside that project goes to the Workspace project', async () => {
    expect(await callIn(frame, 'files.reveal', { path: 'Projects/beta/notes.md', projectId: fixture.projects.beta })).toEqual({
      ok: true,
      value: {}
    })
    await expect.poll(() => activeProjectOf(page)).toBe(fixture.projects.beta)
    await expect(node('Projects/beta/notes.md')).toHaveAttribute('data-selected', 'true')

    expect(await callIn(frame, 'files.reveal', { path: 'Apps/hello/jobs/a.txt', projectId: fixture.projects.beta })).toEqual({
      ok: true,
      value: {}
    })
    await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
    await expect(node('Apps/hello/jobs/a.txt')).toHaveAttribute('data-selected', 'true')

    const unknown = await callIn(frame, 'files.reveal', { path: 'Apps/hello/jobs', projectId: 'nope' })
    expect(unknown.error?.code).toBe('not-found')
  })

  test('a file under a folder revealed earlier stays listed; the second reveal moves the selection', async () => {
    expect(await callIn(frame, 'files.reveal', { path: 'Apps/hello/jobs/run-1/out.log' })).toEqual({ ok: true, value: {} })
    await expect(node('Apps/hello/jobs/run-1/out.log')).toHaveAttribute('data-selected', 'true')
    await expect(node('Apps/hello/jobs/a.txt')).not.toHaveAttribute('data-selected', 'true')
    await page.screenshot({ path: `${SHOTS}/T-275-second-reveal.png` })
  })

  test('a missing path is not-found, an escape outside-workspace, .pomade capability-denied, bad params invalid-params', async () => {
    const before = await activeProjectOf(page)
    expect((await callIn(frame, 'files.reveal', { path: 'Apps/hello/nope' })).error?.code).toBe('not-found')
    expect((await callIn(frame, 'files.reveal', { path: '../outside' })).error?.code).toBe('outside-workspace')
    expect((await callIn(frame, 'files.reveal', { path: '.pomade/workspace.json' })).error?.code).toBe('capability-denied')
    for (const params of [{}, { path: 3 }, { path: 'Apps', projectId: 3 }]) {
      expect((await callIn(frame, 'files.reveal', params)).error?.code, JSON.stringify(params)).toBe('invalid-params')
    }
    expect(await activeProjectOf(page)).toBe(before)
  })

  test('without files.read: capability-denied', async () => {
    await openHelloFromMenu(page, 'hello-noread')
    const noRead = await frameOf(page, 'hello-noread')
    expect((await callIn(noRead, 'files.reveal', { path: 'Apps/hello/jobs' })).error?.code).toBe('capability-denied')
  })
})
