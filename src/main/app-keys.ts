// Pomade — E-028 app keys: the per-app secret a backend or command presents on the Host API socket
// (docs/HOST-API.md §3 "Socket"). One file per app, `<userData>/app-keys/<id>`, mode 0600 in a
// 0700 folder; the platform's own commands use the `pomade` key. Issued by `pomade apps install` /
// `link` and by Pomade itself for every app it hosts; `pomade apps remove` deletes it (revoking a
// running backend's next connection). Shared by the main process and `bin/pomade` (src/cli), which
// runs this file under Node's type stripping: erasable TypeScript, node: built-ins only, no
// Electron, no relative imports.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** Keys live in `<userData>/<APP_KEYS_DIR>/<id>`. */
export const APP_KEYS_DIR = 'app-keys'

export function appKeyFile(userData: string, id: string): string {
  return join(userData, APP_KEYS_DIR, id)
}

async function readKey(file: string): Promise<string | null> {
  try {
    const key = (await fs.readFile(file, 'utf8')).trim()
    return key === '' ? null : key
  } catch {
    return null
  }
}

/** The app's key, or null when none was issued. */
export function readAppKey(userData: string, id: string): Promise<string | null> {
  return readKey(appKeyFile(userData, id))
}

/** The app's key, issuing one (32 random bytes, hex) when there is none. Race-safe: two issuers
 *  at once end up with the same key (exclusive create; the loser reads the winner's). */
export async function ensureAppKey(userData: string, id: string): Promise<string> {
  const dir = join(userData, APP_KEYS_DIR)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700)
  const file = appKeyFile(userData, id)
  const existing = await readKey(file)
  if (existing !== null) return existing
  const key = randomBytes(32).toString('hex')
  try {
    await fs.writeFile(file, `${key}\n`, { flag: 'wx', mode: 0o600 })
    return key
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const winner = await readKey(file)
    if (winner !== null) return winner
    // An empty key file is no key: issue one over it.
    await fs.writeFile(file, `${key}\n`, { mode: 0o600 })
    return key
  }
}

/** Revoke the app's key. */
export async function removeAppKey(userData: string, id: string): Promise<void> {
  await fs.rm(appKeyFile(userData, id), { force: true })
}

/** Constant-time comparison of a presented key with the issued one. */
export function keysMatch(presented: string, issued: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(issued, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
