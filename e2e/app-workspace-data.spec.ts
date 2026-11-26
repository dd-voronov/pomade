// modules: core, editor, tabs, projects
// E-030 e2e — the workspace-data Host API (docs/HOST-API.md §4) in a real Pomade, driven through
// the raw-protocol conformance fixture (e2e/fixtures/apps/hello, copied with a manifest that
// declares the E-030 capabilities; a second copy declares only the read capabilities).
//   - files.write: field-only frontmatter writes on real-shaped tickets (comments, quotes, lists,
//     CRLF, wikilinks and markup in the body) leave every other byte identical; create / write /
//     setBody / move / readFile; the path rule, the symlink escape guard, the .pomade rule and the
//     capability gate.
//   - T-241: conditional writes (`ifMtime` → `changed-on-disk`, file untouched), a mapping written
//     field-only (`files.setKeyLines`), one file's frontmatter record (`readFile({ frontmatter })`),
//     concurrent field writes to one file all landing.
//   - rule 8: an app's write to a doc open with unsaved edits shows the amber banner; the buffer
//     is untouched; without edits, the plain notice.
// LIGHT partition: no terminal panes.

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import type { CallResult, SeenBatch } from './fixtures/globals'
import { tempDir } from './fixtures/temp'

const HELLO_DIR = resolve(__dirname, 'fixtures/apps/hello')
const TICKET = resolve(__dirname, 'fixtures/workspace-data/T-210-board-drag-mixed.md')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** A copy of the hello fixture under its own id with the given capabilities (and extra manifest keys). */
async function helloCopy(id: string, capabilities: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await tempDir(`pomade-${id}-`)
  await fs.cp(HELLO_DIR, dir, { recursive: true })
  const manifest = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, id, name: id, capabilities, ...extra }))
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

async function ok(frame: Frame, method: string, params?: unknown): Promise<unknown> {
  const r = await callIn(frame, method, params)
  expect(r.error, `${method} ${JSON.stringify(params)}`).toBeUndefined()
  return r.value
}

async function code(frame: Frame, method: string, params?: unknown): Promise<string | undefined> {
  return (await callIn(frame, method, params)).error?.code
}

const DATA_CAPS = ['project.read', 'files.read', 'files.write']

