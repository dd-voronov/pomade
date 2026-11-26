// modules: core, git, projects
// T-320 e2e — `git.reveal` (docs/HOST-API.md §4 `git.read`) in a real Pomade, driven through the
// raw-protocol conformance fixture (e2e/fixtures/apps/hello, copied with a manifest that declares
// `git.read`; a second copy does not) and over the socket as a command. A fixture workspace with a
// repo per project (Projects/alpha; Projects/beta holding a nested Projects/beta/lib) and a long run
// of repos under Repos/ — enough that the All repositories list scrolls:
//   - a repo of another project: Pomade switches to it, Git shows, the repo's row is in view;
//   - a collapsed side panel expands; a repo outside the target project's scope is shown in the
//     Workspace project, its row scrolled into view; the path may be a symlinked spelling;
//   - a panel drilled into another repo goes back to the list; one repo in scope shows its view;
//   - an unknown path, a folder that is not a repo, a path outside the workspace and an unknown
//     project are not-found; bad params invalid-params; without git.read capability-denied;
//   - a command over the socket: its project defaults to the Workspace project.
// Screenshots go to POMADE_TEST_T320_SHOTS when set, else e2e/artifacts/app-git-reveal/ (gitignored).

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeProjectOf, callIn, HELLO_DIR, openHelloFromMenu, setActiveProject } from './fixtures/hello-app'
import { clientAs, waitForSocket } from './fixtures/socket-client'
import { tempDir } from './fixtures/temp'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_TEST_T320_SHOTS'] || resolve(__dirname, 'artifacts/app-git-reveal')
const WORKSPACE = '__workspace__'
const REPOS = Array.from({ length: 24 }, (_, i) => `Repos/r${String(i + 1).padStart(2, '0')}`)

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
}

/** A copy of the hello fixture under its own id with the given capabilities. It ships a command
 *  (never run), so the spec may connect over the socket as that command. */
async function helloCopy(id: string, capabilities: string[]): Promise<string> {
  const dir = await tempDir(`pomade-${id}-`)
  await fs.cp(HELLO_DIR, dir, { recursive: true })
  await fs.mkdir(join(dir, 'cli'))
  await fs.writeFile(join(dir, 'cli/main.js'), '')
  const manifest = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const commands = [{ name: id, entry: 'cli/main.js' }]
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id, name: id, capabilities, commands }))
  return dir
}

/** The hello copy `appId`'s frame once its handshake has completed. */
async function frameOf(page: Page, appId: string): Promise<Frame> {
  const prefix = `pomade-app://${appId}/`
  await expect.poll(() => page.frames().some((f) => f.url().startsWith(prefix))).toBe(true)
  const frame = page.frames().find((f) => f.url().startsWith(prefix)) as Frame
  await expect.poll(() => frame.evaluate(() => window.__hello?.status ?? 'loading')).toBe('connected')
  return frame
}

