// modules: editor, tabs
// Pomade T-095 e2e — saving over a REFUSED file must never touch the disk. A >2 MB or binary
// file opens as a refusal panel with `content === ''`; before the fix, Save / Cmd+S wrote that
// empty string over the real file (silent truncation — data loss, no dirty flag, no guard).
// Doc tabs are seeded via .pomade/state like editor-csv.spec.ts.

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

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// >2 MB of real text — trips the size refusal before any read.
const BIG = ('lorem ipsum dolor sit amet '.repeat(64) + '\n').repeat(1300)
// NUL byte → binary refusal (read happens, then the content is refused).
const BIN = 'PNG ' + '\u0000\u0000' + ' fake binary payload ' + '\u0000' + ' end\n'

function docTab(id: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId: 'proj-alpha',
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode: 'raw',
    dirty: false
  }
}

let bigPath: string
let binPath: string

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  bigPath = join(root, 'Projects/alpha', 'huge.md')
  binPath = join(root, 'Projects/alpha', 'blob.md')
  await fs.writeFile(bigPath, BIG)
  await fs.writeFile(binPath, BIN)

  const state = {
    openTabs: [docTab('doc-huge', 'huge.md'), docTab('doc-blob', 'blob.md')],
    activeTabId: 'doc-huge'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('T-095 — save is inert on refused files', () => {
  test('Cmd+S on a too-big refusal leaves the file byte-identical', async () => {
    await page.getByTestId('tab-doc-huge').click()
    await expect(page.locator('[data-testid="editor-refusal"]:visible')).toBeVisible()
    const before = (await fs.stat(bigPath)).size
    expect(before).toBeGreaterThan(2 * 1024 * 1024)

    await page.locator('[data-testid="editor-refusal"]:visible').click()
    await page.keyboard.press(`${MOD}+s`)
    // The write, if it happened, is fast — hold the unchanged size for its whole landing window.
    await expectQuiet(async () => {
      expect((await fs.stat(bigPath)).size).toBe(before)
    }, 600)
  })

  test('the Save button is disabled on a refusal (binary file)', async () => {
    await page.getByTestId('tab-doc-blob').click()
    await expect(page.locator('[data-testid="editor-refusal"]:visible')).toBeVisible()
    const saveBtn = page.locator('[data-testid="doc-save"]:visible')
    await expect(saveBtn).toBeDisabled()

    const before = await fs.readFile(binPath, 'latin1')
    await page.keyboard.press(`${MOD}+s`)
    // A write, if it happened, would land fast — held.
    await expectQuiet(async () => {
      expect(await fs.readFile(binPath, 'latin1')).toBe(before)
    }, 600)
  })
})
