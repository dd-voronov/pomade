// modules: editor, terminal
// Pomade T-184 e2e — Cmd+click link detection in the editor, all three modes (raw / live /
// rendered), reusing the terminal resolver as shared infrastructure.
//
// Behavioral coverage runs through the REAL Cmd+hover DOM decoration + real Cmd+click (CM6 and
// ProseMirror both render real DOM text, so geometry is precise — unlike the xterm canvas). A
// resolve hook (`__pomadeEditorLinkResolve`, precedent: `__pomadeTermLinkResolve`) asserts the
// "no dead links" resolution semantics deterministically. Fixture mirrors real vault material —
// frontmatter, bold, a markdown link, bare/relative paths, and the four wikilink shapes (unique,
// aliased, headinged, ambiguous) — the T-004 lesson that minimal synthetic docs hide bugs.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// ── Fixture content (vault-shaped) ──────────────────────────────────────────────
const FM = '---\ntitle: Hub\ntags: [links, e2e]\n---\n\n'
// The hub docs live in Projects/alpha/notes/, so the doc's OWN directory is distinct from the
// project root (Projects/alpha) — which is what makes the doc-dir-relative case observable.
const BODY = [
  '# Hub',
  '',
  'A **bold** intro paragraph with wonderful prose and nothing clickable here.',
  '',
  'Workspace path: Projects/alpha/guide.md for the ws-relative case.',
  '',
  'Sibling path: sibling.md right next to this doc.',
  '',
  'Unique wikilink [[guide]] here.',
  '',
  'Aliased [[guide|the guide]] and headinged [[guide#Section]].',
  '',
  'Ambiguous [[shared]] link.',
  '',
  'Dead: Projects/alpha/does-not-exist.md never resolves.',
  '',
  'See [guide docs](https://example.com/x) for the markdown-link case.',
  '',
  // Markdown FILE links, shaped like real review docs: bold-wrapped, `../../` across folders (to
  // ANOTHER project), a trailing score — the plain detector alone read `../../…md)**` and failed.
  'Cross: **[cross raw](../../beta/cross-raw.md)** (86) · **[cross live](../../beta/cross-live.md)** (90) · **[cross rendered](../../beta/cross-rendered.md)** (95)',
  '',
  // A markdown link and a GUESSED path on one line — the two detectors must coexist.
  'Mixed live: [mixed link live](mixed-live.md) next to Projects/alpha/mixed-guess-live.md here.',
  '',
  'Mixed rendered: [mixed link rendered](mixed-rendered.md) next to Projects/alpha/mixed-guess-rendered.md here.',
  '',
  'Dead link: [missing target](../nowhere/missing.md) never resolves.',
  ''
].join('\n')
const HUB = FM + BODY

const NOTES = 'Projects/alpha/notes'
const HUB_RAW = `${NOTES}/hub-raw.md`
const HUB_LIVE = `${NOTES}/hub-live.md`
const HUB_RENDERED = `${NOTES}/hub-rendered.md`
// Cmd+click targets.
const GUIDE = 'Projects/alpha/guide.md' // ws-relative path AND the unique `[[guide]]` stem
const SIBLING_NOTES = `${NOTES}/sibling.md` // doc-dir-relative `sibling.md`
const SIBLING_ROOT = 'Projects/alpha/sibling.md' // a DECOY at the project root — doc-dir must win
const SHARED_ALPHA = 'Projects/alpha/shared.md' // ambiguous `[[shared]]` (also in beta)
const SHARED_BETA = 'Projects/beta/shared.md'
// Markdown-link targets — one per mode/case so no test sees a tab another one opened.
const CROSS_RAW = 'Projects/beta/cross-raw.md'
const CROSS_LIVE = 'Projects/beta/cross-live.md'
const CROSS_RENDERED = 'Projects/beta/cross-rendered.md'
const MIXED_LIVE = `${NOTES}/mixed-live.md`
const MIXED_GUESS_LIVE = 'Projects/alpha/mixed-guess-live.md'
const MIXED_RENDERED = `${NOTES}/mixed-rendered.md`
const MIXED_GUESS_RENDERED = 'Projects/alpha/mixed-guess-rendered.md'
const ABS_LIVE = 'Projects/alpha/abs live.md' // a space ⇒ `%20` in the file:// URL
const ABS_RENDERED = 'Projects/alpha/abs-rendered.md'
const ABS_POPOVER = 'Projects/alpha/abs-popover.md'

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