test.describe('E-030 files.write — field-only writes, create / move / body, the guards', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let ticket: string
  let dataDir: string
  let roDir: string
  let outsideDir: string
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  const disk = (rel: string): Promise<string> => fs.readFile(abs(rel), 'utf8')

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    ticket = await fs.readFile(TICKET, 'utf8')
    await fs.mkdir(abs('Projects/alpha/roadmap'), { recursive: true })
    await fs.writeFile(abs('Projects/alpha/roadmap/T-210.md'), ticket)
    await fs.writeFile(abs('Projects/alpha/roadmap/T-211-crlf.md'), ticket.replace(/\n/g, '\r\n'))
    await fs.writeFile(abs('Projects/alpha/roadmap/broken.md'), '---\nid: [unclosed\n---\n\nBody.\n')
    await fs.writeFile(abs('Projects/alpha/roadmap/run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    outsideDir = await tempDir('pomade-e030-out-')
    await fs.writeFile(join(outsideDir, 'secret.md'), '---\nid: S\n---\n')
    await fs.symlink(join(outsideDir, 'secret.md'), abs('Projects/alpha/roadmap/escape.md'))
    await fs.symlink(outsideDir, abs('Projects/alpha/out'))
    dataDir = await helloCopy('hello-data', DATA_CAPS)
    roDir = await helloCopy('hello-ro', ['project.read', 'files.read'])
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${dataDir};${roDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-data')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of [dataDir, roDir, outsideDir]) if (d) await fs.rm(d, { recursive: true, force: true })
  })

  test("the workspace's .pomade folder is out of reach — by the path given and through a symlink", async () => {
    const config = await disk('.pomade/workspace.json')
    await fs.symlink('../../.pomade/workspace.json', abs('Projects/alpha/config-link.json'))
    for (const [m, p] of [
      ['files.readFile', { path: '.pomade/workspace.json' }],
      ['files.readFolder', { path: '.pomade' }],
      ['files.create', { path: 'Projects/../.pomade/new.md' }],
      ['files.move', { from: 'Projects/alpha/roadmap/run.sh', to: '.pomade/run.sh' }],
      ['files.readFile', { path: 'Projects/alpha/config-link.json' }],
      ['files.write', { path: 'Projects/alpha/config-link.json', content: '{}' }]
    ] as const) {
      expect(await code(frame, m, p), `${m} ${JSON.stringify(p)}`).toBe('capability-denied')
    }
    expect(await disk('.pomade/workspace.json')).toBe(config)
    const { entries } = (await ok(frame, 'files.readFolder', { path: 'Projects/alpha' })) as { entries: { path: string }[] }
    expect(entries.map((e) => e.path)).not.toContain('Projects/alpha/config-link.json')
    await fs.rm(abs('Projects/alpha/config-link.json'))
  })

  test('setField changes exactly the field line of a real-shaped ticket; every other byte stays', async () => {
    const path = 'Projects/alpha/roadmap/T-210.md'
    expect(await ok(frame, 'files.setField', { path, key: 'status', value: 'done' })).toEqual({ changed: true })
    expect(await disk(path)).toBe(
      ticket.replace("status: 'in-progress'   # moved by the Board\n", 'status: done   # moved by the Board\n')
    )
    // Identical bytes: nothing is written (the mtime stays).
    const before = (await fs.stat(abs(path))).mtimeMs
    expect(await ok(frame, 'files.setField', { path, key: 'status', value: 'done' })).toEqual({ changed: false })
    expect((await fs.stat(abs(path))).mtimeMs).toBe(before)
    // A list, a new key, a removal — the body (wikilinks, markup, the fenced `---`) never moves.
    await ok(frame, 'files.setField', { path, key: 'tags', value: ['board', 'done'] })
    await ok(frame, 'files.setField', { path, key: 'updated', value: '2026-11-10' })
    await ok(frame, 'files.removeField', { path, key: 'blocked' })
    const after = await disk(path)
    const body = ticket.slice(ticket.indexOf('# T-210'))
    expect(after.endsWith(body)).toBe(true)
    expect(after.slice(0, after.length - body.length)).toBe(
      ticket
        .slice(0, ticket.length - body.length)
        .replace("status: 'in-progress'   # moved by the Board\n", 'status: done   # moved by the Board\n')
        .replace('tags: [board, frontmatter, "rule-8"]\n', 'tags: [board, done]\n')
        .replace('blocked: false\n', '')
        .replace('created: 2026-11-10\n---\n', 'created: 2026-11-10\nupdated: 2026-11-10\n---\n')
    )
  })

  test('CRLF: a field write keeps CRLF everywhere and every other byte', async () => {
    const path = 'Projects/alpha/roadmap/T-211-crlf.md'
    const crlf = ticket.replace(/\n/g, '\r\n')
    await ok(frame, 'files.setField', { path, key: 'estimate', value: 5 })
    expect(await disk(path)).toBe(crlf.replace('estimate: 3\r\n', 'estimate: 5\r\n'))
  })

  test('setBody keeps the frontmatter bytes; readFile returns what is on disk', async () => {
    const path = 'Projects/alpha/roadmap/T-211-crlf.md'
    const beforeText = await disk(path)
    const block = beforeText.slice(0, beforeText.indexOf('# T-210'))
    expect(await ok(frame, 'files.setBody', { path, body: 'Rewritten with [[E-030]].\r\n' })).toEqual({ changed: true })
    expect(await disk(path)).toBe(`${block}Rewritten with [[E-030]].\r\n`)
    const read = (await ok(frame, 'files.readFile', { path })) as { content: string; size: number }
    expect(read.content).toBe(`${block}Rewritten with [[E-030]].\r\n`)
    expect(read.size).toBe(Buffer.byteLength(read.content))
  })

  test('refusals: unreadable frontmatter, invalid values — nothing written', async () => {
    expect(await code(frame, 'files.setField', { path: 'Projects/alpha/roadmap/broken.md', key: 'id', value: 'x' })).toBe(
      'unreadable-frontmatter'
    )
    expect(await code(frame, 'files.setField', { path: 'Projects/alpha/roadmap/T-210.md', key: 'k', value: { a: 1 } })).toBe(
      'invalid-params'
    )
    expect(await code(frame, 'files.setField', { path: 'Projects/alpha/roadmap/T-210.md', key: '', value: 'x' })).toBe(
      'invalid-params'
    )
    expect(await disk('Projects/alpha/roadmap/broken.md')).toBe('---\nid: [unclosed\n---\n\nBody.\n')
  })

  test('T-241 ifMtime: a write against a stale read is changed-on-disk and the file is untouched; a fresh read writes', async () => {
    const path = 'Projects/alpha/roadmap/T-241.md'
    await fs.writeFile(abs(path), ticket)
    const { mtimeMs } = (await ok(frame, 'files.readFile', { path })) as { mtimeMs: number }
    // An agent rewrites the ticket after the app read it.
    const theirs = ticket.replace('estimate: 3\n', 'estimate: 8\n')
    await fs.writeFile(abs(path), theirs)
    const agentMtime = (await fs.stat(abs(path))).mtimeMs
    expect(agentMtime).not.toBe(mtimeMs)
    for (const [m, p] of [
      ['files.write', { content: 'mine\n' }],
      ['files.setBody', { body: 'mine\n' }],
      ['files.setField', { key: 'status', value: 'done' }],
      ['files.removeField', { key: 'blocked' }],
      ['files.setKeyLines', { key: 'repeat', text: 'repeat:\n  once: 2026-12-01' }]
    ] as const) {
      expect(await code(frame, m, { path, ...p, ifMtime: mtimeMs }), m).toBe('changed-on-disk')
    }
    expect(await disk(path)).toBe(theirs)
    expect((await fs.stat(abs(path))).mtimeMs).toBe(agentMtime)
    expect(await fs.readdir(abs('Projects/alpha/roadmap'))).not.toContainEqual(expect.stringMatching(/\.tmp$/))
    // Re-read: the fresh mtime writes, field-only.
    const fresh = (await ok(frame, 'files.readFile', { path })) as { mtimeMs: number }
    expect(fresh.mtimeMs).toBe(agentMtime)
    expect(await ok(frame, 'files.setField', { path, key: 'status', value: 'done', ifMtime: fresh.mtimeMs })).toEqual({ changed: true })
    expect(await disk(path)).toBe(theirs.replace("status: 'in-progress'   # moved by the Board\n", 'status: done   # moved by the Board\n'))
    // That write moved the mtime on: the same read is now stale.
    expect(await code(frame, 'files.setField', { path, key: 'status', value: 'x', ifMtime: fresh.mtimeMs })).toBe('changed-on-disk')
    expect(await code(frame, 'files.setField', { path, key: 'status', value: 'x', ifMtime: 'now' })).toBe('invalid-params')
  })

  test('T-241 setKeyLines writes a mapping field-only; readFile({ frontmatter: true }) reads the record back', async () => {
    const path = 'Projects/alpha/roadmap/T-242.md'
    await fs.writeFile(abs(path), ticket)
    const repeat = 'repeat:\n  every: { week: 1, on: [mon, wed] }\n  start: 2026-11-02'
    expect(await ok(frame, 'files.setKeyLines', { path, key: 'repeat', text: repeat })).toEqual({ changed: true })
    const added = ticket.replace('created: 2026-11-10\n---\n', `created: 2026-11-10\n${repeat}\n---\n`)
    expect(await disk(path)).toBe(added)
    const read = (await ok(frame, 'files.readFile', { path, frontmatter: true })) as {
      content: string
      frontmatter: Record<string, unknown>
    }
    expect(read.content).toBe(added)
    expect(read.frontmatter).toMatchObject({
      id: 'T-210',
      status: 'in-progress',
      created: '2026-11-10',
      repeat: { every: { week: 1, on: ['mon', 'wed'] }, start: '2026-11-02' }
    })
    const { entries } = (await ok(frame, 'files.readFolder', { path: 'Projects/alpha/roadmap', frontmatter: true })) as {
      entries: { path: string; frontmatter?: unknown }[]
    }
    expect(read.frontmatter).toEqual(entries.find((e) => e.path === path)?.frontmatter)
    // Replaced in place: only the key's own lines change.
    const daily = 'repeat:\n  every: { day: 1 }'
    expect(await ok(frame, 'files.setKeyLines', { path, key: 'repeat', text: daily })).toEqual({ changed: true })
    expect(await disk(path)).toBe(added.replace(repeat, daily))
    expect(await ok(frame, 'files.setKeyLines', { path, key: 'repeat', text: daily })).toEqual({ changed: false })
    // Text that is not exactly the key's own lines is refused; nothing is written.
    expect(await code(frame, 'files.setKeyLines', { path, key: 'repeat', text: 'other:\n  a: 1' })).toBe('invalid-params')
    expect(await code(frame, 'files.setKeyLines', { path, key: 'repeat', text: 'repeat:\n  a: [1' })).toBe('invalid-params')
    expect(await disk(path)).toBe(added.replace(repeat, daily))
    // No frontmatter record for a file that is not Markdown, nor without the flag.
    const sh = (await ok(frame, 'files.readFile', { path: 'Projects/alpha/roadmap/run.sh', frontmatter: true })) as Record<string, unknown>
    expect('frontmatter' in sh || 'frontmatterError' in sh).toBe(false)
    expect('frontmatter' in ((await ok(frame, 'files.readFile', { path })) as Record<string, unknown>)).toBe(false)
  })

  test('T-241 two field writes to one file at once both land', async () => {
    const path = 'Projects/alpha/roadmap/T-243.md'
    await fs.writeFile(abs(path), ticket)
    const results = await frame.evaluate(
      async (p) => {
        const h = window.__hello
        return Promise.all(
          Array.from({ length: 8 }, (_, i) => h.call('files.setField', { path: p, key: `k${i}`, value: String(i) }))
        )
      },
      path
    )
    expect(results.every((r) => r.ok)).toBe(true)
    const read = (await ok(frame, 'files.readFile', { path, frontmatter: true })) as { frontmatter: Record<string, unknown> }
    for (let i = 0; i < 8; i++) expect(read.frontmatter[`k${i}`]).toBe(String(i))
  })

  test('create (parents made, exclusive), write (existing only, mode kept), move (refuses collisions)', async () => {
    await ok(frame, 'files.create', { path: 'Projects/alpha/roadmap/done/T-300.md', content: '---\nid: T-300\n---\n' })
    expect(await disk('Projects/alpha/roadmap/done/T-300.md')).toBe('---\nid: T-300\n---\n')
    expect(await code(frame, 'files.create', { path: 'Projects/alpha/roadmap/done/T-300.md' })).toBe('already-exists')
    expect(await disk('Projects/alpha/roadmap/done/T-300.md')).toBe('---\nid: T-300\n---\n')
    // No temp file is left next to it.
    expect(await fs.readdir(abs('Projects/alpha/roadmap/done'))).toEqual(['T-300.md'])

    await ok(frame, 'files.write', { path: 'Projects/alpha/roadmap/run.sh', content: '#!/bin/sh\necho bye\n' })
    expect(await disk('Projects/alpha/roadmap/run.sh')).toBe('#!/bin/sh\necho bye\n')
    expect((await fs.stat(abs('Projects/alpha/roadmap/run.sh'))).mode & 0o777).toBe(0o755)
    expect(await code(frame, 'files.write', { path: 'Projects/alpha/roadmap/nope.md', content: '' })).toBe('not-found')
    expect(await code(frame, 'files.write', { path: 'Projects/alpha/roadmap', content: '' })).toBe('io-error')

    await ok(frame, 'files.move', { from: 'Projects/alpha/roadmap/done/T-300.md', to: 'Projects/alpha/roadmap/archive/T-300.md' })
    expect(await disk('Projects/alpha/roadmap/archive/T-300.md')).toBe('---\nid: T-300\n---\n')
    await ok(frame, 'files.move', { from: 'Projects/alpha/roadmap/archive', to: 'Projects/alpha/roadmap/old' })
    expect(await disk('Projects/alpha/roadmap/old/T-300.md')).toBe('---\nid: T-300\n---\n')
    expect(
      await code(frame, 'files.move', { from: 'Projects/alpha/roadmap/T-210.md', to: 'Projects/alpha/roadmap/broken.md' })
    ).toBe('already-exists')
    expect(await code(frame, 'files.move', { from: 'Projects/alpha/roadmap', to: 'Projects/alpha/roadmap/sub' })).toBe(
      'invalid-params'
    )
    expect(await code(frame, 'files.move', { from: 'Projects/alpha/nope', to: 'Projects/alpha/x' })).toBe('not-found')
  })

  test('the path rule and the real-path guard: no write lands outside the workspace', async () => {
    expect(await code(frame, 'files.create', { path: '../escape.md' })).toBe('outside-workspace')
    expect(await code(frame, 'files.write', { path: '/etc/hosts', content: '' })).toBe('outside-workspace')
    expect(await code(frame, 'files.create', { path: '' })).toBe('invalid-params')
    // Through a symlinked file, and through a symlinked folder, to a place outside the workspace.
    expect(await code(frame, 'files.setField', { path: 'Projects/alpha/roadmap/escape.md', key: 'id', value: 'X' })).toBe(
      'outside-workspace'
    )
    expect(await code(frame, 'files.create', { path: 'Projects/alpha/out/new.md' })).toBe('outside-workspace')
    expect(await code(frame, 'files.move', { from: 'Projects/alpha/notes.txt', to: 'Projects/alpha/out/notes.txt' })).toBe(
      'outside-workspace'
    )
    expect(await fs.readFile(join(outsideDir, 'secret.md'), 'utf8')).toBe('---\nid: S\n---\n')
    expect(await fs.readdir(outsideDir)).toEqual(['secret.md'])
  })

  test("a watch sees the app's own writes", async () => {
    const watch = (await ok(frame, 'files.watch', { path: 'Projects/alpha/roadmap', recursive: true })) as { watchId: string }
    await frame.evaluate(() => {
      window.__seen = []
      window.addEventListener('message', (e) => {
        const d = e.data as { type?: string; name?: string; payload?: SeenBatch }
        if (d?.type === 'event' && d.name === 'files.changed' && d.payload) window.__seen.push(d.payload)
      })
    })
    await ok(frame, 'files.create', { path: 'Projects/alpha/roadmap/T-400.md', content: 'x\n' })
    await expect
      .poll(() =>
        frame.evaluate(() =>
          window.__seen
            .flatMap((b) => b.changes)
            .filter((c) => c.path === 'Projects/alpha/roadmap/T-400.md')
            .map((c) => c.kind)
        )
      )
      .toContain('create')
    await ok(frame, 'files.unwatch', watch)
  })

  test('without files.write every write is capability-denied; readFile needs only files.read', async () => {
    const ro = await openApp(page, 'hello-ro')
    for (const m of ['files.create', 'files.write', 'files.setBody', 'files.setField', 'files.removeField', 'files.setKeyLines', 'files.move']) {
      expect(await code(ro, m, { path: 'Projects/alpha/notes.txt' })).toBe('capability-denied')
    }
    expect(await ok(ro, 'files.readFile', { path: 'Projects/alpha/notes.txt' })).toMatchObject({ content: 'alpha notes\n' })
  })
})

