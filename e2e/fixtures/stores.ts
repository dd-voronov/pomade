// Pomade e2e — the typed store/IPC test surface (T-161).
//
// Two globals let specs drive the app below the UI: `window.pomade` (the real preload bridge,
// typed in src/shared/ipc-api.ts) and `window.__pomadeStores` (an e2e-only hook App.tsx installs,
// exposing the zustand stores; see the "e2e hook" comment there). Both are declared on `Window` in
// ./globals.ts with the other test hooks; this module models the store shapes and exports the
// common pokes (`readBuffer`, `writePty`, `tabsOf`, …).
//
// Store DATA fields the specs read are typed (against src/shared where the shape lives there); store
// ACTIONS stay permissive so a spec can call any action without re-typing it. The store-STATE shapes
// are renderer-internal, so they're modelled structurally here rather than imported (e2e's tsconfig
// sees src/shared only).

import { expect, type Page } from '@playwright/test'
import type { AppBackendStatus, Project, Group } from '../../src/shared/types'

/** A zustand store as the e2e hook exposes it: `.getState()` and `.setState()`. */
interface StoreHandle<S> {
  getState(): S
  setState(partial: Partial<S>): void
  subscribe(listener: (state: S, prev: S) => void): () => void
}

// The typed fields win over the catch-all; the `[key: string]: any` catch-all keeps every other
// field and every store ACTION reachable without hand-typing ~40 action signatures.
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped store actions: see the comment above */
interface TabsState {
  tabsByProject: Record<string, TabSnap[]>
  activeTabByProject: Record<string, string | undefined>
  reopenStackByProject: Record<string, { tab: TabSnap }[]>
  tabsFor(projectId: string): TabSnap[]
  [key: string]: any
}
interface WorkspaceState {
  activeProjectId: string
  projects: Project[]
  groups: Group[]
  [key: string]: any
}
interface AppSettingsState {
  hydrated: boolean
  layout: { fileTreeCollapsed: boolean }
  [key: string]: any
}
interface AppsState {
  apps: {
    id: string
    backend: AppBackendStatus | null
    shortcuts: { key: string }[]
    shortcutConflicts: string[]
    [key: string]: any
  }[]
  [key: string]: any
}
interface GenericState {
  [key: string]: any
}
interface AgentLiveState {
  /** termId → the agent's live state (`working` · `needs-you` · `idle`). */
  states: Record<string, string>
  [key: string]: any
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PomadeStores {
  useTabsStore: StoreHandle<TabsState>
  useWorkspaceStore: StoreHandle<WorkspaceState>
  useWorkspaceUiStore: StoreHandle<GenericState>
  useTerminalsStore: StoreHandle<GenericState>
  useAppSettingsStore: StoreHandle<AppSettingsState>
  useMountsStore: StoreHandle<GenericState>
  useAppsStore: StoreHandle<AppsState>
  useAgentLiveStore: StoreHandle<AgentLiveState>
}

/** A flat, all-optional projection over the `Tab` union (DocTab ∪ TerminalTab), so a spec can
 *  read any tab field — `path`/`mode`/`dirty` (doc) or `termId`/`status`/`cwd` (terminal) —
 *  off one `tabsOf` result without narrowing. It is exactly the persisted tab shape. */
export interface TabSnap {
  id: string
  projectId: string
  kind: string
  title: string
  // doc fields
  path?: string
  mode?: string
  richView?: string
  dirty?: boolean
  symlink?: boolean
  version?: { label: string; source: { kind: string } }
  // terminal/agent fields
  termId?: string
  agentId?: string
  cwd?: string
  status?: string
  lastCommand?: string
  resumeSessionId?: string
  lastExec?: string
  renamed?: boolean
  cwdAtLaunch?: string
  bindState?: string
  // app fields
  appId?: string
  icon?: string
  route?: string
  key?: string
  tabKind?: string
  appTitled?: boolean
  // shared
  color?: string
  attention?: boolean
}

/** The rendered pty buffer for a term (what the shell has printed so far). */
export function readBuffer(page: Page, termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}

/** Write raw bytes into a term's pty (driving the shell). */
export function writePty(page: Page, termId: string, data: string): Promise<void> {
  return page.evaluate(({ tid, d }) => window.pomade.pty.write(tid, d), { tid: termId, d: data })
}

/** The shim's precmd marker (OSC 7879 `pomade:prompt`, see src/main/pty-manager.ts). The raw pty
 *  buffer carries it once zsh has finished its startup files and drawn a prompt. */
const PROMPT_MARKER = '\x1b]7879;pomade:prompt;'

/** Wait until a term's shell has drawn its first prompt — zle is about to read a command line, so
 *  typed input is no longer eaten by shell startup. The same signal main trusts for T-115's
 *  pre-typed input. (`pty.cwd` is no such oracle: it is seeded with the spawn cwd.) */
export async function waitForPrompt(page: Page, termId: string, timeout = 20_000): Promise<void> {
  await expect.poll(() => promptCount(page, termId), { timeout }).toBeGreaterThan(0)
}

/** Type into a term once its shell has drawn its first prompt (`waitForPrompt`), so the
 *  interactive login zsh's startup does not eat the input. */
export async function writeWhenReady(page: Page, termId: string, data: string): Promise<void> {
  await waitForPrompt(page, termId)
  await writePty(page, termId, data)
}

/** How many prompts a term's shell has drawn so far. zsh runs precmd before EVERY prompt —
 *  after a command, and after a Ctrl+C that discards the line — so "the count grew" is the
 *  oracle for "the shell is back at a fresh, empty prompt". */
export function promptCount(page: Page, termId: string): Promise<number> {
  return readBuffer(page, termId).then((b) => b.split(PROMPT_MARKER).length - 1)
}

/** Ctrl+C the term's current line (e.g. T-115's pre-typed command) and wait for zsh's fresh prompt. */
export async function discardLine(page: Page, termId: string): Promise<void> {
  const before = await promptCount(page, termId)
  await writePty(page, termId, '\x03')
  await expect.poll(() => promptCount(page, termId), { timeout: 10_000 }).toBeGreaterThan(before)
}

/** The tabs of a project, straight from the store (empty array when the project has none). */
export function tabsOf(page: Page, projectId: string): Promise<TabSnap[]> {
  return page.evaluate((p) => window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? [], projectId)
}

/** The project's active tab id (or undefined). */
export function activeIdOf(page: Page, projectId: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[p],
    projectId
  )
}

