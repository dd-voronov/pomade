// modules: filetree
// Pomade E-026 (Slice 1) e2e — multiple within-workspace file-tree roots: mount a folder below
// the project root, collapse/expand each root to its header, the pinned project-root "home"
// chip, orange scope marks, unmount (✕ + menu), duplicate/self no-op, per-project persistence
// across a reload, the missing-root state on disk deletion, and full-peer ops inside a mount.
//
// Runs against the FIXTURE workspace, with the ACTIVE project switched to alpha (so mounts
// persist — the Workspace project's are session-only). This file seeds `Knowledge/` and
// `mount-del/` at the workspace root before launch. Specs chain state WITHIN this file — append,
// never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type Page,
  type Locator
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'
import { tempDir } from './fixtures/temp'

let fixture: Fixture
let app: ElectronApplication
let page: Page
let root: string
let alpha: string
// T-132 — a mount OUTSIDE the fixture workspace. Created under the real HOME dir (a throwaway
// tempDir — never a real user folder) so its header label renders home-relative (`~/…`); the
// workspace itself lives under the OS tmp dir, so this is genuinely outside it.
let outsideDir: string
/** The `~`-relative form the outside header is expected to show (T-101 convention). */
const outsideTilde = (): string => `~${outsideDir.slice(homedir().length)}`

const onDisk = (rel: string) =>
  fs
    .access(join(root, rel))
    .then(() => true)
    .catch(() => false)

/** The header row of a root, located by its (stable) workspace-relative path. */
const rootHeader = (path: string): Locator => page.locator(`[data-root-path="${path}"]`)

async function launch(): Promise<void> {
  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('filetree-root')).toBeVisible()
  // Switch to a REAL project so mounts persist (the Workspace project's are session-only).
  await page.getByTestId(`project-${alpha}`).click()
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
  await expect(page.getByTestId('tree-node-Projects/alpha/README.md')).toBeVisible()
}

/** T-144 — the Mount action moved into the file-tree section ⋯ kebab. Open the kebab and click
 *  "Mount new folder…" to raise the mount dialog. */
async function openMountDialog(): Promise<void> {
  await page.getByTestId('tree-section-kebab').click()
  await page.getByTestId('menu-mount-folder').click()
  await expect(page.getByTestId('tree-mount-dialog')).toBeVisible()
}

/** Open the mount popup, type `path`, and press Mount. */
async function mount(path: string): Promise<void> {
  await openMountDialog()
  await page.getByTestId('tree-mount-input').fill(path)
  await page.getByTestId('tree-mount-submit').click()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  root = fixture.workspaceRoot
  alpha = fixture.projects.alpha

  // A sibling folder OUTSIDE the alpha project (→ orange), plus a nested subtree.
  await fs.mkdir(join(root, 'Knowledge/sub'), { recursive: true })
  await fs.writeFile(join(root, 'Knowledge/note.md'), '# Note\n')
  await fs.writeFile(join(root, 'Knowledge/sub/deep.md'), '# Deep\n')
  // A throwaway folder mounted then deleted on disk (missing-root test).
  await fs.mkdir(join(root, 'mount-del'), { recursive: true })
  await fs.writeFile(join(root, 'mount-del/tmp.md'), 'tmp\n')

  // T-132 — an outside-workspace tree (under HOME, so its label is `~`-relative), with a nested
  // subtree, mounted by the appended outside-mount specs.
  outsideDir = await tempDir('pomade-t132-', homedir())
  await fs.mkdir(join(outsideDir, 'sub'), { recursive: true })
  await fs.writeFile(join(outsideDir, 'sub', 'deep.md'), '# Deep\n')
  await fs.writeFile(join(outsideDir, 'top.md'), '# Top\n')

  // T-133 — a fresh outside dir for the write-op specs (the T-132 one is deleted by the
  // missing-state specs).
  outW = await tempDir('pomade-t133-', homedir())
  await fs.mkdir(join(outW, 'sub'), { recursive: true })
  await fs.writeFile(join(outW, 'seed.md'), '# Seed\n')

  // T-137 — an outside PARENT that exists, with a child target that does not (mounted cold).
  coldParent = await tempDir('pomade-t137-', homedir())
  coldTarget = join(coldParent, 'appears-later') // intentionally NOT created yet

  await launch()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
  if (outW) await fs.rm(outW, { recursive: true, force: true })
  if (coldParent) await fs.rm(coldParent, { recursive: true, force: true })
})

test('mounting a within-workspace folder adds a second root with an orange mark and loads its children', async () => {
  await mount('Knowledge')

  // A new root header appears, below the project root. Scope now lives in the collapse DIAMOND
  // (T-135): an outside-project root gets the ORANGE diamond, and — being healthy — shows NO ⚠
  // triangle (the triangle is problem-only now).
  await expect(rootHeader('Knowledge')).toBeVisible()
  await expect(page.locator('[data-root-path="Knowledge"] [data-scope="outside-project"]')).toBeVisible()
  await expect(page.locator('[data-root-path="Knowledge"] [data-tone]')).toHaveCount(0)

  // Its children load and open like the project tree.
  await expect(page.getByTestId('tree-node-Knowledge/note.md')).toBeVisible()
  await page.getByTestId('tree-node-Knowledge/sub').click()
  await expect(page.getByTestId('tree-node-Knowledge/sub/deep.md')).toBeVisible()
})

