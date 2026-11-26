// modules: core, filetree, tabs, editor, terminal
// Pomade T-106 e2e (E-021) — outside-workspace files of ANY type open IN a doc tab.
//
// T-102 shipped a carve-out where an outside-workspace image/binary still revealed in Finder;
// T-106 removes it. An outside-workspace FILE of any type (image, binary, oversize, unknown) now
// opens as a doc tab keyed on its ABSOLUTE path — the editor shows its standard refusal /
// unsupported panel (red scope triangle, Cmd+S inert). Only a DIRECTORY outside the workspace
// still reveals in Finder. Both entry points (terminal Cmd+click, go-to-path) go through the SAME
// routeProbe, so both are asserted here.
//
// The outside dir is a SECOND OS-tmp dir (never a real user path). The image is a REAL 1x1 PNG
// (magic bytes matter: the refusal machinery sniffs a NUL byte to classify binary).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join, basename } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'
import { writeWhenReady } from './fixtures/stores'
import { tempDir } from './fixtures/temp'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// A real 1x1 red PNG (has NUL bytes → classified binary by the refusal sniff).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

let fixture: Fixture
let app: ElectronApplication
let page: Page
/** A directory OUTSIDE the fixture workspace (still in OS tmp — never a real user path). */
let outsideDir: string
let outsideImage: string
let outsideImageGoto: string
let outsideSubDir: string

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}

async function openTerminal(): Promise<string> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

async function alphaTerminal(): Promise<string> {
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}

/** Activate a link by TOKEN through the pane's e2e hook (scan + resolve + route). */
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}

interface TabSnapshot {
  id: string
  kind: string
  path?: string
}
function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ id: t.id, kind: t.kind, path: t.path }))
  }, projectId)
}

function activeProject(): Promise<string> {
  return page.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId)
}

/** Paths handed to Finder (recorded, not revealed, under NODE_ENV=test). */
function revealed(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

async function submitGoto(pathText: string): Promise<void> {
  const input = page.getByTestId('tree-goto')
  await expect(input).toBeVisible()
  await input.fill(pathText)
  await input.press('Enter')
}

/** The alpha doc tab whose absolute path ends with `suffix`, once it exists; returns its id. */
async function outsideTabId(suffix: string): Promise<string> {
  let id = ''
  await expect
    .poll(
      () =>
        tabsOf(fixture.projects.alpha).then((t) => {
          const hit = t.find(
            (x) => x.kind === 'doc' && !!x.path && x.path.startsWith('/') && x.path.endsWith(suffix)
          )
          id = hit?.id ?? ''
          return !!hit
        }),
      { timeout: 10_000 }
    )
    .toBe(true)
  return id
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  outsideDir = await tempDir('pomade-t106-outside-')
  outsideImage = join(outsideDir, 'outside-pic.png')
  outsideImageGoto = join(outsideDir, 'outside-pic-goto.png')
  outsideSubDir = join(outsideDir, 'a-folder')
  await fs.writeFile(outsideImage, PNG_1x1)
  await fs.writeFile(outsideImageGoto, PNG_1x1)
  await fs.mkdir(outsideSubDir, { recursive: true })

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

test.describe('T-106 — outside-workspace unsupported files open in a tab (E-021)', () => {
  test('Cmd+click an outside IMAGE opens a doc tab with the refusal panel (NOT Finder), red triangle, Cmd+S inert', async () => {
    const term = await alphaTerminal()
    const before = await fs.readFile(outsideImage)
    const revealedBefore = (await revealed()).length

    await activateLink(term, outsideImage)

    // A doc tab keyed on the ABSOLUTE path — NOT a Finder reveal (the T-102 carve-out is gone).
    const tabId = await outsideTabId('/outside-pic.png')
    expect(await activeProject()).toBe(fixture.projects.alpha)
    // No reveal fired for opening the FILE.
    expect(await revealed()).toHaveLength(revealedBefore)

    // The editor shows the standard refusal panel (image → binary sniff).
    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })

    // T-101 red (danger) scope triangle on the tab — outside the workspace.
    const mark = page.getByTestId(`tab-scope-${tabId}`)
    await expect(mark).toBeVisible()
    await expect(mark).toHaveAttribute('data-tone', 'danger')

    // T-095 — the refused file was never read, so Save is inert and Cmd+S must not truncate it.
    await expect(pane.locator('[data-testid="doc-save"]')).toBeDisabled()
    await pane.locator('[data-testid="editor-refusal"]').click()
    await page.keyboard.press(`${MOD}+s`)
    // Real-world window (save-path latency, not interval-derived) — a truncating write would
    // land well inside it; the bytes hold throughout.
    await expectQuiet(async () => {
      expect((await fs.readFile(outsideImage)).equals(before)).toBe(true)
    }, 600)
  })

  test('go-to-path with an outside IMAGE opens the same doc tab + refusal panel (shared routeProbe)', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const revealedBefore = (await revealed()).length

    await submitGoto(outsideImageGoto)

    const tabId = await outsideTabId('/outside-pic-goto.png')
    expect(await activeProject()).toBe(fixture.projects.alpha)
    expect(await revealed()).toHaveLength(revealedBefore)

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`tab-scope-${tabId}`)).toHaveAttribute('data-tone', 'danger')
  })

  test('an outside DIRECTORY still reveals in Finder and opens no tab (unchanged)', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const tabsBefore = (await tabsOf(fixture.projects.alpha)).length
    const revealedBefore = (await revealed()).length

    await submitGoto(outsideSubDir)

    const wantSuffix = '/' + basename(outsideSubDir)
    await expect
      .poll(() => revealed().then((paths) => paths.some((p) => p.endsWith(wantSuffix))), { timeout: 10_000 })
      .toBe(true)
    expect(await revealed()).toHaveLength(revealedBefore + 1)
    // No new tab — held for the window a late async open would need.
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(tabsBefore)
    }, 300)
  })
})
