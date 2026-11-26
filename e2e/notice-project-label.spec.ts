// modules: core
// T-222 e2e — a notice names its project (docs/modules/core/notices.md "Notices"): the toast's
// source line and the Notices panel row read "Hello · Beta", muted, whichever project is in front;
// "N more from Hello" opens the Notices panel in the project all of the burst belongs to (switching
// to it), and without switching when the burst spans projects. Screenshots land in T222_SHOTS when set.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'
import { postNotice } from 'pomade-kit/node'

import { firstAppWindow, launchApp } from './fixtures/app'
import { activeProjectOf, callIn, connectedFrame, HELLO_DIR } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.T222_SHOTS

async function shotOf(el: Locator | Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await el.screenshot({ path: join(SHOTS, name) })
}

test.describe('T-222 a notice names its project', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  async function showProject(id: string): Promise<void> {
    await page.getByTestId(`project-${id}`).click()
    await expect.poll(() => activeProjectOf(page)).toBe(id)
  }

  async function helloPanel(): Promise<Frame> {
    await page.getByTestId('strip-app-hello-panel').click()
    return connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  }

  async function clearToasts(): Promise<void> {
    const dismiss = page.getByTestId('notice-toast-dismiss')
    while ((await dismiss.count()) > 0) await dismiss.first().click()
  }

  async function postFrom(projectId: string, titles: string[]): Promise<void> {
    await showProject(projectId)
    const panel = await helloPanel()
    for (const title of titles) await callIn(panel, 'notices.post', { title })
  }

  test('the toast and the panel row name the project the notice belongs to, from any project in front', async () => {
    await postFrom(fixture.projects.beta, ['Roadmap ready'])
    await showProject(fixture.projects.alpha)
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'Roadmap ready' })
    await expect(toast.getByTestId('notice-toast-source')).toHaveText('Hello')
    await expect(toast.getByTestId('notice-toast-project')).toHaveText('Beta')
    await shotOf(toast, 'toast-project-other.png')
    await clearToasts()

    // Posted from the project in front, it is named too.
    await postFrom(fixture.projects.alpha, ['Roadmap changed'])
    const here = page.getByTestId('notice-toast').filter({ hasText: 'Roadmap changed' })
    await expect(here.getByTestId('notice-toast-project')).toHaveText('Alpha')
    await clearToasts()

    await page.getByTestId('strip-notices').click()
    const rows = page.getByTestId('notice-row')
    await expect(rows.filter({ hasText: 'Roadmap ready' }).getByTestId('notice-row-project')).toHaveText('Beta')
    await expect(rows.filter({ hasText: 'Roadmap changed' }).getByTestId('notice-row-project')).toHaveText('Alpha')
    await shotOf(page.getByTestId('notices-panel'), 'panel-rows-project.png')
  })

  test('a notice from a command belongs to the Workspace project, and says so', async () => {
    await showProject(fixture.projects.beta)
    await postNotice({ title: 'From a command' }, { source: 'hello', userData: fixture.userDataDir })
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'From a command' })
    await expect(toast.getByTestId('notice-toast-project')).toHaveText('Workspace')
    await clearToasts()
  })

  test('"N more" — a burst from one project opens the Notices panel in that project, switching to it', async () => {
    await postFrom(fixture.projects.beta, ['Run 1', 'Run 2', 'Run 3'])
    await showProject(fixture.projects.alpha)
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'Run 3' })
    await expect(toast.getByTestId('notice-toast-project')).toHaveText('Beta')
    await expect(toast.getByTestId('notice-toast-more')).toHaveText('2 more from Hello')
    await toast.getByTestId('notice-toast-more').click()
    await expect.poll(() => activeProjectOf(page)).toBe(fixture.projects.beta)
    await expect(page.getByTestId('notices-panel')).toBeVisible()
    await expect(page.getByTestId('notice-row').filter({ hasText: /Run \d/ })).toHaveCount(3)
    await expect(page.getByTestId('notice-toast')).toHaveCount(0)
  })

  test('"N more" — a burst across projects opens the Notices panel where you are, rows naming their projects', async () => {
    await postFrom(fixture.projects.beta, ['Build 1'])
    await postFrom(fixture.projects.alpha, ['Build 2'])
    await showProject(fixture.projects.beta)
    const toast = page.getByTestId('notice-toast').filter({ hasText: 'Build 2' })
    await expect(toast.getByTestId('notice-toast-more')).toHaveText('1 more from Hello')
    await shotOf(toast, 'toast-more-mixed.png')
    await toast.getByTestId('notice-toast-more').click()
    // Still in Beta: the burst spans Alpha and Beta.
    await expect(page.getByTestId('notices-panel')).toBeVisible()
    expect(await activeProjectOf(page)).toBe(fixture.projects.beta)
    const rows = page.getByTestId('notice-row')
    await expect(rows.filter({ hasText: 'Build 1' }).getByTestId('notice-row-project')).toHaveText('Beta')
    await expect(rows.filter({ hasText: 'Build 2' }).getByTestId('notice-row-project')).toHaveText('Alpha')
    await expect(page.getByTestId('notice-toast')).toHaveCount(0)
  })
})