test('the project root shows the home chip, stays first, and has no unmount affordance', async () => {
  await expect(page.getByTestId('tree-root-home-chip')).toBeVisible()

  // First in the body: the project-root header precedes the Knowledge header in the DOM.
  const boxes = await page.locator('[data-root-path]').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).getAttribute('data-root-path'))
  )
  expect(boxes[0]).toBe('Projects/alpha')
  expect(boxes).toContain('Knowledge')

  // No ✕ under the project root, and no Unmount in its menu.
  await expect(
    page.locator('[data-testid="filetree-root"] [data-testid^="tree-root-unmount-"]')
  ).toHaveCount(0)
  await page.getByTestId('filetree-root').click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
  await expect(page.getByTestId('menu-unmount')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('each root collapses to its header and re-expands, including the project root', async () => {
  // Collapse the Knowledge mount: its header stays, its children hide.
  await rootHeader('Knowledge').click()
  await expect(page.getByTestId('tree-node-Knowledge/note.md')).toHaveCount(0)
  await expect(rootHeader('Knowledge')).toBeVisible()
  // Re-expand.
  await rootHeader('Knowledge').click()
  await expect(page.getByTestId('tree-node-Knowledge/note.md')).toBeVisible()

  // The project root collapses too.
  await page.getByTestId('filetree-root').click()
  await expect(page.getByTestId('tree-node-Projects/alpha/README.md')).toHaveCount(0)
  await page.getByTestId('filetree-root').click()
  await expect(page.getByTestId('tree-node-Projects/alpha/README.md')).toBeVisible()
})

test('a duplicate or self path does not add a second root', async () => {
  // Pasting an already-mounted path: the popup shows the "already shown" hint and adds nothing.
  await openMountDialog()
  await page.getByTestId('tree-mount-input').fill('Knowledge')
  await expect(page.getByTestId('tree-mount-hint')).toContainText('Already shown')
  await page.getByTestId('tree-mount-submit').click()
  await expect(page.locator('[data-root-path="Knowledge"]')).toHaveCount(1)

  // Pasting the project root itself is a self-duplicate — also a no-op.
  await openMountDialog()
  await page.getByTestId('tree-mount-input').fill('Projects/alpha')
  await expect(page.getByTestId('tree-mount-hint')).toContainText('Already shown')
  await page.getByTestId('tree-mount-submit').click()
  await expect(page.locator('[data-root-path]')).toHaveCount(2) // project root + Knowledge only
})

test('the popup now ALLOWS an outside-workspace path (T-132) with a red-mark hint', async () => {
  // Slice 2 (T-132) enabled outside mounts: the danger hint changed from "Slice 2" to the
  // red-mark copy, and Mount is enabled. Fill + cancel here (the real outside mount is covered by
  // the appended T-132 specs, which use a temp dir — never a real system path).
  await openMountDialog()
  await page.getByTestId('tree-mount-input').fill('/etc/hosts')
  await expect(page.getByTestId('tree-mount-hint')).toContainText('red mark')
  await expect(page.getByTestId('tree-mount-submit')).toBeEnabled()
  await page.getByTestId('tree-mount-cancel').click()
})

test('unmount removes a mount (via the ⋯ kebab and via the context menu)', async () => {
  // T-144 — via the per-root ⋯ kebab menu (the old hover ✕ was replaced by the kebab).
  await openRootKebab('Knowledge')
  await page.getByTestId('menu-unmount').click()
  await expect(rootHeader('Knowledge')).toHaveCount(0)

  // Re-mount, then unmount via the right-click context menu (still the same commands menu).
  await mount('Knowledge')
  await expect(rootHeader('Knowledge')).toBeVisible()
  await rootHeader('Knowledge').click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
  await page.getByTestId('menu-unmount').click()
  await expect(rootHeader('Knowledge')).toHaveCount(0)

  // Leave Knowledge mounted, and COLLAPSED, for the persistence test.
  await mount('Knowledge')
  await expect(rootHeader('Knowledge')).toBeVisible()
  await rootHeader('Knowledge').click()
  await expect(page.getByTestId('tree-node-Knowledge/note.md')).toHaveCount(0)
})

test('mounts and collapsed state persist to the state file and survive a reload', async () => {
  // Wait out the 500ms debounce, then assert the on-disk state carries the mount + collapse.
  await expect
    .poll(
      async () => {
        const raw = await fs
          .readFile(join(root, '.pomade', 'state', `${alpha}.json`), 'utf8')
          .catch(() => '')
        if (!raw) return null
        const st = JSON.parse(raw)
        return {
          mounts: (st.mounts ?? []).map((m: { path: string }) => m.path),
          collapsed: (st.collapsedRoots ?? []).length
        }
      },
      { timeout: 5_000 }
    )
    .toEqual({ mounts: ['Knowledge'], collapsed: 1 })

  // Relaunch and re-open alpha: the mount is back and STILL collapsed.
  await app.close()
  await launch()
  await expect(rootHeader('Knowledge')).toBeVisible()
  await expect(page.getByTestId('tree-node-Knowledge/note.md')).toHaveCount(0)
  // Re-expand for the following tests.
  await rootHeader('Knowledge').click()
  await expect(page.getByTestId('tree-node-Knowledge/note.md')).toBeVisible()
})

test('deleting a mounted folder on disk flips it to the missing state without removing it', async () => {
  await mount('mount-del')
  await expect(rootHeader('mount-del')).toBeVisible()
  await expect(page.getByTestId('tree-node-mount-del/tmp.md')).toBeVisible()

  // Let the new mount's watcher ARM before deleting — under a parallel full-suite run FSEvents can
  // arm after the immediate rm, missing the deletion event entirely (the 15s poll then times out
  // and, since this file chains state, the next test cascades). Matches the outside-door arm waits.
  // eslint-disable-next-line playwright/no-wait-for-timeout -- FSEvents arm latency: no signal says the watcher is live; 1200 ms as 500 proved too tight under the parallel suite
  await page.waitForTimeout(1200)
  await fs.rm(join(root, 'mount-del'), { recursive: true, force: true })

  // The watcher reports it gone → the header flips to the muted "doesn't exist" state, but the
  // root is KEPT (never auto-removed) and its children clear.
  await expect(rootHeader('mount-del')).toHaveAttribute('data-missing', 'true', { timeout: 15_000 })
  await expect(rootHeader('mount-del')).toBeVisible()
  await expect(page.getByTestId('tree-node-mount-del/tmp.md')).toHaveCount(0)
})

test('full-peer file ops work inside a mounted subtree', async () => {
  // New file inside the Knowledge mount (via the mount subtree's context menu).
  await page.getByTestId('tree-node-Knowledge/sub').click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
  await page.getByTestId('menu-new-file').click()
  await page.getByTestId('name-input').fill('peer.md')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('tree-node-Knowledge/sub/peer.md')).toBeVisible()
  await expect.poll(() => onDisk('Knowledge/sub/peer.md')).toBe(true)

  // Rename it.
  await page.getByTestId('tree-node-Knowledge/sub/peer.md').click({ button: 'right' })
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('name-input').fill('peer2.md')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('tree-node-Knowledge/sub/peer2.md')).toBeVisible()
  await expect.poll(() => onDisk('Knowledge/sub/peer2.md')).toBe(true)
  await expect.poll(() => onDisk('Knowledge/sub/peer.md')).toBe(false)

  // Delete it.
  await page.getByTestId('tree-node-Knowledge/sub/peer2.md').click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('tree-node-Knowledge/sub/peer2.md')).toHaveCount(0)
  await expect.poll(() => onDisk('Knowledge/sub/peer2.md')).toBe(false)
})