test.describe('E-030 rule 8 — an app write to an open doc', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dataDir: string
  let ticket: string
  const DIRTY = 'Projects/alpha/T-500-dirty.md'
  const CLEAN = 'Projects/alpha/T-501-clean.md'
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
  const docTab = (id: string, path: string): Record<string, unknown> => ({
    id,
    projectId: fixture.projects.alpha,
    kind: 'doc',
    title: path.split('/').pop(),
    path,
    mode: 'raw',
    dirty: false
  })

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    ticket = await fs.readFile(TICKET, 'utf8')
    await fs.writeFile(abs(DIRTY), ticket)
    await fs.writeFile(abs(CLEAN), ticket)
    await fs.mkdir(abs('.pomade/state'), { recursive: true })
    await fs.writeFile(
      abs(`.pomade/state/${fixture.projects.alpha}.json`),
      JSON.stringify({ openTabs: [docTab('doc-dirty', DIRTY), docTab('doc-clean', CLEAN)], activeTabId: 'doc-dirty' })
    )
    dataDir = await helloCopy('hello-data', DATA_CAPS)
    app = await launchApp(fixture, { POMADE_DEV_APPS: dataDir })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-data')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
  })

  test('unsaved edits + an app setField → the amber banner; neither the buffer nor the disk moves on its own', async () => {
    await page.getByTestId('tab-doc-dirty').click()
    const cm = vis('[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.type('MINE ')
    await expect(vis('[data-testid="doc-save"]')).toHaveText('Save')

    expect(await ok(frame, 'files.setField', { path: DIRTY, key: 'status', value: 'done' })).toEqual({ changed: true })
    await expect(vis('[data-testid="editor-changed-dirty"]')).toHaveText(/File changed since your edits\./)
    expect(await fs.readFile(abs(DIRTY), 'utf8')).toBe(
      ticket.replace("status: 'in-progress'   # moved by the Board\n", 'status: done   # moved by the Board\n')
    )
    // The buffer still holds the user's edit on top of the old frontmatter.
    const text = await vis('[data-testid="raw-editor"] .cm-content').innerText()
    expect(text.startsWith('MINE ---')).toBe(true)
    expect(text).toContain("status: 'in-progress'")
  })

  test('without unsaved edits an app write shows the plain notice and never reloads silently', async () => {
    await page.getByTestId('tab-doc-clean').click()
    await expect(vis('[data-testid="raw-editor"]')).toContainText("status: 'in-progress'")
    await ok(frame, 'files.setBody', { path: CLEAN, body: 'Body written by an app.\n' })
    await expect(vis('[data-testid="editor-changed-outside"]')).toHaveText(/This file changed on disk outside Pomade\./)
    await expect(vis('[data-testid="raw-editor"]')).toContainText('Trailing line without a newline')
    await vis('[data-testid="editor-reload"]').click()
    await expect(vis('[data-testid="raw-editor"]')).toContainText('Body written by an app.')
  })
})

