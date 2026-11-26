// modules: core, projects
// T-324 e2e — `project.activate` (docs/HOST-API.md §4 `project.activate`, capability `tabs.open`) in a real
// Pomade, driven through the raw-protocol conformance fixture (e2e/fixtures/apps/hello, copied with a
// manifest that declares `tabs.open`; a second copy does not) and over the socket as a command:
//   - another project becomes active with its own active tab shown, the tab lists of both projects
//     unchanged, and `project.changed` reaches the app's frame; the Workspace project id works;
//   - the active project again answers {} and changes nothing (no second `project.changed`);
//   - the switch is one Pomade makes on its own: the Projects panel unfolds the project's group and
//     shows its row (T-311);
//   - an unknown id is not-found, a bad param invalid-params, and neither changes the active project;
//     without `tabs.open` it is capability-denied;
//   - a command over the socket activates a project too.
// Screenshots go to POMADE_TEST_T324_SHOTS when set, else e2e/artifacts/app-project-activate/ (gitignored).

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import {
  activeProjectOf,
  activeTabOf,
  callIn,
  eventsOf,
  HELLO_DIR,
  openHelloFromMenu,
  setActiveProject,
  tabsOf
} from './fixtures/hello-app'
import { clientAs, waitForSocket } from './fixtures/socket-client'
import { tempDir } from './fixtures/temp'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env['POMADE_TEST_T324_SHOTS'] || resolve(__dirname, 'artifacts/app-project-activate')
const WORKSPACE = '__workspace__'
const FOLDED = 'grp-folded'
const FAR = 'proj-far'

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

