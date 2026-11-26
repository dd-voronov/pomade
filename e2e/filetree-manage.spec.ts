// modules: filetree, editor
// Pomade E-012 e2e — file-tree file management: context menu (Cut/Copy/Paste/Rename/Delete/
// Copy path/Copy full path), drag-and-drop move, and symlink transparency (indicator +
// write-through pin). Runs against the FIXTURE workspace; this file seeds its own `mng/`
// subtree (incl. two symlinks) on disk before launch so the tree renders them. Specs chain
// state WITHIN this file — append, never insert mid-file.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchApp } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let fixture: Fixture
let app: ElectronApplication
let page: Page
let root: string

const vis = (sel: string) => page.locator(`${sel}:visible`)
const onDisk = (rel: string) =>
  fs
    .access(join(root, rel))
    .then(() => true)
    .catch(() => false)

// Drive HTML5 drag-and-drop deterministically (Playwright mouse gestures don't trigger
// native DnD). One DataTransfer shared across dragstart→dragover→drop→dragend, mirroring
// the tab-reorder helper in tabs.spec.ts.
async function dragNodeOnto(sourcePath: string, targetPath: string): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const source = page.getByTestId(`tree-node-${sourcePath}`)
  const target = page.getByTestId(`tree-node-${targetPath}`)
  const box = await target.boundingBox()
  if (!box) throw new Error('target node has no box')
  const clientX = Math.round(box.x + box.width / 2)
  const clientY = Math.round(box.y + box.height / 2)
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt, clientX, clientY })
  // drop triggers the (async) move; the source node is removed from the tree once it lands,
  // so a trailing dragend on the source would race a vanished element. onDrop already clears
  // the drag state (clearDrag), so dragend is unnecessary here.
  await target.dispatchEvent('drop', { dataTransfer: dt, clientX, clientY })
}

