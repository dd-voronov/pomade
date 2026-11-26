// modules: editor
// Pomade T-293 — the rendered-mode parse gate (E-023) checks the text the editor is about to
// render: the buffer, unsaved edits included — not the version on disk.
//
// A tab opened in Rendered with a recovered unsaved draft (E-035) is the one path where the gate
// runs while the buffer differs from the disk: an explicit raw → Rendered toggle bypasses the gate
// (T-042 "an explicit toggle always wins"). Real markdown that Milkdown cannot parse does not
// exist (commonmark + gfm parse any UTF-8 text), so the spec makes one text unparseable: a
// page patch makes micromark's preprocessor — the first step of every markdown parse,
// the gate's and the live editor's alike — throw on a text holding the POISON marker.
//   - disk parses, the recovered draft does not → the pane stays Raw, showing the draft;
//   - disk does not parse, the recovered draft does → the pane opens Rendered.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, firstAppWindow } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'

const PID = 'proj-alpha'
const POISON = 'T293POISON'

const BREAK_DISK = '# Clean on disk\n\nA fine paragraph.\n'
const BREAK_DRAFT = `# Clean on disk\n\nA fine paragraph. ${POISON}\n`
const FIX_DISK = `# Broken on disk\n\nA paragraph. ${POISON}\n`
const FIX_DRAFT = '# Fixed in the buffer\n\nA paragraph, repaired.\n'

let fixture: Fixture
let app: ElectronApplication
let page: Page

function docTab(id: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId: PID,
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode: 'rendered',
    dirty: false,
    richView: 'rendered'
  }
}

const pane = (tabId: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="pane-${tabId}"] [data-testid="editor-pane"]`)

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/break.md'), BREAK_DISK)
  await fs.writeFile(join(root, 'Projects/alpha/fix.md'), FIX_DISK)
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state/proj-alpha.json'),
    JSON.stringify({ openTabs: [docTab('doc-break', 'break.md'), docTab('doc-fix', 'fix.md')], activeTabId: 'doc-break' }, null, 2)
  )

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await firstAppWindow(app)
  await expect(page.getByTestId('app-shell')).toBeVisible()

  // The unsaved drafts a crash would have left (E-035), stored through the app itself…
  await page.evaluate(
    async ({ drafts, ws }) => {
      for (const d of drafts) {
        await window.pomade.recovery.put({
          path: d.path,
          tabId: d.tabId,
          title: d.title,
          content: d.content,
          savedAt: Date.now(),
          base: null,
          stretchId: `stretch-${d.tabId}`
        })
      }
      return ws
    },
    {
      ws: root,
      drafts: [
        { path: 'Projects/alpha/break.md', tabId: 'doc-break', title: 'break.md', content: BREAK_DRAFT },
        { path: 'Projects/alpha/fix.md', tabId: 'doc-fix', title: 'fix.md', content: FIX_DRAFT }
      ]
    }
  )
  // …and a markdown parser that fails on a text holding the marker, in force from the first
  // paint of the reloaded window, so every pane mounts under it and finds its draft.
  await app.context().addInitScript((marker) => {
    const exec = RegExp.prototype.exec
    RegExp.prototype.exec = function (this: RegExp, s: string): RegExpExecArray | null {
      if (this.global && this.source.includes('\\0') && typeof s === 'string' && s.includes(marker)) {
        throw new Error('T-293 unparseable text')
      }
      return exec.call(this, s)
    }
  }, POISON)
  await page.reload()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${PID}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('T-293: a recovered draft that breaks parsing keeps the pane Raw although the disk parses', async () => {
  await page.getByTestId('tab-doc-break').click()
  await expect(page.locator('[data-testid="pane-doc-break"] [data-testid="editor-recovered"]')).toBeVisible()
  // The gate verdict lands asynchronously: hold Raw for the window a Rendered entry would need.
  await expectQuiet(async () => {
    await expect(pane('doc-break')).toHaveAttribute('data-mode', 'raw')
  }, 800)
  await expect(page.locator('[data-testid="pane-doc-break"] [data-testid="rendered-editor"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="pane-doc-break"] [data-testid="raw-editor"]')).toContainText(POISON)
})

test('T-293: a recovered draft that parses opens Rendered although the disk does not', async () => {
  await page.getByTestId('tab-doc-fix').click()
  await expect(page.locator('[data-testid="pane-doc-fix"] [data-testid="editor-recovered"]')).toBeVisible()
  await expect(pane('doc-fix')).toHaveAttribute('data-mode', 'rendered')
  await expect(page.locator('[data-testid="pane-doc-fix"] [data-testid="rendered-editor"]')).toContainText(
    'Fixed in the buffer'
  )
})
