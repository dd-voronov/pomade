// modules: agents, terminal
// Pomade Wave 4 e2e — session history for a specialised (folder) agent and
// the unresolved-agent mapping dialog flow (S4.4) — the two scenarios that had zero coverage.
//   S6: seed a claude-style projects/<encoded-cwd>/*.jsonl under the fixture agent's config
//       dir (Agents/<name>/), then assert Session history lists it and Resume opens an
//       agent tab whose command contains `--resume <id>`.
//   S4.4: an unresolved agent shows a badge; the mapping dialog sets a working command,
//       persists it to .pomade/agents.json, and starts the agent.

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
import { readBuffer } from './fixtures/stores'
import { FAKE_AGENT_ECHO, seedFakeAgentScript } from './fixtures/fake-agent'

// A stand-in agent: announces readiness, echoes lines. Args (e.g. `--resume <id>`) are ignored.

function encodeCwd(abs: string): string {
  return abs.replace(/[^a-zA-Z0-9]/g, '-')
}


async function visibleTermId(page: Page): Promise<string> {
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible({ timeout: 10_000 })
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

// ─── S6: session history + resume for a specialised folder agent ──────────────────
test.describe('session history (S6)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  const SESSION_ID = 'sess-hist-01'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const root = fixture.workspaceRoot
    const scriptPath = await seedFakeAgentScript(root, { script: FAKE_AGENT_ECHO })

    // Map claude-test → the stand-in so Resume actually launches (roster resolves it).
    await fs.writeFile(
      join(root, '.pomade/agents.json'),
      JSON.stringify({ commands: { 'claude-test': scriptPath }, hidden: [] }, null, 2)
    )

    // Seed a claude-style session store under the folder agent's own config dir
    // (Agents/claude-test/), keyed by the encoded absolute cwd of Projects/alpha.
    const alphaAbs = join(root, 'Projects/alpha')
    const storeDir = join(root, 'Agents/claude-test/projects', encodeCwd(alphaAbs))
    await fs.mkdir(storeDir, { recursive: true })
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Resume me please' },
        timestamp: '2026-05-01T09:00:00.000Z'
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    ]
    await fs.writeFile(join(storeDir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n')

    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('Session history lists the folder agent session and Resume opens it with --resume', async () => {
    await page.getByTestId('session-history-open').click()
    await expect(page.getByTestId('session-history')).toBeVisible()

    // The seeded session is listed with its preview.
    const row = page.getByTestId(`session-${SESSION_ID}`)
    await expect(row).toBeVisible()
    await expect(row).toContainText('Resume me please')

    // Resume launches a new agent terminal whose command carries `--resume <id>`.
    await page.getByTestId(`resume-session-${SESSION_ID}`).click()
    await expect(page.getByTestId('session-history')).toHaveCount(0)
    const termId = await visibleTermId(page)
    await expect
      .poll(() => readBuffer(page, termId), { timeout: 10_000 })
      .toContain(`--resume ${SESSION_ID}`)
  })

  test('deleting the session file removes it from the list', async () => {
    const alphaAbs = join(fixture.workspaceRoot, 'Projects/alpha')
    const file = join(fixture.workspaceRoot, 'Agents/claude-test/projects', encodeCwd(alphaAbs), `${SESSION_ID}.jsonl`)
    await fs.rm(file)

    await page.getByTestId('session-history-open').click()
    await expect(page.getByTestId('session-history')).toBeVisible()
    await expect(page.getByTestId(`session-${SESSION_ID}`)).toHaveCount(0)
    await expect(page.getByTestId('session-history-empty')).toBeVisible()
    // Escape dismisses the dialog (consistency with other modals).
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('session-history')).toHaveCount(0)
  })
})

// ─── S4.4: unresolved-agent mapping dialog ────────────────────────────────────────
test.describe('agent mapping dialog (S4.4)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let scriptPath = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // No agents.json → claude-test's default command 'claude-test' does not resolve.
    scriptPath = await seedFakeAgentScript(fixture.workspaceRoot, { script: FAKE_AGENT_ECHO })
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('clicking an unresolved agent opens the dialog; Escape dismisses it without mapping', async () => {
    // Open the + launcher; claude-test appears with an unresolved badge.
    await page.getByTestId('tab-add').click()
    const agentBtn = page.getByTestId('tab-add-agent-claude-test')
    await expect(agentBtn).toBeVisible()
    await expect(agentBtn.locator('[title="Command not found — click to map"]')).toBeVisible()

    // Clicking an unresolved agent opens the mapping dialog instead of launching.
    await agentBtn.click()
    await expect(page.getByTestId('agent-mapping')).toBeVisible()

    // Escape dismisses it (consistency with other modals) and writes nothing.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('agent-mapping')).toHaveCount(0)
    await expect(
      fs.access(join(fixture.workspaceRoot, '.pomade/agents.json')).then(
        () => true,
        () => false
      )
    ).resolves.toBe(false)
  })

  test('mapping dialog sets a working command, persists to agents.json, and starts the agent', async () => {
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    await expect(page.getByTestId('agent-mapping')).toBeVisible()

    // Map it to the working stand-in and save.
    await page.getByTestId('agent-command-input').fill(scriptPath)
    await page.getByTestId('agent-command-save').click()

    // The override persists to .pomade/agents.json…
    const agentsJson = join(fixture.workspaceRoot, '.pomade/agents.json')
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(agentsJson, 'utf8')).commands['claude-test']
        } catch {
          return ''
        }
      })
      .toBe(scriptPath)

    // …and, now resolved, the agent starts.
    const termId = await visibleTermId(page)
    await expect.poll(() => readBuffer(page, termId), { timeout: 10_000 }).toContain('AGENT_READY')
  })
})
