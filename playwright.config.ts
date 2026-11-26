import { defineConfig } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { TEST_TUNING_ENV } from './e2e/fixtures/timing'

// T-108 — a live `electron-vite dev` server leaks ELECTRON_RENDERER_URL into shells; the specs
// spread `...process.env` into the Electron launch, so with the var present the app under test
// silently loads the Owner's LIVE dev renderer (main checkout src) instead of the built out/renderer
// — every result is then about the wrong code. This config file is evaluated in the runner AND in
// every worker process, so deleting it here scrubs all spec launches without touching each file.
delete process.env.ELECTRON_RENDERER_URL

// A run started from a Pomade terminal (an agent session inside Pomade) inherits that Pomade's
// host vars — POMADE_HOME=~/.pomade, POMADE_WORKSPACE, POMADE_TAB_ID, … Spread into every app
// under test, they make each test instance write the Owner's REAL ~/.pomade (host.json, the
// workspace pointer, the command folder). Scrubbed here like the var above, so no launch or CLI
// spawn sees them; a spec that needs one passes it explicitly. POMADE_TEST_* tuning vars from
// the invoking shell are kept on purpose (see the loop below).
for (const key of Object.keys(process.env)) {
  if (key.startsWith('POMADE_') && !key.startsWith('POMADE_TEST_')) delete process.env[key]
}

// T-177 — export the tuned poll/debounce intervals into every worker's process.env, which every
// spec's `electron.launch` spreads into the app under test. Same mechanism as the scrub above:
// one place, all launches. A spec that needs one app at production timing opts out per launch by
// setting the var to '' (see e2e/fixtures/timing.ts); a var already set in the invoking shell
// (e.g. '' to debug a whole run at production timing) wins over the suite default.
for (const [key, value] of Object.entries(TEST_TUNING_ENV)) {
  if (process.env[key] === undefined) process.env[key] = value
}

// T-146 — reduced-concurrency pass for the heavy real-zsh terminal specs.
//
// Every spec below opens at least one REAL interactive login zsh (a terminal pane via
// `tab-add-terminal` / `useTerminalsStore.newTerminal`, or an agent tab running a `#!/bin/zsh`
// stand-in). Each such pane is Electron + a live PTY + shell. Under the default 4-worker,
// worker===file scheme (T-037 below) up to four of these files run at once, spawning several
// Electron+zsh stacks concurrently; on a loaded machine that saturates CPU/memory and terminal
// REVIVE (app relaunch + zsh) never completes — the terminal-scrollback "restore divider" runs 2/3
// then fail. OS limits are fine (ulimit -n 1048576, -u 2666); it is contention, not an fd/proc cap,
// which is why inflating the revive poll caps (20s→60s) did not help. Fix is scheduling, not
// timeouts or weakened assertions: route these files to their own project run at fewer workers.
//
// `npm run e2e` runs TWO passes off ONE build: the `light` project (everything else) at 4 workers,
// then the `heavy` project (this list) at 1 worker. The two projects partition the suite exactly
// — light IGNORES this list, heavy MATCHES it — so every spec runs once, no gaps, no dupes.
// Worker count is set per pass on the CLI (`--workers`), overriding the config default below.
// 1 worker (not 2): with fullyParallel:false a worker === a spec file, so `--workers=1` runs the
// heavy files strictly one at a time — zero concurrent Electron+zsh stacks, the minimum self-load
// this suite can impose. Light stays at 4, so the suite is not globally slowed (that would trip the
// P-023 cadence note); only these zsh-bound files serialize.
//
// The heavy list is kept MINIMAL (T-162): a file belongs here only while some describe in it
// spawns; a self-contained describe that never touches a terminal lives in a light sibling file
// instead (e.g. tabs.spec.ts (heavy) / tabs-rename-collision.spec.ts (light)), so doc-only work
// is not serialized behind the zsh describes. When splitting, move only WHOLE describes that own
// their fixture/app and share no state with the rest of the file — tests within a file chain in
// order, so never reorder or insert mid-chain.
//
// CAVEAT (T-146): serializing removes THIS suite's self-contention but not WHOLE-MACHINE load. The
// terminal-scrollback revive specs (run 2/3) are timing-fragile and, on a loaded machine, fail
// even in isolation — a slow revive (>20s `waitRevived`) or a pre-type/keystroke race in the fresh
// shell. Measured on an 11-core Mac: isolated they PASS in ~8s at load ≲2.8 but FAIL in ~25s at
// load ≳2.9. So two green full runs need EITHER a quiet machine OR a fix to the specs' revive/
// pre-type timing (out of scope here — must not weaken those assertions). This split is the right
// scheduling hygiene and lowers failure probability; it is not on its own a determinism guarantee.
const HEAVY_ZSH_NAMES = [
  'agent-history',
  'app-always-on',
  'app-bundled',
  'app-backend-tooltip',
  'app-backends',
  'app-broker',
  'app-commands',
  'app-socket',
  'app-open-terminal',
  'app-agent-tab-exited',
  'app-agent-tabs',
  'attached-terminals',
  'attention',
  'attention-active-interaction',
  'attention-dedupe-counter',
  'attention-derived-counter',
  'bulk-close-confirm',
  'close-focus',
  'editor-context-find',
  'font-settings',
  'git-branch-session',
  'git-branches-agent',
  'layout',
  'menu-clamp',
  'move-dedupe',
  'outside-unsupported-in-tab',
  'project-teardown',
  'quit-confirm',
  'reopen-closed-tab',
  'revive',
  'session-bind-no-pane',
  'session-capture',
  'session-unbound-ui',
  'shell-history',
  'smoke',
  'tab-cross-project',
  'tab-cross-project-v2',
  'tab-details',
  'tab-drag-to-projects-panel',
  'tab-hotkeys',
  'tab-title-tooltip',
  'tabs',
  'tabstrip-render-scope',
  'terminal-copy',
  'terminal-first-click',
  'terminal-last-exec',
  'terminal-link-case-insensitive',
  'terminal-link-dir-suffix',
  'terminal-link-file-suffix',
  'terminal-link-folders',
  'terminal-link-hidden-pane',
  'terminal-link-jump',
  'terminal-link-line-range',
  'terminal-link-meta',
  'terminal-link-picker-line',
  'terminal-link-picker-scroll',
  'terminal-link-wrap-join',
  'terminal-link-wrap-join-r2',
  'terminal-links',
  'terminal-outside-workspace',
  'terminal-render',
  'terminal-scrollback',
  'terminal-scrollback-command',
  'terminals'
]
const HEAVY_ZSH_SPECS = HEAVY_ZSH_NAMES.map((name) => `**/${name}.spec.ts`)