// ─── T-132 — outside-workspace mounts (the E-026 slice this file completes) ──────
// The outside root reads through the T-131 door (fs.treeOutside + fs.watchOutside); its node
// paths are ABSOLUTE (no ws-relative form), so testids are `tree-node-<absolute path>`.

test('T-132: mounting an OUTSIDE-workspace folder adds a root with a RED mark, a ~-relative label, and children', async () => {
  await mount(outsideDir)

  // A new root header keyed by the ABSOLUTE path, carrying the RED (danger) scope diamond (T-135).
  await expect(rootHeader(outsideDir)).toBeVisible()
  await expect(page.locator(`[data-root-path="${outsideDir}"] [data-scope="outside-workspace"]`)).toBeVisible()
  // Not orange, and — healthy — no ⚠ triangle at all.
  await expect(page.locator(`[data-root-path="${outsideDir}"] [data-scope="outside-project"]`)).toHaveCount(0)
  await expect(page.locator(`[data-root-path="${outsideDir}"] [data-tone]`)).toHaveCount(0)

  // The header label is home-relative (`~/pomade-t132-…`), T-101 convention.
  await expect(rootHeader(outsideDir)).toContainText(outsideTilde())

  // Children load via treeOutside and open like any tree; the subdir descends on expand.
  await expect(page.getByTestId(`tree-node-${outsideDir}/top.md`)).toBeVisible()
  await page.getByTestId(`tree-node-${outsideDir}/sub`).click()
  await expect(page.getByTestId(`tree-node-${outsideDir}/sub/deep.md`)).toBeVisible()
})

test('T-132: an outside root live-refreshes on a file add and remove', async () => {
  // FSEvents arm latency: give the just-started outside watcher time before the first mutation
  // (the full parallel suite is CPU-contended).
  // eslint-disable-next-line playwright/no-wait-for-timeout -- FSEvents arm latency: no signal says the watcher is live; 1200 ms as 500 proved too tight under the parallel suite
  await page.waitForTimeout(1200)

  const added = join(outsideDir, `live-${Date.now()}.md`)
  await fs.writeFile(added, '# live\n')
  await expect(page.getByTestId(`tree-node-${added}`)).toBeVisible({ timeout: 15_000 })

  await fs.rm(added, { force: true })
  await expect(page.getByTestId(`tree-node-${added}`)).toHaveCount(0, { timeout: 15_000 })
})

test('T-132: an outside mount persists (with outside:true) and restores LIVE with its children', async () => {
  // Wait out the 500ms debounce, then confirm the state file carries the absolute path + flag.
  await expect
    .poll(
      async () => {
        const raw = await fs
          .readFile(join(root, '.pomade', 'state', `${alpha}.json`), 'utf8')
          .catch(() => '')
        if (!raw) return null
        const st = JSON.parse(raw)
        const m = (st.mounts ?? []).find((x: { path: string }) => x.path === outsideDir)
        return m ? { path: m.path, outside: m.outside === true } : null
      },
      { timeout: 5_000 }
    )
    .toEqual({ path: outsideDir, outside: true })

  // Relaunch: the outside mount is back, still red, and its children re-read through treeOutside.
  await app.close()
  await launch()
  await expect(rootHeader(outsideDir)).toBeVisible()
  await expect(page.locator(`[data-root-path="${outsideDir}"] [data-scope="outside-workspace"]`)).toBeVisible()
  await expect(page.getByTestId(`tree-node-${outsideDir}/top.md`)).toBeVisible()
})

