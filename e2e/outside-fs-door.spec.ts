// modules: core, filetree
// Pomade T-131 e2e (E-026) — the outside-workspace mount door: fs.treeOutside + the bounded
// recursive watcher (fs.watchOutside / fs.unwatchOutside).
//
// These are MAIN-process + IPC surfaces, driven directly through window.pomade.fs (no filetree
// UI — that is T-130's, disjoint files). The mounted root is a SECOND OS-tmp dir, always OUTSIDE
// the fixture workspace and never a real user path. Change events arrive on the SAME fs.onChanged
// subscription the in-workspace watcher uses, keyed by the ABSOLUTE root path.
//
// Coverage (the T-131 acceptance list):
//   - treeOutside(root, 1) returns the immediate children with ABSOLUTE paths, dirs before files.
//   - treeOutside throws on a non-existent path (drives the missing-root state).
//   - watchOutside fires on a file add AND on the root's own deletion; unwatchOutside stops it.
//   - a double watchOutside opens ONE descriptor (idempotent — asserted via the main diagnostic).
//   - the escape guard is intact: a workspace-relative fs.tree('') still resolves inside only.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'
import { tempDir } from './fixtures/temp'

let fixture: Fixture
let app: ElectronApplication
let page: Page
/** A directory OUTSIDE the fixture workspace (still in OS tmp — never a real user path). */
let outsideDir: string

interface Node {
  name: string
  path: string
  kind: 'dir' | 'file'
  children?: Node[]
  symlink?: boolean
}

function treeOutside(absPath: string, depth: number): Promise<Node> {
  return page.evaluate(
    ({ p, d }) => window.pomade.fs.treeOutside(p, d) as Promise<unknown>,
    { p: absPath, d: depth }
  ) as Promise<Node>
}

/** treeOutside wrapped so a rejection comes back as a string instead of failing the evaluate. */
function treeOutsideErr(absPath: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    try {
      await window.pomade.fs.treeOutside(p, 1)
      return null
    } catch (e) {
      return String(e)
    }
  }, absPath)
}

/** Start collecting fs.onChanged payloads into a page-global array. */
async function startCollecting(): Promise<void> {
  await page.evaluate(() => {
    window.__changes = []
    window.__unsub = window.pomade.fs.onChanged(({ root: r }) => {
      window.__changes.push(r)
    })
  })
}

function collected(): Promise<string[]> {
  return page.evaluate(() => window.__changes)
}

async function clearCollected(): Promise<void> {
  await page.evaluate(() => {
    window.__changes = []
  })
}

/** Main-process diagnostic: number of live outside-root watcher descriptors. */
function outsideWatchCount(): Promise<number> {
  return app.evaluate(
    () => globalThis.__pomadeOutsideWatch?.size ?? -1
  )
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  outsideDir = await tempDir('pomade-t131-mount-')
  // A small tree so treeOutside(depth 1) has both a dir and a file child (dirs sort first).
  await fs.mkdir(join(outsideDir, 'sub'), { recursive: true })
  await fs.writeFile(join(outsideDir, 'sub', 'deep.md'), '# deep\n')
  await fs.writeFile(join(outsideDir, 'top.md'), '# top\n')

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
})

