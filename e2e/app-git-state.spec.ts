// modules: core, git, projects
// E-030 e2e — git state for apps (docs/HOST-API.md §4 `git.read`) in a real Pomade, driven through
// the raw-protocol conformance fixture (e2e/fixtures/apps/hello, copied with a manifest that
// declares `git.read`; a second copy does not). A fixture workspace whose ROOT is a local-only repo
// holding a NESTED repo (Projects/alpha, pushed to a bare remote, one commit ahead):
//   - repo identity: folder name, absolute path, branch, remote URL or null (local only); a remote
//     added or removed in .git/config shows up live
//   - git.getState: every repo, or a project's repos (plus the repo holding the project folder),
//     served from the same snapshot the tree shows; an unknown project is not-found
//   - git.watch: `git.changed` with the scope's repos after a working change and a commit; a change
//     in another repo is not delivered to a project-scoped watch; unwatch stops delivery
//   - the capability gate
// LIGHT partition: no terminal panes.

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import type { CallResult } from './fixtures/globals'
import { tempDir } from './fixtures/temp'

const HELLO_DIR = resolve(__dirname, 'fixtures/apps/hello')
const A = 'Projects/alpha'

interface GitChanged {
  watchId?: string
  repos?: Repo[]
}
interface Repo {
  name: string
  root: string
  absPath: string
  remoteUrl: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  hasCommits: boolean
  changes: { path: string; status: string; from?: string; dir?: true }[]
  error?: string
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}
function configRepo(dir: string): void {
  git(dir, 'config', 'user.email', 't@pomade.test')
  git(dir, 'config', 'user.name', 'Pomade Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

async function helloCopy(id: string, capabilities: string[]): Promise<string> {
  const dir = await tempDir(`pomade-${id}-`)
  await fs.cp(HELLO_DIR, dir, { recursive: true })
  const manifest = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id, name: id, capabilities }))
  return dir
}

async function openApp(page: Page, appId: string): Promise<Frame> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId(`tab-add-app-${appId}`).click()
  const prefix = `pomade-app://${appId}/`
  await expect.poll(() => page.frames().some((f) => f.url().startsWith(prefix))).toBe(true)
  const frame = page.frames().find((f) => f.url().startsWith(prefix)) as Frame
  await expect
    .poll(() => frame.evaluate(() => window.__hello?.status ?? 'loading'))
    .toBe('connected')
  return frame
}

function callIn(frame: Frame, method: string, params?: unknown): Promise<CallResult> {
  return frame.evaluate(
    ([m, p]) => window.__hello.call(m as string, p),
    [method, params] as const
  )
}

async function ok<T>(frame: Frame, method: string, params?: unknown): Promise<T> {
  const r = await callIn(frame, method, params)
  expect(r.error, `${method} ${JSON.stringify(params)}`).toBeUndefined()
  return r.value as T
}

/** The `git.changed` payloads delivered for one watch, in order. */
function gitEvents(frame: Frame, watchId: string): Promise<Repo[][]> {
  return frame.evaluate(
    (id) =>
      window.__hello.events
        .map((e) => ({ name: e.name, payload: e.payload as GitChanged }))
        .filter((e) => e.name === 'git.changed' && e.payload.watchId === id)
        .map((e) => e.payload.repos ?? []),
    watchId
  )
}

let fixture: Fixture
let remote: string
let alpha: string
let gitDir: string
let noGitDir: string
let app: ElectronApplication
let page: Page
let frame: Frame

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  alpha = join(root, A)

  remote = await tempDir('pomade-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  git(alpha, 'add', '-A')
  git(alpha, 'commit', '-q', '-m', 'alpha v1')
  git(alpha, 'remote', 'add', 'origin', remote)
  git(alpha, 'push', '-q', '-u', 'origin', 'main')
  await fs.writeFile(join(alpha, 'local.md'), 'not pushed\n')
  git(alpha, 'add', 'local.md')
  git(alpha, 'commit', '-q', '-m', 'alpha local')
  await fs.appendFile(join(alpha, 'README.md'), 'changed\n')

  await fs.writeFile(join(root, '.gitignore'), '.pomade/\nnode_modules/\n')
  git(root, 'init', '-q', '-b', 'main')
  configRepo(root)
  git(root, 'add', '.gitignore', 'Projects/beta')
  git(root, 'commit', '-q', '-m', 'root v1')

  gitDir = await helloCopy('hello-git', ['project.read', 'files.read', 'git.read'])
  noGitDir = await helloCopy('hello-nogit', ['project.read', 'files.read'])
  app = await launchApp(fixture, { POMADE_DEV_APPS: `${gitDir};${noGitDir}` })
  page = await firstAppWindow(app)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  frame = await openApp(page, 'hello-git')
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  for (const d of [remote, gitDir, noGitDir]) if (d) await fs.rm(d, { recursive: true, force: true })
})

