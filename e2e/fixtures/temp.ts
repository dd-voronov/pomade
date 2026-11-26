// Pomade e2e — throwaway folders (CONVENTIONS "Tests": every temp folder a test creates is removed
// in teardown, on failure too). Every folder a spec or fixture makes comes from `tempDir`, which
// records it; when the worker process exits, every recorded folder still there is removed — so a
// failed `beforeAll`, a test that times out before its `afterAll` cleanup, or a forgotten cleanup
// leaves nothing behind. Specs still remove their own folders in teardown; this is the backstop.
// The suite-wide check that nothing was left is `leftovers.ts` (Playwright's global setup).

import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made = new Set<string>()

/** A fresh folder `<parent>/<prefix>XXXXXX` (parent: the OS temp dir), removed at the latest when
 *  this worker exits. */
export async function tempDir(prefix: string, parent: string = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(parent, prefix))
  made.add(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // A folder that cannot go now is reported by the suite's leftovers check.
    }
  }
})
