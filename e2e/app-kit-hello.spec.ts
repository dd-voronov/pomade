// modules: core, tabs
// pomade-kit:E-001 acceptance in a real Pomade — the kit's own hello example, built on the kit's
// SDK (`connect()`, `files.readFolder`, `files.watch`, `project.onChange`), installed with
// `bin/pomade apps install` into the test's user data and opened in a tab. It lists the active
// project's `docs/roadmap/*.md` with their frontmatter, (E-031) shows the platform events it hears,
// and (T-209) keeps the project's group and agents lines live.
//
// e2e/fixtures/apps/kit-hello/ is the kit's `npm run hello:build` output
// (`examples/hello/dist/` of the pinned pomade-kit tag) without its backend: `backend/` is left out
// and so is the manifest's `backend` key (an installed copy cannot run it — pomade-kit:T-001; the
// backend path is app-always-on's). Everything else is vendored unchanged. Refresh it from the tag's
// source when the kit pin moves. Screenshots land in e2e/artifacts/app-kit-hello/.

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type FrameLocator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const KIT_HELLO_DIR = resolve(__dirname, 'fixtures/apps/kit-hello')
const POMADE_BIN = resolve(__dirname, '../bin/pomade')
const ARTIFACTS = resolve(__dirname, 'artifacts/app-kit-hello')

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

const ticket = (id: string, status: string, title: string): string =>
  `---\nid: ${id}\nstatus: ${status}\ntitle: ${title}\ncreated: 2026-11-09\n---\n\n# ${title}\n`

function setActiveProject(page: Page, id: string): Promise<void> {
  return page.evaluate((pid) => {
    window.__pomadeStores.useWorkspaceStore.getState()
      .setActiveProject(pid)
  }, id)
}

/** The hello table's rows as `file id status title` lines (header excluded). */
function rowTexts(frame: FrameLocator): Promise<string[]> {
  return frame
    .locator('[data-testid="rows"] tr[data-path]')
    .evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent).join(' ')))
}