test('git.getState serves every repo from the snapshot the tree shows', async () => {
  const { repos } = await ok<{ repos: Repo[] }>(frame, 'git.getState')
  expect(repos.map((r) => [r.root, r.name])).toEqual([
    ['', basename(fixture.workspaceRoot)],
    [A, 'alpha']
  ])
  const [rootRepo, alphaRepo] = repos
  expect(alphaRepo).toEqual({
    name: 'alpha',
    root: A,
    absPath: alpha,
    remoteUrl: remote,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    hasCommits: true,
    changes: [{ path: `${A}/README.md`, status: 'modified' }]
  })
  // The workspace-root repo: named after the workspace folder, no remote — local only.
  expect(rootRepo).toMatchObject({
    absPath: fixture.workspaceRoot,
    remoteUrl: null,
    branch: 'main',
    upstream: null,
    ahead: 0,
    hasCommits: true
  })
  // The nested repo's files are its own; the parent only sees its own untracked entries.
  expect(rootRepo.changes.some((c) => c.path.startsWith(`${A}/`) || c.path === A)).toBe(false)
})

test('a project scope: its repos plus the repo holding its folder; unknown is not-found', async () => {
  const alphaScope = await ok<{ repos: Repo[] }>(frame, 'git.getState', { projectId: fixture.projects.alpha })
  expect(alphaScope.repos.map((r) => r.root)).toEqual([A])
  const betaScope = await ok<{ repos: Repo[] }>(frame, 'git.getState', { projectId: fixture.projects.beta })
  expect(betaScope.repos.map((r) => r.root)).toEqual([''])
  const ws = await ok<{ repos: Repo[] }>(frame, 'git.getState', { projectId: '__workspace__' })
  expect(ws.repos).toHaveLength(2)
  expect((await callIn(frame, 'git.getState', { projectId: 'nope' })).error?.code).toBe('not-found')
  expect((await callIn(frame, 'git.watch', { projectId: 'nope' })).error?.code).toBe('not-found')
})

test('git.watch delivers the scope after a change and a commit, never another repo’s change', async () => {
  const { watchId: alphaWatch } = await ok<{ watchId: string }>(frame, 'git.watch', { projectId: fixture.projects.alpha })
  const { watchId: wsWatch } = await ok<{ watchId: string }>(frame, 'git.watch', {})

  // A change in the root repo: the workspace watch hears it; the alpha watch does not.
  await fs.writeFile(join(fixture.workspaceRoot, 'Projects/beta/README.md'), '# Beta\n\nchanged\n')
  await expect
    .poll(async () =>
      (await gitEvents(frame, wsWatch))
        .at(-1)
        ?.find((r) => r.root === '')
        ?.changes.some((c) => c.path === 'Projects/beta/README.md' && c.status === 'modified')
    )
    .toBe(true)
  expect(await gitEvents(frame, alphaWatch)).toEqual([])

  // A new file in alpha, then a commit of everything: the alpha watch follows both.
  await fs.writeFile(join(alpha, 'new.md'), 'new\n')
  await expect
    .poll(async () => (await gitEvents(frame, alphaWatch)).at(-1)?.[0]?.changes.map((c) => c.path).sort())
    .toEqual([`${A}/README.md`, `${A}/new.md`])
  git(alpha, 'add', '-A')
  git(alpha, 'commit', '-q', '-m', 'alpha more')
  await expect
    .poll(async () => {
      const last = (await gitEvents(frame, alphaWatch)).at(-1)?.[0]
      return last && { ahead: last.ahead, changes: last.changes }
    })
    .toEqual({ ahead: 2, changes: [] })
  // Every alpha delivery is scoped to alpha.
  for (const repos of await gitEvents(frame, alphaWatch)) expect(repos.map((r) => r.root)).toEqual([A])

  // Unwatched: nothing more for it.
  await ok(frame, 'git.unwatch', { watchId: alphaWatch })
  const delivered = (await gitEvents(frame, alphaWatch)).length
  await fs.writeFile(join(alpha, 'after.md'), 'after\n')
  await expect
    .poll(async () => (await gitEvents(frame, wsWatch)).at(-1)?.find((r) => r.root === A)?.changes.map((c) => c.path))
    .toEqual([`${A}/after.md`])
  expect(await gitEvents(frame, alphaWatch)).toHaveLength(delivered)
})

test('a remote added to .git/config shows up live (the git-meta tap); removing it is local only again', async () => {
  const { watchId } = await ok<{ watchId: string }>(frame, 'git.watch', { projectId: fixture.projects.beta })
  const url = 'https://example.com/workspace.git'
  git(fixture.workspaceRoot, 'remote', 'add', 'origin', url)
  await expect.poll(async () => (await gitEvents(frame, watchId)).at(-1)?.[0]?.remoteUrl).toBe(url)
  git(fixture.workspaceRoot, 'remote', 'remove', 'origin')
  await expect.poll(async () => (await gitEvents(frame, watchId)).at(-1)?.[0]?.remoteUrl).toBeNull()
  await ok(frame, 'git.unwatch', { watchId })
})

test('an app without git.read is refused', async () => {
  const noGit = await openApp(page, 'hello-nogit')
  for (const [m, p] of [
    ['git.getState', {}],
    ['git.watch', {}],
    ['git.unwatch', { watchId: 'g1' }]
  ] as const) {
    expect((await callIn(noGit, m, p)).error?.code).toBe('capability-denied')
  }
})
