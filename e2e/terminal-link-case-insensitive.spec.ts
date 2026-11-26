// modules: terminal, editor
// Pomade T-188 e2e — case-INSENSITIVE link matching on BOTH surfaces (terminal + editor), the
// shared name/stem/suffix index behind them, and the exact-case-first / current-project ranking.
//
// The Owner's user-test finding: a prose `Northwind` did not underline while `northwind` did, and
// `[[Northwind]]` did not resolve like `[[northwind]]` (Obsidian folds; we didn't). T-188 folds the
// index keys to lowercase (a plain toLowerCase()) and recovers the exact case at lookup, where
// results rank exact-case-first, then current-project, then walk order. The suffix legs fold too
// (explicit paths fold; an exact-case file wins when both exist). This spec pins:
//   • fold — `Northwind`/`NORTHWIND` find `northwind.md` via findByName AND findByStem (the wikilink
//     stem leg), and the slashed-file suffix leg matches a case-mismatched suffix;
//   • rank — exact-case basename leads its case-variant siblings; a same-project match leads an
//     out-of-project one; both through the real fs.find* IPC;
//   • terminal end-to-end — an uppercase prose word underlines (resolves), and the ambiguity
//     picker leads with the exact-case candidate;
//   • editor end-to-end — `[[Northwind]]` and a bare prose `Northwind` resolve in a real doc's
//     context (the `__pomadeEditorLinkResolve` seam).
// Revert-proven: with the fold stashed on a rebuilt bundle, every uppercase-query assertion fails.

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

// ── Fixture files (seeded BEFORE launch — the T-091 index builds eagerly on root-set) ──────────
// The headline lowercase file a case-variant query must find.
const NORTHWIND = 'northwind.md'
// README case variants for exact-case-first ranking. The fixture already ships three EXACT-case
// `README.md` (Projects/alpha, Projects/beta, Apps/gamma); we add a lower and a mixed variant.
const README_LOWER = 'docs/readme.md'
const README_MIXED = 'variants/ReadMe.md'
// Same-basename files in two projects for current-project ranking.
const RANK_ALPHA = 'Projects/alpha/rankme-uniq.md'
const RANK_BETA = 'Projects/beta/rankme-uniq.md'
// A deep file for the case-folded FILE-suffix leg (2-segment suffix `deep/Case-Report.md`).
const SUFFIX_FILE = 'Knowledge/deep/Case-Report.md'
// Case variants of a basename that exists in NO probe base (not in the alpha cwd / project / ws
// root), so a bare `CasePick.md` token misses every probe and reaches the folded index → the
// ambiguity picker. Used to prove the picker leads with the exact-case candidate.
const PICK_LOWER = 'docs/casepick.md'
const PICK_MIXED = 'variants/CasePick.md'
const PICK_UPPER = 'Knowledge/CASEPICK.md'
// The editor hub doc (preloaded as a tab) — its own directory is Projects/alpha/notes.
const HUB = 'Projects/alpha/notes/hub.md'

async function writeFile(ws: string, rel: string, body = `# ${rel}\n`): Promise<void> {
  await fs.mkdir(join(ws, rel, '..'), { recursive: true })
  await fs.writeFile(join(ws, rel), body, 'utf8')
}

// ── PTY / terminal helpers (shared shape with terminal-link-file-suffix.spec) ──────────────────
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
function resolvesToLink(termId: string, token: string): Promise<boolean> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinkResolve[tid](tk),
    { tid: termId, tk: token }
  )
}
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}

