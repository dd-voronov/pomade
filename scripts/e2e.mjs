#!/usr/bin/env node
// Full e2e run (`npm run e2e`): one standard build, the light and heavy passes, then the dev-React
// rebuild and the dev-react pass. The dev-React bundle overwrites out/, so the standard build is
// restored once the dev-React build has started — pass or fail — and out/ is always the standard
// build when this script exits. The run stops at the first failing step; the exit code is that
// step's, never the restore's.
//
// `--dry-run` prints the steps without running them.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEV_REACT_CONFIG = 'electron.vite.dev-react.config.ts'

const BUILD = ['electron-vite', 'build']
const PASSES = [
  ['playwright', 'test', '--project=light', '--workers=4'],
  ['playwright', 'test', '--project=heavy', '--workers=1'],
  ['electron-vite', 'build', '-c', DEV_REACT_CONFIG],
  ['playwright', 'test', '--project=dev-react', '--workers=1']
]

const dryRun = process.argv.includes('--dry-run')

function run(args) {
  console.log(`\n> npx ${args.join(' ')}`)
  if (dryRun) return 0
  return spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit' }).status ?? 1
}

let code = run(BUILD)
let devReactBuilt = false
for (const args of PASSES) {
  if (code !== 0) break
  if (args.includes(DEV_REACT_CONFIG)) devReactBuilt = true
  code = run(args)
}
if (devReactBuilt) {
  const restore = run(BUILD)
  if (code === 0) code = restore
}
process.exit(code)
