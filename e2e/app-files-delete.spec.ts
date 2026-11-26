// modules: core, editor, tabs
// T-236 e2e — `files.delete` (docs/HOST-API.md §4 `files.write`) in a real Pomade, driven through
// the raw-protocol conformance fixture (e2e/fixtures/apps/hello, copied with a manifest that
// declares `files.write`; a second copy declares only the read capabilities).
//   - two files deleted in one call: both leave the folder for the macOS Trash, the app's watch
//     reports both, and the one open with unsaved edits keeps its buffer and shows the
//     deleted-on-disk notice (rule 8);
//   - each path on its own: a `.pomade` path, a folder, a missing file and an escape fail their
//     own entry; the other paths in the same call still go;
//   - the capability gate.
// LIGHT partition: no terminal panes. Each run's files carry a unique suffix, so finding them in
// ~/.Trash is unambiguous; teardown removes them from the Trash again.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { HELLO_DIR } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import type { CallResult, SeenBatch } from './fixtures/globals'
import { tempDir } from './fixtures/temp'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const TRASH = join(homedir(), '.Trash')

interface DeleteResult {
  path: string
  ok: boolean
  error?: { code: string; message: string }
}

/** A copy of the hello fixture under its own id with the given capabilities. */
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
  return frame.evaluate(([m, p]) => window.__hello.call(m as string, p), [method, params] as const)
}

async function deleteIn(frame: Frame, paths: unknown[]): Promise<DeleteResult[]> {
  const r = await callIn(frame, 'files.delete', { paths })
  expect(r.error, JSON.stringify(paths)).toBeUndefined()
  return (r.value as { results: DeleteResult[] }).results
}

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(
    () => true,
    () => false
  )