// ── Store / routing readers (shared shape with terminal-links.spec) ───────────────
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
function activeTabId(projectId: string): Promise<string | undefined> {
  return page.evaluate(
    (pid) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[pid],
    projectId
  )
}
function openedUrls(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeOpenedUrls ?? []) as string[])
}
function hasTab(path: string): Promise<boolean> {
  return tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === path))
}
/** The resolve hook for THIS doc's context — does a line hold a link that resolves on disk? */
function resolves(tabId: string, text: string): Promise<boolean> {
  return page.evaluate(
    ({ id, t }) => window.__pomadeEditorLinkResolve[id](t),
    { id: tabId, t: text }
  )
}

// ── Geometry: the pixel centre of one rendered character inside a visible editor host ─────────
async function charPoint(hostTestId: string, marker: string, off: number): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ({ host, mk, o }) => {
      const hosts = Array.from(document.querySelectorAll(`[data-testid="${host}"]`))
      const visible = hosts.find((h) => (h as HTMLElement).offsetParent !== null) ?? hosts[0]
      const content = visible?.querySelector('.cm-content, .ProseMirror') ?? visible
      if (!content) return null
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const idx = (node.textContent ?? '').indexOf(mk)
        if (idx >= 0) {
          const range = document.createRange()
          range.setStart(node, idx + o)
          range.setEnd(node, idx + o + 1)
          const r = range.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }
        node = walker.nextNode()
      }
      return null
    },
    { host: hostTestId, mk: marker, o: off }
  )
  if (!point) throw new Error(`no rendered character for "${marker}" +${off} in ${hostTestId}`)
  return point
}

/** Hold Cmd, hover the target character (so the layer resolves + decorates), then click it.
 *  Only for REAL link targets: the click waits for the decoration to prove the layer resolved
 *  (Cmd went down fresh, so any decoration is this hover's own). */
async function cmdClick(hostTestId: string, marker: string, off: number): Promise<void> {
  const pt = await charPoint(hostTestId, marker, off)
  await page.keyboard.down('Meta')
  await page.mouse.move(pt.x, pt.y)
  await expect.poll(() => linkDecoCount(hostTestId), { timeout: 10_000 }).toBeGreaterThan(0)
  await page.mouse.click(pt.x, pt.y)
  await page.keyboard.up('Meta')
}

/** Hold Cmd and hover (no click) — leaves Cmd DOWN so the caller can assert the decoration: a
 *  present one with `expect.poll`, an absent one with `expectQuiet` over `RESOLVE_WINDOW_MS`. */
async function cmdHover(hostTestId: string, marker: string, off: number): Promise<void> {
  const pt = await charPoint(hostTestId, marker, off)
  await page.keyboard.down('Meta')
  await page.mouse.move(pt.x, pt.y)
}

/** How long a hover's async link resolve (a probe IPC round trip) may take to decorate — an
 *  empirical window for "no decoration appears", not a tuned interval. */
const RESOLVE_WINDOW_MS = 350

/** Cmd+click an ELEMENT by its box centre — used for `[[wikilink]]` runs, whose `.cm-wikilink` /
 *  `.pm-wikilink` span splits `[[…]]` into per-bracket text nodes (so char geometry can't target
 *  the token, but the wrapping element's box can). */