async function openMenuOn(path: string): Promise<void> {
  await page.getByTestId(`tree-node-${path}`).click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  root = fixture.workspaceRoot

  // A self-contained subtree at the workspace root (the default active Workspace project roots
  // the tree here). Includes a folder to move things into and two symlinks.
  await fs.mkdir(join(root, 'mng/sub'), { recursive: true })
  await fs.writeFile(join(root, 'mng/a.md'), 'AAA\n')
  await fs.writeFile(join(root, 'mng/b.md'), 'BBB\n')
  await fs.writeFile(join(root, 'mng/sub/keep.md'), 'keep\n')
  await fs.writeFile(join(root, 'mng/target.txt'), 'ORIGINAL\n')
  // Relative symlinks: a file link (alias.txt → target.txt) and a dir link (linkdir → sub).
  await fs.symlink('target.txt', join(root, 'mng/alias.txt'))
  await fs.symlink('sub', join(root, 'mng/linkdir'))

  // E-016 fixtures: a doc-follow subject, and clash pairs for the move-collision dialog.
  await fs.mkdir(join(root, 'mng/dest'), { recursive: true })
  await fs.writeFile(join(root, 'mng/e016-follow.md'), 'FOLLOW\n')
  await fs.writeFile(join(root, 'mng/e016-clash.md'), 'SRC\n')
  await fs.writeFile(join(root, 'mng/dest/e016-clash.md'), 'DEST\n')
  await fs.writeFile(join(root, 'mng/e016-over.md'), 'NEWSRC\n')
  await fs.writeFile(join(root, 'mng/dest/e016-over.md'), 'OLD\n')

  // T-220 fixtures: a file and a folder (with one child) to rename by double-click.
  await fs.mkdir(join(root, 'mng/dbl-dir'), { recursive: true })
  await fs.writeFile(join(root, 'mng/dbl-dir/inner.md'), 'inner\n')
  await fs.writeFile(join(root, 'mng/dbl-file.md'), 'DBL\n')
  await fs.writeFile(join(root, 'mng/dbl-keep.md'), 'KEEP\n')
  await fs.mkdir(join(root, 'mng/dbl-mod'), { recursive: true })
  await fs.writeFile(join(root, 'mng/dbl-mod/m.md'), 'm\n')

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('filetree-root')).toBeVisible()
  // Expand the mng folder so its children (incl. symlinks) render.
  await page.getByTestId('tree-node-mng').click()
  await expect(page.getByTestId('tree-node-mng/a.md')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('symlink indicator shows on a symlinked file and folder (not on plain entries)', async () => {
  await expect(page.getByTestId('tree-symlink-mng/alias.txt')).toBeVisible()
  await expect(page.getByTestId('tree-node-mng/alias.txt')).toHaveAttribute('data-symlink', 'true')
  await expect(page.getByTestId('tree-symlink-mng/linkdir')).toBeVisible()
  // A symlinked directory stays kind:'dir' (target followed) — transparent, expandable.
  await expect(page.getByTestId('tree-node-mng/linkdir')).toHaveAttribute('data-kind', 'dir')
  // Plain files carry no indicator.
  await expect(page.getByTestId('tree-symlink-mng/a.md')).toHaveCount(0)
})

test('Rename via the context menu renames on disk and refuses a collision', async () => {
  await openMenuOn('mng/a.md')
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('name-input').fill('renamed.md')
  await page.getByTestId('name-submit').click()

  await expect(page.getByTestId('tree-node-mng/renamed.md')).toBeVisible()
  await expect.poll(() => onDisk('mng/renamed.md')).toBe(true)
  await expect.poll(() => onDisk('mng/a.md')).toBe(false)

  // Collision: renaming b.md → renamed.md is refused; nothing is clobbered.
  await openMenuOn('mng/b.md')
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('name-input').fill('renamed.md')
  await page.getByTestId('name-submit').click()

  await expect(page.getByTestId('tree-node-mng/b.md')).toBeVisible()
  await expect.poll(() => onDisk('mng/b.md')).toBe(true)
  // renamed.md is still a.md's content (AAA), not overwritten by b.md (BBB).
  expect(await fs.readFile(join(root, 'mng/renamed.md'), 'utf8')).toBe('AAA\n')
})

test('Cut then Paste moves a file into a folder', async () => {
  await openMenuOn('mng/renamed.md')
  await page.getByTestId('menu-cut').click()

  await openMenuOn('mng/sub')
  await page.getByTestId('menu-paste').click()

  await expect(page.getByTestId('tree-node-mng/sub/renamed.md')).toBeVisible()
  await expect.poll(() => onDisk('mng/sub/renamed.md')).toBe(true)
  await expect.poll(() => onDisk('mng/renamed.md')).toBe(false)
})

test('Paste is disabled once the cut entry has been consumed', async () => {
  // The Cut above was consumed by its Paste, so the clipboard is now empty.
  await openMenuOn('mng/sub')
  await expect(page.getByTestId('menu-paste')).toBeDisabled()
  await page.keyboard.press('Escape')
})

test('Copy then Paste duplicates a file with collision-safe naming', async () => {
  await openMenuOn('mng/b.md')
  await page.getByTestId('menu-copy').click()

  // Paste onto b.md itself → destination folder is its parent (mng), collides → "b copy.md".
  await openMenuOn('mng/b.md')
  await page.getByTestId('menu-paste').click()

  await expect(page.getByTestId('tree-node-mng/b copy.md')).toBeVisible()
  await expect.poll(() => onDisk('mng/b copy.md')).toBe(true)
  await expect.poll(() => onDisk('mng/b.md')).toBe(true) // original untouched
})

test('Delete moves a file to the trash (gone from tree and disk, no error)', async () => {
  await openMenuOn('mng/b copy.md')
  await page.getByTestId('menu-delete').click()

  await expect(page.getByTestId('tree-node-mng/b copy.md')).toHaveCount(0)
  await expect.poll(() => onDisk('mng/b copy.md')).toBe(false)
})

test('Copy path / Copy full path write to the clipboard', async () => {
  await openMenuOn('mng/b.md')
  await page.getByTestId('menu-copy-path').click()
  await expect
    .poll(() => page.evaluate(() => window.pomade.app.clipboardRead()))
    .toBe('mng/b.md')

  await openMenuOn('mng/b.md')
  await page.getByTestId('menu-copy-full-path').click()
  await expect
    .poll(() => page.evaluate(() => window.pomade.app.clipboardRead()))
    .toBe(join(root, 'mng/b.md'))
})

test('Drag-and-drop moves a file into a folder (disk + tree)', async () => {
  await dragNodeOnto('mng/b.md', 'mng/sub')

  await expect(page.getByTestId('tree-node-mng/sub/b.md')).toBeVisible()
  await expect.poll(() => onDisk('mng/sub/b.md')).toBe(true)
  await expect.poll(() => onDisk('mng/b.md')).toBe(false)
})

test('Moving a folder into its own descendant is refused (guard)', async () => {
  const err = await page.evaluate(async () => {
    try {
      await window.pomade.fs.move('mng/sub', 'mng/sub/sub-copy')
      return null
    } catch (e) {
      return (e as Error).message
    }
  })
  expect(err).toContain('itself')
  // The folder is untouched.
  await expect.poll(() => onDisk('mng/sub')).toBe(true)
  await expect.poll(() => onDisk('mng/sub/sub-copy')).toBe(false)
})

test('symlink write-through: two saves keep the link and update the target', async () => {
  // Open the symlinked .txt (opens the raw editor), edit + save twice.
  await page.getByTestId('tree-node-mng/alias.txt').click()
  const cm = vis('[data-testid="raw-editor"] .cm-content')
  await expect(cm).toBeVisible()

  await cm.click()
  await page.keyboard.type('\nEDIT-ONE')
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => fs.readFile(join(root, 'mng/target.txt'), 'utf8').catch(() => '')).toContain('EDIT-ONE')

  await cm.click()
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type('\nEDIT-TWO')
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => fs.readFile(join(root, 'mng/target.txt'), 'utf8').catch(() => '')).toContain('EDIT-TWO')

  // After two saves the alias is STILL a symlink pointing at the same target, and the
  // edits landed on the TARGET file (write-through, not a detached copy).
  const lst = await fs.lstat(join(root, 'mng/alias.txt'))
  expect(lst.isSymbolicLink()).toBe(true)
  expect(await fs.readlink(join(root, 'mng/alias.txt'))).toBe('target.txt')
  expect(await fs.realpath(join(root, 'mng/alias.txt'))).toBe(
    await fs.realpath(join(root, 'mng/target.txt'))
  )
  const target = await fs.readFile(join(root, 'mng/target.txt'), 'utf8')
  expect(target).toContain('EDIT-ONE')
  expect(target).toContain('EDIT-TWO')
})

