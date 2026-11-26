// modules: filetree, tabs, editor
// Pomade T-105 e2e (E-021) — go-to-path for OUT-OF-SCOPE paths.
//
// P-021's file-tree "go to path…" row reveals an in-scope path in the current tree and opens the
// doc. T-105 extends the OUT-OF-SCOPE branch so it still does something useful:
//   • a file in ANOTHER project of the workspace  → a normal doc tab (workspace-relative path,
//     T-101's ORANGE triangle), the current tree is NOT re-rooted/revealed;
//   • a file OUTSIDE the workspace                 → a tab via the T-102 door (absolute path,
//     T-101's RED triangle);
//   • a FOLDER out of scope (either flavour)        → reveal in Finder, no tab.
// In-scope paths keep the P-021 reveal-in-tree-and-open behaviour (regression asserted here too,
// plus the standing P-021 suite in filetree-manage.spec.ts).
//
// Everything routes through the SAME `term-link-open.routeProbe` matrix a terminal Cmd+click uses,
// so the two entry points can't drift. Reveal-in-Finder is recorded (not performed) under
// NODE_ENV=test via the main-process `__pomadeRevealedPaths` bucket. The outside targets live in a
// SECOND OS-tmp dir (never a real user path); the `~`-expansion case needs a path under the real
// home (env.home === os.homedir() in test), so it uses a namespaced throwaway dir there, cleaned up.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'
import { tempDir } from './fixtures/temp'

// Realistic vault-shaped markdown (frontmatter + inline markup) — what the editor actually loads.
const NOTE_MD = [
  '---',
  'title: Out-of-scope note',
  'tags: [t105, e2e]',
  '---',
  '',
  '# Out-of-scope note',
  '',
  'Reached by **go-to-path** from outside the tree. Sentinel: GOTO_BODY_SENTINEL.',
  'See [[some-other-note]] for context.',
  ''
].join('\n')

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

let fixture: Fixture
let app: ElectronApplication
let page: Page
/** A directory OUTSIDE the fixture workspace (still in OS tmp — never a real user path). */
let outsideDir: string
let outsideNote: string
/** A namespaced throwaway dir under the REAL home, only for the `~`-expansion case. */
let homeDir: string
let homeNote: string

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

