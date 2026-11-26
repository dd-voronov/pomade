// modules: terminal, editor, filetree, tabs
// Pomade E-020 e2e — Cmd+click file links in the terminal (T-086).
//
// Covers the whole locked routing matrix, plus the guarantees around it: no dead links, the
// cwd → project → workspace resolution order, `:line` jumps, the ambiguity picker, and URLs.
//
// Two activation routes are exercised deliberately:
//   • ONE real-mouse Cmd+click, which proves the xterm link provider is registered, that the
//     affordance/hit-testing works, and that a Cmd+click does not steal focus back to the pane;
//   • the `__pomadeTermLinks` hook for the remaining matrix rows — cell-precise clicks on a
//     specific token of a wrapped terminal row are fiddly to synthesize, and repeating that
//     geometry for ten rows would buy flakiness rather than coverage.
//
// Fixture content mirrors real vault material (frontmatter, inline markup, a code file with real
// lines) rather than one-line synthetic stubs, because that content is what the scanner and the
// `:line` jump actually have to survive.

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
import { expectQuiet } from './fixtures/timing'
import { writeWhenReady } from './fixtures/stores'
import { tempDir } from './fixtures/temp'

let fixture: Fixture
let app: ElectronApplication
let page: Page
/** A directory OUTSIDE the fixture workspace — the "outside the workspace root" matrix row. */
let outsideDir: string
let outsideFile: string

const ALPHA_DOC = 'Projects/alpha/link-target.md'
const ALPHA_CODE = 'Projects/alpha/lib/resolver.ts'
const ALPHA_IMAGE = 'Projects/alpha/assets/diagram.png'
const BETA_DOC = 'Projects/beta/beta-only.md'
const AMBIGUOUS = 'shared-notes.md'
const UNIQUE_BARE = 'uniquely-named-note.md'
// ── round-2 fixtures ─────────────────────────────────────────────────────────
/** Clicked after 200 rows of filler — the scrolled-buffer regression (see its test). */
const SCROLL_DOC = 'Projects/alpha/scrolled-target.md'
/** Printed inside an agent-style tool header: `Update(<path>)`. */
const BRACKET_DOC = 'Projects/alpha/bracketed.md'
/** Reached by the extension-LESS word `VISION` (stem index). */
const STEM_DOC = 'Projects/alpha/VISION.md'
/** Reached by the word `Makefile` — an EXACT basename with no extension at all. */
const STEM_EXACT = 'Projects/alpha/lib/Makefile'
/** `RUNBOOK` exists in alpha (the shell's cwd) AND in beta: the cwd copy must win outright. */
const CWD_WORD_ALPHA = 'Projects/alpha/RUNBOOK'
const CWD_WORD_BETA = 'Projects/beta/RUNBOOK'
/** `CHANGELOG` has no cwd match and two stem matches → the picker. */
const STEM_AMBIGUOUS_ALPHA = 'Projects/alpha/CHANGELOG.md'
const STEM_AMBIGUOUS_BETA = 'Projects/beta/CHANGELOG.md'
/** A directory inside the active project (tree reveal) and one outside it (Finder). */
const ALPHA_DIR = 'Projects/alpha/lib'
const BETA_DIR = 'Projects/beta'
// ── T-170 ────────────────────────────────────────────────────────────────────
/** A symlinked doc — Cmd+clicking this MUST show the tab-strip symlink glyph, same as opening it
 *  from the tree (E-012). Revert-proof for openDocByPath: the old openDocFromLink never set the
 *  symlink flag on a terminal-link open, so this is the case that fails pre-fix. */
const SYMLINK_TARGET = 'Projects/alpha/glyph-target.md'
const SYMLINK_DOC = 'Projects/alpha/glyph-link.md'

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