interface TabLite {
  id: string
  kind: string
  path?: string
  title: string
}

function tabsOf(page: Page, projectId: string): Promise<{ tabs: TabLite[]; active: string | undefined; project: string }> {
  return page.evaluate((pid) => {
    const t = window.__pomadeStores.useTabsStore.getState()
    return {
      tabs: (t.tabsByProject[pid] ?? []).map((x) => ({ id: x.id, kind: x.kind, path: x.path, title: x.title })),
      active: t.activeTabByProject[pid],
      project: window.__pomadeStores.useWorkspaceStore.getState().activeProjectId
    }
  }, projectId)
}

test.describe('E-030 tabs.openFile', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dataDir: string
  let roDir: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    dataDir = await helloCopy('hello-data', [...DATA_CAPS, 'tabs.open'])
    roDir = await helloCopy('hello-ro', ['project.read', 'files.read'])
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${dataDir};${roDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-data')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of [dataDir, roDir]) if (d) await fs.rm(d, { recursive: true, force: true })
  })

  test('opens a doc tab right of the active tab and shows it; a second call focuses it', async () => {
    const alpha = fixture.projects.alpha
    await ok(frame, 'tabs.openFile', { path: 'Projects/alpha/README.md' })
    await expect(page.locator('[data-testid="editor-pane"][data-doc-path="Projects/alpha/README.md"]')).toBeVisible()
    let s = await tabsOf(page, alpha)
    const readme = s.tabs.find((t) => t.path === 'Projects/alpha/README.md')
    expect(s.tabs.map((t) => t.kind)).toEqual(['app', 'doc'])
    expect(s.active).toBe(readme?.id)

    // Back on the app tab, a second file lands right of it — between the app and README.
    await page.getByTestId(`tab-${s.tabs[0].id}`).click()
    await ok(frame, 'tabs.openFile', { path: 'Projects/alpha/notes.txt' })
    s = await tabsOf(page, alpha)
    expect(s.tabs.map((t) => t.path ?? t.kind)).toEqual(['app', 'Projects/alpha/notes.txt', 'Projects/alpha/README.md'])

    await ok(frame, 'tabs.openFile', { path: 'Projects/alpha/README.md' })
    s = await tabsOf(page, alpha)
    expect(s.tabs).toHaveLength(3)
    expect(s.active).toBe(readme?.id)
  })

  test('a file outside the project it opens in shows the "Outside this project" mark; a file inside it, or in its own project, does not', async () => {
    const alpha = fixture.projects.alpha
    await ok(frame, 'tabs.openFile', { path: 'Projects/beta/README.md' })
    const outside = (await tabsOf(page, alpha)).tabs.find((t) => t.path === 'Projects/beta/README.md')
    const mark = page.getByTestId(`tab-scope-${outside?.id}`)
    await expect(mark).toHaveAttribute('data-tone', 'warning')
    await expect(async () => {
      await page.mouse.move(0, 0)
      await mark.hover()
      await expect(page.getByTestId(`tab-scope-${outside?.id}-tooltip`)).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 10_000 })
    await expect(page.getByTestId(`tab-scope-${outside?.id}-tooltip`)).toHaveText('Outside this project')

    await ok(frame, 'tabs.openFile', { path: 'Projects/alpha/notes.txt' })
    const inside = (await tabsOf(page, alpha)).tabs.find((t) => t.path === 'Projects/alpha/notes.txt')
    await expect(page.getByTestId(`tab-${inside?.id}`)).toBeVisible()
    await expect(page.getByTestId(`tab-scope-${inside?.id}`)).toHaveCount(0)
  })

  test('projectId opens in that project and switches to it; the Workspace project works too', async () => {
    const beta = fixture.projects.beta
    await ok(frame, 'tabs.openFile', { path: 'Projects/beta/data.csv', projectId: beta })
    await expect.poll(async () => (await tabsOf(page, beta)).project).toBe(beta)
    expect((await tabsOf(page, beta)).tabs.map((t) => t.path)).toEqual(['Projects/beta/data.csv'])
    const inBeta = (await tabsOf(page, beta)).tabs[0]
    await expect(page.getByTestId(`tab-${inBeta.id}`)).toBeVisible()
    await expect(page.getByTestId(`tab-scope-${inBeta.id}`)).toHaveCount(0)
    await ok(frame, 'tabs.openFile', { path: 'welcome.md', projectId: '__workspace__' })
    await expect.poll(async () => (await tabsOf(page, '__workspace__')).project).toBe('__workspace__')
    expect((await tabsOf(page, '__workspace__')).tabs.map((t) => t.path)).toContain('welcome.md')
  })

  test('errors: missing, folder, outside, unknown project; capability', async () => {
    expect(await code(frame, 'tabs.openFile', { path: 'Projects/alpha/nope.md' })).toBe('not-found')
    expect(await code(frame, 'tabs.openFile', { path: 'Projects/alpha' })).toBe('io-error')
    expect(await code(frame, 'tabs.openFile', { path: '../x.md' })).toBe('outside-workspace')
    expect(await code(frame, 'tabs.openFile', { path: 'welcome.md', projectId: 'ghost' })).toBe('not-found')
    expect(await code(frame, 'tabs.openTerminal', { cwd: 'Projects/nope' })).toBe('not-found')
    expect(await code(frame, 'tabs.openTerminal', { cwd: 'welcome.md' })).toBe('io-error')
    expect(await code(frame, 'tabs.openTerminal', { cwd: '', command: 'a\nb' })).toBe('invalid-params')
    const ro = await openApp(page, 'hello-ro')
    expect(await code(ro, 'tabs.openFile', { path: 'welcome.md' })).toBe('capability-denied')
    expect(await code(ro, 'tabs.openTerminal', { cwd: '' })).toBe('capability-denied')
  })
})

