// Pomade e2e — the shared app-launch harness (T-161).
//
// Every spec drives the BUILT Electron app, and every launch needs the same three-var
// environment plumbed in: POMADE_WORKSPACE (skips the picker, points the app at the fixture
// tree), POMADE_USER_DATA (isolates each instance's userData), and NODE_ENV=test. Before this
// module that plumbing was re-declared in ~40 spec files, and its `env` shape had drifted; a
// launch-contract change (e.g. the T-108 ELECTRON_RENDERER_URL scrub) then had to touch every
// copy. `launchApp` is now the ONE place the env is built — playwright.config.ts additionally
// spreads the tuned POMADE_TEST_* intervals into process.env, which `...process.env` below
// carries into each app (see e2e/fixtures/timing.ts).
//
// A spec that must run one app at PRODUCTION timing opts out per launch by passing the interval
// var empty, e.g. `launchApp(fixture, { POMADE_TEST_POLL_MS: '' })`; extra vars a spec needs
// (CLAUDE_CONFIG_DIR, FAKE_AGENT_STORE, POMADE_TEST_QUIT_CONFIRM, …) go in the same `env` arg.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The built main entry the specs launch (electron-vite build output). */
const MAIN = resolve(__dirname, '../../out/main/index.js')

/** The minimum a launch needs: which workspace tree and which userData dir. `Fixture` (and
 *  scope-header's HomeFixture) satisfy this structurally, so most call sites pass the fixture. */
export interface LaunchTarget {
  workspaceRoot: string
  userDataDir: string
}

/** THE env builder + launch. `env` merges over the three base vars, so a caller can add vars or
 *  override a tuned interval (pass '' to unset one). Returns the app only — pair with
 *  `firstWindow()` yourself, or use `launchAppPage` for the common window bootstrap. */
export function launchApp(
  target: LaunchTarget,
  env: Record<string, string> = {}
): Promise<ElectronApplication> {
  const fullEnv = {
    ...process.env,
    POMADE_WORKSPACE: target.workspaceRoot,
    POMADE_USER_DATA: target.userDataDir,
    NODE_ENV: 'test',
    ...env
  }
  assertNotRealHome(env.POMADE_HOME ?? process.env.POMADE_HOME)
  return electron.launch({ args: [MAIN], env: fullEnv })
}

/** An app under test must never get the Owner's real Pomade home (`~/.pomade`, `~/.pomade-dev`):
 *  it would rewrite their host record, workspace pointer and command folder. playwright.config.ts
 *  scrubs inherited host vars; this catches one passed in explicitly. */
function assertNotRealHome(home: string | undefined): void {
  if (!home) return
  const real = [join(homedir(), '.pomade'), join(homedir(), '.pomade-dev')]
  if (real.includes(resolve(home))) {
    throw new Error(`launchApp: POMADE_HOME=${home} is the real Pomade home — use a temp folder`)
  }
}

/** `app.firstWindow()` hardened for the app's real renderer document. A BrowserWindow's first
 *  document is the intrinsic empty `about:blank`; the app then `loadFile`s `index.html`. Under
 *  Electron 44 (newer Chromium) `firstWindow()` resolves on that empty document — so a bare
 *  `waitForLoadState('domcontentloaded')` returns on `about:blank`, and the very next
 *  `page.evaluate` (e.g. a hydration poll) races the navigation to `index.html` and dies with
 *  "Execution context was destroyed, most likely because of a navigation". Waiting for the
 *  index.html URL first pins us to the real document (no-op when it's already there, so this is
 *  safe for the fast case too). Locator-based waits self-recover across the navigation and never
 *  needed this; page.evaluate-first specs do. Use this instead of a raw `firstWindow()`. */
export async function firstAppWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForURL('**/index.html')
  await page.waitForLoadState('domcontentloaded')
  return page
}

/** `launchApp` + open the first window at the real renderer document (see `firstAppWindow`).
 *  Specs add their own readiness waits (app-shell visible, store hydration, a project click). */
export async function launchAppPage(
  target: LaunchTarget,
  env: Record<string, string> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(target, env)
  const page = await firstAppWindow(app)
  return { app, page }
}

/** Close `app`, then launch a fresh instance against the same target (a quit→relaunch round
 *  trip). Returns the new app + its first window at `domcontentloaded`. */
export async function relaunchApp(
  app: ElectronApplication,
  target: LaunchTarget,
  env: Record<string, string> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close()
  return launchAppPage(target, env)
}
