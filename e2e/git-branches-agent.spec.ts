// modules: git, terminal
// Pomade E-041 e2e — "blocked while an agent is live": a worktree's branch cannot be merged,
// rebased or removed while an agent runs in that worktree. The agent is started the way a person
// does it: the branch tab's Open terminal there opens a terminal in the worktree, and the agent's
// command is typed into it (its folder at launch is the worktree). A real zsh — heavy partition.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { FAKE_AGENT_ECHO_EXIT, seedFakeAgent } from './fixtures/fake-agent'
import { createBranchFixture, type BranchFixture } from './fixtures/git-branch-repos'
import { readBuffer, tabsOf, writePty } from './fixtures/stores'
import { showGitPanel } from './fixtures/panels'

let fx: BranchFixture
let app: ElectronApplication
let page: Page
let script: string
/** Screenshots: POMADE_E041_SHOTS, else the test's own output folder. */
const SHOTS = process.env.POMADE_E041_SHOTS ?? join(__dirname, '..', 'test-results')

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createBranchFixture()
  script = await seedFakeAgent(fx, { script: FAKE_AGENT_ECHO_EXIT })
  ;({ app, page } = await launchAppPage(fx, fx.env))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('An agent live in the worktree: Merge is disabled with the reason; when it ends, Merge is back', async () => {
  await page.getByTestId(`project-${fx.projects.alpha}`).click()
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
  const view = page.getByTestId('git-repo-view')
  await view.getByTestId('git-progress-agent/t1').click()
  const pane = page.locator('[data-testid="branch-pane"]:visible')
  await expect(pane.getByTestId('branch-merge')).toBeEnabled()
  await expect(pane.getByTestId('branch-live')).toHaveCount(0)

  await pane.getByTestId('branch-open-terminal').click()
  let termId = ''
  await expect
    .poll(async () => {
      const t = (await tabsOf(page, fx.projects.alpha)).find((x) => x.kind === 'terminal' && x.cwd === fx.agentWt)
      termId = t?.termId ?? ''
      return termId
    })
    .not.toBe('')
  await expect.poll(async () => (await readBuffer(page, termId)).length, { timeout: 20000 }).toBeGreaterThan(0)
  await writePty(page, termId, `${script}\r`)
  await expect.poll(async () => readBuffer(page, termId), { timeout: 20000 }).toContain('AGENT_READY')

  // The branch tab and the row say so; Merge (and Rebase) wait.
  await view.getByTestId('git-progress-agent/t1').click()
  await expect(pane.getByTestId('branch-live')).toContainText('An agent is working here (claude-test)', { timeout: 15000 })
  await expect(pane.getByTestId('branch-merge')).toBeDisabled()
  await expect(pane.getByTestId('branch-rebase')).toBeDisabled()
  await expect(view.getByTestId('git-progress-live-agent/t1')).toBeVisible()
  // The disabled actions still explain themselves on hover: the reason they wait.
  for (const id of ['branch-merge', 'branch-rebase']) {
    await pane.getByTestId(id).hover()
    await expect(page.getByRole('tooltip')).toHaveText('An agent is working here — this waits until it ends.')
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  }
  // The operation itself refuses too, with the reason.
  const p = await page.evaluate(() => window.pomade.git.preview('Projects/alpha', { op: 'merge-branch', branch: 'agent/t1', mode: 'squash' }))
  expect(p.blocked?.message).toBe(`An agent is working here (claude-test in ${fx.agentWt}) — this waits until it ends, so nothing changes under its feet.`)
  await page.screenshot({ path: join(SHOTS, 'e041-agent-live.png') })

  // The agent ends: Merge is back.
  await writePty(page, termId, '/exit\r')
  await expect(pane.getByTestId('branch-live')).toHaveCount(0, { timeout: 15000 })
  await expect(pane.getByTestId('branch-merge')).toBeEnabled()
})
