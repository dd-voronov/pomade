// modules: tabs
// Pomade T-149 §8 e2e — non-close paths (moveTabToProject, preview replacement) never push a
// reopen entry. Doc tabs + store calls only (no terminal/agent), so this file runs in the LIGHT
// pass; the reopen suites that replay terminals and agents live in reopen-closed-tab.spec.ts
// (heavy).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

async function bootPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return page
}

interface TabInfo {
  id: string
  kind: string
  title: string
}

function tabsInfo(page: Page, pid: string): Promise<TabInfo[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title
    }))
  }, pid)
}

function reopenStackIds(page: Page, pid: string): Promise<string[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.reopenStackByProject[p] ?? []).map((e) => e.tab.id)
  }, pid)
}

async function openDoc(
  page: Page,
  pid: string,
  path: string,
  title: string,
  mode: string
): Promise<string> {
  return page.evaluate(
    ({ p, path, title, mode }) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      const id = 'doc-' + Math.random().toString(36).slice(2, 10)
      s.openTab({ id, projectId: p, kind: 'doc', title, path, mode, dirty: false })
      return id
    },
    { p: pid, path, title, mode }
  )
}

// ═══ §8 — moveTabToProject and preview replacement create NO reopen entries ═══
test.describe('T-149 §8 — non-close paths never push a reopen entry', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let page: Page
  let alpha = ''
  let beta = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta
    app = await launchApp(fixture)
    page = await bootPage(app)
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('moving a tab to another project leaves both reopen stacks empty', async () => {
    test.slow()
    const d = await openDoc(page, alpha, 'Projects/alpha/README.md', 'mv.md', 'raw')
    await page.evaluate(
      ({ from, id, to }) => {
        return window.__pomadeStores.useTabsStore.getState().moveTabToProject(from, id, to)
      },
      { from: alpha, id: d, to: beta }
    )
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === d)))
      .toBe(false)
    // The move is not a close: no entry in EITHER project's stack.
    expect(await reopenStackIds(page, alpha)).toEqual([])
    expect(await reopenStackIds(page, beta)).toEqual([])
  })

  test('replacing a preview tab creates no reopen entry', async () => {
    test.slow()
    // Open a preview tab, then replace it in place (the tree-reuse path) via the store.
    const oldId = await page.evaluate((p) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      const id = 'prev-' + Math.random().toString(36).slice(2, 8)
      s.openTab(
        { id, projectId: p, kind: 'doc', title: 'p1.md', path: 'Projects/alpha/README.md', mode: 'raw', dirty: false },
        { preview: true }
      )
      return id
    }, alpha)
    const stackBefore = await reopenStackIds(page, alpha)
    await page.evaluate(
      ({ p, oldId }) => {
        const s = window.__pomadeStores.useTabsStore.getState()
        const newId = 'prev2-' + Math.random().toString(36).slice(2, 8)
        s.replacePreviewTab(p, oldId, {
          id: newId,
          projectId: p,
          kind: 'doc',
          title: 'p2.txt',
          path: 'Projects/alpha/notes.txt',
          mode: 'raw',
          dirty: false
        })
      },
      { p: alpha, oldId }
    )
    await expect
      .poll(() => tabsInfo(page, alpha).then((t) => t.some((x) => x.id === oldId)))
      .toBe(false)
    // replacePreviewTab dropped the old preview WITHOUT a close ⇒ the stack is unchanged.
    expect(await reopenStackIds(page, alpha)).toEqual(stackBefore)
  })
})