test('T-132: deleting the outside root on disk flips it to the missing state without removing it', async () => {
  await fs.rm(outsideDir, { recursive: true, force: true })

  // LIVE detection: the non-recursive parent watch (T-132, fs-service) fires on the root's own
  // removal and broadcasts on fs.onChanged, so the renderer re-reads via treeOutside (which now
  // throws) and the header flips to the muted "doesn't exist" state with NO manual refresh. The
  // root is KEPT (never auto-removed) and its children clear. Generous timeout absorbs FSEvents
  // parent-watch latency.
  await expect(rootHeader(outsideDir)).toHaveAttribute('data-missing', 'true', { timeout: 15_000 })
  await expect(rootHeader(outsideDir)).toBeVisible()
  await expect(page.getByTestId(`tree-node-${outsideDir}/top.md`)).toHaveCount(0)
})

test('T-132: a persisted outside mount whose path is gone restores DIRECTLY into the missing state', async () => {
  // Relaunch with the outside dir still deleted: treeOutside throws on restore → the mount
  // rehydrates straight into the missing state, no error, the app stays healthy.
  await app.close()
  await launch()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(rootHeader(outsideDir)).toHaveAttribute('data-missing', 'true', { timeout: 15_000 })
  await expect(rootHeader(outsideDir)).toBeVisible()
})

// ─── T-133 — WRITE ops INSIDE an outside mount (the doors, the delete confirm, the no-mix rule) ──
// The Owner chose SUPPORT over disable: create/rename/delete/duplicate/move/copy inside an outside
// subtree via the guarded `…Outside` doors. A FRESH outside dir is used — the T-132 `outsideDir`
// above was deleted by the missing-state specs. Node testids are `tree-node-<absolute path>`.

/** A fresh outside-workspace dir (under HOME, a throwaway tempDir) for the write-op specs. */
let outW: string
const onDiskAbs = (abs: string): Promise<boolean> =>
  fs
    .access(abs)
    .then(() => true)
    .catch(() => false)

test('T-133: mount the fresh outside root for the write-op specs', async () => {
  await mount(outW)
  await expect(rootHeader(outW)).toBeVisible()
  await expect(page.getByTestId(`tree-node-${outW}/seed.md`)).toBeVisible()
  // Let the outside watcher ARM before mutating (FSEvents latency under parallel load).
  // eslint-disable-next-line playwright/no-wait-for-timeout -- FSEvents arm latency: no signal says the watcher is live; 1200 ms as 500 proved too tight under the parallel suite
  await page.waitForTimeout(1200)
})

test('T-133: New file and New folder inside an outside subtree land via the outside door', async () => {
  // New file at the outside root (right-click a file → its parent = the root).
  await page.getByTestId(`tree-node-${outW}/seed.md`).click({ button: 'right' })
  await page.getByTestId('menu-new-file').click()
  await page.getByTestId('name-input').fill('note.md')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId(`tree-node-${outW}/note.md`)).toBeVisible()
  await expect.poll(() => onDiskAbs(join(outW, 'note.md'))).toBe(true)

  // New folder at the outside root.
  await page.getByTestId(`tree-node-${outW}/seed.md`).click({ button: 'right' })
  await page.getByTestId('menu-new-folder').click()
  await page.getByTestId('name-input').fill('newdir')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId(`tree-node-${outW}/newdir`)).toBeVisible()
  await expect.poll(() => onDiskAbs(join(outW, 'newdir'))).toBe(true)
})

test('T-133: rename inside an outside subtree (via renameOutside)', async () => {
  await page.getByTestId(`tree-node-${outW}/note.md`).click({ button: 'right' })
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('name-input').fill('note2.md')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId(`tree-node-${outW}/note2.md`)).toBeVisible()
  await expect.poll(() => onDiskAbs(join(outW, 'note2.md'))).toBe(true)
  await expect.poll(() => onDiskAbs(join(outW, 'note.md'))).toBe(false)
})

test('T-133: duplicate (Copy→Paste into the same outside folder) makes a " copy" via copyOutside', async () => {
  await page.getByTestId(`tree-node-${outW}/note2.md`).click({ button: 'right' })
  await page.getByTestId('menu-copy').click()
  // Paste into the SAME folder (right-click a file → parent = the root) → collision-safe " copy".
  await page.getByTestId(`tree-node-${outW}/seed.md`).click({ button: 'right' })
  await page.getByTestId('menu-paste').click()
  await expect(page.getByTestId(`tree-node-${outW}/note2 copy.md`)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => onDiskAbs(join(outW, 'note2 copy.md'))).toBe(true)
})

test('T-133: a Cut→Paste name clash inside an outside root opens the collision dialog', async () => {
  // Expand sub so its children live-refresh, then seed the same filename in two outside folders.
  await page.getByTestId(`tree-node-${outW}/sub`).click()
  await fs.writeFile(join(outW, 'clash.md'), 'a\n')
  await fs.writeFile(join(outW, 'sub', 'clash.md'), 'b\n')
  await expect(page.getByTestId(`tree-node-${outW}/clash.md`)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId(`tree-node-${outW}/sub/clash.md`)).toBeVisible({ timeout: 15_000 })

  // Cut the root clash.md, paste into sub (which already holds a clash.md) → collision dialog.
  await page.getByTestId(`tree-node-${outW}/clash.md`).click({ button: 'right' })
  await page.getByTestId('menu-cut').click()
  await page.getByTestId(`tree-node-${outW}/sub`).click({ button: 'right' })
  await page.getByTestId('menu-paste').click()
  await expect(page.getByTestId('tree-collision')).toBeVisible()

  // Resolve with a collision-safe rename → "clash copy.md" lands in sub; the root file is gone.
  await page.getByTestId('collision-rename').click()
  await expect(page.getByTestId(`tree-node-${outW}/sub/clash copy.md`)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => onDiskAbs(join(outW, 'sub', 'clash copy.md'))).toBe(true)
  await expect.poll(() => onDiskAbs(join(outW, 'clash.md'))).toBe(false)
})

