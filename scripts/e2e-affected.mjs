#!/usr/bin/env node
// Affected-scope e2e runner (T-079). A CONVENIENCE tier below the full gate: it maps the files you
// touched to product modules, then runs only the spec subset whose declared modules intersect —
// plus an always-on smoke core. It is NOT a merge/push/session-end gate; those stay FULL (npm run
// e2e). When a touched file is dangerous to reason about narrowly (a core/shell file, an unmapped
// file, or test-infra itself) the runner FAILS SAFE and runs the whole suite.
//
// Usage:
//   npm run e2e:affected                 # changed vs origin/main (+ working tree), build, run subset
//   npm run e2e:affected -- --base <ref> # change the diff base
//   npm run e2e:affected -- --dry-run    # print the plan (touched modules, selected specs) and stop
//
// Spec selection uses the `// modules: <m1>, <m2>` header every e2e/*.spec.ts carries (enforced at
// config-eval time in playwright.config.ts). Partition semantics are preserved: selected light
// specs run @4 workers, selected heavy specs @1 worker, dev-react specs (after their own rebuild)
// @1 worker — exactly the projects/worker counts `npm run e2e` uses.

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const E2E_DIR = join(ROOT, 'e2e')

// Always-on smoke core: the app-boot spec runs on every affected invocation, including no-op runs.
const SMOKE_SPEC = 'smoke.spec.ts'

// ── Source → module map ──────────────────────────────────────────────────────────────────────
// Mirrors the Modules table's "Where in code" column (docs/modules/index.md). Ordered; first match wins.
// A `dir` prefix matches any file under it; a `file` matches that exact path. Anything a touched
// file resolves to that is NOT in this map — or resolves to `core` — triggers a FULL run (fail-safe
// below): core = the app shell/persistence/IPC/shared-types/layout/generic-stores blast radius, too
// broad to scope narrowly, so it is deliberately absent here and handled as escalation.
const SOURCE_MAP = [
  { dir: 'src/renderer/modules/projects-panel/', module: 'projects' },
  { file: 'src/renderer/stores/workspace-store.ts', module: 'projects' },
  { dir: 'src/renderer/modules/filetree/', module: 'filetree' },
  { dir: 'src/renderer/layout/TabStrip', module: 'tabs' }, // TabStrip.tsx + TabStrip.module.css
  { dir: 'src/renderer/layout/PaneHost', module: 'tabs' }, // PaneHost.tsx + PaneHost.module.css
  { file: 'src/renderer/stores/tabs-store.ts', module: 'tabs' },
  { dir: 'src/renderer/modules/editor/', module: 'editor' },
  { dir: 'src/renderer/modules/terminal/', module: 'terminal' },
  { file: 'src/main/pty-manager.ts', module: 'terminal' },
  { file: 'src/main/agent-service.ts', module: 'agents' },
  { file: 'src/main/session-watcher.ts', module: 'agents' },
  { file: 'src/main/git-service.ts', module: 'git' },
  { file: 'src/main/git-state.ts', module: 'git' },
  { dir: 'src/renderer/modules/git/', module: 'git' }
]

// ── Test-infra / build-config files ⇒ FULL run ───────────────────────────────────────────────
// A change here can alter how EVERY spec builds or runs, so no module subset is trustworthy.
function isTestInfra(f) {
  return (
    f === 'playwright.config.ts' ||
    f.startsWith('e2e/fixtures/') ||
    f === 'package.json' ||
    f === 'package-lock.json' ||
    /^electron\.vite[^/]*\.ts$/.test(f) ||
    /^tsconfig[^/]*\.json$/.test(f) ||
    f.startsWith('scripts/')
  )
}