// ── Index IPC probes (the folded lookups themselves) ───────────────────────────────────────────
function findByName(name: string, projectRootAbs?: string): Promise<string[]> {
  return page.evaluate(
    ({ n, p }) => window.pomade.fs.findByName(n, p),
    { n: name, p: projectRootAbs }
  )
}
function findByStem(word: string): Promise<string[]> {
  return page.evaluate((w) => window.pomade.fs.findByStem(w), word)
}
function findFilesBySuffix(token: string): Promise<string[]> {
  return page.evaluate((tk) => window.pomade.fs.findFilesBySuffix(tk), token)
}
// The editor resolve seam (does a line hold a link that resolves on disk in THIS doc's context?).
function editorResolves(tabId: string, text: string): Promise<boolean> {
  return page.evaluate(
    ({ id, t }) => window.__pomadeEditorLinkResolve[id](t),
    { id: tabId, t: text }
  )
}
function base(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const ws = fixture.workspaceRoot
  for (const rel of [
    NORTHWIND,
    README_LOWER,
    README_MIXED,
    RANK_ALPHA,
    RANK_BETA,
    SUFFIX_FILE,
    PICK_LOWER,
    PICK_MIXED,
    PICK_UPPER
  ]) {
    await writeFile(ws, rel)
  }
  await writeFile(ws, HUB, '---\ntitle: Hub\n---\n\n# Hub\n\nA prose paragraph.\n')

  // Preload the hub as an open doc tab so the editor resolve seam is armed for it.
  const state = {
    openTabs: [
      {
        id: 'hub',
        projectId: fixture.projects.alpha,
        kind: 'doc',
        title: 'hub.md',
        path: HUB,
        mode: 'raw',
        dirty: false
      }
    ],
    activeTabId: 'hub'
  }
  await fs.mkdir(join(ws, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(ws, `.pomade/state/${fixture.projects.alpha}.json`), JSON.stringify(state, null, 2))

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('T-188 case-insensitive link matching + ranking', () => {
  test('the index folds: a case-variant query finds the lowercase file (name + stem legs)', async () => {
    // findByName (bare filename leg + wikilink-with-extension leg).
    expect(await findByName('Northwind.md')).toContain(NORTHWIND)
    expect(await findByName('NORTHWIND.MD')).toContain(NORTHWIND)
    // findByStem (prose-stem leg AND the `[[Northwind]]` wikilink stem leg).
    expect(await findByStem('Northwind')).toContain(NORTHWIND)
    expect(await findByStem('NORTHWIND')).toContain(NORTHWIND)
    // No dead links: a word that names nothing is still nothing, whatever the case.
    expect(await findByName('NoSuchFile.md')).toEqual([])
    expect(await findByStem('NoSuchWordXyz')).toEqual([])
  })

  test('ranking: the exact-case basename leads its case-variant siblings', async () => {
    // Three exact-case README.md exist plus a lower + a mixed variant — all in one folded bucket.
    const upper = await findByName('README.md')
    expect(upper.length).toBeGreaterThan(1)
    expect(base(upper[0])).toBe('README.md') // exact-case leads
    // The lowercase query promotes the lowercase file instead.
    const lower = await findByName('readme.md')
    expect(lower[0]).toBe(README_LOWER)
    // The mixed-case query promotes the mixed file.
    const mixed = await findByName('ReadMe.md')
    expect(mixed[0]).toBe(README_MIXED)
    // Every case variant is present regardless of the query's case (folded into one bucket).
    expect(new Set(upper)).toEqual(new Set(lower))
  })

  test('ranking: a current-project match leads an out-of-project one', async () => {
    const ws = fixture.workspaceRoot
    const alphaAbs = `${ws}/Projects/alpha`
    const betaAbs = `${ws}/Projects/beta`
    // Same basename in alpha and beta — the biased project's copy ranks first.
    const forAlpha = await findByName('rankme-uniq.md', alphaAbs)
    expect(forAlpha[0]).toBe(RANK_ALPHA)
    const forBeta = await findByName('rankme-uniq.md', betaAbs)
    expect(forBeta[0]).toBe(RANK_BETA)
  })

  test('the slashed-file suffix leg folds (explicit paths match a case-mismatched suffix)', async () => {
    // The file is `Knowledge/deep/Case-Report.md`; a differently-cased suffix still finds it.
    expect(await findFilesBySuffix('deep/case-report.md')).toContain(SUFFIX_FILE)
    expect(await findFilesBySuffix('DEEP/Case-Report.md')).toContain(SUFFIX_FILE)
    // The segment boundary still holds (a sheared segment does not match).
    expect(await findFilesBySuffix('eep/case-report.md')).toEqual([])
  })

  test('terminal: an uppercase prose word underlines (resolves), lowercase still does', async () => {
    const term = await alphaTerminal()
    expect(await resolvesToLink(term, 'Northwind')).toBe(true)
    expect(await resolvesToLink(term, 'NORTHWIND')).toBe(true)
    expect(await resolvesToLink(term, 'northwind')).toBe(true)
    // A ≥4-char non-file word is still not a link (no dead links).
    expect(await resolvesToLink(term, 'Nonsenseword')).toBe(false)
  })

  test('terminal: the ambiguity picker leads with the exact-case candidate', async () => {
    const term = await alphaTerminal()
    // `CasePick.md` misses every probe base (nothing by that name in the alpha cwd/project/ws
    // root), so it reaches the folded index and its three case variants make it ambiguous.
    await activateLink(term, 'CasePick.md')
    const picker = page.getByTestId('terminal-link-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })
    const candidates = picker.locator('[data-testid^="terminal-link-candidate-"]')
    // The exact-case query `CasePick.md` promotes `variants/CasePick.md` to the top of the picker.
    await expect(candidates.first()).toHaveAttribute('data-path', PICK_MIXED)
    // The lower + upper variants are offered too (the fold merged them into one bucket).
    await expect(picker.locator(`[data-path="${PICK_LOWER}"]`)).toHaveCount(1)
    await expect(picker.locator(`[data-path="${PICK_UPPER}"]`)).toHaveCount(1)
    await page.keyboard.press('Escape')
  })

  test('editor: `[[Northwind]]` and bare prose `Northwind` resolve in a real doc context', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.getByTestId('tab-hub').click()
    // Wikilink stem leg — Obsidian parity: `[[Northwind]]` resolves like `[[northwind]]`.
    expect(await editorResolves('hub', 'see [[Northwind]] here')).toBe(true)
    expect(await editorResolves('hub', 'see [[northwind]] here')).toBe(true)
    // The headline T-184 finding: a bare prose word underlines whatever its case.
    expect(await editorResolves('hub', 'Northwind in prose')).toBe(true)
    // Still no dead links.
    expect(await editorResolves('hub', 'Nonsenseword in prose')).toBe(false)
  })
})