test.describe('T-131 — outside-workspace fs door (E-026)', () => {
  test('treeOutside returns immediate children with ABSOLUTE paths, dirs before files', async () => {
    const tree = await treeOutside(outsideDir, 1)
    // The root node itself carries the absolute path.
    expect(tree.path).toBe(outsideDir)
    expect(tree.kind).toBe('dir')
    const children = tree.children ?? []
    const names = children.map((c) => c.name)
    expect(names).toEqual(['sub', 'top.md']) // dir sorts before file

    const sub = children.find((c) => c.name === 'sub')!
    const top = children.find((c) => c.name === 'top.md')!
    // Every path is absolute (no ws-relative form outside the workspace).
    expect(sub.path).toBe(join(outsideDir, 'sub'))
    expect(top.path).toBe(join(outsideDir, 'top.md'))
    expect(sub.kind).toBe('dir')
    expect(top.kind).toBe('file')
    // depth 1 does not descend into the subdir.
    expect(sub.children).toBeUndefined()
  })

  test('treeOutside descends `depth` levels and rejects a non-existent root', async () => {
    const tree = await treeOutside(outsideDir, 2)
    const sub = (tree.children ?? []).find((c) => c.name === 'sub')!
    expect((sub.children ?? []).map((c) => c.name)).toEqual(['deep.md'])
    expect(sub.children![0].path).toBe(join(outsideDir, 'sub', 'deep.md'))

    const err = await treeOutsideErr(join(outsideDir, 'does-not-exist'))
    expect(err).toBeTruthy() // ENOENT — drives the renderer's missing-root state
  })

  test('watchOutside fires fs.onChanged (keyed by the abs root) on add/remove; unwatch stops it', async () => {
    await startCollecting()
    await page.evaluate((p) => window.pomade.fs.watchOutside(p), outsideDir)
    expect(await outsideWatchCount()).toBe(1)
    // eslint-disable-next-line playwright/no-wait-for-timeout -- FSEvents arm latency: no signal says the watcher is live before the first mutation
    await page.waitForTimeout(800)

    const added = join(outsideDir, `added-${Date.now()}.md`)
    await fs.writeFile(added, '# added under the mounted root\n')
    await expect
      .poll(() => collected().then((c) => c.includes(outsideDir)), { timeout: 10_000 })
      .toBe(true)

    // Unwatch, then a further change must NOT arrive.
    await clearCollected()
    await page.evaluate((p) => window.pomade.fs.unwatchOutside(p), outsideDir)
    expect(await outsideWatchCount()).toBe(0)
    await fs.rm(added, { force: true })
    // Real-world window (FSEvents delivery latency, not interval-derived): a still-armed watcher
    // would have delivered well inside 1500ms — held throughout.
    await expectQuiet(async () => {
      expect(await collected()).not.toContain(outsideDir)
    }, 1500)
  })

  test('a double watchOutside opens ONE descriptor (idempotent add)', async () => {
    await page.evaluate((p) => window.pomade.fs.watchOutside(p), outsideDir)
    await page.evaluate((p) => window.pomade.fs.watchOutside(p), outsideDir)
    expect(await outsideWatchCount()).toBe(1)
    await page.evaluate((p) => window.pomade.fs.unwatchOutside(p), outsideDir)
    expect(await outsideWatchCount()).toBe(0)
  })

  test('watching the root detects the root’s OWN deletion', async () => {
    const doomed = await tempDir('pomade-t131-doomed-')
    await fs.writeFile(join(doomed, 'x.md'), '# x\n')
    await startCollecting()
    await page.evaluate((p) => window.pomade.fs.watchOutside(p), doomed)
    expect(await outsideWatchCount()).toBe(1)
    // FSEvents arm latency: under a parallel full-suite run 500ms is too tight — a not-yet-armed
    // watcher misses the root's deletion entirely and the poll below times out. 1200ms is safe.
    // eslint-disable-next-line playwright/no-wait-for-timeout -- FSEvents arm latency: no signal says the watcher is live; 1200 ms per the note above
    await page.waitForTimeout(1200)

    await fs.rm(doomed, { recursive: true, force: true })
    await expect
      .poll(() => collected().then((c) => c.includes(doomed)), { timeout: 10_000 })
      .toBe(true)
    // After the root is gone, a re-read throws — the renderer's missing-root signal.
    expect(await treeOutsideErr(doomed)).toBeTruthy()
    await page.evaluate((p) => window.pomade.fs.unwatchOutside(p), doomed)
  })

  test('the escape guard is intact: fs.tree stays workspace-bounded (no regression)', async () => {
    // A workspace-relative read still works and returns ws-relative paths (no leading slash).
    const tree = await page.evaluate(() => window.pomade.fs.tree('', 1) as Promise<unknown>)
    const root = tree as Node
    expect(root.path.startsWith('/')).toBe(false)
    // An absolute outside path handed to the ESCAPE-GUARDED fs.read is refused (it is not a
    // door — only the *Outside channels are). abs() throws "Path escapes workspace".
    const guarded = await page.evaluate(async (p) => {
      try {
        await window.pomade.fs.read(p)
        return { ok: true, err: '' }
      } catch (e) {
        return { ok: false, err: String(e) }
      }
    }, outsideDir)
    expect(guarded.ok).toBe(false)
    expect(guarded.err).toContain('escapes workspace')
  })
})