test('T-133: an outside clipboard cannot be pasted into an in-workspace folder (and vice-versa)', async () => {
  // Outside clip → the Paste item is DISABLED over an in-workspace folder (never offered).
  await page.getByTestId(`tree-node-${outW}/note2.md`).click({ button: 'right' })
  await page.getByTestId('menu-copy').click()
  await page.getByTestId('tree-node-Projects/alpha/README.md').click({ button: 'right' })
  await expect(page.getByTestId('menu-paste')).toBeDisabled()
  await page.keyboard.press('Escape')

  // In-workspace clip → Paste is DISABLED over an outside folder.
  await page.getByTestId('tree-node-Projects/alpha/README.md').click({ button: 'right' })
  await page.getByTestId('menu-copy').click()
  await page.getByTestId(`tree-node-${outW}/note2.md`).click({ button: 'right' })
  await expect(page.getByTestId('menu-paste')).toBeDisabled()
  await page.keyboard.press('Escape')
})

test('T-133: Cut→Paste moves a file within the outside root (moveOutside)', async () => {
  await page.getByTestId(`tree-node-${outW}/note2.md`).click({ button: 'right' })
  await page.getByTestId('menu-cut').click()
  await page.getByTestId(`tree-node-${outW}/sub`).click({ button: 'right' })
  await page.getByTestId('menu-paste').click()
  // pasteInto auto-expands the destination folder, so the moved node is visible.
  await expect(page.getByTestId(`tree-node-${outW}/sub/note2.md`)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => onDiskAbs(join(outW, 'sub', 'note2.md'))).toBe(true)
  await expect.poll(() => onDiskAbs(join(outW, 'note2.md'))).toBe(false)
})

test('T-133: deleting an outside node confirms EVERY time — cancel leaves it, confirm trashes it', async () => {
  // Cancel: the node stays on disk and in the tree.
  await page.getByTestId(`tree-node-${outW}/seed.md`).click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('tree-delete-confirm')).toBeVisible()
  await page.getByTestId('delete-confirm-cancel').click()
  await expect(page.getByTestId('tree-delete-confirm')).toHaveCount(0)
  await expect(page.getByTestId(`tree-node-${outW}/seed.md`)).toBeVisible()
  await expect.poll(() => onDiskAbs(join(outW, 'seed.md'))).toBe(true)

  // Confirm: it goes to the Trash (recoverable) and leaves the tree.
  await page.getByTestId(`tree-node-${outW}/seed.md`).click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('tree-delete-confirm')).toBeVisible()
  await page.getByTestId('delete-confirm-ok').click()
  await expect(page.getByTestId(`tree-node-${outW}/seed.md`)).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => onDiskAbs(join(outW, 'seed.md'))).toBe(false)
})

test('T-133: an in-workspace delete still has NO confirm (the asymmetry)', async () => {
  // A throwaway file in the alpha project, created + deleted through the UI: the delete goes
  // straight to Trash with no confirm dialog.
  await page.getByTestId('tree-node-Projects/alpha/README.md').click({ button: 'right' })
  await page.getByTestId('menu-new-file').click()
  await page.getByTestId('name-input').fill('t133-del.md')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('tree-node-Projects/alpha/t133-del.md')).toBeVisible()

  await page.getByTestId('tree-node-Projects/alpha/t133-del.md').click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('tree-delete-confirm')).toHaveCount(0)
  await expect(page.getByTestId('tree-node-Projects/alpha/t133-del.md')).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => onDisk('Projects/alpha/t133-del.md')).toBe(false)
})

test('T-133: a mixed inside+outside multi-selection disables the mutating bulk items', async () => {
  // Select one in-workspace node, then Cmd+click one outside node (selection spans both roots).
  await page.getByTestId('tree-node-Projects/alpha/README.md').click()
  await page.getByTestId(`tree-node-${outW}/sub`).click({ modifiers: ['Meta'] })

  // Right-click inside the selection → the BULK menu, with the mutating items disabled.
  await page.getByTestId('tree-node-Projects/alpha/README.md').click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toHaveAttribute('data-bulk', 'true')
  await expect(page.getByTestId('menu-cut')).toBeDisabled()
  await expect(page.getByTestId('menu-copy')).toBeDisabled()
  await expect(page.getByTestId('menu-paste')).toBeDisabled()
  await expect(page.getByTestId('menu-delete')).toBeDisabled()
  // Non-mutating items stay enabled (Copy path, Reveal).
  await expect(page.getByTestId('menu-copy-path')).toBeEnabled()
  await page.keyboard.press('Escape')
})

// ─── T-137 — COLD-START mount watcher: a mount whose target does NOT exist yet must go live the
// moment the folder appears on disk, WITHOUT a project switch. Pre-fix, arming the recursive
// fs.watch on a missing path threw and bailed out before the parent watch was set up, so nothing
// observed the parent for the create event and the root only activated after switching projects
// and back. The fix arms a non-recursive watch on the nearest EXISTING ancestor while the target
// is absent, then promotes to the recursive target watch once it appears — the SAME broadcast +
// re-arm path that already makes delete→recreate of an existing mount instant. This asserts all
// four transitions (absent→present cold start, present→absent, absent→present recreate) live.

/** A fresh outside PARENT that EXISTS, with a child target that does NOT (mounted cold). */
let coldParent: string
let coldTarget: string