test.describe('E-030 projects — the groups → projects tree, the Workspace project, stable ids', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dataDir: string

  const events = (): Promise<{ name: string; payload: unknown }[]> =>
    frame.evaluate(() =>
      window.__hello.events.filter(
        (e) => e.name === 'project.changed'
      )
    )

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const configPath = join(fixture.workspaceRoot, '.pomade/workspace.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { projects: Record<string, unknown>[] }
    await fs.writeFile(
      configPath,
      JSON.stringify({
        ...config,
        groups: [
          { id: 'g-build', name: 'Building tools', order: 0 },
          { id: 'g-tools', name: 'Tools', order: 0, parentId: 'g-build' }
        ],
        projects: config.projects.map((p) => (p.id === fixture.projects.alpha ? { ...p, groupId: 'g-tools' } : p))
      })
    )
    dataDir = await helloCopy('hello-data', DATA_CAPS)
    app = await launchApp(fixture, { POMADE_DEV_APPS: dataDir })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-data')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
  })

  test('project.list: groups and projects in Projects panel order, each project with its nested group path', async () => {
    expect(await ok(frame, 'project.list')).toEqual({
      workspace: { id: '__workspace__', kind: 'workspace', name: 'Workspace', root: '' },
      groups: [
        { id: 'g-build', name: 'Building tools', parentId: null, path: ['Building tools'] },
        { id: 'g-tools', name: 'Tools', parentId: 'g-build', path: ['Building tools', 'Tools'] }
      ],
      projects: [
        {
          id: fixture.projects.alpha,
          kind: 'project',
          name: 'Alpha',
          root: 'Projects/alpha',
          groupId: 'g-tools',
          groupPath: ['Building tools', 'Tools']
        },
        { id: fixture.projects.beta, kind: 'project', name: 'Beta', root: 'Projects/beta', groupId: null, groupPath: [] }
      ]
    })
  })

  test('choosing the Workspace row is a project.changed to the Workspace project', async () => {
    const before = (await events()).length
    await page.getByTestId('project-__workspace__').click()
    await expect.poll(async () => (await events()).slice(before).map((e) => e.payload)).toEqual([
      { id: '__workspace__', kind: 'workspace', name: 'Workspace', root: '' }
    ])
    expect(await ok(frame, 'project.getActive')).toEqual({ id: '__workspace__', kind: 'workspace', name: 'Workspace', root: '' })
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect.poll(async () => (await events()).at(-1)?.payload).toMatchObject({ id: fixture.projects.alpha })
  })

  test('a rename and a move keep the id: the stored reference still resolves, and the change is an event', async () => {
    const stored = fixture.projects.alpha
    const before = (await events()).length
    await page.evaluate((id) => {
      window.__pomadeStores.useWorkspaceStore
        .getState()
        .updateProject(id, { name: 'Alpha Prime', rootPath: 'Projects/alpha-prime' })
    }, stored)
    await expect.poll(async () => (await events()).slice(before).map((e) => e.payload)).toEqual([
      { id: stored, kind: 'project', name: 'Alpha Prime', root: 'Projects/alpha-prime' }
    ])
    const list = (await ok(frame, 'project.list')) as { projects: { id: string; name: string; root: string }[] }
    expect(list.projects.find((p) => p.id === stored)).toMatchObject({ name: 'Alpha Prime', root: 'Projects/alpha-prime' })
  })
})

