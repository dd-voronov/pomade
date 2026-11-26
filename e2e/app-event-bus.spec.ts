// modules: core, tabs
// E-031 e2e — the event bus (docs/HOST-API.md §4 `events`): platform events (Pomade ready —
// sticky —, project created / renamed / removed / opened / changed, the Workspace project included),
// app events from one app to another app's frames (hidden ones too) and to the publisher's own
// other frames when it subscribes to its own event, subscription-aware publishing
// (`events.hasSubscribers`, `events.subscribersChanged`), the manifest gate, subscriptions
// ending with the frame, and `project.updated` (a project's group, visible agents or one app's
// settings changed). Two apps: the hello fixture and a copy of it with another id.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { callIn, connectedFrame, eventsOf, HELLO_DIR, openHelloFromMenu, setActiveProject } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

test.describe('E-031 event bus', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let otherDir: string
  let eventLog: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    otherDir = await tempDir('pomade-hello-other-')
    await fs.cp(HELLO_DIR, otherDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(otherDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(otherDir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        id: 'hello-other',
        name: 'Hello (other)',
        capabilities: [...(manifest.capabilities as string[]), 'project.write'],
        strip: [],
        shortcuts: [],
        events: { publish: ['pinged'], subscribe: ['hello:pinged', 'project.renamed', 'project.updated'] }
      })
    )
    eventLog = join(fixture.userDataDir, 'bus-events.jsonl')
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${HELLO_DIR};${otherDir}`, POMADE_TEST_EVENT_LOG: eventLog })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(otherDir, { recursive: true, force: true })
  })

  async function loggedEvents(): Promise<{ name: string; payload: unknown }[]> {
    const text = await fs.readFile(eventLog, 'utf8').catch(() => '')
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; payload: unknown })
  }

  async function helloTab(): Promise<Frame> {
    if ((await page.getByTestId('app-frame-hello').count()) === 0) await openHelloFromMenu(page)
    return connectedFrame(page.getByTestId('app-frame-hello'))
  }

  async function otherTab(): Promise<Frame> {
    if ((await page.getByTestId('app-frame-hello-other').count()) === 0) await openHelloFromMenu(page, 'hello-other')
    return connectedFrame(page.getByTestId('app-frame-hello-other'))
  }

  const ref = (id: string, name: string, root: string) => ({ id, kind: 'project', name, root })
  const ALPHA = (): ReturnType<typeof ref> => ref(fixture.projects.alpha, 'Alpha', 'Projects/alpha')
  const WORKSPACE = { id: '__workspace__', kind: 'workspace', name: 'Workspace', root: '' }

  test('Pomade ready fires once the tabs are restored, then the launch project counts as opened', async () => {
    await expect.poll(async () => (await loggedEvents()).map((e) => e.name)).toContain('pomade.ready')
    const log = await loggedEvents()
    const ready = log.findIndex((e) => e.name === 'pomade.ready')
    // The launch scope (no remembered project: the Workspace project) is opened right after ready.
    expect(log.slice(ready)).toEqual([
      { name: 'pomade.ready', payload: {} },
      { name: 'project.opened', payload: WORKSPACE }
    ])
    expect(log.filter((e) => e.name === 'project.created' || e.name === 'project.removed')).toEqual([])
  })

  test('a frame that subscribes after ready gets it at once (sticky), exactly once', async () => {
    await setActiveProject(page, fixture.projects.alpha)
    const tab = await helloTab()
    expect(await callIn(tab, 'events.subscribe', { name: 'pomade.ready' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => eventsOf(tab, 'pomade.ready')).toEqual([{}])
    expect(await callIn(tab, 'events.subscribe', { name: 'pomade.ready' })).toEqual({ ok: true, value: {} })
    // A sticky delivery would follow its subscribe's answer before any later call's answer.
    await callIn(tab, 'host.info')
    expect(await eventsOf(tab, 'pomade.ready')).toEqual([{}])
  })

  test('project created and renamed reach subscribers; the active project rename is also project.changed', async () => {
    const tab = await helloTab()
    await callIn(tab, 'events.subscribe', { name: 'project.created' })
    await callIn(tab, 'events.subscribe', { name: 'project.renamed' })
    const changedBefore = (await eventsOf(tab, 'project.changed')).length

    await page.evaluate(() => {
      const ws = window.__pomadeStores.useWorkspaceStore.getState()
      ws.addProject({ id: 'proj-gamma', name: 'Gamma', rootPath: 'Apps/gamma', visibleAgents: ['*'], order: 2 })
    })
    await expect.poll(() => eventsOf(tab, 'project.created')).toEqual([ref('proj-gamma', 'Gamma', 'Apps/gamma')])

    const rename = (id: string, name: string): Promise<void> =>
      page.evaluate(
        ([pid, n]) => {
          window.__pomadeStores.useWorkspaceStore.getState().updateProject(pid, { name: n })
        },
        [id, name] as const
      )
    await rename('proj-gamma', 'Gamma 2')
    await expect
      .poll(() => eventsOf(tab, 'project.renamed'))
      .toEqual([{ project: ref('proj-gamma', 'Gamma 2', 'Apps/gamma'), previous: ref('proj-gamma', 'Gamma', 'Apps/gamma') }])
    // Gamma is not active: no project.changed for it.
    expect(await eventsOf(tab, 'project.changed')).toHaveLength(changedBefore)

    await rename(fixture.projects.alpha, 'Alpha 2')
    const alpha2 = ref(fixture.projects.alpha, 'Alpha 2', 'Projects/alpha')
    await expect.poll(async () => (await eventsOf(tab, 'project.renamed')).at(-1)).toEqual({ project: alpha2, previous: ALPHA() })
    await expect.poll(async () => (await eventsOf(tab, 'project.changed')).at(-1)).toEqual(alpha2)
    await rename(fixture.projects.alpha, 'Alpha')
    await expect.poll(async () => (await eventsOf(tab, 'project.changed')).at(-1)).toEqual(ALPHA())
  })

  test('project removed: subscribers get the project as it was; the id is gone from the list', async () => {
    const tab = await helloTab()
    expect(await callIn(tab, 'events.subscribe', { name: 'project.removed' })).toEqual({ ok: true, value: {} })
    const changedBefore = (await eventsOf(tab, 'project.changed')).length
    await page.evaluate(() => {
      window.__pomadeStores.useWorkspaceStore.getState().deleteProject('proj-gamma')
    })
    await expect.poll(() => eventsOf(tab, 'project.removed')).toEqual([ref('proj-gamma', 'Gamma 2', 'Apps/gamma')])
    await expect
      .poll(async () => (await loggedEvents()).filter((e) => e.name === 'project.removed'))
      .toEqual([{ name: 'project.removed', payload: ref('proj-gamma', 'Gamma 2', 'Apps/gamma') }])
    // Gamma was not active: the active project did not change.
    expect(await eventsOf(tab, 'project.changed')).toHaveLength(changedBefore)
    const listed = await callIn(tab, 'project.list')
    expect((listed.value as { projects: { id: string }[] }).projects.map((p) => p.id)).not.toContain('proj-gamma')
  })

  test('project.updated: a group move, a visible-agents change and a settings write reach subscribers; settings only the app they belong to', async () => {
    await setActiveProject(page, fixture.projects.alpha)
    const tab = await helloTab()
    const other = await otherTab()
    expect(await callIn(tab, 'events.subscribe', { name: 'project.updated' })).toEqual({ ok: true, value: {} })
    expect(await callIn(other, 'events.subscribe', { name: 'project.updated' })).toEqual({ ok: true, value: {} })
    const store = (patch: { group?: unknown; project?: unknown }): Promise<void> =>
      page.evaluate(
        ([pid, p]) => {
          const ws = window.__pomadeStores.useWorkspaceStore.getState()
          if (p.group) ws.addGroup(p.group)
          if (p.project) ws.updateProject(pid, p.project)
        },
        [fixture.projects.alpha, patch] as const
      )
    const alpha = (groupId: string | null, groupPath: string[]) => ({ ...ALPHA(), groupId, groupPath })

    // The user moves Alpha into a new group (the Projects panel's drag or the project dialog).
    await store({ group: { id: 'grp-tools', name: 'Tools', order: 0 }, project: { groupId: 'grp-tools' } })
    const grouped = { project: alpha('grp-tools', ['Tools']), changes: ['group'] }
    await expect.poll(() => eventsOf(tab, 'project.updated')).toEqual([grouped])
    // …and offers only claude in its "+" menu.
    await store({ project: { visibleAgents: ['claude'] } })
    const agents = { project: alpha('grp-tools', ['Tools']), changes: ['agents'] }
    await expect.poll(() => eventsOf(tab, 'project.updated')).toEqual([grouped, agents])

    // hello-other writes its own settings for Alpha: it hears it; hello does not.
    const written = await callIn(other, 'project.setSettings', { projectId: fixture.projects.alpha, settings: { folder: 'docs' } })
    expect(written).toEqual({ ok: true, value: { settings: { folder: 'docs' } } })
    const settings = { project: alpha('grp-tools', ['Tools']), changes: ['settings'] }
    await expect.poll(() => eventsOf(other, 'project.updated')).toEqual([grouped, agents, settings])
    // An identical write changes nothing and says nothing.
    await callIn(other, 'project.setSettings', { projectId: fixture.projects.alpha, settings: { folder: 'docs' } })

    // Back as it was, in one change: one event with both. hello's list proves the settings event
    // never reached it (it would sit before this one).
    await store({ project: { groupId: undefined, visibleAgents: ['*'] } })
    const restored = { project: alpha(null, []), changes: ['group', 'agents'] }
    await expect.poll(() => eventsOf(tab, 'project.updated')).toEqual([grouped, agents, restored])
    await expect.poll(() => eventsOf(other, 'project.updated')).toEqual([grouped, agents, settings, restored])
    await callIn(other, 'project.setSettings', { projectId: fixture.projects.alpha, settings: { folder: null } })
    await expect.poll(async () => (await eventsOf(other, 'project.updated')).length).toBe(5)
    expect(await eventsOf(tab, 'project.updated')).toHaveLength(3)
  })

  test('project opened: the first activation since start only; changed: every switch, the Workspace project included', async () => {
    const tab = await helloTab()
    expect(await callIn(tab, 'events.subscribe', { name: 'project.opened' })).toEqual({ ok: true, value: {} })
    // The hello tab lives in Alpha; it stays mounted (hidden) while other projects are shown.
    await setActiveProject(page, fixture.projects.beta)
    await setActiveProject(page, '__workspace__')
    await setActiveProject(page, fixture.projects.beta)
    await setActiveProject(page, fixture.projects.alpha)
    const BETA = ref(fixture.projects.beta, 'Beta', 'Projects/beta')
    // Alpha and the Workspace project were opened before this subscription; Beta opens once.
    await expect.poll(() => eventsOf(tab, 'project.opened')).toEqual([BETA])
    await expect.poll(async () => (await eventsOf(tab, 'project.changed')).slice(-4)).toEqual([BETA, WORKSPACE, BETA, ALPHA()])
    const opened = (await loggedEvents()).filter((e) => e.name === 'project.opened').map((e) => (e.payload as { id: string }).id)
    expect(opened).toEqual(['__workspace__', fixture.projects.alpha, fixture.projects.beta])
  })

  test('an app event reaches another app’s hidden frame and the publisher’s other frames, never the publishing frame', async () => {
    const other = await otherTab()
    expect(await callIn(other, 'events.subscribe', { name: 'hello:pinged' })).toEqual({ ok: true, value: {} })
    const tab = await helloTab() // the other app's tab is hidden now
    await page.getByTestId('strip-app-hello-panel').click()
    const panel = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
    expect(await callIn(panel, 'events.subscribe', { name: 'hello-other:pinged' })).toEqual({ ok: true, value: {} })

    expect(await callIn(tab, 'events.publish', { name: 'pinged', payload: { n: 1, note: 'é ✓' } })).toEqual({ ok: true, value: {} })
    await expect.poll(() => eventsOf(other, 'hello:pinged')).toEqual([{ n: 1, note: 'é ✓' }])
    expect(await eventsOf(tab, 'hello:pinged')).toEqual([])

    expect(await callIn(other, 'events.publish', { name: 'pinged' })).toEqual({ ok: true, value: {} })
    await expect.poll(() => eventsOf(panel, 'hello-other:pinged')).toEqual([null])
  })

  test('an app may subscribe to its own event: its other frames hear what one of its frames publishes', async () => {
    const tab = await helloTab()
    await page.getByTestId('strip-app-hello-panel').click()
    const panel = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
    expect(await callIn(panel, 'events.subscribe', { name: 'hello:pinged' })).toEqual({ ok: true, value: {} })
    expect(await callIn(tab, 'events.publish', { name: 'pinged', payload: { own: true } })).toEqual({ ok: true, value: {} })
    await expect.poll(() => eventsOf(panel, 'hello:pinged')).toEqual([{ own: true }])
    expect(await eventsOf(tab, 'hello:pinged')).toEqual([])
    expect(await callIn(panel, 'events.unsubscribe', { name: 'hello:pinged' })).toEqual({ ok: true, value: {} })
  })

  test('subscription-aware: hasSubscribers follows other apps, and the publisher hears when it flips', async () => {
    const tab = await helloTab()
    const other = await otherTab()
    // hello-other's tab subscribed to hello:pinged in the previous test.
    expect(await callIn(tab, 'events.hasSubscribers', { name: 'pinged' })).toEqual({ ok: true, value: { subscribed: true } })
    const newsBefore = (await eventsOf(tab, 'events.subscribersChanged')).length
    expect(await callIn(other, 'events.unsubscribe', { name: 'hello:pinged' })).toEqual({ ok: true, value: {} })
    expect(await callIn(tab, 'events.hasSubscribers', { name: 'pinged' })).toEqual({ ok: true, value: { subscribed: false } })
    await callIn(other, 'events.subscribe', { name: 'hello:pinged' })
    expect(await callIn(tab, 'events.hasSubscribers', { name: 'pinged' })).toEqual({ ok: true, value: { subscribed: true } })
    await expect
      .poll(async () => (await eventsOf(tab, 'events.subscribersChanged')).slice(newsBefore))
      .toEqual([
        { name: 'pinged', subscribed: false },
        { name: 'pinged', subscribed: true }
      ])
    // A reload of the subscriber ends its subscriptions (a new handshake).
    await other.evaluate(() => location.reload())
    await connectedFrame(page.getByTestId('app-frame-hello-other'))
    await expect
      .poll(async () => (await callIn(tab, 'events.hasSubscribers', { name: 'pinged' })).value)
      .toEqual({ subscribed: false })
  })

  test('the manifest gates every name; malformed names are invalid-params', async () => {
    const other = await otherTab()
    const code = async (method: string, params: unknown): Promise<string | undefined> =>
      (await callIn(other, method, params)).error?.code
    expect(await code('events.subscribe', { name: 'pomade.ready' })).toBe('capability-denied')
    expect(await code('events.subscribe', { name: 'hello:other' })).toBe('capability-denied')
    expect(await code('events.subscribe', { name: 'pinged' })).toBe('invalid-params')
    expect(await code('events.publish', { name: 'other' })).toBe('capability-denied')
    expect(await code('events.publish', { name: 'hello-other:pinged' })).toBe('invalid-params')
    expect(await code('events.publish', { name: 'pinged', payload: 'x'.repeat(70 * 1024) })).toBe('invalid-params')
    expect(await code('events.hasSubscribers', { name: 'other' })).toBe('capability-denied')
    expect(await callIn(other, 'events.unsubscribe', { name: 'never.subscribed' })).toEqual({ ok: true, value: {} })
  })
})