test('T-137: mounting a NON-EXISTENT outside path shows the root in the missing state', async () => {
  await mount(coldTarget)
  // The root is kept (never dropped) and rendered in the muted "doesn't exist" state — treeOutside
  // threw ENOENT on the initial read because the folder is not on disk yet.
  await expect(rootHeader(coldTarget)).toBeVisible()
  await expect(rootHeader(coldTarget)).toHaveAttribute('data-missing', 'true', { timeout: 15_000 })
  // Give the nearest-existing-ancestor watch (on coldParent) time to ARM before the create
  // (FSEvents arm latency; the full parallel suite is CPU-contended).
  // eslint-disable-next-line playwright/no-wait-for-timeout -- FSEvents arm latency: no signal says the watcher is live; 1200 ms as 500 proved too tight under the parallel suite
  await page.waitForTimeout(1200)
})

test('T-137: creating the folder on disk activates the root LIVE — no project switch', async () => {
  // Create the target with a file in it. The ancestor watch fires on the child appearing, the
  // renderer re-reads treeOutside (now resolving) and the root promotes to active — all without
  // touching the project selector. Live latency is sub-second; the generous ceiling only absorbs
  // FSEvents arm/broadcast jitter under parallel load.
  await fs.mkdir(coldTarget, { recursive: true })
  await fs.writeFile(join(coldTarget, 'hello.md'), '# Hello\n')

  await expect(rootHeader(coldTarget)).not.toHaveAttribute('data-missing', 'true', { timeout: 15_000 })
  await expect(page.getByTestId(`tree-node-${coldTarget}/hello.md`)).toBeVisible({ timeout: 15_000 })
})

test('T-137: deleting the now-existing folder flips it back to missing LIVE', async () => {
  await fs.rm(coldTarget, { recursive: true, force: true })
  await expect(rootHeader(coldTarget)).toHaveAttribute('data-missing', 'true', { timeout: 15_000 })
  await expect(page.getByTestId(`tree-node-${coldTarget}/hello.md`)).toHaveCount(0)
})

test('T-137: recreating the folder activates it again LIVE (same path as delete→recreate)', async () => {
  await fs.mkdir(coldTarget, { recursive: true })
  await fs.writeFile(join(coldTarget, 'again.md'), '# Again\n')
  await expect(rootHeader(coldTarget)).not.toHaveAttribute('data-missing', 'true', { timeout: 15_000 })
  await expect(page.getByTestId(`tree-node-${coldTarget}/again.md`)).toBeVisible({ timeout: 15_000 })
})

// ─── T-135 / T-136 — root-header line rework + reveal-in-Finder on every root ──────
// Chain state: at this point the roots are the pinned project (alpha / home), the healthy
// within-workspace mount Knowledge (orange), the healthy outside mount outW (red), and the
// outsideDir mount left in the MISSING state by the T-132 specs. Appended, never inserted.

test('T-135: a root header does not shift on hover — row height constant, chip stays put, actions reserved', async () => {
  const header = page.getByTestId('filetree-root')
  const chip = page.getByTestId('tree-root-home-chip')
  // T-144 — the reserved strip now holds the ⋯ kebab (was Copy/Reveal); the no-shift rule is
  // unchanged (button reserved in layout, revealed on hover).
  const kebabBtn = page.getByTestId('filetree-root-kebab')

  // Not hovered: the action strip is present in layout but hidden (visibility), so it reserves
  // its width without being interactable/visible.
  await page.mouse.move(0, 0)
  await expect(kebabBtn).toBeHidden()
  const rowBefore = await header.boundingBox()
  const chipBefore = await chip.boundingBox()

  // Hover: the strip fades in (opacity/visibility) but occupies the SAME reserved space, so the
  // row height is unchanged and the home chip does not move horizontally.
  await header.hover()
  await expect(kebabBtn).toBeVisible()
  const rowAfter = await header.boundingBox()
  const chipAfter = await chip.boundingBox()

  expect(rowAfter!.height).toBeCloseTo(rowBefore!.height, 1) // no vertical jump
  expect(chipAfter!.x).toBeCloseTo(chipBefore!.x, 1) // chip attached after the path, not floated
  expect(chipAfter!.y).toBeCloseTo(chipBefore!.y, 1)
})

test('T-135: a healthy mount shows its scope DIAMOND and NO ⚠ triangle', async () => {
  const header = rootHeader('Knowledge')
  await expect(header).toBeVisible()
  // Orange diamond (outside-project), always visible; no problem triangle on a healthy route.
  await expect(header.locator('[data-scope="outside-project"]')).toBeVisible()
  await expect(header.locator('[data-tone]')).toHaveCount(0)
  await expect(header).not.toHaveAttribute('data-missing', 'true')
})

test('T-136/T-144: Reveal in Finder + Copy path live in EVERY non-home root ⋯ kebab', async () => {
  // T-144 — the per-root Copy/Reveal moved from inline hover buttons into the ⋯ kebab menu. Assert
  // the menu carries Copy path + Reveal in Finder (enabled) rather than clicking Reveal (a real
  // click would launch Finder). Covered for BOTH an in-workspace mount and an outside mount.
  await openRootKebab('Knowledge')
  await expect(page.getByTestId('menu-copy-path')).toHaveCount(1)
  await expect(page.getByTestId('menu-reveal')).toBeEnabled()
  await page.keyboard.press('Escape')

  await openRootKebab(outW)
  await expect(page.getByTestId('menu-copy-path')).toHaveCount(1)
  await expect(page.getByTestId('menu-reveal')).toBeEnabled()
  await page.keyboard.press('Escape')
})