// StrictMode swallow fix — specs that must run against the DEV-REACT bundle
// (`electron-vite build -c electron.vite.dev-react.config.ts`, which overwrites `out/`). Their
// regime guard asserts StrictMode double-invoke, which a PRODUCTION bundle fails by design, so
// they are partitioned out of light/heavy exactly like the heavy list. `npm run e2e` runs them
// as a third pass, after its own dev-React rebuild (the last step, so the prod passes never see
// the dev bundle) and rebuilds the standard bundle afterwards, pass or fail.
const DEV_REACT_NAMES = ['strictmode-caret-swallow']
const DEV_REACT_SPECS = DEV_REACT_NAMES.map((name) => `**/${name}.spec.ts`)

// T-162 — mechanical partition enforcement, run right here at config-eval time so EVERY
// playwright invocation (runner and workers alike) refuses to start when the partition is stale.
// Two checks:
//   1. Every listed name must exist as an e2e spec file — a stale entry (e.g. after a rename)
//      would otherwise silently match nothing. Dupes across/within lists are rejected too.
//   2. Any spec OUTSIDE heavy ∪ dev-react whose source carries a zsh-spawn marker fails the run:
//      by the heavy criterion above, a spec spawning a real interactive zsh (or the #!/bin/zsh
//      fake-agent stand-in) must not run at light's 4 workers. The scan is textual on purpose —
//      cheap, dependency-free, and biased toward false positives, which are the safe direction.
//      A spec that contains a marker string WITHOUT actually spawning (e.g. it only asserts menu
//      copy) opts out with an inline `// heavy-exempt: <reason>` comment; never weaken the
//      marker list to silence a false positive.
const ZSH_SPAWN_MARKERS =
  /tab-add-terminal|newTerminal|startAgent|seedFakeAgent|fake-agent|#!\/bin\/zsh|tab-add-agent/