// ── Changed-file computation ─────────────────────────────────────────────────────────────────
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}
function gitLines(args) {
  try {
    return git(args).split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}
function refExists(ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: ROOT })
  return r.status === 0
}
function changedFiles(base) {
  const set = new Set()
  if (refExists(base)) {
    // Committed diff since the merge-base with `base` (three-dot).
    for (const f of gitLines(['diff', '--name-only', `${base}...HEAD`])) set.add(f)
  } else {
    console.warn(`  (base ref "${base}" not found — skipping committed-diff comparison)`)
  }
  for (const f of gitLines(['diff', '--name-only', '--cached'])) set.add(f) // staged
  for (const f of gitLines(['diff', '--name-only'])) set.add(f) // unstaged
  for (const f of gitLines(['ls-files', '--others', '--exclude-standard'])) set.add(f) // untracked
  return [...set]
}

// ── Spec header parsing ──────────────────────────────────────────────────────────────────────
function specModules(specFile) {
  const src = readFileSync(join(E2E_DIR, specFile), 'utf8')
  const m = src.match(/^\s*\/\/\s*modules:\s*(.+)$/m)
  if (!m) return null
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── Partition classification (single source of truth: playwright.config.ts) ──────────────────
// Parse the two name arrays out of the config text so the runner never drifts from the gate's
// partition. If parsing fails we fail safe (treat everything as light would mis-route heavy specs
// to 4 workers), so a parse failure aborts instead.
function parseNameArray(src, varName) {
  const m = src.match(new RegExp(`const ${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`))
  if (!m) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
const configSrc = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8')
const HEAVY_NAMES = parseNameArray(configSrc, 'HEAVY_ZSH_NAMES')
const DEV_REACT_NAMES = parseNameArray(configSrc, 'DEV_REACT_NAMES')
if (!HEAVY_NAMES || !DEV_REACT_NAMES) {
  console.error('e2e:affected — could not parse HEAVY_ZSH_NAMES / DEV_REACT_NAMES from playwright.config.ts')
  process.exit(1)
}
function partitionOf(specFile) {
  const name = specFile.replace(/\.spec\.ts$/, '')
  if (DEV_REACT_NAMES.includes(name)) return 'dev-react'
  if (HEAVY_NAMES.includes(name)) return 'heavy'
  return 'light'
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  let base = 'origin/main'
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') base = argv[++i]
    else if (argv[i].startsWith('--base=')) base = argv[i].slice('--base='.length)
    else if (argv[i] === '--dry-run') dryRun = true
  }
  return { base, dryRun }
}

// Set once the dev-React build starts: it overwrites out/, so every exit from then on restores the
// standard build first.
let devReactBuilt = false

function run(cmd, args, label) {
  console.log(`\n\x1b[1m▶ ${label}\x1b[0m`)
  console.log(`  ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (r.status !== 0) {
    console.error(`\n✖ step failed (${label}) — exit ${r.status}`)
    if (devReactBuilt) restoreStandardBuild()
    process.exit(r.status || 1)
  }
}

function restoreStandardBuild() {
  devReactBuilt = false
  run('npx', ['electron-vite', 'build'], 'rebuild (prod bundle, restored after dev-React)')
}

function main() {
  const { base, dryRun } = parseArgs(process.argv.slice(2))
  const allSpecs = readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.ts'))

  console.log('\x1b[1m── e2e:affected ──\x1b[0m')
  console.log(`  diff base: ${base}`)
  const changed = changedFiles(base)
  console.log(`  changed files: ${changed.length}`)

  // Classify changed files → touched modules, full-run escalation, self-selected specs.
  const touchedModules = new Set()
  const selfSpecs = new Set()
  const fullReasons = []
  for (const f of changed) {
    if (isTestInfra(f)) {
      fullReasons.push(`test-infra touched: ${f}`)
      continue
    }
    if (f.startsWith('e2e/') && f.endsWith('.spec.ts')) {
      selfSpecs.add(f.slice('e2e/'.length)) // a touched spec selects itself
      continue
    }
    if (f.startsWith('e2e/')) {
      // other e2e/ files (non-spec, non-fixture) — treat as infra, fail safe
      fullReasons.push(`test-infra touched: ${f}`)
      continue
    }
    if (!f.startsWith('src/')) {
      // docs, config at root, etc. — not product code; ignore unless it also matched infra above.
      // (docs/** and README changes do not affect any spec.)
      if (f.startsWith('docs/') || f === 'README.md' || f === 'LICENSE' || f === '.gitignore') continue
      fullReasons.push(`unmapped file (unknown blast radius): ${f}`)
      continue
    }
    const hit = SOURCE_MAP.find((r) => (r.dir ? f.startsWith(r.dir) : f === r.file))
    if (hit) {
      touchedModules.add(hit.module)
    } else {
      // src/** file with no rule ⇒ core / unknown ⇒ FULL (fail-safe).
      fullReasons.push(`core/unmapped source touched: ${f}`)
    }
  }

  const goFull = fullReasons.length > 0

  // Build the selected spec set.
  let selected
  if (goFull) {
    selected = new Set(allSpecs)
  } else {
    selected = new Set()
    for (const spec of allSpecs) {
      const mods = specModules(spec)
      if (!mods) continue // enforcement guarantees this won't happen; be defensive.
      if (mods.some((m) => touchedModules.has(m))) selected.add(spec)
    }
    for (const s of selfSpecs) selected.add(s)
    selected.add(SMOKE_SPEC) // always-on smoke core
  }

  // ── Plan ────────────────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m── plan ──\x1b[0m')
  if (goFull) {
    console.log('  \x1b[33mESCALATED → FULL SUITE\x1b[0m')
    for (const r of fullReasons) console.log(`    • ${r}`)
    console.log(`  running all ${selected.size} of ${allSpecs.length} specs`)
  } else {
    console.log(`  touched modules: ${touchedModules.size ? [...touchedModules].sort().join(', ') : '(none)'}`)
    if (selfSpecs.size) console.log(`  touched spec files (self-selected): ${[...selfSpecs].sort().join(', ')}`)
    console.log(`  selected ${selected.size} of ${allSpecs.length} specs (+ always-on ${SMOKE_SPEC})`)
  }

  // Route selected specs into their partitions.
  const byProject = { light: [], heavy: [], 'dev-react': [] }
  for (const spec of selected) byProject[partitionOf(spec)].push(`e2e/${spec}`)
  for (const p of Object.keys(byProject)) byProject[p].sort()
  console.log(
    `  by project → light: ${byProject.light.length}, heavy: ${byProject.heavy.length}, dev-react: ${byProject['dev-react'].length}`
  )

  if (dryRun) {
    console.log('\n  (--dry-run: plan only, no build/run)')
    return
  }

  // ── Run ─────────────────────────────────────────────────────────────────────────────────
  // Build the prod bundle once (light + heavy run against it).
  run('npx', ['electron-vite', 'build'], 'build (prod bundle)')

  if (byProject.light.length > 0) {
    run('npx', ['playwright', 'test', '--project=light', '--workers=4', ...byProject.light], 'light @4 workers')
  }
  if (byProject.heavy.length > 0) {
    run('npx', ['playwright', 'test', '--project=heavy', '--workers=1', ...byProject.heavy], 'heavy @1 worker')
  }
  if (byProject['dev-react'].length > 0) {
    // dev-react runs LAST: its rebuild overwrites out/ with the dev bundle, so prod passes never see
    // it; the prod bundle is rebuilt afterwards, pass or fail.
    devReactBuilt = true
    run('npx', ['electron-vite', 'build', '-c', 'electron.vite.dev-react.config.ts'], 'build (dev-React bundle)')
    run('npx', ['playwright', 'test', '--project=dev-react', '--workers=1', ...byProject['dev-react']], 'dev-react @1 worker')
    restoreStandardBuild()
  }

  console.log('\n\x1b[32m✔ e2e:affected passed\x1b[0m')
}

main()