// ── E-012 round-3: tree selection drives header create + visible symlink indicator ──

test('Selecting a folder makes the header New file create INSIDE it', async () => {
  const row = page.getByTestId('tree-node-mng/sub')
  await row.click()
  await expect(row).toHaveAttribute('data-selected', 'true')

  await page.getByTestId('tree-new-file').click()
  await page.getByTestId('name-input').fill('hdr-in-sub.md')
  await page.getByTestId('name-submit').click()

  await expect(page.getByTestId('tree-node-mng/sub/hdr-in-sub.md')).toBeVisible()
  await expect.poll(() => onDisk('mng/sub/hdr-in-sub.md')).toBe(true)
  // Not created at the root.
  await expect.poll(() => onDisk('hdr-in-sub.md')).toBe(false)
})

test('Selecting a FILE makes the header New folder target the file’s parent', async () => {
  const file = page.getByTestId('tree-node-mng/target.txt')
  await file.click()
  await expect(file).toHaveAttribute('data-selected', 'true')

  await page.getByTestId('tree-new-folder').click()
  await page.getByTestId('name-input').fill('hdr-sibling')
  await page.getByTestId('name-submit').click()

  // Created next to the file (its parent = mng/), not inside the file.
  await expect(page.getByTestId('tree-node-mng/hdr-sibling')).toBeVisible()
  await expect.poll(() => onDisk('mng/hdr-sibling')).toBe(true)
})

test('With nothing selected the header create falls back to the project root', async () => {
  // Click the empty tree body to clear the selection.
  const body = page.getByTestId('tree-body')
  const box = present(await body.boundingBox(), 'tree body box')
  await body.click({ position: { x: 12, y: box.height - 12 } })
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0)

  await page.getByTestId('tree-new-file').click()
  await page.getByTestId('name-input').fill('hdr-at-root.md')
  await page.getByTestId('name-submit').click()

  await expect(page.getByTestId('tree-node-hdr-at-root.md')).toBeVisible()
  await expect.poll(() => onDisk('hdr-at-root.md')).toBe(true)
})