test.describe('E-030 per-project app settings and visible agents', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let other: Frame
  let dataDir: string
  let otherDir: string
  let roDir: string
  const configPath = (): string => join(fixture.workspaceRoot, '.pomade/workspace.json')
  const savedProject = async (id: string): Promise<Record<string, unknown> | undefined> =>
    (JSON.parse(await fs.readFile(configPath(), 'utf8')) as { projects: Record<string, unknown>[] }).projects.find(
      (p) => p.id === id
    )

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    dataDir = await helloCopy('hello-data', [...DATA_CAPS, 'project.write'])
    otherDir = await helloCopy('hello-other', ['project.read', 'project.write'])
    roDir = await helloCopy('hello-ro', ['project.read', 'files.read'])
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${dataDir};${otherDir};${roDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-data')
    other = await openApp(page, 'hello-other')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of [dataDir, otherDir, roDir]) if (d) await fs.rm(d, { recursive: true, force: true })
  })

  test("settings are the app's own, per project; merged; persisted with the project", async () => {
    const alpha = fixture.projects.alpha
    expect(await ok(frame, 'project.getSettings', { projectId: alpha })).toEqual({ settings: {} })
    expect(
      await ok(frame, 'project.setSettings', { projectId: alpha, settings: { backlog: 'Projects/alpha/docs/roadmap', view: { cols: 3 } } })
    ).toEqual({ settings: { backlog: 'Projects/alpha/docs/roadmap', view: { cols: 3 } } })
    expect(await ok(frame, 'project.setSettings', { projectId: alpha, settings: { view: null, lanes: ['Signals'] } })).toEqual({
      settings: { backlog: 'Projects/alpha/docs/roadmap', lanes: ['Signals'] }
    })
    // Another app sees only its own entry; the other project is untouched.
    expect(await ok(other, 'project.getSettings', { projectId: alpha })).toEqual({ settings: {} })
    await ok(other, 'project.setSettings', { projectId: alpha, settings: { pinned: true } })
    expect(await ok(frame, 'project.getSettings', { projectId: fixture.projects.beta })).toEqual({ settings: {} })
    await expect.poll(() => savedProject(alpha).then((p) => p?.appSettings)).toEqual({
      'hello-data': { backlog: 'Projects/alpha/docs/roadmap', lanes: ['Signals'] },
      'hello-other': { pinned: true }
    })
    // Emptying an app's settings drops its entry.
    await ok(other, 'project.setSettings', { projectId: alpha, settings: { pinned: null } })
    await expect.poll(() => savedProject(alpha).then((p) => Object.keys((p?.appSettings as object) ?? {}))).toEqual(['hello-data'])
  })

  test('settings survive a rename: they live with the project id', async () => {
    const alpha = fixture.projects.alpha
    await page.evaluate((id) => {
      window.__pomadeStores.useWorkspaceStore
        .getState()
        .updateProject(id, { name: 'Alpha Renamed' })
    }, alpha)
    expect(await ok(frame, 'project.getSettings', { projectId: alpha })).toMatchObject({
      settings: { backlog: 'Projects/alpha/docs/roadmap' }
    })
  })

  test('visible agents: read and replace; the Workspace project sees every agent', async () => {
    const beta = fixture.projects.beta
    expect(await ok(frame, 'project.getAgents', { projectId: beta })).toEqual({ visibleAgents: ['*'] })
    expect(await ok(frame, 'project.getAgents', { projectId: '__workspace__' })).toEqual({ visibleAgents: ['*'] })
    await ok(frame, 'project.setAgents', { projectId: beta, visibleAgents: ['claude-test', 'codex', 'codex'] })
    expect(await ok(frame, 'project.getAgents', { projectId: beta })).toEqual({ visibleAgents: ['claude-test', 'codex'] })
    const inStore = await page.evaluate(
      (id) =>
        window.__pomadeStores.useWorkspaceStore
          .getState()
          .projects.find((p) => p.id === id)?.visibleAgents,
      beta
    )
    expect(inStore).toEqual(['claude-test', 'codex'])
    await expect.poll(() => savedProject(beta).then((p) => p?.visibleAgents)).toEqual(['claude-test', 'codex'])
  })

  test('errors and capabilities', async () => {
    expect(await code(frame, 'project.getSettings', { projectId: 'ghost' })).toBe('not-found')
    expect(await code(frame, 'project.getSettings', { projectId: '__workspace__' })).toBe('invalid-params')
    expect(await code(frame, 'project.setSettings', { projectId: fixture.projects.beta, settings: [1] })).toBe('invalid-params')
    expect(
      await code(frame, 'project.setSettings', { projectId: fixture.projects.beta, settings: { big: 'x'.repeat(70000) } })
    ).toBe('invalid-params')
    expect(await code(frame, 'project.setAgents', { projectId: fixture.projects.beta, visibleAgents: ['*', 'codex'] })).toBe(
      'invalid-params'
    )
    expect(await code(frame, 'project.setAgents', { projectId: '__workspace__', visibleAgents: [] })).toBe('invalid-params')
    const ro = await openApp(page, 'hello-ro')
    expect(await code(ro, 'project.getAgents', { projectId: fixture.projects.beta })).toBeUndefined()
    expect(await code(ro, 'project.setSettings', { projectId: fixture.projects.beta, settings: {} })).toBe('capability-denied')
    expect(await code(ro, 'project.setAgents', { projectId: fixture.projects.beta, visibleAgents: [] })).toBe('capability-denied')
  })
})