test.describe('pomade-kit hello app, installed into a real Pomade', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const alpha = join(fixture.workspaceRoot, 'Projects/alpha/docs/roadmap')
    await write(join(alpha, 'E-001-sdk.md'), ticket('E-001', 'in-progress', 'SDK'))
    await write(join(alpha, 'T-002-hosting.md'), ticket('T-002', 'planned', 'Hosting'))
    await write(join(fixture.workspaceRoot, 'Projects/beta/docs/roadmap/B-010-beta.md'), ticket('B-010', 'open', 'Beta ten'))

    const out = execFileSync(POMADE_BIN, ['apps', 'install', KIT_HELLO_DIR], {
      env: { ...process.env, POMADE_USER_DATA: fixture.userDataDir },
      encoding: 'utf8'
    })
    expect(out).toContain('Hello 0.1.0 (hello)')

    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    // Every test works in this one Hello tab (a worker restarted after a failure opens it again).
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-app-hello').click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('lists the roadmap rows with frontmatter, follows a new file and a project switch', async () => {
    const frame = page.frameLocator('[data-testid="app-frame-hello"]')

    await expect(frame.getByTestId('state')).toHaveText('Project: Alpha')
    await expect(frame.getByTestId('folder')).toHaveText('Projects/alpha/docs/roadmap')
    await expect.poll(() => rowTexts(frame)).toEqual([
      'E-001-sdk.md E-001 in-progress SDK Done Open',
      'T-002-hosting.md T-002 planned Hosting Done Open'
    ])

    // A file created on disk reaches the app through its watch.
    await write(join(fixture.workspaceRoot, 'Projects/alpha/docs/roadmap/T-003-acceptance.md'), ticket('T-003', 'done', 'Acceptance'))
    await expect.poll(() => rowTexts(frame)).toEqual([
      'E-001-sdk.md E-001 in-progress SDK Done Open',
      'T-002-hosting.md T-002 planned Hosting Done Open',
      'T-003-acceptance.md T-003 done Acceptance Done Open'
    ])
    await fs.mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'kit-hello.png') })

    // A project switch re-lists: the frame (now hidden, never unmounted) gets project.changed.
    await setActiveProject(page, fixture.projects.beta)
    await expect(frame.getByTestId('state')).toHaveText('Project: Beta')
    await expect.poll(() => rowTexts(frame)).toEqual(['B-010-beta.md B-010 open Beta ten Done Open'])

    await setActiveProject(page, fixture.projects.alpha)
    await expect(frame.getByTestId('state')).toHaveText('Project: Alpha')
    await expect.poll(() => rowTexts(frame)).toHaveLength(3)
  })

  test("E-027: it says once where its shipped skill is in the installed build, and in About", async () => {
    const frame = page.frameLocator('[data-testid="app-frame-hello"]')
    const skill = join(fixture.userDataDir, 'apps', 'hello', 'skills', 'hello-roadmap')
    await expect(frame.getByTestId('skill-notice-text')).toHaveText(
      `This app ships a skill for agents: hello-roadmap, at ${skill}. To give it to an agent, copy or link that folder into the agent's skills folder.`
    )
    await fs.mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'kit-hello-skill-notice.png') })
    await frame.getByTestId('skill-notice-dismiss').click()
    await expect(frame.getByTestId('skill-notice')).toBeHidden()
    await frame.getByTestId('about-toggle').click()
    await expect(frame.locator('[data-testid="about-skills"] li[data-skill="hello-roadmap"]')).toHaveText(`hello-roadmap — ${skill}`)
    await page.screenshot({ path: join(ARTIFACTS, 'kit-hello-about.png') })
    await frame.getByTestId('about-toggle').click()
    // Dismissed for good: the app state remembers it (shared with its other frames and next runs).
    const state = JSON.parse(await fs.readFile(join(fixture.userDataDir, 'app-state', 'hello', 'state.json'), 'utf8')) as Record<string, unknown>
    expect(state.skillNoticeDismissed).toBe(true)
  })

  test('E-031: on the event bus it hears Pomade ready (subscribed after launch) and a project rename', async () => {
    const frame = page.frameLocator('[data-testid="app-frame-hello"]')
    await expect(frame.getByTestId('events')).toHaveText('Last event: Pomade ready')
    await expect(frame.getByTestId('listeners')).toHaveText('nobody listens')
    await page.evaluate((pid) => {
      window.__pomadeStores.useWorkspaceStore.getState().updateProject(pid, { name: 'Beta Prime' })
    }, fixture.projects.beta)
    await expect(frame.getByTestId('events')).toHaveText('Last event: Beta renamed to Beta Prime')
  })

  test('E-032: "Notify me" posts a notice through the SDK; its click opens the roadmap in the app’s tab', async () => {
    const frame = page.frameLocator('[data-testid="app-frame-hello"]')
    await frame.getByTestId('notify').click()
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'Roadmap ready' })
    await expect(toast.getByTestId('notice-toast-source')).toHaveText('Hello')
    await expect(toast.getByTestId('notice-toast-body')).toHaveText('3 tickets in Projects/alpha/docs/roadmap')
    await toast.getByTestId('notice-toast-open').click()
    await expect(frame.getByTestId('route')).toHaveText('Route: roadmap')
  })

  test('T-209: the group and Agents lines follow a regroup and an agent-list change without reopening', async () => {
    await setActiveProject(page, fixture.projects.alpha)
    const frame = page.frameLocator('[data-testid="app-frame-hello"]')
    await expect(frame.getByTestId('group')).toHaveText('Ungrouped')
    await expect(frame.getByTestId('agents')).toHaveText('Agents: all')
    const store = (patch: { group?: unknown; project?: unknown }): Promise<void> =>
      page.evaluate(
        ([pid, p]) => {
          const ws = window.__pomadeStores.useWorkspaceStore.getState()
          if (p.group) ws.addGroup(p.group)
          if (p.project) ws.updateProject(pid, p.project)
        },
        [fixture.projects.alpha, patch] as const
      )
    await store({ group: { id: 'grp-tools', name: 'Tools', order: 0 }, project: { groupId: 'grp-tools' } })
    await expect(frame.getByTestId('group')).toHaveText('Tools')
    await store({ project: { visibleAgents: ['claude', 'codex'] } })
    await expect(frame.getByTestId('agents')).toHaveText('Agents: claude, codex')
    await fs.mkdir(ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(ARTIFACTS, 'kit-hello-live-group-agents.png') })
    // Its own write: "Only claude" sets the agents; the event redraws the line.
    await frame.getByTestId('only-claude').click()
    await expect(frame.getByTestId('agents')).toHaveText('Agents: claude')
    // Its own settings write: the folder toggles to done/ and back.
    await write(join(fixture.workspaceRoot, 'Projects/alpha/docs/roadmap/done/T-000-old.md'), ticket('T-000', 'done', 'Old'))
    await frame.getByTestId('use-done').click()
    await expect(frame.getByTestId('folder')).toHaveText('Projects/alpha/docs/roadmap/done')
    await expect.poll(() => rowTexts(frame)).toEqual(['T-000-old.md T-000 done Old Done Open'])
    await frame.getByTestId('use-done').click()
    await expect(frame.getByTestId('folder')).toHaveText('Projects/alpha/docs/roadmap')
    await store({ project: { groupId: undefined, visibleAgents: ['*'] } })
    await expect(frame.getByTestId('group')).toHaveText('Ungrouped')
    await expect(frame.getByTestId('agents')).toHaveText('Agents: all')
  })

  test('pomade-kit:T-002: a ticket whose --- block never closes is listed red as unreadable', async () => {
    const frame = page.frameLocator('[data-testid="app-frame-hello"]')
    const path = 'Projects/alpha/docs/roadmap/T-009-unclosed.md'
    await write(join(fixture.workspaceRoot, path), '---\nid: T-009\nstatus: open\n\n# Never closed\n')
    const row = frame.locator(`[data-testid="rows"] tr[data-path="${path}"]`)
    await expect(row).toHaveText("T-009-unclosed.mdcan't read: the leading --- block is not closed")
    // Pomade's --danger (pomade-kit/tokens.css).
    await expect(row.locator('td.error')).toHaveCSS('color', 'rgb(209, 73, 91)')
    await page.screenshot({ path: join(ARTIFACTS, 'kit-hello-unclosed.png') })
    await fs.rm(join(fixture.workspaceRoot, path))
    await expect(row).toHaveCount(0)
  })

  test("T-246: on a dark Mac its tab and panel stay light like Pomade, and follow Pomade's theme", async () => {
    const tab = page.frameLocator('[data-testid="app-frame-hello"]')
    // The panel frame loads hidden at launch (startOnLaunch): every frame follows, shown or not.
    const panel = page.frameLocator('[data-testid="panel-frame-app-hello-hello"]')
    const setTheme = (theme: 'light' | 'dark'): Promise<void> =>
      app.evaluate((_e, t) => {
        globalThis.__pomadeTheme?.set(t)
      }, theme)
    await expect(tab.getByTestId('state')).toHaveText('Project: Alpha')

    // A dark Mac: the native appearance, and Chromium's media emulation (Playwright pins pages to
    // light otherwise), so `prefers-color-scheme` reads dark in every frame.
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await page.emulateMedia({ colorScheme: 'dark' })
    try {
      // The Mac's appearance reaches the frames as dark…
      await expect.poll(() => tab.locator('html').evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
      // …yet each one is light like Pomade: its theme, Pomade's --bg and --text, light native controls.
      for (const frame of [tab, panel]) {
        await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light')
        await expect(frame.locator('html')).toHaveCSS('color-scheme', 'light')
        await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(250, 251, 252)')
        await expect(frame.locator('body')).toHaveCSS('color', 'rgb(31, 41, 51)')
      }
      await fs.mkdir(ARTIFACTS, { recursive: true })
      await page.screenshot({ path: join(ARTIFACTS, 'kit-hello-dark-mac.png') })

      // Pomade's theme source flips: every frame follows; back again.
      await setTheme('dark')
      for (const frame of [tab, panel]) await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.screenshot({ path: join(ARTIFACTS, 'kit-hello-theme-dark.png') })
      await setTheme('light')
      for (const frame of [tab, panel]) await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light')
    } finally {
      await setTheme('light')
      await page.emulateMedia({ colorScheme: 'light' })
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'system'
      })
    }
  })
})
