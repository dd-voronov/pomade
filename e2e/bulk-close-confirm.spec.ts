// modules: terminal, tabs, agents
// Pomade T-299 e2e — "Stop all terminals" and "Exit all agents" ask once before closing busy tabs.
// A busy terminal (a foreground `sleep`) or a mid-turn agent makes the action show one confirm for
// the whole batch (`bulk-close-guard`); Cancel closes nothing, Close runs the action. With nothing
// busy the action closes straight away, as the tab × does.
//
// The shells read a temp ZDOTDIR (never the real rc or history files). The agent is a zsh
// stand-in that draws claude's window title: `/work` puts it mid-turn, `/exit` quits.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { seedFakeAgent } from './fixtures/fake-agent'
import { readBuffer, tabsOf, waitForPrompt, writePty } from './fixtures/stores'
import { expectQuiet } from './fixtures/timing'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { tempDir } from './fixtures/temp'

/** The stand-in agent CLI: claude's idle title at start, its working title on `/work`. */
const FAKE_AGENT_TURNS = `#!/bin/zsh
printf '\\e]0;✳ Claude\\a'
echo AGENT_READY
while IFS= read -r line; do
  case "$line" in
    /work) printf '\\e]0;◐ Working\\a'; echo WORKING ;;
    /exit) exit 0 ;;
    *) echo "AGENT_GOT: $line" ;;
  esac
done
`

// The bulk `/exit` reaps an agent's leftover shell after 1.2 s; a quiet window past that proves
// a cancelled Exit all agents ended nothing.
const EXIT_REAP_QUIET_MS = 2500

