// modules: core, tabs
// E-027 / E-030 e2e — app hosting and the Host API (docs/HOST-API.md). The protocol-conformance
// fixture app (e2e/fixtures/apps/hello, plain JS speaking the raw protocol) runs in a real Pomade
// against a fixture workspace: dev-linked through POMADE_DEV_APPS, and installed / updated /
// removed through `bin/pomade apps` against the test's own user data. Also: the app standalone in
// plain Chromium. Screenshots land in e2e/artifacts/app-hosting/ (gitignored).

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { chromium, expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import type { CallResult, HelloState } from './fixtures/globals'
import { tempDir } from './fixtures/temp'

const HELLO_DIR = resolve(__dirname, 'fixtures/apps/hello')
const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const ARTIFACTS = resolve(__dirname, 'artifacts/app-hosting')

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

const md = (fm: string, body = 'Body.\n'): string => `---\n${fm}\n---\n\n${body}`

/** Roadmap folders the hello app lists (`<project root>/roadmap`, recursive). */
async function seedRoadmaps(f: Fixture): Promise<void> {
  const alpha = join(f.workspaceRoot, 'Projects/alpha/roadmap')
  await write(join(alpha, 'T-001.md'), md('id: T-001\ntitle: First\nstatus: open\ncreated: 2026-11-09'))
  await write(join(alpha, 'T-002.md'), md('id: T-002\ntitle: Second\nstatus: doing'))
  await write(join(alpha, 'broken.md'), md('id: [unclosed\ntitle: Broken'))
  await write(join(alpha, 'done/T-000.md'), md('id: T-000\ntitle: Zero\nstatus: done'))
  await write(join(alpha, 'notes.txt'), 'not markdown\n')
  // On the workspace's ignored items: never listed.
  await write(join(alpha, 'node_modules/hidden.md'), md('id: HIDDEN'))
  await write(join(f.workspaceRoot, 'Projects/beta/roadmap/B-010.md'), md('id: B-010\ntitle: Beta ten\nstatus: open'))
}

function appFrame(page: Page, appId: string): Frame {
  const frame = page.frames().find((f) => f.url().startsWith(`pomade-app://${appId}/`))
  if (!frame) throw new Error(`no frame for ${appId}`)
  return frame
}

async function waitFrame(page: Page, appId: string): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url().startsWith(`pomade-app://${appId}/`))).toBe(true)
  const frame = appFrame(page, appId)
  await expect
    .poll(() => frame.evaluate(() => window.__hello?.status ?? 'loading'))
    .toBe('connected')
  return frame
}

function hello<T>(frame: Frame, fn: (s: HelloState) => T): Promise<T> {
  return frame.evaluate(
    (src) => {
      const s = window.__hello
      return (new Function('s', `return (${src})(s)`) as (s: HelloState) => T)(s)
    },
    fn.toString()
  )
}

function rowPaths(frame: Frame): Promise<string[]> {
  return hello(frame, (s) => s.rows.map((r) => r.path))
}

function callIn(frame: Frame, method: string, params?: unknown): Promise<CallResult> {
  return frame.evaluate(
    ([m, p]) => window.__hello.call(m as string, p),
    [method, params] as const
  )
}

async function openFromMenu(page: Page, appId: string): Promise<void> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId(`tab-add-app-${appId}`).click()
}

function setActiveProject(page: Page, id: string): Promise<void> {
  return page.evaluate((pid) => {
    window.__pomadeStores.useWorkspaceStore.getState()
      .setActiveProject(pid)
  }, id)
}

const ALPHA_ROWS = [
  'Projects/alpha/roadmap/T-001.md',
  'Projects/alpha/roadmap/T-002.md',
  'Projects/alpha/roadmap/broken.md',
  'Projects/alpha/roadmap/done/T-000.md'
]