test.describe('T-320 git.reveal', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dirs: string[] = []
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  const row = (root: string): ReturnType<Page['locator']> => page.getByTestId(`git-repo-row-${root}`)
  const collapse = (): Promise<void> =>
    page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().setFileTreeCollapsed(true))

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(abs('Projects/beta/lib'), { recursive: true })
    await fs.writeFile(abs('Projects/beta/lib/index.ts'), 'export {}\n')
    for (const r of ['Projects/alpha', 'Projects/beta', 'Projects/beta/lib']) gitInit(abs(r))
    for (const r of REPOS) {
      await fs.mkdir(abs(r), { recursive: true })
      gitInit(abs(r))
    }
    const gitDir = await helloCopy('hello-git-reveal', ['project.read', 'git.read'])
    const noGitDir = await helloCopy('hello-git-noread', ['project.read', 'files.read'])
    dirs = [gitDir, noGitDir]
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${gitDir};${noGitDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await openHelloFromMenu(page, 'hello-git-reveal')
    frame = await frameOf(page, 'hello-git-reveal')
    await fs.mkdir(SHOTS, { recursive: true })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
  })

  test("a repo of another project: Pomade switches to it, Git shows, the repo's row is in view", async () => {
    // From Files, in Alpha.
    expect(await activeProjectOf(page)).toBe(fixture.projects.alpha)
    await expect(page.getByTestId('side-panel-files')).toBeVisible()

    const reply = await callIn(frame, 'git.reveal', { path: abs('Projects/beta/lib'), projectId: fixture.projects.beta })
    expect(reply).toEqual({ ok: true, value: {} })

    await expect.poll(() => activeProjectOf(page)).toBe(fixture.projects.beta)
    await expect(page.getByTestId('side-panel-git')).toBeVisible()
    await expect(page.getByTestId('side-panel-files')).toBeHidden()
    await expect(page.getByTestId('git-repo-list-title')).toHaveText('Repositories in Beta')
    await expect(row('Projects/beta/lib')).toBeInViewport()
  })

  test("from a collapsed side panel: a repo outside the project's scope shows in the Workspace project, its row scrolled into view", async () => {
    await setActiveProject(page, fixture.projects.alpha)
    await collapse()
    await expect(page.getByTestId('filetree-expand')).toBeVisible()

    // The real path: a `pomade-git` run reports `GitRunResult.path` with symlinks resolved.
    const last = REPOS[REPOS.length - 1]
    const real = await fs.realpath(abs(last))
    expect(await callIn(frame, 'git.reveal', { path: `${real}/` })).toEqual({ ok: true, value: {} })

    await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
    await expect(page.getByTestId('filetree-expand')).toHaveCount(0)
    await expect(page.getByTestId('side-panel-git')).toBeVisible()
    await expect(page.getByTestId('git-repo-list-title')).toHaveText('All repositories')
    await expect(row(last)).toBeInViewport()
    // The list is longer than the panel: the reveal scrolled it.
    await expect(row(REPOS[0])).not.toBeInViewport()
    await page.screenshot({ path: `${SHOTS}/T-320-reveal-workspace.png` })
  })

  test('a panel drilled into another repo goes back to the list; a project with one repo shows its view', async () => {
    await row(REPOS[2]).click()
    await expect(page.getByTestId('git-repo-list')).toHaveCount(0)

    expect(await callIn(frame, 'git.reveal', { path: abs(REPOS[10]), projectId: WORKSPACE })).toEqual({ ok: true, value: {} })
    await expect(page.getByTestId('git-repo-list')).toBeVisible()
    await expect(row(REPOS[10])).toBeInViewport()

    expect(await callIn(frame, 'git.reveal', { path: abs('Projects/alpha'), projectId: fixture.projects.alpha })).toEqual({
      ok: true,
      value: {}
    })
    await expect.poll(() => activeProjectOf(page)).toBe(fixture.projects.alpha)
    await expect(page.getByTestId('side-panel-git')).toBeVisible()
    await expect(page.getByTestId('git-repo-list')).toHaveCount(0)
    await expect(page.getByTestId('git-panel')).toHaveAttribute('data-scope', 'Projects/alpha')
  })

  test('not-found: no repo at the path, a folder that is not a repo, outside the workspace, an unknown project; bad params invalid-params', async () => {
    await setActiveProject(page, fixture.projects.beta)
    const notFound: unknown[] = [
      { path: abs('Repos/none') },
      { path: abs('Apps/gamma') },
      { path: abs('Projects/beta/lib/index.ts') },
      { path: '/' },
      { path: abs('Projects/beta'), projectId: 'nope' }
    ]
    for (const params of notFound) {
      expect((await callIn(frame, 'git.reveal', params)).error?.code, JSON.stringify(params)).toBe('not-found')
    }
    for (const params of [{}, { path: '' }, { path: 3 }, { path: 'Projects/beta' }, { path: abs('Projects/beta'), projectId: 3 }]) {
      expect((await callIn(frame, 'git.reveal', params)).error?.code, JSON.stringify(params)).toBe('invalid-params')
    }
    expect(await activeProjectOf(page)).toBe(fixture.projects.beta)
  })

  test('without git.read: capability-denied', async () => {
    await openHelloFromMenu(page, 'hello-git-noread')
    const noRead = await frameOf(page, 'hello-git-noread')
    expect((await callIn(noRead, 'git.reveal', { path: abs('Projects/beta') })).error?.code).toBe('capability-denied')
  })

  test('over the socket: a command reveals; its project defaults to the Workspace project', async () => {
    await setActiveProject(page, fixture.projects.beta)
    await waitForSocket(fixture.userDataDir, 'hello-git-reveal')
    const host = await clientAs(fixture.userDataDir, 'hello-git-reveal', 'command')
    try {
      await host.git.reveal(abs('Projects/beta'))
      await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
      await expect(page.getByTestId('side-panel-git')).toBeVisible()
      await expect(row('Projects/beta')).toBeInViewport()
      await expect(host.git.reveal(abs('Repos/none'))).rejects.toMatchObject({ code: 'not-found' })
    } finally {
      host.close()
    }
  })
})