test.describe('T-324 project.activate', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dirs: string[] = []
  let alpha: string
  let beta: string
  let readmeTab: string

  const tabIdsOf = async (projectId: string): Promise<string[]> => (await tabsOf(page, projectId)).map((t) => t.id)
  const changedTo = async (): Promise<string[]> => (await eventsOf(frame, 'project.changed')).map((p) => (p as { id: string }).id)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta
    // Filler projects above a folded group, so the far project's row sits below the panel's fold.
    const fillers = Array.from({ length: 40 }, (_, i) => ({
      id: `proj-fill-${i}`,
      name: `Filler ${i}`,
      rootPath: 'Projects/beta',
      groupId: 'grp-fillers',
      visibleAgents: ['*'],
      order: i
    }))
    const config = {
      groups: [
        { id: 'grp-fillers', name: 'Fillers', order: 0 },
        { id: FOLDED, name: 'Folded', order: 1 }
      ],
      ungroupedOrder: 2,
      projects: [
        ...fillers,
        { id: FAR, name: 'Far', rootPath: 'Apps/gamma', groupId: FOLDED, visibleAgents: ['*'], order: 0 },
        { id: alpha, name: 'Alpha', rootPath: 'Projects/alpha', visibleAgents: ['*'], order: 0 },
        { id: beta, name: 'Beta', rootPath: 'Projects/beta', visibleAgents: ['*'], order: 1 }
      ]
    }
    await fs.writeFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), JSON.stringify(config, null, 2))
    const activateDir = await helloCopy('hello-activate', ['project.read', 'tabs.open'])
    const plainDir = await helloCopy('hello-activate-plain', ['project.read', 'project.write', 'files.read'])
    dirs = [activateDir, plainDir]
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${activateDir};${plainDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()
    await openHelloFromMenu(page, 'hello-activate')
    frame = await frameOf(page, 'hello-activate')
    await fs.mkdir(SHOTS, { recursive: true })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
  })

  test("another project becomes active with its own active tab shown; both projects' tabs stay as they were; project.changed reaches the frame", async () => {
    // Beta holds two file tabs, the older one (README) active; the app's frame lives in Alpha.
    expect(await callIn(frame, 'tabs.openFile', { path: 'Projects/beta/README.md', projectId: beta })).toEqual({ ok: true, value: {} })
    expect(await callIn(frame, 'tabs.openFile', { path: 'Projects/beta/data.csv', projectId: beta })).toEqual({ ok: true, value: {} })
    await expect.poll(async () => (await tabsOf(page, beta)).length).toBe(2)
    readmeTab = (await tabsOf(page, beta))[0].id
    await page.evaluate(([project, id]) => window.__pomadeStores.useTabsStore.getState().setActive(project, id), [beta, readmeTab])
    await setActiveProject(page, alpha)
    await expect.poll(() => activeProjectOf(page)).toBe(alpha)

    const alphaTabs = await tabIdsOf(alpha)
    const betaTabs = await tabIdsOf(beta)
    const alphaActive = await activeTabOf(page, alpha)
    const before = (await changedTo()).length

    expect(await callIn(frame, 'project.activate', { projectId: beta })).toEqual({ ok: true, value: {} })

    await expect.poll(() => activeProjectOf(page)).toBe(beta)
    await expect(page.getByTestId(`tab-${readmeTab}`)).toHaveAttribute('data-active', 'true')
    expect(await activeTabOf(page, beta)).toBe(readmeTab)
    expect(await tabIdsOf(beta)).toEqual(betaTabs)
    expect(await tabIdsOf(alpha)).toEqual(alphaTabs)
    expect(await activeTabOf(page, alpha)).toBe(alphaActive)
    await expect.poll(async () => (await changedTo()).slice(before)).toEqual([beta])
    await page.screenshot({ path: `${SHOTS}/T-324-activated.png` })
  })

  test('the project already active: {} and nothing changes, no second project.changed', async () => {
    const tabs = await tabIdsOf(beta)
    const before = (await changedTo()).length
    expect(await callIn(frame, 'project.activate', { projectId: beta })).toEqual({ ok: true, value: {} })
    expect(await activeProjectOf(page)).toBe(beta)
    expect(await tabIdsOf(beta)).toEqual(tabs)
    expect(await activeTabOf(page, beta)).toBe(readmeTab)
    expect(await changedTo()).toHaveLength(before)
  })

  test('the Workspace project id works, and its tabs stay as they are', async () => {
    const tabs = await tabIdsOf(WORKSPACE)
    expect(await callIn(frame, 'project.activate', { projectId: WORKSPACE })).toEqual({ ok: true, value: {} })
    await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
    expect(await tabIdsOf(WORKSPACE)).toEqual(tabs)
    expect((await changedTo()).at(-1)).toBe(WORKSPACE)
  })

  test("the switch is Pomade's own: the Projects panel unfolds the project's group and shows its row", async () => {
    await page.evaluate((g) => {
      const ui = window.__pomadeStores.useWorkspaceUiStore.getState()
      if (!ui.isCollapsed(g)) ui.toggleGroupCollapsed(g)
    }, FOLDED)
    await expect(page.getByTestId(`group-collapse-${FOLDED}`)).toHaveAttribute('aria-expanded', 'false')
    await page.getByTestId('projects-panel-scroll').evaluate((el) => (el.scrollTop = 0))
    await expect(page.getByTestId(`project-${FAR}`)).toHaveCount(0)

    expect(await callIn(frame, 'project.activate', { projectId: FAR })).toEqual({ ok: true, value: {} })

    await expect.poll(() => activeProjectOf(page)).toBe(FAR)
    await expect(page.getByTestId(`group-collapse-${FOLDED}`)).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId(`project-${FAR}`)).toBeInViewport()
    await page.screenshot({ path: `${SHOTS}/T-324-panel-revealed.png` })
  })

  test('not-found for an unknown or empty id, invalid-params for a missing or non-string one; the active project stays', async () => {
    for (const params of [{ projectId: 'nope' }, { projectId: '' }]) {
      expect((await callIn(frame, 'project.activate', params)).error?.code, JSON.stringify(params)).toBe('not-found')
    }
    for (const params of [{}, { projectId: 3 }, { projectId: null }, { id: beta }, undefined]) {
      expect((await callIn(frame, 'project.activate', params)).error?.code, JSON.stringify(params)).toBe('invalid-params')
    }
    expect(await activeProjectOf(page)).toBe(FAR)
  })

  test('without tabs.open: capability-denied, even with project.write', async () => {
    await openHelloFromMenu(page, 'hello-activate-plain')
    const plain = await frameOf(page, 'hello-activate-plain')
    const active = await activeProjectOf(page)
    expect((await callIn(plain, 'project.activate', { projectId: alpha })).error?.code).toBe('capability-denied')
    expect(await activeProjectOf(page)).toBe(active)
  })

  test('over the socket: a command activates a project; an unknown id is not-found', async () => {
    await setActiveProject(page, alpha)
    await waitForSocket(fixture.userDataDir, 'hello-activate')
    const host = await clientAs(fixture.userDataDir, 'hello-activate', 'command')
    try {
      await host.project.activate(beta)
      await expect.poll(() => activeProjectOf(page)).toBe(beta)
      await expect(host.project.activate('nope')).rejects.toMatchObject({ code: 'not-found' })
      expect(await activeProjectOf(page)).toBe(beta)
    } finally {
      host.close()
    }
  })
})