test.describe('E-030 scoped symlinks', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let agentsDir: string
  let writerDir: string
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  const SKILL = 'Apps/pomade-agents/skill'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(abs(SKILL), { recursive: true })
    await fs.writeFile(abs(`${SKILL}/SKILL.md`), '---\nname: sessions\n---\n')
    await fs.mkdir(abs('Agents/claude-test/skills/own'), { recursive: true })
    await fs.writeFile(abs('Agents/claude-test/skills/own/SKILL.md'), 'own\n')
    await fs.symlink(abs('Agents/claude-test'), abs('Agents/linked'))
    agentsDir = await helloCopy('hello-agents', ['files.read', 'files.symlink'], { symlinks: ['Agents/*/skills'] })
    writerDir = await helloCopy('hello-writer', ['files.read', 'files.write'], { symlinks: ['Agents/*/skills'] })
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${agentsDir};${writerDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-agents')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of [agentsDir, writerDir]) if (d) await fs.rm(d, { recursive: true, force: true })
  })

  test('creates a relative link in a declared folder (missing folders made); the listing shows its target kind', async () => {
    await ok(frame, 'files.symlink', { path: 'Agents/claude-test/skills/sessions', target: SKILL })
    const link = abs('Agents/claude-test/skills/sessions')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(link)).toBe('../../../Apps/pomade-agents/skill')
    expect(await fs.readFile(join(link, 'SKILL.md'), 'utf8')).toBe('---\nname: sessions\n---\n')
    await ok(frame, 'files.symlink', { path: 'Agents/claude-new/skills/sessions', target: SKILL })
    expect((await fs.lstat(abs('Agents/claude-new/skills/sessions'))).isSymbolicLink()).toBe(true)
    const listed = (await ok(frame, 'files.readFolder', { path: 'Agents/claude-test/skills' })) as {
      entries: { name: string; kind: string }[]
    }
    expect(listed.entries.map((e) => [e.name, e.kind])).toEqual([
      ['own', 'dir'],
      ['sessions', 'dir']
    ])
  })

  test('removes only the link, never its target; a real folder is never removed', async () => {
    await ok(frame, 'files.removeSymlink', { path: 'Agents/claude-test/skills/sessions' })
    await expect(fs.lstat(abs('Agents/claude-test/skills/sessions'))).rejects.toThrow()
    expect(await fs.readFile(abs(`${SKILL}/SKILL.md`), 'utf8')).toBe('---\nname: sessions\n---\n')
    expect(await code(frame, 'files.removeSymlink', { path: 'Agents/claude-test/skills/own' })).toBe('invalid-params')
    expect(await fs.readFile(abs('Agents/claude-test/skills/own/SKILL.md'), 'utf8')).toBe('own\n')
    expect(await code(frame, 'files.removeSymlink', { path: 'Agents/claude-test/skills/gone' })).toBe('not-found')
  })

  test('refusals: outside the declared folders, through a symlinked folder, taken paths, bad targets', async () => {
    expect(await code(frame, 'files.symlink', { path: 'Agents/claude-test/x', target: SKILL })).toBe('capability-denied')
    expect(await code(frame, 'files.symlink', { path: 'Agents/claude-test/skills/a/b', target: SKILL })).toBe(
      'capability-denied'
    )
    expect(await code(frame, 'files.symlink', { path: 'Agents/linked/skills/x', target: SKILL })).toBe('capability-denied')
    expect(await code(frame, 'files.removeSymlink', { path: 'Agents/linked/skills/own' })).toBe('capability-denied')
    expect(await code(frame, 'files.symlink', { path: 'Agents/claude-test/skills/own', target: SKILL })).toBe('already-exists')
    expect(await code(frame, 'files.symlink', { path: 'Agents/claude-test/skills/x', target: 'Apps/nope' })).toBe('not-found')
    expect(await code(frame, 'files.symlink', { path: 'Agents/claude-test/skills/x', target: '../outside' })).toBe(
      'outside-workspace'
    )
    expect(await fs.readdir(abs('Agents/claude-test/skills'))).toEqual(['own'])
  })

  test('without files.symlink a declared folder grants nothing', async () => {
    const writer = await openApp(page, 'hello-writer')
    expect(await code(writer, 'files.symlink', { path: 'Agents/claude-test/skills/x', target: SKILL })).toBe(
      'capability-denied'
    )
  })
})

test.describe('E-030 files.pickFolder', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dataDir: string
  let noReadDir: string
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  interface PickRequest {
    defaultPath: string
    message: string
  }

  /** Queue the user's choices (absolute folders, or null = cancel) and clear the request log. */
  const script = (answers: (string | null)[]): Promise<void> =>
    app.evaluate((_electron, a) => {
      globalThis.__pomadePick = { answers: a, requests: [] }
    }, answers)
  const requests = (): Promise<PickRequest[]> =>
    app.evaluate(() => globalThis.__pomadePick?.requests ?? [])

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(abs('Projects/alpha/docs/roadmap'), { recursive: true })
    dataDir = await helloCopy('hello-data', DATA_CAPS)
    noReadDir = await helloCopy('hello-noread', ['project.read'])
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${dataDir};${noReadDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-data')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of [dataDir, noReadDir]) if (d) await fs.rm(d, { recursive: true, force: true })
  })

  test('returns the chosen folder workspace-relative; the picker opens at initial, inside the project', async () => {
    await script([abs('Projects/alpha/docs/roadmap')])
    expect(
      await ok(frame, 'files.pickFolder', { root: fixture.projects.alpha, initial: 'Projects/alpha/docs' })
    ).toEqual({ path: 'Projects/alpha/docs/roadmap' })
    expect(await requests()).toEqual([
      { defaultPath: abs('Projects/alpha/docs'), message: 'Choose a folder inside Projects/alpha' }
    ])
  })

  test('a folder outside the root is refused in the panel, which opens again at the root', async () => {
    await script([abs('Projects/beta'), abs('Projects/alpha/docs')])
    expect(await ok(frame, 'files.pickFolder', { root: fixture.projects.alpha })).toEqual({ path: 'Projects/alpha/docs' })
    expect(await requests()).toEqual([
      { defaultPath: abs('Projects/alpha'), message: 'Choose a folder inside Projects/alpha' },
      { defaultPath: abs('Projects/alpha'), message: 'That folder is outside Projects/alpha. Choose a folder inside it.' }
    ])
  })

  test('cancel is { path: null }; the default root is the whole workspace; an initial outside the root is ignored', async () => {
    await script([null])
    expect(await ok(frame, 'files.pickFolder', { root: fixture.projects.alpha })).toEqual({ path: null })
    await script([abs('Apps/gamma')])
    expect(await ok(frame, 'files.pickFolder')).toEqual({ path: 'Apps/gamma' })
    expect((await requests())[0]).toEqual({ defaultPath: fixture.workspaceRoot, message: 'Choose a folder inside the workspace' })
    await script([null])
    await ok(frame, 'files.pickFolder', { root: fixture.projects.alpha, initial: 'Projects/beta' })
    expect((await requests())[0].defaultPath).toBe(abs('Projects/alpha'))
  })

  test('errors: an unknown root project, an escaping initial, no files.read', async () => {
    expect(await code(frame, 'files.pickFolder', { root: 'ghost' })).toBe('not-found')
    expect(await code(frame, 'files.pickFolder', { initial: '../x' })).toBe('outside-workspace')
    const noRead = await openApp(page, 'hello-noread')
    expect(await code(noRead, 'files.pickFolder', {})).toBe('capability-denied')
  })
})