test.describe('T-299 bulk close confirms busy tabs', () => {
  let fixture: Fixture
  let zdotdir: string
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_TURNS })
    zdotdir = await tempDir('pomade-t299-zd-')
    await fs.writeFile(join(zdotdir, '.zshrc'), `HISTFILE="${zdotdir}/.zsh_history"\nPROMPT="t299> "\n`)
    app = await launchApp(fixture, { ZDOTDIR: zdotdir })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fixture?.cleanup()
    await fs.rm(zdotdir, { recursive: true, force: true })
  })

  const busy = (termId: string): Promise<boolean> =>
    page.evaluate((t) => window.pomade.pty.list().then((l) => l.some((x) => x.termId === t && x.busy)), termId)
  const agentState = (termId: string): Promise<string | undefined> =>
    page.evaluate((t) => window.__pomadeStores.useAgentLiveStore.getState().states[t], termId)
  const kindIds = async (kind: string): Promise<string[]> =>
    (await tabsOf(page, alpha)).filter((t) => t.kind === kind).map((t) => t.id)

  async function openTerminal(): Promise<{ id: string; termId: string }> {
    const before = new Set(await kindIds('terminal'))
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()
    await expect.poll(async () => (await kindIds('terminal')).filter((id) => !before.has(id)).length).toBe(1)
    const tab = (await tabsOf(page, alpha)).find((t) => t.kind === 'terminal' && !before.has(t.id))
    const termId = tab?.termId ?? ''
    await waitForPrompt(page, termId)
    return { id: tab?.id ?? '', termId }
  }

  async function openAgent(): Promise<{ id: string; termId: string }> {
    const before = new Set(await kindIds('agent'))
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-agent-claude-test').click()
    await expect.poll(async () => (await kindIds('agent')).filter((id) => !before.has(id)).length).toBe(1)
    const tab = (await tabsOf(page, alpha)).find((t) => t.kind === 'agent' && !before.has(t.id))
    const termId = tab?.termId ?? ''
    await expect.poll(() => readBuffer(page, termId), { timeout: 15_000 }).toContain('AGENT_READY')
    return { id: tab?.id ?? '', termId }
  }

  test('Stop all terminals with nothing busy closes the terminals without asking', async () => {
    await openTerminal()
    await openTerminal()
    await page.getByTestId('bulk-actions').click()
    await page.getByTestId('bulk-stop-terminals').click()
    await expect.poll(() => kindIds('terminal')).toEqual([])
    await expect(page.getByTestId('bulk-close-guard')).toHaveCount(0)
  })

  test('Stop all terminals with a busy terminal asks once; Cancel keeps every terminal running', async () => {
    const running = await openTerminal()
    const idle = await openTerminal()
    const second = await openTerminal()
    await writePty(page, running.termId, 'sleep 30\r')
    await writePty(page, second.termId, 'sleep 30\r')
    await expect.poll(() => busy(running.termId), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => busy(second.termId), { timeout: 10_000 }).toBe(true)

    await page.getByTestId('bulk-actions').click()
    await page.getByTestId('bulk-stop-terminals').click()
    const guard = page.getByTestId('bulk-close-guard')
    await expect(guard).toBeVisible()
    await expect(guard).toHaveCount(1)
    await expect(guard).toContainText('Close running terminals?')
    await expect(guard).toContainText('A command is still running in 2 terminals.')

    await page.getByTestId('bulk-close-cancel').click()
    await expect(guard).toHaveCount(0)
    await expectQuiet(async () => {
      expect(await kindIds('terminal')).toEqual([running.id, idle.id, second.id])
    }, 1000)
    expect(await busy(running.termId)).toBe(true)
    expect(await busy(second.termId)).toBe(true)
  })

  test('Close in the confirm stops every terminal, the idle one too (strip menu)', async () => {
    await page.getByTestId('tabstrip-end-zone').click({ button: 'right' })
    await page.getByTestId('strip-stop-terminals').click()
    await expect(page.getByTestId('bulk-close-guard')).toBeVisible()
    await page.getByTestId('bulk-close-confirm').click()
    await expect.poll(() => kindIds('terminal')).toEqual([])
    await expect(page.getByTestId('bulk-close-guard')).toHaveCount(0)
  })

  test('one busy terminal is named in the confirm', async () => {
    const running = await openTerminal()
    await writePty(page, running.termId, 'sleep 30\r')
    await expect.poll(() => busy(running.termId), { timeout: 10_000 }).toBe(true)
    const title = (await tabsOf(page, alpha)).find((t) => t.id === running.id)?.title ?? ''
    await page.getByTestId('bulk-actions').click()
    await page.getByTestId('bulk-stop-terminals').click()
    const guard = page.getByTestId('bulk-close-guard')
    await expect(guard).toContainText('Close running terminal?')
    await expect(guard).toContainText(`A command is still running in “${title}”. Closing it will stop the process.`)
    await page.getByTestId('bulk-close-confirm').click()
    await expect.poll(() => kindIds('terminal')).toEqual([])
  })

  test('Exit all agents with every agent idle exits them without asking', async () => {
    const a = await openAgent()
    await expect.poll(() => agentState(a.termId), { timeout: 10_000 }).toBe('idle')
    await page.getByTestId('bulk-actions').click()
    await page.getByTestId('bulk-exit-agents').click()
    // `/exit` hands the tab back to its shell, which the action then reaps: the tab is gone.
    await expect.poll(() => tabsOf(page, alpha), { timeout: 10_000 }).toEqual([])
    await expect(page.getByTestId('bulk-close-guard')).toHaveCount(0)
  })

  test('Exit all agents with an agent mid-turn asks once; Cancel ends no agent', async () => {
    const working = await openAgent()
    const idle = await openAgent()
    await writePty(page, working.termId, '/work\r')
    await expect.poll(() => agentState(working.termId), { timeout: 10_000 }).toBe('working')
    await expect.poll(() => agentState(idle.termId), { timeout: 10_000 }).toBe('idle')
    const title = (await tabsOf(page, alpha)).find((t) => t.id === working.id)?.title ?? ''

    await page.getByTestId('bulk-actions').click()
    await page.getByTestId('bulk-exit-agents').click()
    const guard = page.getByTestId('bulk-close-guard')
    await expect(guard).toBeVisible()
    await expect(guard).toContainText('Close working agent?')
    await expect(guard).toContainText(`“${title}” is in the middle of a turn.`)

    await page.getByTestId('bulk-close-cancel').click()
    await expect(guard).toHaveCount(0)
    await expectQuiet(async () => {
      expect(await kindIds('agent')).toEqual([working.id, idle.id])
    }, EXIT_REAP_QUIET_MS)
  })

  test('Close in the confirm exits every agent (strip menu)', async () => {
    await page.getByTestId('tabstrip-end-zone').click({ button: 'right' })
    await page.getByTestId('strip-exit-agents').click()
    await expect(page.getByTestId('bulk-close-guard')).toBeVisible()
    await page.getByTestId('bulk-close-confirm').click()
    await expect.poll(() => tabsOf(page, alpha), { timeout: 10_000 }).toEqual([])
  })
})