async function cmdClickLoc(hostTestId: string, loc: ReturnType<Page['locator']>): Promise<void> {
  await loc.first().scrollIntoViewIfNeeded()
  const box = await loc.first().boundingBox()
  if (!box) throw new Error('no bounding box for locator')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.keyboard.down('Meta')
  await page.mouse.move(x, y)
  await expect.poll(() => linkDecoCount(hostTestId), { timeout: 10_000 }).toBeGreaterThan(0)
  await page.mouse.click(x, y)
  await page.keyboard.up('Meta')
}

/** The link-decoration count inside the visible editor host (both engines' classes). */
function linkDecoCount(hostTestId: string): Promise<number> {
  return page.evaluate((host) => {
    const hosts = Array.from(document.querySelectorAll(`[data-testid="${host}"]`))
    const visible = (hosts.find((h) => (h as HTMLElement).offsetParent !== null) ?? hosts[0]) as HTMLElement | undefined
    if (!visible) return 0
    return visible.querySelectorAll('.cm-editorLink, .pm-editor-link').length
  }, hostTestId)
}

async function openHub(tabId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const ws = fixture.workspaceRoot
  // Seed BEFORE launch so the name index (T-091, built eagerly on root-set) sees every file.
  // `file://` links need the run's absolute workspace path, so that line is appended here.
  const fileUrl = (rel: string): string => pathToFileURL(join(ws, rel)).href
  const hub =
    HUB +
    `Abs: [abs live](${fileUrl(ABS_LIVE)}) and [abs rendered](${fileUrl(ABS_RENDERED)}) and [abs popover](${fileUrl(ABS_POPOVER)}).\n`
  await write(join(ws, HUB_RAW), hub)
  await write(join(ws, HUB_LIVE), hub)
  await write(join(ws, HUB_RENDERED), hub)
  for (const rel of [
    CROSS_RAW, CROSS_LIVE, CROSS_RENDERED, MIXED_LIVE, MIXED_GUESS_LIVE, MIXED_RENDERED,
    MIXED_GUESS_RENDERED, ABS_LIVE, ABS_RENDERED, ABS_POPOVER
  ]) {
    await write(join(ws, rel), `# ${rel}\n\nA markdown-link target.\n`)
  }
  await write(join(ws, GUIDE), '# Guide\n\nThe guide doc.\n')
  await write(join(ws, SIBLING_NOTES), '# Sibling (in notes)\n\nThe doc-dir sibling.\n')
  await write(join(ws, SIBLING_ROOT), '# Sibling (project root DECOY)\n\nMust NOT win.\n')
  await write(join(ws, SHARED_ALPHA), '# Shared (alpha)\n\nAlpha copy.\n')
  await write(join(ws, SHARED_BETA), '# Shared (beta)\n\nBeta copy.\n')

  const state = {
    openTabs: [
      { id: 'hub-raw', projectId: 'proj-alpha', kind: 'doc', title: 'hub-raw.md', path: HUB_RAW, mode: 'raw', dirty: false },
      { id: 'hub-live', projectId: 'proj-alpha', kind: 'doc', title: 'hub-live.md', path: HUB_LIVE, mode: 'live', dirty: false },
      { id: 'hub-rendered', projectId: 'proj-alpha', kind: 'doc', title: 'hub-rendered.md', path: HUB_RENDERED, mode: 'rendered', dirty: false }
    ],
    activeTabId: 'hub-raw'
  }
  await fs.mkdir(join(ws, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(ws, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: ws, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('editor Cmd+click links (T-184)', () => {
  // ── Resolution semantics (deterministic, doc-context-aware) ─────────────────────
  test('resolution: real paths & wikilinks resolve; dead paths and non-file prose do not', async () => {
    await openHub('hub-raw')
    // ws-relative path, doc-dir-relative path.
    expect(await resolves('hub-raw', 'see Projects/alpha/guide.md here')).toBe(true)
    expect(await resolves('hub-raw', 'see sibling.md here')).toBe(true)
    // wikilinks: unique, aliased, headinged all resolve on the BASENAME; ambiguous resolves too
    // (to a picker — non-null); the terminal resolver decides open-vs-pick.
    expect(await resolves('hub-raw', 'x [[guide]] y')).toBe(true)
    expect(await resolves('hub-raw', 'x [[guide|the guide]] y')).toBe(true)
    expect(await resolves('hub-raw', 'x [[guide#Section]] y')).toBe(true)
    expect(await resolves('hub-raw', 'x [[shared]] y')).toBe(true)
    // dead path + non-file prose word ⇒ NOT links (no dead links).
    expect(await resolves('hub-raw', 'Projects/alpha/does-not-exist.md')).toBe(false)
    expect(await resolves('hub-raw', 'wonderful prose paragraph nothing clickable')).toBe(false)
    expect(await resolves('hub-raw', '[[totally-not-a-file]]')).toBe(false)
    // markdown links: the HREF decides — doc-folder-relative `../../`, existence-checked.
    expect(await resolves('hub-raw', '**[x](../../beta/cross-raw.md)** (86)')).toBe(true)
    expect(await resolves('hub-raw', '[x](../nowhere/missing.md)')).toBe(false)
    expect(await resolves('hub-raw', '[x](#a-heading-anchor)')).toBe(false)
  })

  // ── RAW mode ────────────────────────────────────────────────────────────────────
  test('raw: Cmd+hover underlines a ws-relative path and Cmd+click opens it', async () => {
    await openHub('hub-raw')
    await expect(page.locator('[data-testid="raw-editor"]:visible .cm-content')).toBeVisible()
    await cmdHover('raw-editor', 'guide.md', 0)
    await expect.poll(() => linkDecoCount('raw-editor')).toBeGreaterThan(0)
    await page.keyboard.up('Meta')
    // Cmd+click opens the doc tab.
    await cmdClick('raw-editor', 'guide.md', 0)
    await expect.poll(() => hasTab(GUIDE), { timeout: 10_000 }).toBe(true)
  })

  test('raw: a dead path and a non-file prose word never underline', async () => {
    await openHub('hub-raw')
    await cmdHover('raw-editor', 'does-not-exist.md', 0)
    // The whole dead line was scanned — nothing on it resolves, so nothing underlines.
    await expectQuiet(async () => expect(await linkDecoCount('raw-editor')).toBe(0), RESOLVE_WINDOW_MS)
    await page.keyboard.up('Meta')
    await cmdHover('raw-editor', 'wonderful', 0)
    await expectQuiet(async () => expect(await linkDecoCount('raw-editor')).toBe(0), RESOLVE_WINDOW_MS)
    await page.keyboard.up('Meta')
  })

  test('raw: a plain click never navigates and lands the caret where clicked', async () => {
    await openHub('hub-raw')
    const before = await activeTabId(fixture.projects.alpha)
    const pt = await charPoint('raw-editor', 'guide.md', 2) // no Meta held
    await page.mouse.click(pt.x, pt.y)
    // Still on the hub — a plain click is pure caret/selection, never navigation.
    expect(await activeTabId(fixture.projects.alpha)).toBe(before)
    // The caret landed inside the clicked line (collapsed DOM selection in the content).
    const sel = await page.evaluate(() => {
      const s = window.getSelection()
      return { collapsed: s?.isCollapsed ?? false, text: s?.anchorNode?.textContent ?? '' }
    })
    expect(sel.collapsed).toBe(true)
    expect(sel.text).toContain('guide.md')
  })

  test('raw: a doc-dir-relative path resolves against the doc folder (beats the project-root decoy)', async () => {
    await openHub('hub-raw')
    await cmdClick('raw-editor', 'sibling.md', 0)
    // The sibling in the doc's OWN folder wins — the project-root decoy is never opened.
    await expect.poll(() => hasTab(SIBLING_NOTES), { timeout: 10_000 }).toBe(true)
    expect(await hasTab(SIBLING_ROOT)).toBe(false)
  })

  test('raw: a unique [[wikilink]] opens the doc', async () => {
    await openHub('hub-raw')
    await cmdClickLoc('raw-editor', page.locator('[data-testid="raw-editor"]:visible .cm-wikilink', { hasText: '[[guide]]' }))
    await expect.poll(() => hasTab(GUIDE), { timeout: 10_000 }).toBe(true)
  })

  test('raw: an ambiguous [[wikilink]] opens the picker; the pick opens the chosen doc', async () => {
    await openHub('hub-raw')
    await cmdClickLoc('raw-editor', page.locator('[data-testid="raw-editor"]:visible .cm-wikilink', { hasText: '[[shared]]' }))
    const picker = page.getByTestId('editor-link-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await expect(picker.locator('[data-testid^="editor-link-candidate-"]')).toHaveCount(2)
    await picker.locator(`[data-path="${SHARED_ALPHA}"]`).click()
    await expect(picker).toHaveCount(0)
    await expect.poll(() => hasTab(SHARED_ALPHA), { timeout: 10_000 }).toBe(true)
  })

  test('raw: Cmd+click on a markdown [text](../../path) link opens the href, resolved from the doc folder', async () => {
    await openHub('hub-raw')
    await cmdClick('raw-editor', 'cross raw', 2)
    await expect.poll(() => hasTab(CROSS_RAW), { timeout: 10_000 }).toBe(true)
  })

  // ── LIVE mode ─────────────────────────────────────────────────────────────────
  test('live: Cmd+hover underlines a ws-relative path and Cmd+click opens it', async () => {
    await openHub('hub-live')
    await expect(page.locator('[data-testid="live-editor"]:visible .cm-content')).toBeVisible()
    await cmdHover('live-editor', 'guide.md', 0)
    await expect.poll(() => linkDecoCount('live-editor')).toBeGreaterThan(0)
    await page.keyboard.up('Meta')
    await cmdClick('live-editor', 'guide.md', 0)
    await expect.poll(() => hasTab(GUIDE), { timeout: 10_000 }).toBe(true)
  })

  test('live: a unique [[wikilink]] opens the doc', async () => {
    await openHub('hub-live')
    await cmdClickLoc('live-editor', page.locator('[data-testid="live-editor"]:visible .cm-wikilink', { hasText: '[[guide]]' }))
    await expect.poll(() => hasTab(GUIDE), { timeout: 10_000 }).toBe(true)
  })

  test('live: Cmd+click on a markdown file link opens it — and never also pops the URL popover', async () => {
    await openHub('hub-live')
    await cmdClick('live-editor', 'cross live', 2)
    await expect.poll(() => hasTab(CROSS_LIVE), { timeout: 10_000 }).toBe(true)
    await expect(page.getByTestId('link-popover')).toHaveCount(0)
  })

  test('live: a file:// link (percent-encoded space) opens the file', async () => {
    await openHub('hub-live')
    await cmdClick('live-editor', 'abs live', 2)
    await expect.poll(() => hasTab(ABS_LIVE), { timeout: 10_000 }).toBe(true)
  })

  test('live: a markdown link and a guessed path on the same line both work', async () => {
    await openHub('hub-live')
    await cmdHover('live-editor', 'mixed link live', 2)
    await expect.poll(() => linkDecoCount('live-editor')).toBe(2)
    await page.keyboard.up('Meta')
    await cmdClick('live-editor', 'mixed link live', 2)
    await expect.poll(() => hasTab(MIXED_LIVE), { timeout: 10_000 }).toBe(true)
    await openHub('hub-live')
    await cmdClick('live-editor', 'mixed-guess-live.md', 2)
    await expect.poll(() => hasTab(MIXED_GUESS_LIVE), { timeout: 10_000 }).toBe(true)
  })

  test('live: a markdown link to a missing file never underlines', async () => {
    await openHub('hub-live')
    await cmdHover('live-editor', 'missing target', 2)
    await expectQuiet(async () => expect(await linkDecoCount('live-editor')).toBe(0), RESOLVE_WINDOW_MS)
    await page.keyboard.up('Meta')
  })

  test("live: the plain-click popover's Open handles a file:// link", async () => {
    await openHub('hub-live')
    const pt = await charPoint('live-editor', 'abs popover', 2)
    await page.mouse.click(pt.x, pt.y)
    await expect(page.getByTestId('link-popover')).toBeVisible()
    await page.getByTestId('link-popover-open').click()
    await expect.poll(() => hasTab(ABS_POPOVER), { timeout: 10_000 }).toBe(true)
  })

  // ── RENDERED mode ───────────────────────────────────────────────────────────────
  test('rendered: Cmd+hover underlines a ws-relative path and Cmd+click opens it', async () => {
    await openHub('hub-rendered')
    await expect(page.locator('[data-testid="rendered-editor"]:visible .ProseMirror')).toBeVisible()
    await cmdHover('rendered-editor', 'guide.md', 0)
    await expect.poll(() => linkDecoCount('rendered-editor')).toBeGreaterThan(0)
    await page.keyboard.up('Meta')
    await cmdClick('rendered-editor', 'guide.md', 0)
    await expect.poll(() => hasTab(GUIDE), { timeout: 10_000 }).toBe(true)
  })

  test('rendered: a unique [[wikilink]] opens the doc', async () => {
    await openHub('hub-rendered')
    await cmdClickLoc('rendered-editor', page.locator('[data-testid="rendered-editor"]:visible .pm-wikilink', { hasText: '[[guide]]' }))
    await expect.poll(() => hasTab(GUIDE), { timeout: 10_000 }).toBe(true)
  })

  test('rendered: a markdown link goes to its HREF, never to a stem guessed from its text', async () => {
    await openHub('hub-rendered')
    const before = await activeTabId(fixture.projects.alpha)
    // "guide docs" is the link's TEXT; its word `guide` would resolve as a stem (→ guide.md), but
    // the link mark owns that run, so the click goes to the href (the browser), not guide.md.
    await cmdClick('rendered-editor', 'guide docs', 0)
    await expect.poll(() => openedUrls(), { timeout: 10_000 }).toContain('https://example.com/x')
    expect(await activeTabId(fixture.projects.alpha)).toBe(before)
  })

  test('rendered: Cmd+click on a markdown file link opens it, resolved from the doc folder', async () => {
    await openHub('hub-rendered')
    await cmdClick('rendered-editor', 'cross rendered', 2)
    await expect.poll(() => hasTab(CROSS_RENDERED), { timeout: 10_000 }).toBe(true)
  })

  test('rendered: a file:// link opens the file', async () => {
    await openHub('hub-rendered')
    await cmdClick('rendered-editor', 'abs rendered', 2)
    await expect.poll(() => hasTab(ABS_RENDERED), { timeout: 10_000 }).toBe(true)
  })

  test('rendered: a markdown link and a guessed path on the same line both work', async () => {
    await openHub('hub-rendered')
    await cmdHover('rendered-editor', 'mixed link rendered', 2)
    await expect.poll(() => linkDecoCount('rendered-editor')).toBe(2)
    await page.keyboard.up('Meta')
    await cmdClick('rendered-editor', 'mixed link rendered', 2)
    await expect.poll(() => hasTab(MIXED_RENDERED), { timeout: 10_000 }).toBe(true)
    await openHub('hub-rendered')
    await cmdClick('rendered-editor', 'mixed-guess-rendered.md', 2)
    await expect.poll(() => hasTab(MIXED_GUESS_RENDERED), { timeout: 10_000 }).toBe(true)
  })
})