test('Symlink indicator shows on the tree row, the tab, and the editor header', async () => {
  // Tree-row indicator (new chain-link glyph, testid + data-symlink preserved).
  await expect(page.getByTestId('tree-symlink-mng/alias.txt')).toBeVisible()

  // Opening the symlinked file surfaces the glyph in its tab and the chip in the editor header.
  await page.getByTestId('tree-node-mng/alias.txt').click()
  await expect(page.getByTestId('tab-symlink')).toBeVisible()
  await expect(page.getByTestId('editor-symlink')).toBeVisible()
})

// ── E-012 (final): clickable symlink target popover ──────────────────────────

test('Clicking the tree indicator opens the popover; Open target opens the real file', async () => {
  await page.getByTestId('tree-symlink-mng/alias.txt').click()
  await expect(page.getByTestId('symlink-popover')).toBeVisible()
  // Workspace-relative target shown (alias.txt → target.txt, both under mng/).
  await expect(page.getByTestId('symlink-path')).toContainText('mng/target.txt')

  await page.getByTestId('symlink-open-target').click()
  await expect(page.getByTestId('symlink-popover')).toHaveCount(0)
  // The real file opened in a doc tab (its editor pane is now shown).
  await expect(page.locator('[data-doc-path="mng/target.txt"]:visible')).toBeVisible()
})

test('Reveal in tree selects the target row', async () => {
  await page.getByTestId('tree-symlink-mng/alias.txt').click()
  await expect(page.getByTestId('symlink-popover')).toBeVisible()
  await page.getByTestId('symlink-reveal-tree').click()

  await expect(page.getByTestId('symlink-popover')).toHaveCount(0)
  await expect(page.getByTestId('tree-node-mng/target.txt')).toHaveAttribute('data-selected', 'true')
})

test('A broken symlink shows the danger state and a tinted indicator', async () => {
  // Create a broken link on disk; the live watcher surfaces it in the (expanded) mng folder.
  await fs.symlink('does-not-exist.txt', join(root, 'mng/broken.txt'))
  const indicator = page.getByTestId('tree-symlink-mng/broken.txt')
  await expect(indicator).toBeVisible()
  await expect(indicator).toHaveAttribute('data-broken', 'true')

  await indicator.click()
  await expect(page.getByTestId('symlink-popover')).toBeVisible()
  const note = page.getByTestId('symlink-note')
  await expect(note).toHaveAttribute('data-broken', 'true')
  await expect(note).toContainText('broken')
  // Broken state offers Copy path only — no Open target / Reveal in tree.
  await expect(page.getByTestId('symlink-copy-path')).toBeVisible()
  await expect(page.getByTestId('symlink-open-target')).toHaveCount(0)
  await expect(page.getByTestId('symlink-reveal-tree')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('symlink-popover')).toHaveCount(0)
})

test('The editor-header indicator opens the same popover', async () => {
  // Activate the symlinked file's editor, then click its header chip.
  await page.getByTestId('tree-node-mng/alias.txt').click()
  await expect(page.getByTestId('editor-symlink')).toBeVisible()
  await page.getByTestId('editor-symlink').click()

  await expect(page.getByTestId('symlink-popover')).toBeVisible()
  await expect(page.getByTestId('symlink-path')).toContainText('mng/target.txt')
  await page.keyboard.press('Escape')
})

// ── P-021: go-to-path row ────────────────────────────────────────────────────

test('Go-to-path (relative) reveals + selects a nested file and opens it', async () => {
  await page.getByTestId('tree-goto').fill('mng/sub/keep.md')
  await page.getByTestId('tree-goto').press('Enter')

  await expect(page.getByTestId('tree-node-mng/sub/keep.md')).toHaveAttribute('data-selected', 'true')
  await expect(page.locator('[data-doc-path="mng/sub/keep.md"]:visible')).toBeVisible()
  // The input clears on success.
  await expect(page.getByTestId('tree-goto')).toHaveValue('')
})