const HEAVY_EXEMPT = /\/\/ heavy-exempt: \S/
{
  const e2eDir = join(__dirname, 'e2e')
  const specFiles = readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts'))
  const fileNames = new Set(specFiles.map((f) => f.replace(/\.spec\.ts$/, '')))
  const listed = [...HEAVY_ZSH_NAMES, ...DEV_REACT_NAMES]
  const stale = listed.filter((n) => !fileNames.has(n))
  const dupes = listed.filter((n, i) => listed.indexOf(n) !== i)
  if (stale.length > 0 || dupes.length > 0) {
    throw new Error(
      `e2e partition check (playwright.config.ts): ` +
        (stale.length > 0 ? `listed specs with no e2e/*.spec.ts file: ${stale.join(', ')}. ` : '') +
        (dupes.length > 0 ? `names listed twice: ${dupes.join(', ')}. ` : '') +
        `Fix HEAVY_ZSH_NAMES / DEV_REACT_NAMES to match the files on disk.`
    )
  }
  const serialized = new Set(listed)
  const violations = specFiles.filter((f) => {
    if (serialized.has(f.replace(/\.spec\.ts$/, ''))) return false
    const src = readFileSync(join(e2eDir, f), 'utf8')
    return ZSH_SPAWN_MARKERS.test(src) && !HEAVY_EXEMPT.test(src)
  })
  if (violations.length > 0) {
    throw new Error(
      `e2e partition check (playwright.config.ts): zsh-spawning spec(s) outside the heavy ` +
        `partition: ${violations.join(', ')}. A spec that opens a real terminal pane or launches ` +
        `the #!/bin/zsh fake-agent must run serialized — add its name to HEAVY_ZSH_NAMES. If the ` +
        `marker is a false positive (the spec never spawns), annotate the spec with ` +
        `"// heavy-exempt: <reason>" instead.`
    )
  }
}

// T-079 — module-header enforcement, run at config-eval time beside the partition check above so
// every playwright invocation refuses to start when a spec's module declaration is missing or
// invalid. Every e2e/*.spec.ts MUST carry a `// modules: <m1>, <m2>` header naming the product
// modules it exercises (canonical list below, from docs/modules/index.md). The affected-
// scope runner (scripts/e2e-affected.mjs) reads these headers to pick the spec subset for a touched
// module set; a missing or mistyped declaration would silently drop a spec from that subset, so it
// is a hard failure here instead.
const CANONICAL_MODULES = new Set([
  'core',
  'projects',
  'filetree',
  'tabs',
  'editor',
  'terminal',
  'agents',
  'git'
])
{
  const e2eDir = join(__dirname, 'e2e')
  const specFiles = readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts'))
  const undeclared: string[] = []
  const badModules: string[] = []
  for (const f of specFiles) {
    const src = readFileSync(join(e2eDir, f), 'utf8')
    const m = src.match(/^\s*\/\/\s*modules:\s*(.+)$/m)
    if (!m) {
      undeclared.push(f)
      continue
    }
    const mods = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const invalid = mods.filter((mod) => !CANONICAL_MODULES.has(mod))
    if (mods.length === 0) undeclared.push(f)
    if (invalid.length > 0) badModules.push(`${f} (${invalid.join(', ')})`)
  }
  if (undeclared.length > 0 || badModules.length > 0) {
    throw new Error(
      `e2e module-header check (playwright.config.ts): ` +
        (undeclared.length > 0
          ? `spec(s) missing a "// modules: <m1>, <m2>" header: ${undeclared.join(', ')}. `
          : '') +
        (badModules.length > 0
          ? `spec(s) declaring unknown module names: ${badModules.join('; ')}. ` +
            `Valid modules: ${[...CANONICAL_MODULES].join(', ')}. `
          : '') +
        `Add or fix the header at the top of each named spec.`
    )
  }
}

// Pomade e2e. Specs drive the BUILT app via Playwright's Electron support.
// `npm run e2e` builds first (electron-vite build) then runs these.
//
// T-037 — file-level parallelism. `fullyParallel: false` keeps a worker === a spec file:
// every file boots its own Electron app + throwaway fixture workspace (unique POMADE_USER_DATA
// and mkdtemp roots — see e2e/fixtures/workspace.ts), so files are independent and safe to run
// concurrently, while tests WITHIN a file still chain in order. Workers run that many Electron
// apps at once. The one machine-wide shared resource — the OS clipboard — is isolated per
// instance by a test-mode in-memory clipboard in the main process (config-store.ts).
export default defineConfig({
  testDir: './e2e',
  // Fails the run when it leaves a pomade-* folder behind.
  globalSetup: './e2e/fixtures/leftovers.ts',
  fullyParallel: false,
  workers: 4,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  },
  // T-146 — the two-pass partition (see HEAVY_ZSH_SPECS above). `npm run e2e` invokes each
  // project separately with its own `--workers`; running `playwright test` with no `--project`
  // runs every project at the single default worker count, and dev-react specs then fail against
  // the prod bundle — use the npm scripts.
  projects: [
    { name: 'light', testIgnore: [...HEAVY_ZSH_SPECS, ...DEV_REACT_SPECS] },
    { name: 'heavy', testMatch: HEAVY_ZSH_SPECS },
    // Only ever run after the dev-React rebuild (see DEV_REACT_SPECS above and the e2e script).
    { name: 'dev-react', testMatch: DEV_REACT_SPECS }
  ]
})