/** Realistic vault-shaped content: frontmatter, inline markup, wikilinks, real code lines. */
async function seedLinkFixture(f: Fixture): Promise<void> {
  const ws = f.workspaceRoot

  await write(
    join(ws, ALPHA_DOC),
    [
      '---',
      'title: Alpha link target',
      'tags: [alpha, e2e, links]',
      'created: 2026-07-25',
      '---',
      '',
      '# Alpha link target',
      '',
      'Opened by a **Cmd+click** in a terminal. See [[shared-notes]] and',
      '`Projects/beta/beta-only.md` for the cross-project case.',
      ''
    ].join('\n')
  )

  await write(
    join(ws, ALPHA_CODE),
    [
      "import { join } from 'node:path'",
      '',
      'export interface Resolved {',
      '  abs: string',
      '  rel: string | null',
      '}',
      '',
      'export function resolveIt(base: string, rel: string): Resolved {',
      '  const abs = join(base, rel)',
      '  return { abs, rel }',
      '}',
      ''
    ].join('\n')
  )

  // Not a real PNG — routing is by EXTENSION, and probePath only stats. What matters is that a
  // file with this name exists so the link validates and then gets revealed rather than opened.
  await fs.mkdir(join(ws, 'Projects/alpha/assets'), { recursive: true })
  await fs.writeFile(join(ws, ALPHA_IMAGE), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

  await write(
    join(ws, BETA_DOC),
    ['---', 'title: Beta only', 'tags: [beta]', '---', '', '# Beta only', '', 'Lives *outside* Alpha.', ''].join('\n')
  )

  // The SAME basename in both projects — the ambiguity picker's reason to exist.
  await write(join(ws, `Projects/alpha/${AMBIGUOUS}`), '# Shared notes (alpha)\n\nAlpha copy.\n')
  await write(join(ws, `Projects/beta/${AMBIGUOUS}`), '# Shared notes (beta)\n\nBeta copy.\n')
  // …and one basename that is unique workspace-wide, for the single-match bare-name path.
  await write(join(ws, `Projects/beta/${UNIQUE_BARE}`), '# Uniquely named\n\nOnly one of me.\n')

  // ── round 2 ────────────────────────────────────────────────────────────────
  await write(join(ws, SCROLL_DOC), '# Scrolled target\n\nClicked with the buffer scrolled.\n')
  await write(join(ws, BRACKET_DOC), '# Bracketed\n\nPrinted as `Update(<path>)` by an agent.\n')
  await write(join(ws, STEM_DOC), '# Vision\n\nClicked as the bare word VISION.\n')
  await write(join(ws, STEM_EXACT), 'all:\n\t@echo alpha\n')
  await write(join(ws, CWD_WORD_ALPHA), 'alpha runbook\n')
  await write(join(ws, CWD_WORD_BETA), 'beta runbook\n')
  await write(join(ws, STEM_AMBIGUOUS_ALPHA), '# Changelog (alpha)\n')
  await write(join(ws, STEM_AMBIGUOUS_BETA), '# Changelog (beta)\n')

  // T-170 — a symlinked doc, relative link (mirrors filetree-manage.spec.ts's alias.txt fixture).
  await write(join(ws, SYMLINK_TARGET), '# Glyph target\n\nOpened via a symlink, over a terminal link.\n')
  await fs.symlink('glyph-target.md', join(ws, SYMLINK_DOC))

  outsideDir = await tempDir('pomade-outside-')
  outsideFile = join(outsideDir, 'outside.md')
  // T-102: an outside-workspace file now opens as a doc tab keyed on its absolute path.
  await write(outsideFile, '# Outside the workspace\n\nOpened as the outside-workspace object class.\n')
}

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}

function writePty(termId: string, data: string): Promise<void> {
  return page.evaluate(({ tid, d }) => window.pomade.pty.write(tid, d), { tid: termId, d: data })
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

/**
 * A ready terminal in the Alpha project, opened fresh per test.
 *
 * Each test provisions its own rather than sharing one from an earlier test: Playwright DISCARDS
 * the worker process after any failure and restarts it, so describe-scoped state silently becomes
 * undefined for every test after the first failure — turning one real failure into a cascade of
 * meaningless ones.
 */
async function alphaTerminal(): Promise<string> {
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}

function ptyCwd(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.cwd(tid), termId)
}

/** Activate a link by TOKEN through the pane's e2e hook (see the file header). */
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}

/** Round 2 — the stem index behind an extension-less word (`VISION` → `docs/VISION.md`). */
function stemMatches(word: string): Promise<string[]> {
  return page.evaluate(
    (w) => window.pomade.fs.findByStem(w),
    word
  )
}