test('T-135: a missing root is greyed + struck through, shows the always-red ⚠, and a two-line tooltip', async () => {
  const header = rootHeader(outsideDir)
  await expect(header).toHaveAttribute('data-missing', 'true')

  // Struck-through, dimmed path text (the "dead route" read).
  const decoration = await header
    .locator('[data-testid^="tree-root-label-"]')
    .evaluate((el) => getComputedStyle(el).textDecorationLine)
  expect(decoration).toContain('line-through')

  // The problem marker is a danger (red) ScopeMark — present ONLY because the route is missing.
  const mark = header.locator('[data-tone="danger"]')
  await expect(mark).toBeVisible()

  // Two-line design-system tooltip: scope, then existence (reworded away from "no longer exist").
  await mark.hover()
  const tooltip = page.locator('[role="tooltip"]').last()
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('Outside your workspace')
  await expect(tooltip).toContainText("Path doesn't exist")
})

// ─── T-144 — file-tree header command reorg (per-root ⋯ kebabs + section ⋯ kebab) + mount rename.
// Chain state at this point: home (alpha), Knowledge (orange, expanded), outW (red), outsideDir
// (missing), coldTarget (active). Appended, never inserted.

/** Open a root's ⋯ kebab commands menu (hover-reveal the reserved-strip button, then click). The
 *  button is `filetree-root-kebab` on the home root and `tree-root-kebab-<id>` on a mount, so match
 *  by its stable aria-label instead. */
async function openRootKebab(path: string): Promise<void> {
  const header = rootHeader(path)
  await hoverClick(header, header.locator('button[aria-label="Root actions"]'))
  await expect(page.getByTestId('tree-menu')).toBeVisible()
}