test.describe('T-245 files.pickFile', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let frame: Frame
  let dataDir: string
  let noReadDir: string
  let outsideDir: string
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
  interface PickRequest {
    defaultPath: string
    message: string
    extensions?: string[]
  }

  /** Queue the user's choices (absolute paths, or null = cancel) and clear the request log. */
  const script = (answers: (string | null)[]): Promise<void> =>
    app.evaluate((_electron, a) => {
      globalThis.__pomadePick = { answers: a, requests: [] }
    }, answers)
  const requests = (): Promise<PickRequest[]> =>
    app.evaluate(() => globalThis.__pomadePick?.requests ?? [])

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(abs('Projects/alpha/docs/sub'), { recursive: true })
    await fs.mkdir(abs('.pomade'), { recursive: true })
    await fs.writeFile(abs('Projects/alpha/docs/a.md'), '# a\n')
    await fs.writeFile(abs('Projects/alpha/docs/Day.MD'), '# day\n')
    await fs.writeFile(abs('Projects/alpha/docs/b.txt'), 'b\n')
    await fs.writeFile(abs('.pomade/t245-own.md'), '# own\n')
    outsideDir = await tempDir('pomade-t245-out-')
    await fs.writeFile(join(outsideDir, 'secret.md'), '# secret\n')
    await fs.symlink(join(outsideDir, 'secret.md'), abs('Projects/alpha/docs/escape.md'))
    dataDir = await helloCopy('hello-data', DATA_CAPS)
    noReadDir = await helloCopy('hello-noread', ['project.read'])
    app = await launchApp(fixture, { POMADE_DEV_APPS: `${dataDir};${noReadDir}` })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    frame = await openApp(page, 'hello-data')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    for (const d of [dataDir, noReadDir, outsideDir]) if (d) await fs.rm(d, { recursive: true, force: true })
  })

  test('returns the chosen file workspace-relative; the picker opens at under and offers the extensions', async () => {
    await script([abs('Projects/alpha/docs/a.md')])
    expect(await ok(frame, 'files.pickFile', { under: 'Projects/alpha/docs', extensions: ['md', 'TXT'] })).toEqual({
      path: 'Projects/alpha/docs/a.md'
    })
    expect(await requests()).toEqual([
      {
        defaultPath: abs('Projects/alpha/docs'),
        message: 'Choose a .md or .txt file inside Projects/alpha/docs',
        extensions: ['md', 'txt']
      }
    ])
  })

  test('a file outside under, a folder, an escaping link or another extension is refused in the panel', async () => {
    await script([
      abs('Projects/alpha/README.md'),
      abs('Projects/alpha/docs/sub'),
      abs('Projects/alpha/docs/escape.md'),
      abs('Projects/alpha/docs/b.txt'),
      abs('Projects/alpha/docs/Day.MD')
    ])
    expect(await ok(frame, 'files.pickFile', { under: 'Projects/alpha/docs', extensions: ['md'] })).toEqual({
      path: 'Projects/alpha/docs/Day.MD'
    })
    const asked = await requests()
    const at = abs('Projects/alpha/docs')
    expect(asked.map((r) => r.defaultPath)).toEqual(Array(5).fill(at))
    expect(asked.map((r) => r.message)).toEqual([
      'Choose a .md file inside Projects/alpha/docs',
      'That file is outside Projects/alpha/docs. Choose a .md file inside it.',
      'That file is outside Projects/alpha/docs. Choose a .md file inside it.',
      'That file is outside Projects/alpha/docs. Choose a .md file inside it.',
      'That is not a .md file. Choose a .md file inside Projects/alpha/docs.'
    ])
  })

  test('cancel is { path: null }; under defaults to the whole workspace and any file is offered', async () => {
    await script([null])
    expect(await ok(frame, 'files.pickFile', { under: 'Projects/alpha/docs' })).toEqual({ path: null })
    await script([abs('Projects/beta/data.csv')])
    expect(await ok(frame, 'files.pickFile')).toEqual({ path: 'Projects/beta/data.csv' })
    expect(await requests()).toEqual([{ defaultPath: fixture.workspaceRoot, message: 'Choose a file inside the workspace' }])
  })

  test("a file in Pomade's own .pomade folder is refused in the panel", async () => {
    await script([abs('.pomade/t245-own.md'), abs('Projects/beta/data.csv')])
    expect(await ok(frame, 'files.pickFile')).toEqual({ path: 'Projects/beta/data.csv' })
    expect((await requests()).map((r) => r.message)).toEqual([
      'Choose a file inside the workspace',
      "Files in Pomade's own .pomade folder can't be chosen. Choose a file inside the workspace."
    ])
  })

  test('errors: under that is missing or a file, an escaping under, bad extensions, no files.read', async () => {
    expect(await code(frame, 'files.pickFile', { under: 'Projects/nope' })).toBe('not-found')
    expect(await code(frame, 'files.pickFile', { under: 'Projects/alpha/README.md' })).toBe('not-found')
    expect(await code(frame, 'files.pickFile', { under: '../x' })).toBe('outside-workspace')
    expect(await code(frame, 'files.pickFile', { under: '.pomade' })).toBe('capability-denied')
    expect(await code(frame, 'files.pickFile', { extensions: [] })).toBe('invalid-params')
    expect(await code(frame, 'files.pickFile', { extensions: ['.md'] })).toBe('invalid-params')
    const noRead = await openApp(page, 'hello-noread')
    expect(await code(noRead, 'files.pickFile', {})).toBe('capability-denied')
  })
})