test('Go-to-path accepts an absolute in-workspace path', async () => {
  await page.getByTestId('tree-goto').fill(join(root, 'mng/target.txt'))
  await page.getByTestId('tree-goto').press('Enter')

  await expect(page.getByTestId('tree-node-mng/target.txt')).toHaveAttribute('data-selected', 'true')
  await expect(page.locator('[data-doc-path="mng/target.txt"]:visible')).toBeVisible()
})

test('Go-to-path shows an error for a garbage path and leaves the tree intact', async () => {
  await page.getByTestId('tree-goto').fill('no/such/file.md')
  await page.getByTestId('tree-goto').press('Enter')

  await expect(page.getByTestId('tree-goto-error')).toContainText('Not found')
  // The tree is undisturbed.
  await expect(page.getByTestId('tree-node-mng')).toBeVisible()
  // Esc clears the input + error.
  await page.getByTestId('tree-goto').press('Escape')
  await expect(page.getByTestId('tree-goto-error')).toHaveCount(0)
  await expect(page.getByTestId('tree-goto')).toHaveValue('')
})

// ── E-016: open docs follow in-app file operations ───────────────────────────

test('Moving an open doc through the tree retargets its tab to the new path', async () => {
  // Open the doc (it becomes the active, visible editor pane).
  await page.getByTestId('tree-node-mng/e016-follow.md').click()
  await expect(page.locator('[data-doc-path="mng/e016-follow.md"]:visible')).toBeVisible()

  // Drag it into mng/dest — no collision there.
  await dragNodeOnto('mng/e016-follow.md', 'mng/dest')

  // The open tab followed to the new path (title/path updated, buffer preserved — no reload).
  await expect(page.locator('[data-doc-path="mng/dest/e016-follow.md"]:visible')).toBeVisible()
  expect(await onDisk('mng/dest/e016-follow.md')).toBe(true)
  expect(await onDisk('mng/e016-follow.md')).toBe(false)
})

// ── E-016: move-collision dialog ─────────────────────────────────────────────

test('Moving onto an existing name offers Move-with-rename (collision-safe)', async () => {
  // mng/dest already has e016-clash.md; dragging mng/e016-clash.md there collides.
  await dragNodeOnto('mng/e016-clash.md', 'mng/dest')
  await expect(page.getByTestId('tree-collision')).toBeVisible()

  await page.getByTestId('collision-rename').click()
  await expect(page.getByTestId('tree-collision')).toHaveCount(0)

  // The source moved under a collision-safe name; the existing destination file is untouched.
  await expect.poll(() => onDisk('mng/dest/e016-clash copy.md')).toBe(true)
  expect(await fs.readFile(join(root, 'mng/dest/e016-clash copy.md'), 'utf8')).toBe('SRC\n')
  expect(await fs.readFile(join(root, 'mng/dest/e016-clash.md'), 'utf8')).toBe('DEST\n')
  expect(await onDisk('mng/e016-clash.md')).toBe(false)
})

test('Move-collision Overwrite replaces the destination file', async () => {
  await dragNodeOnto('mng/e016-over.md', 'mng/dest')
  await expect(page.getByTestId('tree-collision')).toBeVisible()
  // Both sides are files, so Overwrite is offered.
  await expect(page.getByTestId('collision-overwrite')).toBeVisible()

  await page.getByTestId('collision-overwrite').click()
  await expect(page.getByTestId('tree-collision')).toHaveCount(0)

  await expect.poll(() => fs.readFile(join(root, 'mng/dest/e016-over.md'), 'utf8').catch(() => '')).toBe('NEWSRC\n')
  expect(await onDisk('mng/e016-over.md')).toBe(false)
})

// ── P-021: paste-path button ─────────────────────────────────────────────────

test('The go-to-path paste button fills the input from the clipboard', async () => {
  await page.evaluate(() => window.pomade.app.clipboardWrite('mng/sub/keep.md'))
  await page.getByTestId('tree-goto').fill('')

  await page.getByTestId('tree-goto-paste').click()

  await expect(page.getByTestId('tree-goto')).toHaveValue('mng/sub/keep.md')
})