function probe(input: string, baseAbs?: string): Promise<unknown> {
  return page.evaluate(
    ({ i, b }) => window.pomade.fs.probePath(i, b),
    { i: input, b: baseAbs }
  )
}

interface TabSnapshot {
  id: string
  kind: string
  path?: string
  mode?: string
}

function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ id: t.id, kind: t.kind, path: t.path, mode: t.mode }))
  }, projectId)
}

function activeProject(): Promise<string> {
  return page.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId)
}

/** Paths handed to Finder by the routing matrix (recorded, not revealed, under NODE_ENV=test). */
function revealed(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

function openedUrls(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeOpenedUrls ?? []) as string[])
}

/** What the pane actually SHOWS — the xterm rows in the DOM (render can lag the pty buffer). */
function rowsText(termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
    return Array.from(rows)
      .map((r) => r.textContent ?? '')
      .join('\n')
  }, termId)
}

/** Pixel centre of one rendered character, located via a DOM Range (prompt-agnostic). */
async function charPoint(termId: string, marker: string, offsetInMarker: number): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ({ tid, mk, off }) => {
      const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
      for (const row of Array.from(rows)) {
        const idx = (row.textContent ?? '').indexOf(mk)
        if (idx < 0) continue
        let remaining = idx + off
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const len = node.textContent?.length ?? 0
          if (remaining < len) {
            const range = document.createRange()
            range.setStart(node, remaining)
            range.setEnd(node, remaining + 1)
            const r = range.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          }
          remaining -= len
          node = walker.nextNode()
        }
      }
      return null
    },
    { tid: termId, mk: marker, off: offsetInMarker }
  )
  if (!point) throw new Error(`no rendered character for marker "${marker}" +${offsetInMarker}`)
  return point
}

/**
 * The real gesture: hold Cmd on the KEYBOARD (so the click carries metaKey — `page.mouse.click()`
 * has no `modifiers` option) and click the target character.
 *
 * T-193 — there is deliberately NO hover dwell before the click: the click-time resolution fallback
 * opens the link on the FIRST click whether or not hover resolution has landed, so every real
 * Cmd+click test here doubles as a first-click test (it would fail against the pre-fallback pane).
 */
async function cmdClickChar(termId: string, marker: string, offsetInMarker: number): Promise<void> {
  await page.keyboard.down('Meta')
  const point = await charPoint(termId, marker, offsetInMarker)
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Meta')
}

/** The title of the VISIBLE editor pane (hidden panes of earlier tests keep their own). */
function visibleEditorTitle(): ReturnType<Page['locator']> {
  return page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-title"]')
}

