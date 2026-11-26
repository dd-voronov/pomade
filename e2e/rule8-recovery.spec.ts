// modules: editor, git, tabs
// Pomade E-035 e2e — rule 8 "the file on disk is the truth" + unsaved-doc recovery.
//   - A write by another writer to an open doc: without unsaved edits → the plain notice
//     (Reload / Dismiss, no reload); with unsaved edits → the amber banner, neither side changing
//     on its own; its Compare opens disk ↔ my edits (E-037), where Keep mine / Use disk version
//     resolve it. Detected in a BACKGROUND project and for an
//     OUTSIDE-workspace doc when it lands (the open-doc watcher), not on switch.
//   - Pomade's own save / rename / move never trip it.
//   - Recovery: unsaved edits (a saved doc and an Untitled doc) survive a real SIGKILL; the tabs
//     come back dirty with the recovery banner; Discard reverts and keeps a discarded draft; a disk
//     change between the kill and the relaunch shows the amber variant.
//   - Discarded drafts older than 7 days are pruned at launch.
//   - Cmd+Shift+G peeks Saved ↔ Unsaved on any doc, git or not.
// LIGHT partition: no terminal/agent panes. Recovery data lives in the fixture's POMADE_USER_DATA.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, firstAppWindow } from './fixtures/app'
import { tempDir } from './fixtures/temp'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.POMADE_E035_SHOTS // optional: directory for the review screenshots

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const paneOf = (page: Page, docPath: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="editor-pane"][data-doc-path="${docPath}"]`)

function docTab(id: string, projectId: string, path: string): Record<string, unknown> {
  return { id, projectId, kind: 'doc', title: path.split('/').pop(), path, mode: 'raw', dirty: false }
}

async function seedState(root: string, projectId: string, tabs: Record<string, unknown>[]): Promise<void> {
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, `.pomade/state/${projectId}.json`),
    JSON.stringify({ openTabs: tabs, activeTabId: tabs[0]?.id }, null, 2)
  )
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(fixture)
  const page = await firstAppWindow(app)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return { app, page }
}

/** Open a seeded doc tab and type at the start of its raw editor. */
async function typeInto(page: Page, projectId: string, tabId: string, text: string): Promise<void> {
  await page.getByTestId(`project-${projectId}`).click()
  await page.getByTestId(`tab-${tabId}`).click()
  const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
  await cm.click()
  await page.keyboard.press(`${MOD}+Home`)
  await page.keyboard.type(text)
  await expect(vis(page, '[data-testid="doc-save"]')).toHaveText('Save')
}

/** The raw editor's text, lines joined by \n, trailing whitespace dropped. */
const rawText = async (page: Page, docPath: string): Promise<string> =>
  (await paneOf(page, docPath).locator('[data-testid="raw-editor"] .cm-content').innerText()).trimEnd()

interface RecoveryFile {
  path: string
  tabId: string
  content: string
}
async function recoveryCopies(userDataDir: string): Promise<RecoveryFile[]> {
  const dir = join(userDataDir, 'recovery/buffers')
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: RecoveryFile[] = []
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    out.push(JSON.parse(await fs.readFile(join(dir, n), 'utf8')) as RecoveryFile)
  }
  return out
}

function drafts(page: Page, path?: string): Promise<{ path: string; content: string; reason: string }[]> {
  return page.evaluate((p) => window.pomade.recovery.drafts(p), path)
}

async function sigkill(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  app.process().kill('SIGKILL')
  await closed
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await vis(page, '[data-testid="editor-pane"]').screenshot({ path: join(SHOTS, `${name}.png`) })
}

// ── External writes (rule 8) ──────────────────────────────────────────────────────────────────
test.describe('E-035 — external writes', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let outsideDir: string
  let app: ElectronApplication
  let page: Page
  const A = 'Projects/alpha/a.txt'
  const C = 'Projects/alpha/c.txt'
  const K = 'Projects/alpha/k.txt'
  const L = 'Projects/alpha/l.txt'
  const B = 'Projects/beta/b.txt'
  let outsidePath: string
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    outsideDir = await tempDir('pomade-e035-out-')
    outsidePath = join(outsideDir, 'outside.txt')
    for (const [rel, body] of [
      [A, 'alpha clean\n'],
      [C, 'charlie\n'],
      [K, 'keep base\n'],
      [L, 'load base\n'],
      [B, 'beta base\n']
    ]) {
      await fs.writeFile(abs(rel), body)
    }
    await fs.writeFile(outsidePath, 'outside base\n')
    await seedState(fixture.workspaceRoot, 'proj-alpha', [
      docTab('doc-a', 'proj-alpha', A),
      docTab('doc-c', 'proj-alpha', C),
      docTab('doc-k', 'proj-alpha', K),
      docTab('doc-l', 'proj-alpha', L),
      docTab('doc-o', 'proj-alpha', outsidePath)
    ])
    await seedState(fixture.workspaceRoot, 'proj-beta', [docTab('doc-b', 'proj-beta', B)])
    ;({ app, page } = await launch(fixture))
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
    await fs.rm(outsideDir, { recursive: true, force: true })
  })

  test('a doc without unsaved edits shows the plain notice and never reloads', async () => {
    await page.getByTestId('project-proj-alpha').click()
    await page.getByTestId('tab-doc-a').click()
    await expect(vis(page, '[data-testid="raw-editor"]')).toContainText('alpha clean')
    await fs.writeFile(abs(A), 'alpha changed by an agent\n')

    const notice = vis(page, '[data-testid="editor-changed-outside"]')
    await expect(notice).toHaveText(/This file changed on disk outside Pomade\./)
    await expect(vis(page, '[data-testid="editor-reload"]')).toBeVisible()
    await expect(vis(page, '[data-testid="editor-dismiss-change"]')).toBeVisible()
    await expect(vis(page, '[data-testid="editor-changed-dirty"]')).toHaveCount(0)
    // No silent reload.
    expect(await rawText(page, A)).toContain('alpha clean')
    await vis(page, '[data-testid="editor-reload"]').click()
    await expect(vis(page, '[data-testid="raw-editor"]')).toContainText('alpha changed by an agent')
    await expect(notice).toHaveCount(0)
  })

  test('unsaved edits + external write → amber banner; Compare, Keep mine → the next save writes the buffer', async () => {
    await typeInto(page, 'proj-alpha', 'doc-k', 'MINE')
    await fs.writeFile(abs(K), 'keep theirs\n')

    const amber = vis(page, '[data-testid="editor-changed-dirty"]')
    await expect(amber).toHaveText(/File changed since your edits\./)
    await expect(vis(page, '[data-testid="editor-changed-outside"]')).toHaveCount(0)
    // Neither side moved on its own.
    expect(await fs.readFile(abs(K), 'utf8')).toBe('keep theirs\n')
    expect(await rawText(page, K)).toBe('MINEkeep base')
    await shot(page, 'amber-banner')

    await vis(page, '[data-testid="editor-compare-disk"]').click()
    await expect(vis(page, '[data-testid="compare-pane"]')).toHaveAttribute('data-mode', 'disk-mine')
    await vis(page, '[data-testid="editor-keep-mine"]').click()
    await expect(amber).toHaveCount(0)
    await expect(page.getByTestId('tab-doc-k').locator('[aria-label="unsaved"]')).toBeVisible()
    await shot(page, 'amber-keep-mine')
    await page.keyboard.press(`${MOD}+s`)
    // An explicit choice — no save-conflict prompt.
    await expect(vis(page, '[data-testid="save-conflict-confirm"]')).toHaveCount(0)
    await expect.poll(() => fs.readFile(abs(K), 'utf8')).toBe('MINEkeep base\n')
  })

  test('unsaved edits + external write → Compare, Use disk version: buffer = disk, edits kept as a draft', async () => {
    await typeInto(page, 'proj-alpha', 'doc-l', 'DRAFTED')
    await fs.writeFile(abs(L), 'load theirs\n')
    await expect(vis(page, '[data-testid="editor-changed-dirty"]')).toBeVisible()
    await vis(page, '[data-testid="editor-compare-disk"]').click()
    await expect(vis(page, '[data-testid="compare-pane"]')).toHaveAttribute('data-mode', 'disk-mine')

    await vis(page, '[data-testid="editor-load-disk"]').click()
    await expect(vis(page, '[data-testid="editor-changed-dirty"]')).toHaveCount(0)
    await expect.poll(() => rawText(page, L)).toBe('load theirs')
    await expect(page.getByTestId('tab-doc-l').locator('[aria-label="unsaved"]')).toHaveCount(0)
    expect(await fs.readFile(abs(L), 'utf8')).toBe('load theirs\n')
    await shot(page, 'amber-load-disk')
    await expect
      .poll(async () => (await drafts(page, L)).map((d) => [d.content, d.reason]))
      .toEqual([['DRAFTEDload base\n', 'load-disk']])
  })

  test('a doc in a background project is caught when the write lands, not on switch', async () => {
    await typeInto(page, 'proj-beta', 'doc-b', 'BETA-EDIT')
    await page.getByTestId('project-proj-alpha').click()
    await expect(paneOf(page, B)).toBeHidden()

    await fs.writeFile(abs(B), 'beta theirs\n')
    // Detected while beta stays in the background: its hidden pane already carries the banner.
    await expect(paneOf(page, B).locator('[data-testid="editor-changed-dirty"]')).toHaveCount(1)
    expect(await fs.readFile(abs(B), 'utf8')).toBe('beta theirs\n')

    await page.getByTestId('project-proj-beta').click()
    await expect(vis(page, '[data-testid="editor-changed-dirty"]')).toBeVisible()
    expect(await rawText(page, B)).toBe('BETA-EDITbeta base')
  })

  test('an outside-workspace doc is watched too', async () => {
    await typeInto(page, 'proj-alpha', 'doc-o', 'OUT-EDIT')
    await fs.writeFile(outsidePath, 'outside theirs\n')
    await expect(paneOf(page, outsidePath).locator('[data-testid="editor-changed-dirty"]')).toBeVisible()
  })

  test("Pomade's own save, rename and move never show a banner", async () => {
    await page.getByTestId('project-proj-alpha').click()
    await page.getByTestId('tab-doc-c').click()
    const cm = vis(page, '[data-testid="raw-editor"] .cm-content')
    await cm.click()
    await page.keyboard.press(`${MOD}+Home`)
    await page.keyboard.type('own ')
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => fs.readFile(abs(C), 'utf8')).toBe('own charlie\n')
    // Keep typing right away: a late watcher event over our own write must not raise anything.
    await page.keyboard.type('more ')

    // In-app rename (tab context menu) …
    await page.getByTestId('tab-doc-c').click({ button: 'right' })
    await page.getByTestId('menu-tab-rename-doc').click()
    const input = page.getByTestId('tab-rename-input-doc-c')
    await input.fill('c2.txt')
    await input.press('Enter')
    await expect(paneOf(page, 'Projects/alpha/c2.txt')).toBeVisible()

    // … and in-app move (the file tree's fs.move + tab retarget).
    await page.evaluate(async () => {
      await window.pomade.fs.createDir('Projects/alpha/sub')
      const dest = await window.pomade.fs.move('Projects/alpha/c2.txt', 'Projects/alpha/sub/c2.txt')
      window.__pomadeStores.useTabsStore
        .getState()
        .retargetPaths('Projects/alpha/c2.txt', dest)
    })
    const moved = paneOf(page, 'Projects/alpha/sub/c2.txt')
    await expect(moved).toBeVisible()

    // Give every watcher time to fire (doc-watch debounce 120 ms, tree watcher 180 ms).
    // eslint-disable-next-line playwright/no-wait-for-timeout -- asserting an ABSENCE needs a settle window
    await page.waitForTimeout(1000)
    for (const id of ['editor-changed-outside', 'editor-changed-dirty', 'editor-missing']) {
      await expect(moved.locator(`[data-testid="${id}"]`)).toHaveCount(0)
    }
    // The buffer followed the file intact; it saves to the new path without a conflict prompt.
    await moved.locator('[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.press(`${MOD}+s`)
    await expect(vis(page, '[data-testid="save-conflict-confirm"]')).toHaveCount(0)
    await expect
      .poll(() => fs.readFile(abs('Projects/alpha/sub/c2.txt'), 'utf8'))
      .toBe('own more charlie\n')
  })

  test('Discard in the close guard keeps a discarded draft', async () => {
    await typeInto(page, 'proj-alpha', 'doc-a', ' CLOSE-DRAFT')
    await page.getByTestId('close-doc-a').click()
    await vis(page, '[data-testid="guard-discard"]').click()
    await expect(page.getByTestId('tab-doc-a')).toHaveCount(0)
    await expect
      .poll(async () => (await drafts(page, A)).map((d) => d.reason))
      .toEqual(['close'])
    expect((await drafts(page, A))[0].content).toContain('CLOSE-DRAFT')
    expect(await fs.readFile(abs(A), 'utf8')).toBe('alpha changed by an agent\n')
  })
})

// ── Recovery across a real SIGKILL ────────────────────────────────────────────────────────────
test.describe('E-035 — recovery after a crash', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  const S = 'Projects/alpha/s.txt'
  const abs = (rel: string): string => join(fixture.workspaceRoot, rel)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.writeFile(abs(S), 'saved line\n')
    await seedState(fixture.workspaceRoot, 'proj-alpha', [docTab('doc-s', 'proj-alpha', S)])
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a saved doc and an Untitled doc survive SIGKILL with the recovery banner', async () => {
    ;({ app, page } = await launch(fixture))
    await typeInto(page, 'proj-alpha', 'doc-s', 'UNSAVED-S')

    // An Untitled doc with content.
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-doc').click()
    await expect(vis(page, '[data-testid="editor-title"]')).toHaveText('Untitled')
    await vis(page, '[data-testid="editor-pane"] .cm-content').click()
    await page.keyboard.type('untitled body')

    // The copies land ~2 s after typing stops, in user data only.
    await expect
      .poll(async () => (await recoveryCopies(fixture.userDataDir)).map((r) => r.content).sort(), {
        timeout: 10_000
      })
      .toEqual(['UNSAVED-Ssaved line\n', 'untitled body'])
    // …and never in the workspace.
    expect(JSON.stringify(await fs.readdir(fixture.workspaceRoot, { recursive: true }))).not.toContain('recovery')
    // The Untitled tab must be in the persisted tab state before the kill.
    await expect
      .poll(async () => {
        const st = JSON.parse(await fs.readFile(join(fixture.workspaceRoot, '.pomade/state/proj-alpha.json'), 'utf8'))
        return (st.openTabs as { path: string }[]).some((t) => t.path === '')
      })
      .toBe(true)

    await sigkill(app)
    ;({ app, page } = await launch(fixture))
    await page.getByTestId('project-proj-alpha').click()

    // The saved doc: edits in place, dirty, banner with the time.
    await page.getByTestId('tab-doc-s').click()
    await expect(vis(page, '[data-testid="raw-editor"]')).toContainText('UNSAVED-Ssaved line')
    await expect(page.getByTestId('tab-doc-s').locator('[aria-label="unsaved"]')).toBeVisible()
    await expect(vis(page, '[data-testid="editor-recovered"]')).toContainText('Recovered unsaved edits from')
    await expect(vis(page, '[data-testid="editor-recovered-time"]')).toHaveText(/^\d{2}:\d{2}$/)
    await expect(vis(page, '[data-testid="editor-recovered-compare"]')).toBeVisible()
    await shot(page, 'recovery-banner')

    // The Untitled doc: still Untitled, with its content.
    const untitled = page.locator('[data-testid="editor-pane"][data-doc-path=""]')
    await expect(untitled).toHaveCount(1)
    await expect(untitled.locator('.cm-content')).toContainText('untitled body')
    await expect(untitled.locator('[data-testid="editor-recovered"]')).toHaveCount(1)
  })

  test('Compare opens Saved ↔ Unsaved; Discard reverts to disk and keeps a draft', async () => {
    await page.getByTestId('tab-doc-s').click()
    await vis(page, '[data-testid="editor-recovered-compare"]').click()
    await expect(page.getByTestId('diff-mode-saved-vs-unsaved')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('diff-merge')).toContainText('UNSAVED-S')
    await page.getByTestId('diff-close').click()

    await vis(page, '[data-testid="editor-recovered-discard"]').click()
    await expect(vis(page, '[data-testid="editor-recovered"]')).toHaveCount(0)
    await expect.poll(() => rawText(page, S)).toBe('saved line')
    await expect(page.getByTestId('tab-doc-s').locator('[aria-label="unsaved"]')).toHaveCount(0)
    await expect
      .poll(async () => (await drafts(page, S)).map((d) => [d.content, d.reason]))
      .toEqual([['UNSAVED-Ssaved line\n', 'recovery-discard']])
    expect(await fs.readFile(abs(S), 'utf8')).toBe('saved line\n')
    await expect
      .poll(async () => (await recoveryCopies(fixture.userDataDir)).map((r) => r.path))
      .toEqual([''])
  })

  test('a disk change between the kill and the relaunch shows the amber banner', async () => {
    await typeInto(page, 'proj-alpha', 'doc-s', 'AGAIN')
    await expect
      .poll(async () => (await recoveryCopies(fixture.userDataDir)).map((r) => r.content), { timeout: 10_000 })
      .toContain('AGAINsaved line\n')
    await sigkill(app)

    await fs.writeFile(abs(S), 'changed while Pomade was down\n')
    // Plant drafts: one 8 days old (pruned at launch), one 6 days old (kept).
    const draftsDir = join(fixture.userDataDir, 'recovery/drafts')
    const day = 24 * 60 * 60 * 1000
    for (const [file, age] of [['old.json', 8 * day], ['young.json', 6 * day]] as const) {
      await fs.writeFile(
        join(draftsDir, file),
        JSON.stringify({
          id: file,
          workspace: fixture.workspaceRoot,
          path: S,
          tabId: 'doc-s',
          title: 's.txt',
          content: file,
          discardedAt: Date.now() - age,
          reason: 'close'
        })
      )
    }

    ;({ app, page } = await launch(fixture))
    await page.getByTestId('project-proj-alpha').click()
    await page.getByTestId('tab-doc-s').click()
    await expect(vis(page, '[data-testid="editor-changed-dirty"]')).toHaveText(/File changed since your edits\./)
    await expect(vis(page, '[data-testid="editor-recovered"]')).toHaveCount(0)
    expect(await rawText(page, S)).toBe('AGAINsaved line')
    expect(await fs.readFile(abs(S), 'utf8')).toBe('changed while Pomade was down\n')
    // Saving without choosing still guards the other writer's version.
    await vis(page, '[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.press(`${MOD}+s`)
    await expect(vis(page, '[data-testid="save-conflict-confirm"]')).toBeVisible()
    await vis(page, '[data-testid="conflict-cancel"]').click()

    // 7-day retention, pruned at launch.
    const names = await fs.readdir(draftsDir)
    expect(names).not.toContain('old.json')
    expect(names).toContain('young.json')
  })
})

// ── Quick peek outside git ────────────────────────────────────────────────────────────────────
test.describe('E-035 — Cmd+Shift+G on a doc outside any repo', () => {
  test.describe.configure({ mode: 'serial' })
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  const N = 'Projects/alpha/n.txt'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.writeFile(join(fixture.workspaceRoot, N), 'on disk\n')
    await seedState(fixture.workspaceRoot, 'proj-alpha', [docTab('doc-n', 'proj-alpha', N)])
    ;({ app, page } = await launch(fixture))
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('an unsaved doc outside any repo shows Saved ↔ Unsaved only', async () => {
    await typeInto(page, 'proj-alpha', 'doc-n', 'BUFFER-ONLY')
    await page.keyboard.press(`${MOD}+Shift+G`)
    await expect(page.getByTestId('diff-overlay')).toBeVisible()
    await expect(page.getByTestId('diff-mode-saved-vs-unsaved')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('diff-mode-working-vs-head')).toHaveCount(0)
    await expect(page.getByTestId('diff-label-a')).toHaveText('Saved (on disk)')
    await expect(page.getByTestId('diff-label-b')).toHaveText('Unsaved (editor)')
    await expect(page.getByTestId('diff-merge')).toContainText('BUFFER-ONLY')
    await page.getByTestId('diff-close').click()
  })

  test('an Untitled doc peeks against an empty saved side', async () => {
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-doc').click()
    await vis(page, '[data-testid="editor-pane"] .cm-content').click()
    await page.keyboard.type('fresh words')
    await page.keyboard.press(`${MOD}+Shift+G`)
    await expect(page.getByTestId('diff-label-a')).toHaveText('Saved (not on disk)')
    await expect(page.getByTestId('diff-merge')).toContainText('fresh words')
    await page.getByTestId('diff-close').click()
  })
})