// T-058 — the paste button lives INSIDE the input box (one control, thin separator).
test('the paste button is embedded within the go-to-path field bounds', async () => {
  const box = await page.getByTestId('tree-goto-box').boundingBox()
  const btn = await page.getByTestId('tree-goto-paste').boundingBox()
  const input = await page.getByTestId('tree-goto').boundingBox()
  expect(box && btn && input).toBeTruthy()
  // Button inside the box, at its right edge; the input never runs under the button.
  expect(btn!.x).toBeGreaterThanOrEqual(box!.x)
  expect(btn!.x + btn!.width).toBeLessThanOrEqual(box!.x + box!.width + 1)
  expect(Math.abs(btn!.x + btn!.width - (box!.x + box!.width))).toBeLessThanOrEqual(2)
  expect(input!.x + input!.width).toBeLessThanOrEqual(btn!.x + 1)
  // The box spans the full row width up to its padding (input takes the remaining width).
  expect(input!.width).toBeGreaterThan(100)
})

// ── T-220: double-click renames ──────────────────────────────────────────────

const docTabs = (): Promise<{ path?: string }[]> =>
  page.evaluate(() => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject['__workspace__'] ?? []
    return tabs.filter((t) => t.kind === 'doc').map((t) => ({ path: t.path }))
  })

test('Double-clicking a file opens the Rename prompt (one tab, no second open) and renames it', async () => {
  await page.getByTestId('tree-node-mng/dbl-file.md').dblclick()
  await expect(page.getByTestId('name-prompt')).toBeVisible()
  await expect(page.getByTestId('name-input')).toBeFocused()
  await expect(page.getByTestId('name-input')).toHaveValue('dbl-file.md')
  await page.screenshot({ path: test.info().outputPath('dblclick-rename-file.png') })
  // The first click opened the file once; the second added nothing.
  expect((await docTabs()).filter((t) => t.path === 'mng/dbl-file.md')).toHaveLength(1)

  await page.getByTestId('name-input').fill('dbl-renamed.md')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('tree-node-mng/dbl-renamed.md')).toBeVisible()
  await expect.poll(() => onDisk('mng/dbl-renamed.md')).toBe(true)
  await expect.poll(() => onDisk('mng/dbl-file.md')).toBe(false)
  // The open tab followed the rename — still exactly one doc tab for the file.
  await expect.poll(() => docTabs().then((t) => t.map((x) => x.path))).toContain('mng/dbl-renamed.md')
  expect((await docTabs()).filter((t) => t.path === 'mng/dbl-file.md')).toHaveLength(0)
})

test('Double-clicking a folder opens the Rename prompt and toggles it once, not twice', async () => {
  await expect(page.getByTestId('tree-node-mng/dbl-dir/inner.md')).toHaveCount(0) // starts collapsed
  await page.getByTestId('tree-node-mng/dbl-dir').dblclick()
  await expect(page.getByTestId('name-prompt')).toBeVisible()
  await expect(page.getByTestId('name-input')).toHaveValue('dbl-dir')
  await page.screenshot({ path: test.info().outputPath('dblclick-rename-folder.png') })
  // Exactly one toggle: the folder is open (two toggles would leave it collapsed).
  await expect(page.getByTestId('tree-node-mng/dbl-dir/inner.md')).toBeVisible()

  await page.getByTestId('name-input').fill('dbl-dir-renamed')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('tree-node-mng/dbl-dir-renamed')).toBeVisible()
  await expect.poll(() => onDisk('mng/dbl-dir-renamed/inner.md')).toBe(true)
  await expect.poll(() => onDisk('mng/dbl-dir')).toBe(false)
})

test('Cancelling the double-click Rename changes nothing; modified double-clicks never rename', async () => {
  await page.getByTestId('tree-node-mng/dbl-keep.md').dblclick()
  await expect(page.getByTestId('name-prompt')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('name-prompt')).toHaveCount(0)
  await expect.poll(() => onDisk('mng/dbl-keep.md')).toBe(true)

  await page.getByTestId('tree-node-mng/dbl-mod').dblclick({ modifiers: ['Shift'] })
  await page.getByTestId('tree-node-mng/dbl-mod').dblclick({ modifiers: [MOD] })
  await expect(page.getByTestId('name-prompt')).toHaveCount(0)
})
