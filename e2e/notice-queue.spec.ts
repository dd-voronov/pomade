// modules: core
// E-032 e2e — the closed-Pomade notice queue (`<userData>/notices/queue/`): a notice a backend or a
// command posted while Pomade was closed shows at the next launch (toast + Notices panel), one
// posted while Pomade runs shows within moments, both through pomade-kit/node's `postNotice` — the
// same helper backends and commands use — and a file that is not a notice is set aside, never shown.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { postNotice } from 'pomade-kit/node'

import { firstAppWindow, launchApp } from './fixtures/app'
import { HELLO_DIR, tabsOf } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

test.describe('E-032 the closed-Pomade notice queue', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let queue: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    queue = join(fixture.userDataDir, 'notices', 'queue')
    // Pomade is closed: a command and a backend post.
    await postNotice(
      { title: 'Commit & push failed', body: 'Knowledge: conflict in README.md', action: { kind: 'openFile', path: 'Projects/alpha/README.md', projectId: fixture.projects.alpha } },
      { source: 'pomade-git', userData: fixture.userDataDir, now: () => new Date('2026-11-10T07:00:00.000Z') }
    )
    await postNotice(
      { title: 'Morning summary', body: '3 items due today', action: { kind: 'openApp', route: 'roadmap/T-001' } },
      { source: 'hello', userData: fixture.userDataDir, now: () => new Date('2026-11-10T07:05:00.000Z') }
    )
    await fs.writeFile(join(queue, '000000000000001-broken.json'), '{ "title": "no source" }')
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('notices queued while Pomade was closed show at launch, in posting order; the queue is drained', async () => {
    const titles = page.getByTestId('notice-toast').getByTestId('notice-toast-title')
    await expect(titles).toHaveText(['Commit & push failed', 'Morning summary'])
    await expect(page.getByTestId('notice-toast').nth(0).getByTestId('notice-toast-source')).toHaveText('pomade-git')
    await expect(page.getByTestId('notice-toast').nth(1).getByTestId('notice-toast-source')).toHaveText('Hello')
    await expect.poll(async () => (await fs.readdir(queue)).sort()).toEqual(['000000000000001-broken.json.invalid'])
  })

  test('a queued notice’s click works like an app’s: the posting app’s tab at the route', async () => {
    await page.getByTestId('notice-toast').nth(1).getByTestId('notice-toast-open').click()
    await expect
      .poll(async () => (await tabsOf(page, '__workspace__')).filter((t) => t.appId === 'hello' && t.route === 'roadmap/T-001'))
      .toHaveLength(1)
  })

  test('a notice posted while Pomade runs shows within moments, and stays in the panel', async () => {
    await postNotice({ title: 'Run finished', body: 'nightly: ok' }, { source: 'pomade-runner', userData: fixture.userDataDir })
    await expect(page.getByTestId('notice-toast').getByTestId('notice-toast-title').filter({ hasText: 'Run finished' })).toHaveCount(1)
    await expect.poll(async () => (await fs.readdir(queue)).filter((n) => n.endsWith('.json'))).toEqual([])
    await page.getByTestId('strip-notices').click()
    await expect(page.getByTestId('notice-row').getByTestId('notice-row-title')).toHaveText([
      'Run finished',
      'Morning summary',
      'Commit & push failed'
    ])
  })
})