/** Close every tab of a project through the store, then wait until the strip is empty. */
export async function resetTabs(page: Page, projectId: string): Promise<void> {
  await page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    for (const t of [...(s.tabsByProject[p] ?? [])]) s.closeTab(p, t.id)
  }, projectId)
  await expect.poll(() => tabsOf(page, projectId).then((t) => t.length)).toBe(0)
}

/** Wait until a caret-placing click has REGISTERED in the (rendered/raw) editor's own state —
 *  T-175 / Electron 44. Milkdown/ProseMirror mounts async: on a tab-switch the freshly-shown view
 *  accepts a click into the DOM a beat before its state catches up (a window the newer Chromium
 *  widened), so `page.keyboard.type` fired immediately after the click lands at the document start.
 *  A real user never types that fast; a spec must. This polls the `__pomadeEditorSelectionFrom`
 *  hook (the visible pane's live selection start) until it STABILISES — two equal, non-negative
 *  reads a settle-sample apart — which is exactly when the click has taken and the state is ready.
 *  Call it after the caret-placing click and before the first keystroke. Deterministic (no fixed
 *  sleep): the state self-converges within a couple of frames, so this returns almost immediately. */
export async function waitCaretRegistered(page: Page): Promise<void> {
  const read = (): Promise<number> =>
    page.evaluate(
      () =>
window.__pomadeEditorSelectionFrom?.() ?? -1
    )
  await expect
    .poll(
      async () => {
        const a = await read()
        // eslint-disable-next-line playwright/no-wait-for-timeout -- the gap between two samples IS the stability test; the poll exits as soon as it holds
        await page.waitForTimeout(50)
        const b = await read()
        return a >= 0 && a === b
      },
      { timeout: 5000 }
    )
    .toBe(true)
}

/** Wait until the visible editor pane SHOWS the active doc tab's stored mode. A freshly opened
 *  markdown doc can still flip `data-mode` after first paint — the default-mode coercion, then the
 *  async parse gate a `rendered` doc passes before Milkdown shows (useEditorMode) — so a spec reads
 *  `data-mode` only after this. For a parseable markdown doc (an unparseable one stays raw). */
export async function waitEditorModeSettled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__pomadeStores
        const p = s.useWorkspaceStore.getState().activeProjectId
        const tabs = s.useTabsStore.getState()
        const tab = tabs.tabsByProject[p]?.find((t) => t.id === tabs.activeTabByProject[p])
        const pane = [...document.querySelectorAll<HTMLElement>('[data-testid="editor-pane"]')].find(
          (el) => el.offsetParent !== null
        )
        return tab?.mode !== undefined && tab.mode === pane?.getAttribute('data-mode')
      })
    )
    .toBe(true)
}

/** Bring the visible editor pane of a parseable markdown doc to `want`, whichever mode it is in.
 *  The mode button flips raw ⇄ the doc's rich view; the ⋯ "Rich view" item switches that rich view
 *  between Live and Rendered. Ends asserting the pane shows `want`. */
export async function setEditorMode(page: Page, want: 'raw' | 'live' | 'rendered'): Promise<void> {
  const pane = page.locator('[data-testid="editor-pane"]:visible')
  const toggle = page.locator('[data-testid="mode-toggle"]:visible')
  await expect(toggle).toBeVisible()
  await waitEditorModeSettled(page)
  const from = await pane.getAttribute('data-mode')
  if ((from === 'raw') !== (want === 'raw')) {
    await toggle.click()
    await expect(pane).not.toHaveAttribute('data-mode', from ?? '')
    await waitEditorModeSettled(page)
  }
  if ((await pane.getAttribute('data-mode')) !== want) {
    await page.locator('[data-testid="doc-actions"]:visible').click()
    await page.locator('[data-testid="action-rich-view"]:visible').click()
  }
  await expect(pane).toHaveAttribute('data-mode', want)
}

/** A seed-literal for a persisted doc tab in `proj-alpha` (for fabricating ProjectState). */
export function docTab(
  id: string,
  name: string,
  mode: 'raw' | 'rendered' | 'live' = 'rendered'
): Record<string, unknown> {
  return {
    id,
    projectId: 'proj-alpha',
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode,
    dirty: false
  }
}
