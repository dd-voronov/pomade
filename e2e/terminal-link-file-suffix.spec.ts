// modules: terminal, editor
// Pomade E-020 e2e — slashed FILE tokens that resolve NOWHERE relative (T-086 Fix A).
//
// The Owner's real Claude Code sessions print a file path RELATIVE to some deep folder, e.g.
// `session-docs-reviewed/4f75f0a0-…-reviewed.md`. It is neither cwd-, project-, nor ws-relative, so
// every probe base misses. r4 added a DIRECTORY-suffix fallback (`findDirsBySuffix`) but no FILE
// counterpart, so such a token died even though the file exists uniquely in the workspace.
//
// Fix A adds `findFilesBySuffix`: FILES whose ws-relative path ends with the token's FULL trailing
// segment sequence, matched on SEGMENT BOUNDARIES (case-sensitive). `docs-reviewed/x.md` must NOT
// match a path ending `session-docs-reviewed/x.md` — the boundary is a whole path segment, never a
// substring. File-first when the token has no trailing slash, then the dir fallback; a trailing
// slash is a directory reference and skips the file leg. Unique ⇒ link, several ⇒ picker, none ⇒
// still not a link (no dead links). Fixtures mirror real agent-output path shapes.

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

// The one deep file behind the headline repro — resolvable only by its full trailing suffix.
const F_DEEP = 'Knowledge/logs/transcripts/session-docs-reviewed/4f75f0a0-reviewed.md'
// A DIFFERENT file whose basename collides but whose parent segment is `session-docs-reviewed` —
// used to prove the segment boundary (a `docs-reviewed/…` token must NOT match it).
const F_SEG = 'Knowledge/logs/session-docs-reviewed/seg1234.md'
// Two files sharing a full 2-segment suffix `reports/2026-summary.md` → the ambiguity picker.
const F_AMB_A = 'Knowledge/alpha/reports/2026-summary.md'
const F_AMB_B = 'Knowledge/beta/reports/2026-summary.md'
// A workspace-unique BARE basename — the pre-existing findByName path must still work (no regression).
const F_BARE = 'Knowledge/onlyone-unique-xyz.md'
// A directory reachable by suffix — proves the file leg never hijacks a dir token.
const D_SUFFIX = 'Knowledge/alpha/reports'

async function writeFile(ws: string, rel: string): Promise<void> {
  await fs.mkdir(join(ws, rel, '..'), { recursive: true })
  await fs.writeFile(join(ws, rel), `# ${rel}\n`, 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  const ws = f.workspaceRoot
  for (const rel of [F_DEEP, F_SEG, F_AMB_A, F_AMB_B, F_BARE]) await writeFile(ws, rel)
}

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
/** The main-side index probe itself. */
function findFilesBySuffix(token: string): Promise<string[]> {
  return page.evaluate((tk) => window.pomade.fs.findFilesBySuffix(tk), token)
}
interface TabSnapshot {
  kind: string
  path?: string
}
function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ kind: t.kind, path: t.path }))
  }, projectId)
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // Seed BEFORE launch — the name index is built eagerly when the workspace root is set (T-091).
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

test.describe('terminal slashed-file suffix fallback (T-086 Fix A)', () => {
  test('the main-side index matches a deep file by its full segment-aligned suffix', async () => {
    // The unit-level guarantee behind the whole feature.
    expect(await findFilesBySuffix('session-docs-reviewed/4f75f0a0-reviewed.md')).toEqual([F_DEEP])
    // The segment boundary: a suffix that shares only PART of a segment does not match.
    expect(await findFilesBySuffix('docs-reviewed/4f75f0a0-reviewed.md')).toEqual([])
    // A bare basename is served by findByName, not here.
    expect(await findFilesBySuffix('4f75f0a0-reviewed.md')).toEqual([])
    // A trailing slash is a directory reference — left entirely to the dir fallback.
    expect(await findFilesBySuffix('reports/')).toEqual([])
  })

  test('a deep-relative file token resolves via the suffix fallback (unique)', async () => {
    const term = await alphaTerminal()
    expect(await resolvesToLink(term, 'session-docs-reviewed/4f75f0a0-reviewed.md')).toBe(true)
  })

  test('the FULL segment sequence must match, not a substring of a segment', async () => {
    const term = await alphaTerminal()
    // The file lives at `…/session-docs-reviewed/seg1234.md`. Its own full suffix links…
    expect(await resolvesToLink(term, 'session-docs-reviewed/seg1234.md')).toBe(true)
    // …but a token that shears the segment (`docs-reviewed/…`) stays DEAD (no dead links).
    expect(await resolvesToLink(term, 'docs-reviewed/seg1234.md')).toBe(false)
  })

  test('a deep-relative file resolves to a doc tab (routing unchanged)', async () => {
    const term = await alphaTerminal()
    await activateLink(term, 'session-docs-reviewed/4f75f0a0-reviewed.md')
    // Inside the workspace, outside the active project → a doc tab in the current strip (the exact
    // E-020 r2 routing a bare/relative in-workspace file already gets).
    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === F_DEEP)), {
        timeout: 10_000
      })
      .toBe(true)
    await expect(page.getByTestId('terminal-link-picker')).toHaveCount(0)
  })

  test('an ambiguous file suffix offers the picker', async () => {
    const term = await alphaTerminal()
    await activateLink(term, 'reports/2026-summary.md')
    const picker = page.getByTestId('terminal-link-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })
    await expect(picker.locator('[data-testid^="terminal-link-candidate-"]')).toHaveCount(2)
    await expect(picker.locator(`[data-path="${F_AMB_A}"]`)).toHaveCount(1)
    await expect(picker.locator(`[data-path="${F_AMB_B}"]`)).toHaveCount(1)
    await page.keyboard.press('Escape')
  })

  test('a nonexistent slashed file is still not a link (no dead links)', async () => {
    const term = await alphaTerminal()
    expect(await resolvesToLink(term, 'no/such/deep-file-xyz.md')).toBe(false)
    expect(await resolvesToLink(term, 'totally/made-up/thing.md')).toBe(false)
  })

  test('the file leg never hijacks a directory token, and bare names still resolve', async () => {
    const term = await alphaTerminal()
    // A slashed token naming a DIR (no file with that basename) still resolves via the dir fallback.
    expect(await resolvesToLink(term, 'alpha/reports')).toBe(true)
    expect(await findFilesBySuffix('alpha/reports')).toEqual([]) // …and NOT as a file
    // The pre-existing bare-name path (findByName) is untouched.
    expect(await resolvesToLink(term, 'onlyone-unique-xyz.md')).toBe(true)
    // A directory the file leg must ignore is still a real directory in the workspace.
    void D_SUFFIX
  })
})
