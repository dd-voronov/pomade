// modules: core, filetree
// T-243 e2e — watchers never miss a change. The native watcher (FSEvents) can miss one: a
// descriptor that has just opened is not live yet, and a second change to a path changed moments
// before can be dropped. Real loss is not reproducible on demand, so this app runs with
// POMADE_TEST_WATCH_LOSS_MS (docs/contracts/test-hooks.md): every in-workspace descriptor is
// deaf for its first LOSS_MS and drops an event for a path heard less than LOSS_MS before. What
// must still hold, because watchers SETTLE (re-read after registering and after each burst until
// nothing new — `@shared/settle`):
//   - files.watch: a file created 50 ms after the watch registered is reported;
//   - files.watch: a rapid double-write reports the final content (the app re-reads on each batch
//     and ends on the second write's text);
//   - files.watch: a delete inside a recursively watched folder, 50 ms after registering, is
//     reported;
//   - the file tree: a file deleted moments after it appeared leaves the tree.
// The watched folders belong to a project that is NOT active, so no tree watcher already covers
// them: each watch opens its own native descriptor.
// LIGHT partition: no terminal panes.

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

const HELLO_DIR = resolve(__dirname, 'fixtures/apps/hello')
const APP_ID = 'hello-settle'
/** The simulated loss window — well past the 50 ms the specs act at, inside the settle's reach. */
const LOSS_MS = 1000

interface Change {
  kind: string
  path: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

test.describe('T-243 files.watch settles — no change is missed', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let appDir: string
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    for (const folder of ['early', 'double', 'gone']) {
      await fs.mkdir(abs(`Projects/beta/${folder}/sub`), { recursive: true })
      await fs.writeFile(abs(`Projects/beta/${folder}/sub/old.md`), 'old\n')
    }
    appDir = await tempDir(`pomade-${APP_ID}-`)
    await fs.cp(HELLO_DIR, appDir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(join(appDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      join(appDir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        id: APP_ID,
        name: APP_ID,
        capabilities: ['project.read', 'files.read']
      })
    )
    app = await launchApp(fixture, { POMADE_DEV_APPS: appDir, POMADE_TEST_WATCH_LOSS_MS: String(LOSS_MS) })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.getByTestId('tab-add').click()
    await page.getByTestId(`tab-add-app-${APP_ID}`).click()
    const prefix = `pomade-app://${APP_ID}/`
    await expect.poll(() => page.frames().some((f) => f.url().startsWith(prefix))).toBe(true)
    frame = page.frames().find((f) => f.url().startsWith(prefix)) as Frame
    await expect
      .poll(() => frame.evaluate(() => window.__hello?.status ?? 'loading'))
      .toBe('connected')
    // The app's side: record every files.changed batch, and re-read each changed file the way a
    // live view does — the last read of a path is what the app ends up showing.
    await frame.evaluate(() => {
      window.__settle = { batches: [], reads: [] }
      window.addEventListener('message', (e) => {
        const d = e.data as {
          type?: string
          name?: string
          payload?: { watchId: string; changes: Change[] }
        }
        if (d?.type !== 'event' || d.name !== 'files.changed' || !d.payload) return
        window.__settle.batches.push(d.payload)
        for (const c of d.payload.changes) {
          if (c.kind === 'delete') continue
          void window.__hello.call('files.readFile', { path: c.path }).then((r) => {
            const content = (r.value as { content?: unknown } | undefined)?.content
            if (r.ok && typeof content === 'string') window.__settle.reads.push({ path: c.path, content })
          })
        }
      })
    })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    if (appDir) await fs.rm(appDir, { recursive: true, force: true })
  })

  async function watch(path: string): Promise<string> {
    const r = await frame.evaluate(
      (p) =>
        window.__hello.call('files.watch', {
          path: p,
          recursive: true
        }),
      path
    )
    expect(r.error).toBeUndefined()
    return (r.value as { watchId?: string } | undefined)?.watchId as string
  }

  const kindsFor = (watchId: string, path: string): Promise<string[]> =>
    frame.evaluate(
      ([id, p]) =>
        window.__settle.batches
          .filter((b) => b.watchId === id)
          .flatMap((b) => b.changes)
          .filter((c) => c.path === p)
          .map((c) => c.kind),
      [watchId, path] as const
    )

  const lastRead = (path: string): Promise<string | null> =>
    frame.evaluate((p) => {
      const reads = window.__settle.reads.filter((r) => r.path === p)
      return reads.length ? reads[reads.length - 1].content : null
    }, path)

  test('a file created 50 ms after the watch registered is reported', async () => {
    const id = await watch('Projects/beta/early')
    await sleep(50)
    await fs.writeFile(abs('Projects/beta/early/sub/new.md'), 'fresh\n')
    await expect
      .poll(() => kindsFor(id, 'Projects/beta/early/sub/new.md'), {
        timeout: 5000
      })
      .toContain('create')
    await expect.poll(() => lastRead('Projects/beta/early/sub/new.md')).toBe('fresh\n')
  })

  test('a rapid double-write reports the final content', async () => {
    const id = await watch('Projects/beta/double')
    await sleep(LOSS_MS + 200) // past the deaf start: the first write is heard
    const file = 'Projects/beta/double/sub/old.md'
    await fs.writeFile(abs(file), 'first\n')
    await expect.poll(() => lastRead(file), { timeout: 5000 }).toBe('first\n')
    // Moments later, the second write — the one the native watcher drops.
    await fs.writeFile(abs(file), 'second\n')
    expect(await kindsFor(id, file)).not.toEqual([])
    await expect.poll(() => lastRead(file), { timeout: 5000 }).toBe('second\n')
  })

  test('a delete inside a recursively watched folder, 50 ms after registering, is reported', async () => {
    const id = await watch('Projects/beta/gone')
    await sleep(50)
    await fs.rm(abs('Projects/beta/gone/sub/old.md'))
    await expect
      .poll(() => kindsFor(id, 'Projects/beta/gone/sub/old.md'), {
        timeout: 5000
      })
      .toContain('delete')
  })

  test('the file tree drops a file deleted moments after it appeared', async () => {
    await sleep(LOSS_MS + 200) // the tree's descriptor is past its deaf start
    const row = page.getByTestId('tree-node-Projects/alpha/blink.md')
    await fs.writeFile(abs('Projects/alpha/blink.md'), 'blink\n')
    await expect(row).toBeVisible({ timeout: 5000 })
    // Deleted moments after it appeared — the native watcher drops this second event.
    await fs.rm(abs('Projects/alpha/blink.md'))
    await expect(row).toHaveCount(0, { timeout: 5000 })
  })
})