test.describe('T-236 files.delete', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dataDir: string
  let roDir: string
  const run = `${process.pid}-${Date.now()}`
  const DIRTY = `Projects/alpha/roadmap/T236-dirty-${run}.md`
  const PLAIN = `Projects/alpha/roadmap/T236-plain-${run}.md`
  const OTHER = `Projects/alpha/roadmap/T236-other-${run}.md`
  const trashed: string[] = []
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  const nameOf = (rel: string): string => rel.split('/').pop() as string
  const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(abs('Projects/alpha/roadmap/sub'), { recursive: true })
    for (const rel of [DIRTY, PLAIN, OTHER]) await fs.writeFile(abs(rel), `---\nid: ${nameOf(rel)}\n---\n\nBody.\n`)
    await fs.writeFile(abs('Projects/alpha/roadmap/sub/keep.md'), 'keep\n')
    await fs.mkdir(abs('.pomade/state'), { recursive: true })
    await fs.writeFile(
      abs(`.pomade/state/${fixture.projects.alpha}.json`),
      JSON.stringify({
        openTabs: [{ id: 'doc-dirty', projectId: fixture.projects.alpha, kind: 'doc', title: nameOf(DIRTY), path: DIRTY, mode: 'raw', dirty: false }],
        activeTabId: 'doc-dirty'
      })
    )
    dataDir = await helloCopy('hello-del', ['project.read', 'files.read', 'files.write'])
    roDir = await helloCopy('hello-ro', ['project.read', 'files.read'])
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${dataDir};${roDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-del')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of [dataDir, roDir]) if (d) await fs.rm(d, { recursive: true, force: true })
    for (const name of trashed) await fs.rm(join(TRASH, name), { force: true }).catch(() => undefined)
  })

  test('two files, one open with unsaved edits: both go to the Trash, the watch hears both, the buffer stays', async () => {
    const watch = await callIn(frame, 'files.watch', { path: 'Projects/alpha/roadmap', recursive: true })
    expect(watch.ok).toBe(true)
    await frame.evaluate(() => {
      window.__seen = []
      window.addEventListener('message', (e) => {
        const d = e.data as { type?: string; name?: string; payload?: SeenBatch }
        if (d?.type === 'event' && d.name === 'files.changed' && d.payload) window.__seen.push(d.payload)
      })
    })

    await page.getByTestId('tab-doc-dirty').click()
    const cm = vis('[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.type('MINE ')
    await expect(vis('[data-testid="doc-save"]')).toHaveText('Save')

    expect(await deleteIn(frame, [DIRTY, PLAIN])).toEqual([
      { path: DIRTY, ok: true },
      { path: PLAIN, ok: true }
    ])
    trashed.push(nameOf(DIRTY), nameOf(PLAIN))
    expect(await exists(abs(DIRTY))).toBe(false)
    expect(await exists(abs(PLAIN))).toBe(false)
    // In the Trash, so Finder can put them back.
    expect(await exists(join(TRASH, nameOf(DIRTY)))).toBe(true)
    expect(await exists(join(TRASH, nameOf(PLAIN)))).toBe(true)

    // fs.watch may report one delete in two batches; what matters is that both are reported.
    await expect
      .poll(() =>
        frame.evaluate(() => [
          ...new Set(
            window.__seen
              .flatMap((b) => b.changes)
              .filter((c) => c.kind === 'delete')
              .map((c) => c.path)
          )
        ])
      )
      .toEqual(expect.arrayContaining([DIRTY, PLAIN]))

    // Rule 8: the doc says the file is gone; the user's edit is still in the buffer.
    await expect(vis('[data-testid="editor-missing"]')).toHaveText(/This file no longer exists on disk/)
    const text = await vis('[data-testid="raw-editor"] .cm-content').innerText()
    expect(text.startsWith('MINE ---')).toBe(true)
    await expect(vis('[data-testid="doc-save"]')).toHaveText('Save')
  })

  test('each path on its own: .pomade, a folder, the root, missing, an escape fail their entry; the rest still go', async () => {
    await fs.symlink('../../../.pomade/workspace.json', abs('Projects/alpha/roadmap/cfg-link.json'))
    const config = await fs.readFile(abs('.pomade/workspace.json'), 'utf8')
    const results = await deleteIn(frame, [
      '.pomade/workspace.json',
      'Projects/alpha/roadmap/cfg-link.json',
      'Projects/alpha/roadmap/sub',
      '',
      'Projects/alpha/roadmap/nope.md',
      '../outside.md',
      OTHER
    ])
    trashed.push(nameOf(OTHER))
    expect(results.map((r) => [r.path, r.ok ? 'ok' : r.error?.code])).toEqual([
      ['.pomade/workspace.json', 'capability-denied'],
      ['Projects/alpha/roadmap/cfg-link.json', 'capability-denied'],
      ['Projects/alpha/roadmap/sub', 'invalid-params'],
      ['', 'invalid-params'],
      ['Projects/alpha/roadmap/nope.md', 'not-found'],
      ['../outside.md', 'outside-workspace'],
      [OTHER, 'ok']
    ])
    expect(results[2].error?.message).toBe('"Projects/alpha/roadmap/sub" is a folder; files.delete deletes files only')
    expect(await fs.readFile(abs('.pomade/workspace.json'), 'utf8')).toBe(config)
    expect(await exists(abs('Projects/alpha/roadmap/cfg-link.json'))).toBe(true)
    expect(await fs.readFile(abs('Projects/alpha/roadmap/sub/keep.md'), 'utf8')).toBe('keep\n')
    expect(await exists(abs(OTHER))).toBe(false)
    expect(await exists(join(TRASH, nameOf(OTHER)))).toBe(true)
  })

  test('a malformed list refuses the whole call; without files.write it is capability-denied', async () => {
    for (const params of [{}, { paths: 'a.md' }, { paths: ['a.md', 1] }]) {
      expect((await callIn(frame, 'files.delete', params)).error?.code).toBe('invalid-params')
    }
    expect(await deleteIn(frame, [])).toEqual([])
    const ro = await openApp(page, 'hello-ro')
    expect((await callIn(ro, 'files.delete', { paths: ['Projects/alpha/notes.txt'] })).error?.code).toBe('capability-denied')
    expect(await exists(abs('Projects/alpha/notes.txt'))).toBe(true)
  })
})
