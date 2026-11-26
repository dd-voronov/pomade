// modules: filetree, editor, terminal
// Pomade T-091 e2e — the terminal name index is EAGER and WATCHED.
//
// E-020's bare-name / stem lookups (`findByName` / `findByStem`) used to be served by a lazily
// built index with a 30 s TTL, so the first Cmd+hover of a terminal session paid a full
// workspace walk (~2 s on a real vault) and a file created a second ago stayed unclickable for
// up to 30 s. T-091 builds the index when the workspace root is set and keeps it fresh with one
// index-owned recursive fs.watch, patched per dirty directory on a ~200 ms debounce.
//
// What is asserted here — and why each of these FAILS on the pre-T-091 implementation:
//   • the index exists before ANY lookup (there was no eager build at all);
//   • a file created AFTER a build becomes findable in seconds — every test forces a build
//     first, so the old TTL would have to expire (30 s) for the lookup to see it;
//   • deletions leave the index (same reasoning, in reverse);
//   • a newly created nested subtree is indexed (one coalesced FSEvents event must still be
//     resolved into a walk of that subtree);
//   • the shared artifact-ignore list keeps build outputs out of the index while a control file
//     created in the same beat IS indexed (proves the exclusion isn't just staleness).
//
// Every test provisions its own file names: Playwright discards a worker after a failure, so
// state shared between tests would turn one real failure into a cascade of meaningless ones.

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

let fixture: Fixture
let app: ElectronApplication
let page: Page

/** How long a watcher-driven patch may take to show up. Comfortably above the 200 ms debounce
 *  plus FSEvents latency, and FAR below the 30 s TTL of the implementation this replaces — that
 *  gap is what makes these specs revert-proof. */
const FRESH_TIMEOUT_MS = 8_000

interface IndexStats {
  builds: number
  patches: number
  watching: boolean
  lastBuildMs: number
  files: number
  dirs: number
}

/** Main-process diagnostics (not an IPC surface): see `nameIndexStats` in main/fs-service.ts. */
function indexStats(): Promise<IndexStats | undefined> {
  return app.evaluate(
    () => globalThis.__pomadeNameIndex
  ) as Promise<IndexStats | undefined>
}

function findByName(name: string): Promise<string[]> {
  return page.evaluate((n) => window.pomade.fs.findByName(n), name)
}

function findByStem(word: string): Promise<string[]> {
  return page.evaluate((w) => window.pomade.fs.findByStem(w), word)
}

/** Wait until an index exists for this workspace, then force a lookup through the real IPC
 *  surface so a lazy implementation would ALSO have a freshly built index at this point. That
 *  is the fair comparison: everything asserted afterwards is about staying fresh, not about
 *  building at all. */
async function indexBuiltAndQueried(): Promise<void> {
  await expect.poll(() => indexStats().then((s) => s?.builds ?? 0), { timeout: 15_000 }).toBeGreaterThan(0)
  expect(await findByName('welcome.md')).toContain('welcome.md')
}

async function write(relPath: string, content: string): Promise<void> {
  const abs = join(fixture.workspaceRoot, relPath)
  await fs.mkdir(join(abs, '..'), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('name index: eager warm + watcher freshness (T-091)', () => {
  test('the index is built and watched before any lookup asks for it', async () => {
    // No findByName/findByStem call has happened in this app instance yet: the index can only
    // exist because the workspace root being set warmed it.
    await expect.poll(() => indexStats().then((s) => s?.builds ?? 0), { timeout: 15_000 }).toBeGreaterThan(0)
    const stats = await indexStats()
    expect(stats?.watching).toBe(true)
    expect(stats?.files ?? 0).toBeGreaterThan(0)
    // And it really is serving: a fixture file is findable by its bare name.
    expect(await findByName('welcome.md')).toContain('welcome.md')
  })

  test('a file created AFTER the build is findable by bare name and by stem', async () => {
    await indexBuiltAndQueried()
    const rel = 'Projects/alpha/born-after-index.md'
    await write(rel, '# Born after the index was built\n')

    await expect
      .poll(() => findByName('born-after-index.md'), { timeout: FRESH_TIMEOUT_MS })
      .toContain(rel)
    // The stem map rides the same patch — an extension-less word must not lag behind.
    await expect.poll(() => findByStem('born-after-index'), { timeout: FRESH_TIMEOUT_MS }).toContain(rel)
  })

  test('a deleted file leaves the index', async () => {
    await indexBuiltAndQueried()
    const rel = 'Projects/beta/doomed-note.md'
    await write(rel, '# About to be deleted\n')
    await expect.poll(() => findByName('doomed-note.md'), { timeout: FRESH_TIMEOUT_MS }).toContain(rel)

    await fs.rm(join(fixture.workspaceRoot, rel))
    await expect.poll(() => findByName('doomed-note.md'), { timeout: FRESH_TIMEOUT_MS }).toEqual([])
    expect(await findByStem('doomed-note')).toEqual([])
  })

  test('a whole new nested subtree is indexed', async () => {
    await indexBuiltAndQueried()
    // Created in one `mkdir -p`-shaped burst: FSEvents may report only the top directory, so
    // the patch has to walk what appeared underneath it.
    const rel = 'Projects/alpha/fresh-dir/deeper/nested-note.md'
    await write(rel, '# Nested, created after the build\n')

    // EXACTLY one hit: the subtree walk that picks this up may re-read a directory an earlier
    // event already indexed, and a duplicated path would make this unique file pop the
    // ambiguity picker instead of opening.
    await expect.poll(() => findByName('nested-note.md'), { timeout: FRESH_TIMEOUT_MS }).toEqual([rel])
    expect(await findByStem('nested-note')).toEqual([rel])
  })

  test('files in build-output / vendored trees stay out of the index', async () => {
    await indexBuiltAndQueried()
    // Same name in an ignored tree and in a normal one, created in the same beat: the control
    // proves the exclusion is the ignore list rather than a slow patch.
    await write('Projects/alpha/dist/artifact-note.md', '# Build output\n')
    await write('node_modules/dummy-pkg/artifact-note.md', '# Vendored\n')
    await write('Projects/alpha/control-note.md', '# Indexed normally\n')

    await expect
      .poll(() => findByName('control-note.md'), { timeout: FRESH_TIMEOUT_MS })
      .toContain('Projects/alpha/control-note.md')
    expect(await findByName('artifact-note.md')).toEqual([])
    expect(await findByStem('artifact-note')).toEqual([])
  })
})
