// modules: core, filetree, terminal
// Pomade E-020 e2e — slashed FOLDER tokens that resolve NOWHERE relative (T-086 round 4).
//
// The Owner, real Claude Code + Codex sessions: `Docs/`, `_templates/` printed as a bare "statement
// of the folder" (not a cwd- or ws-relative route) are DEAD, while r3 made bare slash-less names
// (`docs`) clickable. Root cause: a slashed token is resolved ONLY by probePath against
// cwd/project/ws; when it matches none of those bases, r3's bare-name index fallback was skipped
// (`if (target.includes('/')) return null`). `_templates/` lives at `Knowledge/_templates/`, unique;
// there are MANY `docs/`; the printed token is just the folder's own name/suffix.
//
// Round 4 adds a DIRECTORY-suffix index fallback: a slashed token that fails every probe base is
// matched against indexed directories by its full trailing segment sequence (case-insensitively) —
// unique ⇒ link, several ⇒ the picker, none ⇒ still not a link. probePath hits still win (cwd stays
// first-class). Fixtures mirror a real vault layout (Knowledge/_templates, nested specs, etc.).

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
import { writeWhenReady } from './fixtures/stores'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// ── dirs that live ELSEWHERE than the alpha terminal's cwd (Projects/alpha) ────
const D_TEMPLATES = 'Knowledge/_templates' // unique, underscore-leading
const D_MYSTUFF = 'Knowledge/MyStuff' // unique, mixed-case (token `mystuff/` must match)
const D_DOCS_A = 'Knowledge/docs' // two `docs` → `docs/` is ambiguous
const D_DOCS_B = 'Projects/beta/docs'
const D_DEEP = 'Knowledge/nested/deep/leaf' // unique 2-segment suffix `deep/leaf`
const D_SPECS_FULL = 'Knowledge/x/docs/superpowers/specs' // full suffix docs/superpowers/specs
const D_SPECS_DECOY = 'Knowledge/other/specs' // a `specs` that is NOT under docs/superpowers
// ── dirs INSIDE the cwd (probePath must win, and tokenizer proof) ──────────────
const D_SHARED_CWD = 'Projects/alpha/shared' // same basename as a Knowledge/ dir → cwd wins
const D_SHARED_ELSEWHERE = 'Knowledge/shared'
const D_CWDTPL = 'Projects/alpha/_cwdtpl' // underscore slashed token that DOES resolve cwd-relative

async function mk(ws: string, rel: string): Promise<void> {
  await fs.mkdir(join(ws, rel), { recursive: true })
  await fs.writeFile(join(ws, rel, 'keep.md'), '# keep\n', 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  const ws = f.workspaceRoot
  for (const d of [
    D_TEMPLATES,
    D_MYSTUFF,
    D_DOCS_A,
    D_DOCS_B,
    D_DEEP,
    D_SPECS_FULL,
    D_SPECS_DECOY,
    D_SHARED_CWD,
    D_SHARED_ELSEWHERE,
    D_CWDTPL
  ]) {
    await mk(ws, d)
  }
}

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}
function ptyCwd(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.cwd(tid), termId)
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
  const alphaAbs = join(fixture.workspaceRoot, 'Projects/alpha')
  await expect.poll(() => ptyCwd(termId), { timeout: 10_000 }).toContain(alphaAbs)
  return termId
}

/** Does TOKEN resolve to a link at all (scan + resolve, no routing)? */
function resolvesToLink(termId: string, token: string): Promise<boolean> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinkResolve[tid](tk),
    { tid: termId, tk: token }
  )
}
/** Activate a link by TOKEN (whole tokenizer + resolver + router). */
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}
/** Paths handed to Finder (recorded, not revealed, under NODE_ENV=test). */
function revealed(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // Seed BEFORE launch — the name index is built eagerly when the workspace root is set (T-091),
  // so every fixture directory is present in that first build (no watcher-timing dependency).
  await seed(fixture)
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('terminal slashed-folder suffix fallback (T-086 r4)', () => {
  test('tokenizer emits slashed folder tokens (underscore, trailing slash) — proven cwd-relative', async () => {
    const term = await alphaTerminal()
    // These resolve via probePath (they exist in the cwd), which only happens if the tokenizer
    // emitted them as path candidates in the first place.
    expect(await resolvesToLink(term, '_cwdtpl/')).toBe(true)
    expect(await resolvesToLink(term, 'shared/')).toBe(true)
  })

  test('a unique dir elsewhere resolves by suffix (single segment, underscore, case-mismatch)', async () => {
    const term = await alphaTerminal()
    expect(await resolvesToLink(term, '_templates/')).toBe(true)
    expect(await resolvesToLink(term, 'mystuff/')).toBe(true) // matches Knowledge/MyStuff case-insensitively
    expect(await resolvesToLink(term, '_templates')).toBe(true) // trailing slash optional
  })

  test('a unique dir elsewhere resolves by its FULL multi-segment suffix', async () => {
    const term = await alphaTerminal()
    expect(await resolvesToLink(term, 'docs/superpowers/specs/')).toBe(true)
    expect(await resolvesToLink(term, 'deep/leaf/')).toBe(true)
  })

  test('the full segment sequence must match, not just the last segment', async () => {
    const term = await alphaTerminal()
    // `specs/` alone matches BOTH Knowledge/x/docs/superpowers/specs and Knowledge/other/specs →
    // ambiguous. But `superpowers/specs/` matches only the first → unique. Proves suffix filtering.
    expect(await resolvesToLink(term, 'superpowers/specs/')).toBe(true)
    await activateLink(term, 'superpowers/specs/')
    // unique ⇒ opens no picker
    await expect(page.getByTestId('terminal-link-picker')).toHaveCount(0)
  })

  test('an ambiguous folder name offers the picker', async () => {
    const term = await alphaTerminal()
    // Three `docs` dirs exist (Knowledge/docs, Projects/beta/docs, Knowledge/x/docs — intermediate
    // dirs are indexed too) and alpha's cwd has none, so `docs/` falls to the suffix index → picker.
    await activateLink(term, 'docs/')
    const picker = page.getByTestId('terminal-link-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await expect(picker.locator('[data-testid^="terminal-link-candidate-"]')).toHaveCount(3)
    // Dismiss for the next test.
    await page.keyboard.press('Escape')
  })

  test('a cwd-relative dir wins over a same-name dir elsewhere (probe beats the index)', async () => {
    const term = await alphaTerminal()
    // `shared` exists in the cwd AND in Knowledge/. cwd must win: single, in-project → tree reveal,
    // NOT the picker.
    await activateLink(term, 'shared/')
    await expect(page.getByTestId('terminal-link-picker')).toHaveCount(0)
    await expect(page.locator(`[data-testid="tree-node-${D_SHARED_CWD}"]`)).toHaveAttribute(
      'data-selected',
      'true',
      { timeout: 10_000 }
    )
  })

  test('a unique dir OUTSIDE the active project routes to Finder (existing routing)', async () => {
    const term = await alphaTerminal()
    const before = (await revealed()).length
    await activateLink(term, '_templates/')
    await expect
      .poll(() => revealed().then((p) => p.some((x) => x.endsWith(`/${D_TEMPLATES}`))), { timeout: 10_000 })
      .toBe(true)
    expect((await revealed()).length).toBeGreaterThan(before)
  })

  test('a nonexistent slashed path is still not a link (no dead links)', async () => {
    const term = await alphaTerminal()
    expect(await resolvesToLink(term, 'no/such/dir/')).toBe(false)
    expect(await resolvesToLink(term, 'totally-not-here/')).toBe(false)
  })
})