test.describe('E-027 hello app, dev-linked through POMADE_DEV_APPS', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let nocapDir: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedRoadmaps(fixture)
    // A second app without files.read, for the capability gate.
    nocapDir = await tempDir('pomade-nocap-')
    await fs.cp(HELLO_DIR, nocapDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(nocapDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(nocapDir, 'manifest.json'),
      JSON.stringify({ ...manifest, id: 'hello-nocap', name: 'Hello (no files)', capabilities: ['project.read'] })
    )
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${HELLO_DIR};${nocapDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(nocapDir, { recursive: true, force: true })
  })

  test('the new-tab menu lists the app; it opens in a tab with its manifest icon', async () => {
    await page.getByTestId('tab-add').click()
    const item = page.getByTestId('tab-add-app-hello')
    await expect(item).toBeVisible()
    await expect(item).toContainText('Hello')
    await item.click()
    const frame = await waitFrame(page, 'hello')
    expect(await hello(frame, (s) => s.project)).toEqual({
      id: fixture.projects.alpha,
      kind: 'project',
      name: 'Alpha',
      root: 'Projects/alpha'
    })
    await expect(page.getByTestId('tabstrip').getByTestId('app-icon-hello')).toBeVisible()
  })

  test('lists frontmatter rows recursively, reports invalid YAML, honors the ignored items', async () => {
    const frame = appFrame(page, 'hello')
    await expect.poll(() => rowPaths(frame)).toEqual(ALPHA_ROWS)
    const rows = await hello(frame, (s) => s.rows)
    expect(rows[0]).toMatchObject({ id: 'T-001', title: 'First', status: 'open', error: null })
    // The YAML parser's reason, one line.
    expect(rows[2].error).toMatch(/^missed comma between flow collection entries \(2:1\)$/)
    expect(rows[3]).toMatchObject({ id: 'T-000', status: 'done' })
    // Dates stay strings across postMessage.
    const res = await callIn(frame, 'files.readFolder', { path: 'Projects/alpha/roadmap', frontmatter: true })
    const entries = (res.value as { entries: { name: string; frontmatter?: Record<string, unknown> }[] }).entries
    expect(entries.find((e) => e.name === 'T-001.md')?.frontmatter?.created).toBe('2026-11-09')
    // Non-recursive: the done/ folder is listed, its contents are not.
    expect(entries.map((e) => e.name)).toEqual(['T-001.md', 'T-002.md', 'broken.md', 'done', 'notes.txt'])
    // The rows are painted in the frame (not only in its state) before the screenshot.
    await expect(page.frameLocator('[data-testid="app-frame-hello"]').locator('tr[data-path]')).toHaveCount(4)
    await fs.mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'app-tab.png') })
  })

  test('host.info and project.getActive answer per the contract', async () => {
    const frame = appFrame(page, 'hello')
    const info = await callIn(frame, 'host.info')
    expect(info).toMatchObject({ ok: true, value: { hostApi: 0, appId: 'hello', surface: 'tab', route: '' } })
    expect((info.value as { icon?: string }).icon).toBeUndefined()
    const active = await callIn(frame, 'project.getActive')
    expect(active.value).toMatchObject({ id: fixture.projects.alpha, kind: 'project' })
  })

  test('a `..` path is outside-workspace; a file path is io-error; a missing one not-found', async () => {
    const frame = appFrame(page, 'hello')
    expect((await callIn(frame, 'files.readFolder', { path: '../x' })).error?.code).toBe('outside-workspace')
    expect((await callIn(frame, 'files.readFolder', { path: '/etc' })).error?.code).toBe('outside-workspace')
    expect((await callIn(frame, 'files.readFolder', { path: 'todo.txt' })).error?.code).toBe('io-error')
    expect((await callIn(frame, 'files.readFolder', { path: 'nope' })).error?.code).toBe('not-found')
    expect((await callIn(frame, 'files.watch', { path: 'nope' })).error?.code).toBe('not-found')
    expect((await callIn(frame, 'files.unwatch', { watchId: 'w-unknown' })).value).toEqual({})
    expect((await callIn(frame, 'files.erase', { path: 'x' })).error?.code).toBe('unknown-method')
  })

  test('a file created on disk shows up within ~1 s', async () => {
    const frame = appFrame(page, 'hello')
    await write(join(fixture.workspaceRoot, 'Projects/alpha/roadmap/T-003.md'), md('id: T-003\ntitle: Third'))
    await expect
      .poll(() => rowPaths(frame), { timeout: 2000 })
      .toContain('Projects/alpha/roadmap/T-003.md')
  })

  test('survives project switches with JS state intact and follows the project while hidden', async () => {
    const frame = appFrame(page, 'hello')
    const mark = await hello(frame, (s) => s.mark)
    await setActiveProject(page, fixture.projects.beta)
    // Hidden (another project is active) — still mounted, and it re-lists for Beta.
    await expect(page.getByTestId('app-frame-hello')).toBeHidden()
    await expect.poll(() => rowPaths(frame)).toEqual(['Projects/beta/roadmap/B-010.md'])
    expect(await hello(frame, (s) => s.events.filter((e) => e.name === 'project.changed').length)).toBe(1)
    await setActiveProject(page, fixture.projects.alpha)
    await expect(page.getByTestId('app-frame-hello')).toBeVisible()
    await expect.poll(() => rowPaths(frame)).toContain('Projects/alpha/roadmap/T-001.md')
    expect(await hello(frame, (s) => s.mark)).toBe(mark)
  })

  test('a Pomade renderer shortcut works while the app frame has focus (forwarded, runs once)', async () => {
    await page.frameLocator('[data-testid="app-frame-hello"]').locator('h1').click()
    // The app frame is an out-of-process iframe: focus reaches it asynchronously after the click.
    // Pressing before it lands would send the chord to Pomade's own document, testing nothing.
    await expect.poll(() => appFrame(page, 'hello').evaluate(() => document.hasFocus())).toBe(true)
    // Cmd+Shift+H (document history) with an app tab in front explains itself in one toast.
    const toast = page.getByTestId('toast').filter({ hasText: 'Open a saved document to see its history' })
    await page.keyboard.press('Meta+Shift+H')
    await expect(toast).toHaveCount(1)
    await expectQuiet(() => expect(toast).toHaveCount(1, { timeout: 50 }), 300)
    await toast.click()
  })

  test('a call without the capability is capability-denied', async () => {
    await openFromMenu(page, 'hello-nocap')
    const frame = await waitFrame(page, 'hello-nocap')
    const res = await callIn(frame, 'files.readFolder', { path: 'Projects/alpha/roadmap' })
    expect(res.error?.code).toBe('capability-denied')
    expect((await callIn(frame, 'project.getActive')).ok).toBe(true)
  })
})