/** Paths handed to Finder by the routing matrix (recorded, not revealed, under NODE_ENV=test). */
function revealed(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

function switchToAlpha(): Promise<void> {
  return page.evaluate(
    (p) => window.__pomadeStores.useWorkspaceStore.getState().setActiveProject(p),
    fixture.projects.alpha
  )
}

async function submitGoto(pathText: string): Promise<void> {
  const input = page.getByTestId('tree-goto')
  await expect(input).toBeVisible()
  await input.fill(pathText)
  await input.press('Enter')
}

/** The alpha doc tab whose path ends with `suffix`, once it exists; returns its id. */
async function tabIdBySuffix(suffix: string): Promise<string> {
  let id = ''
  await expect
    .poll(
      () =>
        tabsOf(fixture.projects.alpha).then((t) => {
          const hit = t.find((x) => x.kind === 'doc' && !!x.path && x.path.endsWith(suffix))
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
  outsideDir = await tempDir('pomade-t105-outside-')
  outsideNote = join(outsideDir, 'outside-goto.md')
  await write(outsideNote, NOTE_MD)

  homeDir = await tempDir('.pomade-t105-', homedir())
  homeNote = join(homeDir, 'home-goto.md')
  await write(homeNote, NOTE_MD)

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await switchToAlpha()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
  if (homeDir) await fs.rm(homeDir, { recursive: true, force: true })
})

test.describe('T-105 — go-to-path for out-of-scope paths (E-021)', () => {
  test('a file in ANOTHER project opens a doc tab (orange triangle) without revealing in the current tree', async () => {
    await switchToAlpha()
    // Beta lives in the same workspace but outside Alpha's root — the Alpha-rooted tree can't show
    // it, so it opens as a normal doc tab keyed on its workspace-relative path.
    await submitGoto('Projects/beta/README.md')

    const id = await tabIdBySuffix('Projects/beta/README.md')
    // The stored path is workspace-relative (NOT absolute) — the in-workspace object class.
    const tab = (await tabsOf(fixture.projects.alpha)).find((t) => t.id === id)
    expect(tab?.path).toBe('Projects/beta/README.md')

    // T-101 scope mark: orange (warning) — in the workspace, outside the active project.
    const mark = page.getByTestId(`tab-scope-${id}`)
    await expect(mark).toBeVisible()
    await expect(mark).toHaveAttribute('data-tone', 'warning')

    // The current tree is NOT re-rooted or revealed: still Alpha, and Beta has no row here.
    expect(await activeProject()).toBe(fixture.projects.alpha)
    await expect(page.getByTestId('tree-node-Projects/beta/README.md')).toHaveCount(0)
    await expect(page.getByTestId('tree-goto')).toHaveValue('')
  })

  test('a file OUTSIDE the workspace opens a tab via the T-102 door (absolute path, red triangle)', async () => {
    await switchToAlpha()
    await submitGoto(outsideNote)

    const id = await tabIdBySuffix('/outside-goto.md')
    const tab = (await tabsOf(fixture.projects.alpha)).find((t) => t.id === id)
    // The distinct outside-workspace object class: the stored path is ABSOLUTE.
    expect(tab?.path?.startsWith('/')).toBe(true)

    // T-101 scope mark: red (danger) — outside the workspace.
    const mark = page.getByTestId(`tab-scope-${id}`)
    await expect(mark).toBeVisible()
    await expect(mark).toHaveAttribute('data-tone', 'danger')

    // The editor actually loaded the outside file (not a refusal).
    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane).toContainText('GOTO_BODY_SENTINEL', { timeout: 10_000 })
    expect(await activeProject()).toBe(fixture.projects.alpha)
  })

  test('a `~`-prefixed outside-workspace file is expanded and opens a tab (red triangle)', async () => {
    await switchToAlpha()
    // env.home === os.homedir() in test; the throwaway dir lives directly under it.
    const gotoText = '~' + homeDir.slice(homedir().length) + '/' + basename(homeNote)
    await submitGoto(gotoText)

    const id = await tabIdBySuffix('/home-goto.md')
    const tab = (await tabsOf(fixture.projects.alpha)).find((t) => t.id === id)
    expect(tab?.path?.startsWith('/')).toBe(true)
    // Not left as a literal `~` path.
    expect(tab?.path?.includes('~')).toBe(false)
    await expect(page.getByTestId(`tab-scope-${id}`)).toHaveAttribute('data-tone', 'danger')
  })

  test('an out-of-scope FOLDER in another project reveals in Finder, opens no tab', async () => {
    await switchToAlpha()
    const tabsBefore = (await tabsOf(fixture.projects.alpha)).length
    const revealedBefore = (await revealed()).length

    await submitGoto('Projects/beta')

    // Compared by suffix: the recorded path is canonical (realpath), so the raw string never
    // matches literally on macOS (/var → /private/var).
    await expect
      .poll(() => revealed().then((paths) => paths.some((p) => p.endsWith('/beta'))), { timeout: 10_000 })
      .toBe(true)
    expect(await revealed()).toHaveLength(revealedBefore + 1)
    // No new tab — held for the window a late async open would need.
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(tabsBefore)
    }, 300)
    await expect(page.getByTestId('tree-goto')).toHaveValue('')
  })

  test('an outside-workspace FOLDER reveals in Finder, opens no tab', async () => {
    await switchToAlpha()
    const tabsBefore = (await tabsOf(fixture.projects.alpha)).length
    const revealedBefore = (await revealed()).length

    await submitGoto(outsideDir)

    const wantSuffix = '/' + basename(outsideDir)
    await expect
      .poll(() => revealed().then((paths) => paths.some((p) => p.endsWith(wantSuffix))), { timeout: 10_000 })
      .toBe(true)
    expect(await revealed()).toHaveLength(revealedBefore + 1)
    // No new tab — held for the window a late async open would need.
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(tabsBefore)
    }, 300)
  })

  test('an IN-SCOPE path still reveals in the tree and opens the doc (P-021 regression)', async () => {
    await switchToAlpha()
    const revealedBefore = (await revealed()).length

    await submitGoto('Projects/alpha/notes.txt')

    // Revealed + selected in the Alpha-rooted tree, and opened as a doc tab.
    await expect(page.getByTestId('tree-node-Projects/alpha/notes.txt')).toHaveAttribute(
      'data-selected',
      'true'
    )
    await expect(page.locator('[data-doc-path="Projects/alpha/notes.txt"]:visible')).toBeVisible()
    // In-scope never hands off to Finder.
    expect(await revealed()).toHaveLength(revealedBefore)
    await expect(page.getByTestId('tree-goto')).toHaveValue('')
  })

  // T-105 follow-up (the Owner's user test, 2026-08-18): deleting the `~` from `~/Downloads/x` leaves
  // `/Downloads/x` — an absolute path from the FILESYSTEM ROOT, which genuinely doesn't exist. The
  // bare "Not found" read as a bug. When the home-anchored variant of a failed path exists, Pomade
  // now offers it.
  //
  // T-122 (the Owner's user test): the hint was an inline span in the same flex row as the input, so a
  // long path collapsed the input to ~0px (unrecoverable) and the hint was inert text. It now
  // renders as a cancelable popover (Apply / × / click-outside), leaving the input full-width.

  // The root-anchored form a user produces by deleting the leading `~`. homeNote is
  // `${homedir()}/.pomade-t105-…/home-goto.md`; stripping the home prefix leaves `/.pomade-t105-…`.
  const rootAnchored = (): string => homeNote.slice(homedir().length)

  test('a root-anchored path that exists under HOME shows a "did you mean ~…" POPOVER, not the inline error', async () => {
    await switchToAlpha()
    const tabsBefore = (await tabsOf(fixture.projects.alpha)).length
    const ra = rootAnchored()

    await submitGoto(ra)

    // The suggestion is a popover with the did-you-mean wording + the concrete ~-anchored path.
    const hint = page.getByTestId('tree-goto-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText(`Not found — did you mean ~${ra}?`)
    // The inline error span does NOT render this case.
    await expect(page.getByTestId('tree-goto-error')).toHaveCount(0)
    // A hint only — nothing opened (held), the input keeps the user's text for editing…
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(tabsBefore)
    }, 200)
    await expect(page.getByTestId('tree-goto')).toHaveValue(ra)
    // …and the input never collapses (the whole point of T-122).
    const inputBox = await page.getByTestId('tree-goto').boundingBox()
    expect(inputBox!.width).toBeGreaterThan(100)

    // Leave clean for the next spec in the chain.
    await page.getByTestId('tree-goto-hint-close').click()
    await page.getByTestId('tree-goto').fill('')
  })

  test('Apply submits the ~-variant: the HOME file opens as a doc tab, popover gone, input cleared', async () => {
    await switchToAlpha()
    const ra = rootAnchored()

    await submitGoto(ra)
    await expect(page.getByTestId('tree-goto-hint')).toBeVisible()

    await page.getByTestId('tree-goto-hint-apply').click()

    // Same object class as the `~`-expansion spec above: absolute path, red (danger) triangle.
    const id = await tabIdBySuffix('/home-goto.md')
    const tab = (await tabsOf(fixture.projects.alpha)).find((t) => t.id === id)
    expect(tab?.path?.startsWith('/')).toBe(true)
    expect(tab?.path?.includes('~')).toBe(false)
    await expect(page.getByTestId(`tab-scope-${id}`)).toHaveAttribute('data-tone', 'danger')

    // Popover gone, input cleared (normal success path).
    await expect(page.getByTestId('tree-goto-hint')).toHaveCount(0)
    await expect(page.getByTestId('tree-goto')).toHaveValue('')
  })

  test('× dismisses the popover, keeps the input text, opens no tab', async () => {
    await switchToAlpha()
    const tabsBefore = (await tabsOf(fixture.projects.alpha)).length
    const ra = rootAnchored()

    await submitGoto(ra)
    await expect(page.getByTestId('tree-goto-hint')).toBeVisible()

    await page.getByTestId('tree-goto-hint-close').click()

    await expect(page.getByTestId('tree-goto-hint')).toHaveCount(0)
    await expect(page.getByTestId('tree-goto')).toHaveValue(ra)
    // Dismissing the hint may not open anything either — held.
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(tabsBefore)
    }, 200)

    // Leave clean for the next spec.
    await page.getByTestId('tree-goto').fill('')
  })

  test('a click elsewhere in the app dismisses the popover', async () => {
    await switchToAlpha()
    const ra = rootAnchored()

    await submitGoto(ra)
    await expect(page.getByTestId('tree-goto-hint')).toBeVisible()

    // A click anywhere outside the popover lands on the full-viewport scrim, which closes it —
    // the same mechanism SymlinkPopover/ColorPickerPopover use for click-outside.
    await page.getByTestId('tree-goto-hint-scrim').click({ position: { x: 5, y: 5 } })

    await expect(page.getByTestId('tree-goto-hint')).toHaveCount(0)
    // The typed text is untouched.
    await expect(page.getByTestId('tree-goto')).toHaveValue(ra)

    // Leave clean for the next spec.
    await page.getByTestId('tree-goto').fill('')
  })

  test('a path that exists nowhere still gets the bare inline "Not found"', async () => {
    await switchToAlpha()
    await submitGoto('/definitely/not/there-t105.md')
    await expect(page.getByTestId('tree-goto-error')).toHaveText('Not found')
    // Not a popover in this case.
    await expect(page.getByTestId('tree-goto-hint')).toHaveCount(0)
  })
})
