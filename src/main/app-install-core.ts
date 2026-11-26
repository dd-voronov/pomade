// Pomade — installing a hosted app's build (docs/HOST-API.md §2 "Installed apps"). Shared by the
// main process (bundled apps, `bundled-apps.ts`) and `bin/pomade` (src/cli), which runs this file
// under Node's type stripping: erasable TypeScript, node: built-ins only, no Electron, no relative
// imports.
//
// Layout: every install is a fresh build folder `<userData>/apps/.builds/<id>-<stamp>/`, and
// `<userData>/apps/<id>` is a symlink to the current one, swapped atomically. A process started
// from a build — an app's keeper, a backend left running by an update — resolves its files (node-pty
// and its `spawn-helper` among them) inside that build folder, so an update never pulls them from
// under it. A build that is no longer current is a retired build: it is deleted once no process has
// a file, a mapped library or its working directory in it (`collectRetiredBuilds`).
//
// Removals: `pomade apps remove` records the removed version in `<userData>/app-removals.json`, so
// a bundled app the user removed is not put back by the Pomade release that carries the same build
// (`bundled-apps-core.ts`). Installing the app again by hand clears the record.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs, type Stats } from 'node:fs'
import { join } from 'node:path'

/** Installed apps live in `<userData>/<APPS>/<id>`. */
const APPS = 'apps'
/** The build folders, inside the apps folder (a dot-name: discovery skips it). */
export const BUILDS_DIR = '.builds'
/** A staging folder younger than this may belong to an install under way: never collected. */
const STAGING_GRACE_MS = 10 * 60 * 1000
/** Removed apps and the version each had: `{ "<id>": "<version>" }`. */
export const APP_REMOVALS_FILE = 'app-removals.json'

function appsDir(userData: string): string {
  return join(userData, APPS)
}

function stamp(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path)
  } catch {
    return null
  }
}

/** The installed app ids: the entries of the apps folder that are (or point to) a folder. */
export async function installedIds(userData: string): Promise<string[]> {
  let names: string[]
  try {
    names = (await fs.readdir(appsDir(userData))).filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    try {
      if ((await fs.stat(join(appsDir(userData), name))).isDirectory()) out.push(name)
    } catch {
      /* a dangling link */
    }
  }
  return out.sort()
}

/** Install `folder` (a validated build of app `id`) as the current build. `replaced`: an earlier
 *  install was there. The earlier build stays on disk as a retired build. */
export async function installBuild(userData: string, id: string, folder: string): Promise<{ replaced: boolean; dest: string }> {
  const apps = appsDir(userData)
  const builds = join(apps, BUILDS_DIR)
  await fs.mkdir(builds, { recursive: true })
  const name = `${id}-${stamp()}`
  const staging = join(builds, `.staging-${name}`)
  await fs.cp(folder, staging, { recursive: true, dereference: true })
  await fs.rename(staging, join(builds, name))
  const dest = join(apps, id)
  const before = await lstatOrNull(dest)
  // An install from before this layout is a real folder: it becomes a retired build first.
  if (before && !before.isSymbolicLink()) await fs.rename(dest, join(builds, `${id}-${stamp()}`))
  const link = join(apps, `.link-${name}`)
  await fs.symlink(join(BUILDS_DIR, name), link)
  await fs.rename(link, dest)
  return { replaced: before !== null, dest }
}

/** Remove the installed app `id`; false when it is not installed. Its build becomes retired. */
export async function removeInstalled(userData: string, id: string): Promise<boolean> {
  const dest = join(appsDir(userData), id)
  const st = await lstatOrNull(dest)
  if (!st) return false
  if (st.isSymbolicLink()) await fs.unlink(dest)
  else if (st.isDirectory()) {
    await fs.mkdir(join(appsDir(userData), BUILDS_DIR), { recursive: true })
    await fs.rename(dest, join(appsDir(userData), BUILDS_DIR, `${id}-${stamp()}`))
  } else return false
  return true
}

/** Every path some process has open — files, mapped libraries, working directories (`lsof`). */
function openPaths(): Promise<string[]> {
  return new Promise((done) => {
    execFile('/usr/sbin/lsof', ['-n', '-P', '-w', '-F', 'n'], { maxBuffer: 256 * 1024 * 1024 }, (_err, stdout) => {
      // lsof exits 1 when some process could not be read; what it printed still holds.
      done(String(stdout ?? '').split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1)))
    })
  })
}

/** Delete the retired builds no process uses; returns the names deleted. `inUse` lists the open
 *  paths (default: `lsof`); when it cannot be read nothing is deleted. */
export async function collectRetiredBuilds(userData: string, inUse: () => Promise<string[]> = openPaths): Promise<string[]> {
  const apps = appsDir(userData)
  const builds = join(apps, BUILDS_DIR)
  let names: string[]
  try {
    names = await fs.readdir(builds)
  } catch {
    return []
  }
  const current = new Set<string>()
  for (const id of await fs.readdir(apps).catch(() => [] as string[])) {
    if (id.startsWith('.')) continue
    try {
      current.add((await fs.readlink(join(apps, id))).split('/').pop() ?? '')
    } catch {
      /* not a link */
    }
  }
  // Leftovers of an install that never finished are retired too, once surely abandoned.
  const retired: string[] = []
  for (const n of names) {
    if (current.has(n)) continue
    if (n.startsWith('.staging-')) {
      const st = await lstatOrNull(join(builds, n))
      if (!st || Date.now() - st.mtimeMs < STAGING_GRACE_MS) continue
    }
    retired.push(n)
  }
  if (retired.length === 0) return []
  const real = await fs.realpath(builds)
  const used = new Set<string>()
  for (const p of await inUse()) {
    for (const root of [real, builds]) {
      if (p.startsWith(`${root}/`)) used.add(p.slice(root.length + 1).split('/')[0])
    }
  }
  const deleted: string[] = []
  for (const name of retired) {
    if (used.has(name)) continue
    await fs.rm(join(builds, name), { recursive: true, force: true })
    deleted.push(name)
  }
  return deleted
}

// ─── Removals ────────────────────────────────────────────────────────────────

export async function readRemovals(userData: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await fs.readFile(join(userData, APP_REMOVALS_FILE), 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    return {}
  }
}

async function writeRemovals(userData: string, removals: Record<string, string>): Promise<void> {
  await fs.mkdir(userData, { recursive: true })
  const file = join(userData, APP_REMOVALS_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(removals, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

/** Record that the user removed `id` at `version`. */
export async function recordRemoval(userData: string, id: string, version: string): Promise<void> {
  await writeRemovals(userData, { ...(await readRemovals(userData)), [id]: version })
}

/** Forget a removal (the app was installed again). */
export async function clearRemoval(userData: string, id: string): Promise<void> {
  const removals = await readRemovals(userData)
  if (!(id in removals)) return
  delete removals[id]
  await writeRemovals(userData, removals)
}