test.describe('E-027 hello app, installed with `pomade apps`', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let buildDir: string

  const pomade = (...args: string[]): string =>
    execFileSync(POMADE_BIN, args, {
      env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir },
      encoding: 'utf8'
    })
  /** Every entry under the fixture workspace's Agents folder (links listed as links, never followed). */
  const agentsTree = async (): Promise<string[]> =>
    (await fs.readdir(join(fixture.workspaceRoot, 'Agents'), { recursive: true, withFileTypes: true }))
      .map((e) => `${join(e.parentPath, e.name)}${e.isSymbolicLink() ? ' -> link' : ''}`)
      .sort()

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedRoadmaps(fixture)
    buildDir = await tempDir('pomade-hello-build-')
    await fs.cp(HELLO_DIR, buildDir, { recursive: true })
    const agentsBefore = await agentsTree()
    const out = pomade('apps', 'install', buildDir)
    expect(out).toContain('Hello 0.1.0 (hello)')
    expect(out).toContain('Shortcuts:     Open the board Cmd+Shift+Y (tab "board"), Open the roadmap Cmd+Alt+P (tab "roadmap/T-001"), Close Cmd+W (tab), Quick add Cmd+Shift+J (overlay "quick-add")')
    expect(out).toContain('Shortcut conflicts — Pomade wins, these do nothing: Cmd+W ("Close") is Pomade\'s Close Tab')
    expect(out).not.toContain('Not supported by this Pomade yet')
    expect(out).toContain('Skills:        hello-roadmap (skills/hello-roadmap)')
    // The skill is reported where it lives in the installed build; Pomade links it nowhere.
    expect(out).toContain(
      `Skill hello-roadmap is at ${join(fixture.userDataDir, 'apps/hello/skills/hello-roadmap')}. To give it to an agent, copy or link this folder into the agent's skills folder.`
    )
    expect(await agentsTree()).toEqual(agentsBefore)
    expect(out).toContain('Strip icons:   Hello panel (panel), Hello tab (tab), Hello board (both)')
    expect(out).toContain('Tab kinds:     Output')
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(buildDir, { recursive: true, force: true })
  })

  test('opens in a tab and lists frontmatter rows', async () => {
    expect(pomade('apps', 'list')).toMatch(/hello\s+0\.1\.0\s+Hello/)
    await openFromMenu(page, 'hello')
    const frame = await waitFrame(page, 'hello')
    await expect.poll(() => rowPaths(frame)).toEqual(ALPHA_ROWS)
  })

  test('a reinstall updates the open tab without a restart', async () => {
    const before = await hello(appFrame(page, 'hello'), (s) => s.mark)
    await fs.writeFile(join(buildDir, 'index.html'), (await fs.readFile(join(buildDir, 'index.html'), 'utf8')).replace('<h1>Hello</h1>', '<h1>Hello v2</h1>'))
    const manifest = JSON.parse(await fs.readFile(join(buildDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(join(buildDir, 'manifest.json'), JSON.stringify({ ...manifest, version: '0.2.0' }))
    expect(pomade('apps', 'install', buildDir)).toContain('Updated into')
    await expect(page.frameLocator('[data-testid="app-frame-hello"]').locator('h1')).toHaveText('Hello v2')
    const frame = await waitFrame(page, 'hello')
    expect(await hello(frame, (s) => s.mark)).not.toBe(before)
    await expect.poll(() => rowPaths(frame)).toEqual(ALPHA_ROWS)
  })

  test('removal shows "App unavailable"; Pomade is unaffected', async () => {
    const tabId = await page.evaluate(() => {
      const s = window.__pomadeStores.useTabsStore.getState()
      return Object.values(s.tabsByProject).flat().find((t) => t.kind === 'app')?.id ?? ''
    })
    expect(pomade('apps', 'remove', 'hello')).toContain('Removed hello')
    const unavailable = page.getByTestId(`app-unavailable-${tabId}`)
    await expect(unavailable).toBeVisible()
    await expect(page.getByTestId(`app-unavailable-${tabId}-reason`)).toContainText('not installed')
    await expect(page.getByTestId('app-frame-hello')).toHaveCount(0)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId('tab-add').click()
    await expect(page.getByTestId('tab-add-app-hello')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await fs.mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'app-unavailable.png') })
  })

  test('reinstalling brings the same tab back', async () => {
    pomade('apps', 'install', buildDir)
    await waitFrame(page, 'hello')
    await expect(page.frameLocator('[data-testid="app-frame-hello"]').locator('h1')).toHaveText('Hello v2')
  })

  test('T-244 a reinstall that renames strip icons retitles their open tabs; a tab the user named keeps its name', async () => {
    const alpha = fixture.projects.alpha
    const appTabs = (): Promise<{ id: string; icon?: string; title: string }[]> =>
      page.evaluate((pid) => {
        const s = window.__pomadeStores.useTabsStore.getState()
        return s.tabsFor(pid).filter((t) => t.kind === 'app').map((t) => ({ id: t.id, icon: t.icon, title: t.title }))
      }, alpha)
    await page.getByTestId('strip-app-hello-tab').click()
    await page.getByTestId('strip-app-hello-both').click()
    await expect.poll(async () => (await appTabs()).map((t) => t.title).sort()).toEqual(['Hello', 'Hello board', 'Hello tab'])
    const tabs = await appTabs()
    const iconTab = tabs.find((t) => t.icon === 'tab')!
    const boardTab = tabs.find((t) => t.icon === 'both')!
    const plainTab = tabs.find((t) => t.icon === undefined)!

    // The user names the board tab: from then on it is theirs.
    await page.getByTestId(`tab-title-${boardTab.id}`).dblclick()
    const input = page.getByTestId(`tab-rename-input-${boardTab.id}`)
    await input.fill('My board')
    await input.press('Enter')
    await expect(page.getByTestId(`tab-title-${boardTab.id}`)).toHaveText('My board')

    const manifest = JSON.parse(await fs.readFile(join(buildDir, 'manifest.json'), 'utf8')) as {
      name: string
      strip: { id: string; title: string }[]
    }
    const strip = manifest.strip.map((s) =>
      s.id === 'tab' ? { ...s, title: 'Hello sheet' } : s.id === 'both' ? { ...s, title: 'Hello kanban' } : s
    )
    await fs.writeFile(join(buildDir, 'manifest.json'), JSON.stringify({ ...manifest, name: 'Hello there', strip }))
    expect(pomade('apps', 'install', buildDir)).toContain('Updated into')

    await expect(page.getByTestId(`tab-title-${iconTab.id}`)).toHaveText('Hello sheet')
    await expect(page.getByTestId(`tab-title-${plainTab.id}`)).toHaveText('Hello there')
    await expect(page.getByTestId('strip-app-hello-both')).toHaveAttribute('aria-label', 'Hello kanban')
    await expect(page.getByTestId(`tab-title-${boardTab.id}`)).toHaveText('My board')
    expect(await appTabs()).toEqual(
      expect.arrayContaining([
        { id: iconTab.id, icon: 'tab', title: 'Hello sheet' },
        { id: boardTab.id, icon: 'both', title: 'My board' },
        { id: plainTab.id, title: 'Hello there' }
      ])
    )
    await fs.mkdir(ARTIFACTS, { recursive: true })
    await page.getByTestId('tabstrip').screenshot({ path: join(ARTIFACTS, 'retitled-tabs.png') })
  })
})

test.describe('E-027 hello app standalone', () => {
  test('opened in plain Chromium it shows "no Pomade host"', async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.goto(pathToFileURL(join(HELLO_DIR, 'index.html')).href)
      await expect(page.locator('#status')).toHaveText('Running standalone — no Pomade host', { timeout: 4000 })
      await fs.mkdir(ARTIFACTS, { recursive: true })
      await page.screenshot({ path: join(ARTIFACTS, 'standalone.png') })
    } finally {
      await browser.close()
    }
  })
})
