// modules: terminal, filetree
// Pomade E-020 e2e — FOLDER links in the terminal (T-086 bug-fix round 3).
//
// The Owner (real claude-code session): folder tokens like `docs/`, `.superpowers/`,
// `docs/superpowers/specs/` are inconsistently clickable while sibling `.md` links on the same
// screen work. E-020 r2 made in-project folders reveal in the tree, so folders ARE meant to be
// links. This spec drives the WHOLE detection chain (tokenizer → resolver → router) on realistic
// agent-transcript tokens: trailing slashes, bracket/backtick wrappers, trailing punctuation, and
// bare (slash-less) directory names.

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

// Folders under the ACTIVE project (alpha), plus a sibling .md file for the "works vs doesn't"
// comparison. `.superpowers` and a nested specs dir mirror the reported tokens exactly.
const DIR_DOCS = 'Projects/alpha/docs'
const DIR_SUPERPOWERS = 'Projects/alpha/.superpowers'
const DIR_SPECS = 'Projects/alpha/docs/superpowers/specs'
const SIBLING_MD = 'Projects/alpha/docs/no-superpowers-scaffolding.md'
// A uniquely-named directory OUTSIDE the alpha terminal's cwd — the only way it can resolve as a
// BARE token is through the name index (the cwd probe can't reach it). Isolates the index change.
const DIR_REMOTE = 'Projects/beta/uniquedir-xyz'

async function seed(f: Fixture): Promise<void> {
  const ws = f.workspaceRoot
  await fs.mkdir(join(ws, DIR_SPECS), { recursive: true })
  await fs.mkdir(join(ws, DIR_SUPERPOWERS), { recursive: true })
  await fs.mkdir(join(ws, DIR_REMOTE), { recursive: true })
  await fs.writeFile(join(ws, SIBLING_MD), '# No superpowers scaffolding\n\nReal doc.\n', 'utf8')
  await fs.writeFile(join(ws, join(DIR_SUPERPOWERS, 'config.yml')), 'a: 1\n', 'utf8')
  await fs.writeFile(join(ws, join(DIR_SPECS, 'spec-one.md')), '# Spec one\n', 'utf8')
  await fs.writeFile(join(ws, join(DIR_REMOTE, 'keep.md')), '# keep\n', 'utf8')
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

/** Activate a link by TOKEN through the pane hook — exercises the real tokenizer + resolver + router. */
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}

/** True when TOKEN resolves to a link at all (null ⇒ not underlined). Uses the same scan+resolve
 *  path the provider uses, exposed for diagnosis. */
function resolvesToLink(termId: string, token: string): Promise<boolean> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinkResolve[tid](tk),
    { tid: termId, tk: token }
  )
}

function treeSelected(path: string): ReturnType<Page['locator']> {
  return page.locator(`[data-testid="tree-node-${path}"]`)
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
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

test.describe('terminal folder links (T-086 r3)', () => {
  const trailingSlash = ['docs/', '.superpowers/', 'docs/superpowers/specs/']
  const bareNames = ['docs', '.superpowers']

  test('trailing-slash folder tokens resolve to links', async () => {
    const term = await alphaTerminal()
    for (const tok of trailingSlash) {
      expect(await resolvesToLink(term, tok), `token ${JSON.stringify(tok)}`).toBe(true)
    }
    // The sibling .md file resolves too (the comparison baseline).
    expect(await resolvesToLink(term, 'docs/no-superpowers-scaffolding.md')).toBe(true)
  })

  test('wrapped / punctuated folder tokens resolve (agent prose shapes)', async () => {
    const term = await alphaTerminal()
    for (const tok of ['`docs/`', '(.superpowers/,', 'docs/,', '`docs/superpowers/specs/`']) {
      expect(await resolvesToLink(term, tok), `token ${JSON.stringify(tok)}`).toBe(true)
    }
  })

  test('bare (slash-less) directory names resolve via the index', async () => {
    const term = await alphaTerminal()
    for (const tok of bareNames) {
      expect(await resolvesToLink(term, tok), `bare ${JSON.stringify(tok)}`).toBe(true)
    }
  })

  test('a trailing-slash folder inside the project reveals in the tree', async () => {
    const term = await alphaTerminal()
    await activateLink(term, 'docs/')
    await expect(treeSelected(DIR_DOCS)).toHaveAttribute('data-selected', 'true', { timeout: 10_000 })
  })

  test('a bare directory name OUTSIDE the cwd resolves via the name index', async () => {
    const term = await alphaTerminal()
    // Not reachable from alpha's cwd/project/ws-root as a relative path — only the index (which
    // must now hold directories) can turn this bare token into a link.
    expect(await resolvesToLink(term, 'uniquedir-xyz')).toBe(true)
  })

  test('a bare directory name inside the project reveals in the tree', async () => {
    const term = await alphaTerminal()
    await activateLink(term, '.superpowers')
    await expect(treeSelected(DIR_SUPERPOWERS)).toHaveAttribute('data-selected', 'true', { timeout: 10_000 })
  })

  test('a NON-existent folder token is never a link (no dead links)', async () => {
    const term = await alphaTerminal()
    expect(await resolvesToLink(term, 'no-such-dir/')).toBe(false)
    expect(await resolvesToLink(term, 'notarealfolder')).toBe(false)
  })
})