test('T-144: the section ⋯ kebab holds ignored items…, show/hide ignored items, and mount-a-folder', async () => {
  await page.getByTestId('tree-section-kebab').click()
  await expect(page.getByTestId('tree-menu')).toHaveAttribute('data-section', 'true')
  await expect(page.getByTestId('menu-ignored-items')).toBeVisible()
  await expect(page.getByTestId('menu-toggle-ignored')).toBeVisible()
  await expect(page.getByTestId('menu-mount-folder')).toBeVisible()
  // The old inline buttons are gone from the header strip.
  await expect(page.getByTestId('tree-toggle-ignored')).toHaveCount(0)
  await expect(page.getByTestId('tree-ignore-settings')).toHaveCount(0)
  await expect(page.getByTestId('tree-mount-add')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('T-144: New folder wears the folder-with-plus icon and creates a folder', async () => {
  // The folder glyph moved off the old Mount button onto New folder; New file stays a text glyph.
  await expect(page.getByTestId('tree-new-folder').locator('svg')).toHaveCount(1)
  await expect(page.getByTestId('tree-new-file').locator('svg')).toHaveCount(0)

  // Selecting the project README (a file → its parent is the project root) targets the create.
  await page.getByTestId('tree-node-Projects/alpha/README.md').click()
  await page.getByTestId('tree-new-folder').click()
  await page.getByTestId('name-input').fill('t144-dir')
  await page.getByTestId('name-submit').click()
  const made = page.getByTestId('tree-node-Projects/alpha/t144-dir')
  await expect(made).toBeVisible()
  await expect(made).toHaveAttribute('data-kind', 'dir')
  await expect.poll(() => onDisk('Projects/alpha/t144-dir')).toBe(true)

  // Clean up the throwaway folder.
  await made.click({ button: 'right' })
  await page.getByTestId('menu-delete').click()
  await expect(page.getByTestId('tree-node-Projects/alpha/t144-dir')).toHaveCount(0, { timeout: 15_000 })
})

test('T-144: the HOME root kebab has Copy path + Reveal but NO Rename / Unmount', async () => {
  await openRootKebab('Projects/alpha')
  await expect(page.getByTestId('menu-copy-path')).toHaveCount(1)
  await expect(page.getByTestId('menu-reveal')).toHaveCount(1)
  await expect(page.getByTestId('menu-rename-mount')).toHaveCount(0)
  await expect(page.getByTestId('menu-unmount')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('T-144: a MOUNT root kebab adds Rename + Unmount', async () => {
  await openRootKebab('Knowledge')
  await expect(page.getByTestId('menu-copy-path')).toHaveCount(1)
  await expect(page.getByTestId('menu-reveal')).toHaveCount(1)
  await expect(page.getByTestId('menu-rename-mount')).toHaveCount(1)
  await expect(page.getByTestId('menu-unmount')).toHaveCount(1)
  await page.keyboard.press('Escape')
})

test('T-144: renaming a mount shows the custom name, persists across reload, and Copy path stays the real path', async () => {
  // Rename Knowledge → "My Notes" via the kebab's inline rename.
  await openRootKebab('Knowledge')
  await page.getByTestId('menu-rename-mount').click()
  const input = page.locator('[data-testid^="tree-root-rename-input-"]')
  await expect(input).toBeVisible()
  await input.fill('My Notes')
  await input.press('Enter')

  // The header (still located by its real ws-relative path) now shows the custom name, not "Knowledge".
  const header = rootHeader('Knowledge')
  await expect(header.locator('[data-testid^="tree-root-label-"]')).toContainText('My Notes')
  await expect(header.locator('[data-testid^="tree-root-label-"]')).not.toContainText('Knowledge')

  // Copy path still copies the REAL path (not the display name).
  await openRootKebab('Knowledge')
  await page.getByTestId('menu-copy-path').click()
  await expect.poll(() => page.evaluate(() => window.pomade.app.clipboardRead())).toBe('Knowledge')

  // The name persists to the state file.
  await expect
    .poll(
      async () => {
        const raw = await fs
          .readFile(join(root, '.pomade', 'state', `${alpha}.json`), 'utf8')
          .catch(() => '')
        if (!raw) return null
        const st = JSON.parse(raw)
        const m = (st.mounts ?? []).find((x: { path: string }) => x.path === 'Knowledge')
        return m?.name ?? null
      },
      { timeout: 5_000 }
    )
    .toBe('My Notes')

  // Survives a reload.
  await app.close()
  await launch()
  await expect(rootHeader('Knowledge').locator('[data-testid^="tree-root-label-"]')).toContainText('My Notes')

  // Clearing the name reverts the header to the path.
  await openRootKebab('Knowledge')
  await page.getByTestId('menu-rename-mount').click()
  const input2 = page.locator('[data-testid^="tree-root-rename-input-"]')
  await input2.fill('')
  await input2.press('Enter')
  await expect(rootHeader('Knowledge').locator('[data-testid^="tree-root-label-"]')).toContainText('Knowledge')
})

// ─── T-143 — the missing-route ⚠ tooltip stays ON-SCREEN when the header is pinned near the
// bottom of the window (the reported v0.2.1 bug: mounts stack low, so the danger ScopeMark's
// two-line tooltip was clipped below the viewport). Placement now runs through the shared T-088
// clamp (useClampedTooltip): it FLIPS to open UPWARD when there's no room below. This mirrors the
// menu-clamp geometry assertions — margin 8px, box fully within [8, viewport-8] on both axes.
const TOOLTIP_MARGIN = 8 // must match OVERLAY_MARGIN in src/renderer/hooks/use-clamped-position.ts

test('T-143: the missing-route ⚠ tooltip flips UP and stays on-screen when its header sits low', async () => {
  // Reload for a clean, predictable state (alpha active + expanded), then shrink the window to its
  // 600px minimum height.
  await app.close()
  await launch()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setContentSize(w.getContentSize()[0], 600)
  })
  await page.waitForFunction(() => window.innerHeight <= 620)

  // Fill the alpha subtree well past the (now short) viewport with throwaway files — the live
  // watcher renders them without a reopen — so the tree genuinely OVERFLOWS. Without overflow the
  // last root can't be pushed to the bottom, and the flip can't be exercised (menu-clamp uses the
  // same technique for its low-in-the-tree cases).
  for (let i = 1; i <= 40; i++) {
    await fs.writeFile(
      join(root, 'Projects/alpha', `zz-t143-filler-${String(i).padStart(2, '0')}.md`),
      `filler ${i}\n`
    )
  }
  await expect(page.getByTestId('tree-node-Projects/alpha/zz-t143-filler-40.md')).toBeVisible({
    timeout: 15_000
  })

  // A fresh non-existent OUTSIDE path → a root kept in the missing state (mirrors T-137), appended
  // LAST so it is the lowest root section in the tree.
  const missDir = join(coldParent, `t143-missing-low-${Date.now()}`) // intentionally never created
  await mount(missDir)
  const header = rootHeader(missDir)
  await expect(header).toHaveAttribute('data-missing', 'true', { timeout: 15_000 })

  // Pin the missing header to the very bottom of the scroll area, so a tooltip opening DOWNWARD
  // would be clipped and the flip is the only way to stay on-screen.
  await page.getByTestId('tree-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })

  // The danger ScopeMark and its portalled tooltip.
  const mark = header.locator('[data-tone="danger"]')
  await expect(mark).toBeVisible()
  await mark.hover()
  const tooltip = page.locator('[role="tooltip"]').last()
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText("Path doesn't exist")

  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const anchor = present(await mark.boundingBox(), 'scope mark box')
  const tip = present(await tooltip.boundingBox(), 'tooltip box')

  // Precondition — this proves the test is discriminating: the anchor is low enough that a tooltip
  // opening downward could NOT fit within the viewport (so the flip is genuinely required).
  expect(
    anchor.y + anchor.height + 6 + tip.height,
    'a downward tooltip would overflow the viewport bottom (so the flip is required)'
  ).toBeGreaterThan(vp.h - TOOLTIP_MARGIN)

  // The bug fix — the tooltip box is FULLY inside the viewport, never past the 8px margin.
  expect(tip.x, 'tooltip left edge').toBeGreaterThanOrEqual(TOOLTIP_MARGIN - 1)
  expect(tip.y, 'tooltip top edge').toBeGreaterThanOrEqual(TOOLTIP_MARGIN - 1)
  expect(tip.x + tip.width, `tooltip right edge (viewport ${vp.w})`).toBeLessThanOrEqual(
    vp.w - TOOLTIP_MARGIN + 1
  )
  expect(tip.y + tip.height, `tooltip bottom edge (viewport ${vp.h})`).toBeLessThanOrEqual(
    vp.h - TOOLTIP_MARGIN + 1
  )

  // And it genuinely FLIPPED UP: the whole tip sits above the anchor's top edge.
  expect(tip.y + tip.height, 'tooltip opened upward, above the ⚠').toBeLessThanOrEqual(anchor.y + 1)

  // Restore the default size for hygiene (no test runs after this, but keep the window sane).
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1360, 900)
  })
})

test('T-143: the section ⋯ kebab carries the design-system Tooltip, not a native title=', async () => {
  // The reported inconsistency: this button used to show a grey OS tooltip via `title=`. It must
  // now carry NO native title and instead render the portalled design-system tooltip on hover.
  const kebab = page.getByTestId('tree-section-kebab')
  await expect(kebab).toBeVisible()
  expect(
    await kebab.evaluate((el) => el.hasAttribute('title')),
    'no native title= (would render a grey OS tooltip)'
  ).toBe(false)

  await kebab.hover()
  const tip = page.locator('[role="tooltip"]').last()
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('File tree options')

  // Hover-only: moving off the control dismisses it.
  await page.getByTestId('tree-body').hover()
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0)
})