/** xterm's viewport scrollTop — non-zero exactly when the buffer has scrolled (ydisp > 0). */
function viewportScrollTop(termId: string): Promise<number> {
  return page.evaluate(
    (tid) => document.querySelector(`[data-term-id="${tid}"] .xterm-viewport`)?.scrollTop ?? 0,
    termId
  )
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // Seed BEFORE launch: the basename index is built eagerly when the workspace root is set
  // (T-091), so seeding first makes every fixture file present in that very first build — no
  // dependency on watcher timing for the clicks these specs perform.
  await seedLinkFixture(fixture)
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

test.describe('terminal file links (T-086)', () => {
  test('the shell reports its cwd, and it follows a cd', async () => {
    const alphaTerm = await alphaTerminal()
    const alphaAbs = join(fixture.workspaceRoot, 'Projects/alpha')

    // The precmd marker carries $PWD, so main knows the cwd without polling.
    await expect.poll(() => ptyCwd(alphaTerm), { timeout: 10_000 }).toContain(alphaAbs)

    await writePty(alphaTerm, 'cd lib\r')
    await expect.poll(() => ptyCwd(alphaTerm), { timeout: 10_000 }).toContain(join(alphaAbs, 'lib'))
    await writePty(alphaTerm, 'cd ..\r')
    await expect.poll(() => ptyCwd(alphaTerm), { timeout: 10_000 }).toMatch(/alpha$/)
  })

  test('a nonexistent path never becomes a link', async () => {
    const alphaTerm = await alphaTerminal()
    // Validation happens before the provider will underline anything, so the probe is the
    // authoritative check: no target ⇒ no link ⇒ nothing to click.
    expect(await probe('Projects/alpha/nope-not-here.md', fixture.workspaceRoot)).toBeNull()
    expect(await probe('/definitely/not/a/real/path.txt')).toBeNull()

    const before = (await tabsOf(fixture.projects.alpha)).length
    await activateLink(alphaTerm, 'Projects/alpha/nope-not-here.md')
    // Real-world window (routing latency, not interval-derived) — no tab may appear, held throughout.
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(before)
    }, 300)
  })

  test('real Cmd+click on a printed path opens the doc and reveals it in the tree', async () => {
    const alphaTerm = await alphaTerminal()
    await writePty(alphaTerm, `printf '%s\\n' ${ALPHA_DOC}\r`)
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 10_000 }).toContain(ALPHA_DOC)
    await expect.poll(() => rowsText(alphaTerm), { timeout: 10_000 }).toContain(ALPHA_DOC)

    await cmdClickChar(alphaTerm, 'link-target.md', 3)

    // A real doc tab in the ACTIVE project, and the tree row is revealed + selected.
    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === ALPHA_DOC)), {
        timeout: 10_000
      })
      .toBe(true)
    await expect(page.getByTestId('editor-title')).toHaveText('link-target.md')
    await expect(page.locator(`[data-testid="tree-node-${ALPHA_DOC}"]`)).toHaveAttribute(
      'data-selected',
      'true'
    )
  })

  test('an absolute path inside the active project opens there', async () => {
    const alphaTerm = await alphaTerminal()
    const abs = join(fixture.workspaceRoot, ALPHA_CODE)
    await activateLink(alphaTerm, abs)
    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.find((x) => x.path === ALPHA_CODE)?.mode), {
        timeout: 10_000
      })
      .toBe('raw')
    expect(await activeProject()).toBe(fixture.projects.alpha)
  })

  test('a `path:line` link opens raw and puts the caret on that line', async () => {
    const alphaTerm = await alphaTerminal()
    // Line 9 of the seeded resolver.ts is `  const abs = join(base, rel)`.
    await activateLink(alphaTerm, `${ALPHA_CODE}:9`)
    const editor = page.locator('[data-testid="editor-pane"]:visible')
    await expect(editor).toBeVisible({ timeout: 10_000 })
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    // CodeMirror marks the caret's gutter row — the line number IS the assertion. Scoped to the
    // LINE-NUMBER gutter: the fold gutter carries the same active class on its (empty) row.
    await expect(editor.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('9', {
      timeout: 10_000
    })
    await expect(editor.locator('.cm-activeLine')).toContainText('const abs = join(base, rel)')
  })

  test('a file inside the workspace but outside the active project opens HERE with a badge', async () => {
    const alphaTerm = await alphaTerminal()
    expect(await activeProject()).toBe(fixture.projects.alpha)

    await activateLink(alphaTerm, BETA_DOC)

    // Round-2 locked change (supersedes "switch to the Workspace project"): the doc opens in the
    // CURRENT project's tab strip — Tab.path is workspace-relative, so it just works — and the
    // tab wears an orange badge saying the file lives outside this project.
    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === BETA_DOC)), {
        timeout: 10_000
      })
      .toBe(true)
    expect(await activeProject()).toBe(fixture.projects.alpha)
    const betaTab = present(
      (await tabsOf(fixture.projects.alpha)).find((t) => t.path === BETA_DOC),
      'tab for the cross-project doc'
    )
    // T-101 — the orange dot was replaced by the exclamation-triangle scope mark (its own slot).
    const badge = page.getByTestId(`tab-scope-${betaTab.id}`)
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('data-tone', 'warning')
    await expect(badge).toHaveAttribute('aria-label', /Outside this project/)
    // No tree reveal for these (the tree is project-rooted) — the badge is the whole affordance.
    expect((await tabsOf('__workspace__')).some((t) => t.path === BETA_DOC)).toBe(false)

    // Closing it leaves you exactly where you were.
    await page.getByTestId(`close-${betaTab.id}`).click()
    await expect(badge).toHaveCount(0)
    expect(await activeProject()).toBe(fixture.projects.alpha)
  })

  test('an image is revealed in Finder, never opened in the editor', async () => {
    const alphaTerm = await alphaTerminal()
    const before = (await tabsOf(fixture.projects.alpha)).length
    await activateLink(alphaTerm, ALPHA_IMAGE)

    // Compared by suffix: the resolved path is CANONICAL, and on macOS realpath rewrites the
    // /var symlink to /private/var, so the fixture's own root string never matches literally.
    await expect
      .poll(() => revealed().then((paths) => paths.some((p) => p.endsWith(`/${ALPHA_IMAGE}`))), {
        timeout: 10_000
      })
      .toBe(true)
    // Real-world window (routing latency, not interval-derived) — reveal only, never a tab.
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(before)
    }, 300)
  })

  test('a file outside the workspace root opens as a doc tab keyed on its absolute path (T-102)', async () => {
    // Superseded the pre-T-102 "reveal in Finder" behavior: an outside-workspace FILE the editor
    // can open is now the distinct outside-workspace object class — a doc tab whose path is the
    // ABSOLUTE path (never in the tree, no workspace-relative form). Full T-102 coverage lives in
    // terminal-outside-workspace.spec.ts; this asserts the routing-matrix row itself.
    const alphaTerm = await alphaTerminal()
    await activateLink(alphaTerm, outsideFile)

    await expect
      .poll(
        () =>
          tabsOf(fixture.projects.alpha).then((t) =>
            t.some((x) => x.kind === 'doc' && !!x.path && x.path.startsWith('/') && x.path.endsWith('/outside.md'))
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
    expect(await activeProject()).toBe(fixture.projects.alpha)
    // No tree reveal for an outside file (the tree is workspace-bounded).
    await expect(page.locator('[data-testid="editor-pane"]:visible')).toBeVisible()
  })

  test('a URL opens in the default browser', async () => {
    const alphaTerm = await alphaTerminal()
    await activateLink(alphaTerm, 'https://example.com/docs/pomade?q=1')
    await expect
      .poll(() => openedUrls(), { timeout: 10_000 })
      .toContain('https://example.com/docs/pomade?q=1')
  })

  test('a bare filename unique in the workspace opens straight away', async () => {
    const alphaTerm = await alphaTerminal()
    await activateLink(alphaTerm, UNIQUE_BARE)
    // It lives in Beta, so (round 2) it opens in Alpha's own tab strip, badged as outside.
    await expect
      .poll(
        () =>
          tabsOf(fixture.projects.alpha).then((t) =>
            t.some((x) => x.path === `Projects/beta/${UNIQUE_BARE}`)
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
    expect(await activeProject()).toBe(fixture.projects.alpha)
  })

  test('an ambiguous bare filename offers a picker, and the pick opens', async () => {
    // Open the terminal in the Workspace project: with the ambiguous name absent from the
    // shell's own cwd, resolution falls through to the workspace basename index — which is where
    // the two candidates come from.
    await page.getByTestId('project-__workspace__').click()
    const wsTerm = await openTerminal()
    await writeWhenReady(page, wsTerm, "printf 'WS_TERM_READY\\n'\r")
    await expect.poll(() => readBuffer(wsTerm), { timeout: 10_000 }).toContain('WS_TERM_READY')

    await activateLink(wsTerm, AMBIGUOUS)
    const picker = page.getByTestId('terminal-link-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await expect(picker.locator('[data-testid^="terminal-link-candidate-"]')).toHaveCount(2)
    await expect(picker).toContainText(AMBIGUOUS)

    // Pick the Beta copy explicitly (by its recorded path, not by row order).
    const betaCandidate = picker.locator(`[data-path="Projects/beta/${AMBIGUOUS}"]`)
    await expect(betaCandidate).toHaveCount(1)
    await betaCandidate.click()
    await expect(picker).toHaveCount(0)
    await expect
      .poll(() => tabsOf('__workspace__').then((t) => t.some((x) => x.path === `Projects/beta/${AMBIGUOUS}`)), {
        timeout: 10_000
      })
      .toBe(true)
  })

  test('a relative name resolves against the shell cwd first', async () => {
    const alphaTerm = await alphaTerminal()
    // cd into the subfolder, then click a name that only exists RELATIVE to it.
    await writePty(alphaTerm, 'cd lib\r')
    await expect.poll(() => ptyCwd(alphaTerm), { timeout: 10_000 }).toMatch(/alpha\/lib$/)

    await activateLink(alphaTerm, './resolver.ts')
    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === ALPHA_CODE)), {
        timeout: 10_000
      })
      .toBe(true)
  })

  // ── E-020 round 2 ──────────────────────────────────────────────────────────
  test('a link still resolves once the buffer has SCROLLED', async () => {
    const alphaTerm = await alphaTerminal()
    // THE round-2 bug. xterm hands `provideLinks` an ABSOLUTE 1-based buffer row (it adds
    // `buffer.ydisp` itself); round 1 treated it as viewport-relative and added the scroll offset a
    // SECOND time, so any terminal with scrollback read a row `ydisp` below the hovered one —
    // usually past the end of the buffer, i.e. no candidates at all. Unscrolled panes (ydisp 0)
    // worked by accident, which is why the whole suite stayed green while real agent sessions had
    // no links. 200 rows of filler is what makes this test able to fail.
    await writePty(alphaTerm, "for i in $(seq 1 200); do printf 'filler %s\\n' \"$i\"; done\r")
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 20_000 }).toContain('filler 200')
    await writePty(alphaTerm, `printf '%s\\n' ${SCROLL_DOC}\r`)
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 10_000 }).toContain(SCROLL_DOC)
    await expect.poll(() => rowsText(alphaTerm), { timeout: 10_000 }).toContain(SCROLL_DOC)
    // Guard: the assertion below only means something while the buffer really is scrolled.
    expect(await viewportScrollTop(alphaTerm)).toBeGreaterThan(0)

    await cmdClickChar(alphaTerm, 'scrolled-target.md', 3)

    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === SCROLL_DOC)), {
        timeout: 10_000
      })
      .toBe(true)
    // Scoped to the VISIBLE pane: by now the project holds several (hidden) doc panes.
    await expect(visibleEditorTitle()).toHaveText('scrolled-target.md')
  })

  test('an opening bracket never glues onto the path (agent tool headers)', async () => {
    const alphaTerm = await alphaTerminal()
    // `Update(path)` / `Read(path)` is how Claude Code and codex head their tool calls. Openers are
    // token DELIMITERS, so the path inside is clickable on its own.
    await writePty(alphaTerm, `printf 'Update(%s)\\n' ${BRACKET_DOC}\r`)
    await expect
      .poll(() => readBuffer(alphaTerm), { timeout: 10_000 })
      .toContain(`Update(${BRACKET_DOC})`)
    await expect
      .poll(() => rowsText(alphaTerm), { timeout: 10_000 })
      .toContain(`Update(${BRACKET_DOC})`)

    // Marker includes the `Update(` prefix so the click lands on the OUTPUT row, not on the echoed
    // command line (where the path is a plain, unbracketed argument and would pass either way).
    await cmdClickChar(alphaTerm, `Update(${BRACKET_DOC}`, 'Update('.length + 3)

    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === BRACKET_DOC)), {
        timeout: 10_000
      })
      .toBe(true)
    await expect(visibleEditorTitle()).toHaveText('bracketed.md')
  })

  test('an extension-less word resolves through the stem index', async () => {
    const alphaTerm = await alphaTerminal()
    expect(await stemMatches('VISION')).toEqual([STEM_DOC])

    await activateLink(alphaTerm, 'VISION')
    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === STEM_DOC)), {
        timeout: 10_000
      })
      .toBe(true)
    // Inside the active project, so it reveals in the tree like any other in-project link.
    await expect(page.locator(`[data-testid="tree-node-${STEM_DOC}"]`)).toHaveAttribute(
      'data-selected',
      'true'
    )
  })

  test('a word matching a whole extension-less basename resolves too', async () => {
    const alphaTerm = await alphaTerminal()
    await activateLink(alphaTerm, 'Makefile')
    await expect
      .poll(
        () => tabsOf(fixture.projects.alpha).then((t) => t.find((x) => x.path === STEM_EXACT)?.mode),
        { timeout: 10_000 }
      )
      .toBe('raw')
  })

  test('a word that exists in the shell cwd beats the stem index', async () => {
    const alphaTerm = await alphaTerminal()
    // Two files named RUNBOOK exist workspace-wide, so the index alone would be ambiguous.
    expect(await stemMatches('RUNBOOK')).toHaveLength(2)

    await activateLink(alphaTerm, 'RUNBOOK')
    await expect
      .poll(
        () => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === CWD_WORD_ALPHA)),
        { timeout: 10_000 }
      )
      .toBe(true)
    // The cwd hit is unambiguous — no picker, and beta's copy is never opened.
    await expect(page.getByTestId('terminal-link-picker')).toHaveCount(0)
    expect((await tabsOf(fixture.projects.alpha)).some((t) => t.path === CWD_WORD_BETA)).toBe(false)
  })

  test('a word with several stem matches offers the picker', async () => {
    const alphaTerm = await alphaTerminal()
    await activateLink(alphaTerm, 'CHANGELOG')
    const picker = page.getByTestId('terminal-link-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await expect(picker.locator('[data-testid^="terminal-link-candidate-"]')).toHaveCount(2)

    await picker.locator(`[data-path="${STEM_AMBIGUOUS_ALPHA}"]`).click()
    await expect(picker).toHaveCount(0)
    await expect
      .poll(
        () =>
          tabsOf(fixture.projects.alpha).then((t) =>
            t.some((x) => x.path === STEM_AMBIGUOUS_ALPHA)
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
  })

  test('an unknown extension-less word is not a link at all', async () => {
    const alphaTerm = await alphaTerminal()
    expect(await stemMatches('NOTAREALFILENAME')).toEqual([])

    const before = (await tabsOf(fixture.projects.alpha)).length
    await activateLink(alphaTerm, 'NOTAREALFILENAME')
    // Real-world window (routing latency, not interval-derived) — no tab AND no picker, held throughout.
    await expectQuiet(async () => {
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(before)
      await expect(page.getByTestId('terminal-link-picker')).toHaveCount(0)
    }, 300)
  })

  test('a directory inside the active project is revealed in the FILE TREE', async () => {
    const alphaTerm = await alphaTerminal()
    const before = (await revealed()).length
    await activateLink(alphaTerm, './lib')

    // Round-2 locked change: expand + focus in the tree, NOT a hand-off to Finder.
    await expect(page.locator(`[data-testid="tree-node-${ALPHA_DIR}"]`)).toHaveAttribute(
      'data-selected',
      'true',
      { timeout: 10_000 }
    )
    expect(await revealed()).toHaveLength(before)
  })

  test('a directory outside the active project still goes to Finder', async () => {
    const alphaTerm = await alphaTerminal()
    await activateLink(alphaTerm, BETA_DIR)
    // The tree is rooted at Alpha, so it has no row for Beta — Finder is the only sensible target.
    await expect
      .poll(() => revealed().then((paths) => paths.some((p) => p.endsWith(`/${BETA_DIR}`))), {
        timeout: 10_000
      })
      .toBe(true)
  })

  // T-170 — a doc opened via a terminal link to a SYMLINKED path shows the tab-strip symlink
  // glyph, same as the tree/editor open paths. `probePath` resolves a link through to its REAL
  // target (realpath) — the tab lands on `glyph-target.md`, not the clicked `glyph-link.md` name,
  // exactly as every other terminal-link open resolves to the real file — so the only way this
  // route can still know "the click was on a symlink" is `PathProbe.isSymbolicLink` (one `lstat`
  // on the raw, pre-realpath target), threaded through `routeProbe` → `openDocFromLink` →
  // `openDocByPath`. REVERT-PROOF: on the pre-fix `openDocFromLink` (which built its own Tab
  // literal with no `symlink` field at all, and no way to learn it), this fails at the
  // `tab-symlink` assertion below — the tab opens, but the glyph never appears.
  test('a terminal link to a symlinked path shows the tab-strip symlink glyph', async () => {
    const alphaTerm = await alphaTerminal()
    await activateLink(alphaTerm, SYMLINK_DOC)

    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === SYMLINK_TARGET)), {
        timeout: 10_000
      })
      .toBe(true)
    await expect(visibleEditorTitle()).toHaveText('glyph-target.md')
    await expect(page.getByTestId('tab-symlink')).toBeVisible({ timeout: 10_000 })
  })
})
