// Pomade e2e — the leftovers check (Playwright global setup + teardown; CONVENTIONS "Tests"). Before
// a run it notes the `pomade-*` folders in the OS temp dir and the test folders in the home folder;
// after the run, any new one fails the run with its name, so a spec or fixture that leaves a folder
// behind is caught the run it starts. The smoke-scale workspace cache (`pomade-smoke-scale-ws-v*`)
// is meant to stay; `pomade-planner-e2e-*` belongs to pomade-planner's suite. A suite run at the
// same time from another checkout shows up here too — rerun alone before chasing one.

import { readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Folders that may appear during a run without failing it. */
const ALLOWED = [/^pomade-smoke-scale-ws-v\d+$/, /^pomade-planner-e2e-/]

/** The Owner's own `pomade*` folders in the home folder — never a test's. */
const OWNERS_HOME = new Set(['.pomade', '.pomade-dev', 'pomade-test-ws', 'pomade-test-remotes'])

function testFolders(): Set<string> {
  const list = (dir: string, keep: (name: string) => boolean): string[] => {
    try {
      return readdirSync(dir).filter(keep).map((name) => join(dir, name))
    } catch {
      return []
    }
  }
  return new Set([
    ...list(tmpdir(), (n) => n.startsWith('pomade-') && !ALLOWED.some((re) => re.test(n))),
    ...list(homedir(), (n) => /^\.?pomade-/.test(n) && !OWNERS_HOME.has(n))
  ])
}

export default function globalSetup(): () => void {
  const before = testFolders()
  return () => {
    const left = [...testFolders()].filter((dir) => !before.has(dir))
    if (left.length > 0) {
      throw new Error(
        `e2e leftovers check (e2e/fixtures/leftovers.ts): this run left ${left.length} folder(s) behind — ` +
          `make the spec or fixture that creates each remove it (tempDir in e2e/fixtures/temp.ts):\n  ${left.join('\n  ')}`
      )
    }
  }
}
