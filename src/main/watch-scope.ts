// Pomade — what a `files.watch` covers, read straight from disk (T-243). The watch's settle
// (`@shared/settle`) compares two of these readings to find changes the native watcher never
// reported: a change made before the descriptor was live, a second change FSEvents dropped.
//
// A reading maps each workspace-relative path in the watch's scope to a signature: a folder is
// only its presence (its mtime moves with every child, which the children already report), a file
// is its size + mtime. Symlinks are read, never followed. The scope honours the same names the
// watcher's events skip — the workspace's tree ignored items and the watcher's own ignore names — and
// `.pomade`, which no app sees. A reading is bounded: past SCOPE_MAX_ENTRIES it gives up (null) and
// the watch settles only the paths its events named.

import { promises as fs, type Stats } from 'node:fs'

import { isPomadeFolderPath } from 'pomade-kit/protocol'

import { WATCH_IGNORE_NAMES } from './fs-shared'

export const SCOPE_MAX_ENTRIES = 5000

export type ScopeReading = Map<string, string>

const watchIgnore = new Set(WATCH_IGNORE_NAMES)

export function signatureOf(st: Stats): string {
  if (st.isDirectory()) return 'd'
  return `${st.isSymbolicLink() ? 'l' : 'f'}:${st.size}:${st.mtimeMs}`
}

/** The signature of one path, or null when it is absent. */
export async function readSignature(absPath: string): Promise<string | null> {
  try {
    return signatureOf(await fs.lstat(absPath))
  } catch {
    return null
  }
}

function skipped(name: string, rel: string, ignore: Set<string>): boolean {
  return ignore.has(name) || watchIgnore.has(name) || isPomadeFolderPath(rel)
}

/** Read the scope of a watch on `rel` (workspace-relative; `absOf` maps it to disk): the path
 *  itself and — for a folder — its entries, all the way down when `recursive`. `ignore` is the
 *  workspace's tree ignored items. Null when the scope holds more than `max` entries. */
export async function readScope(
  rel: string,
  recursive: boolean,
  ignore: Set<string>,
  absOf: (rel: string) => string,
  max = SCOPE_MAX_ENTRIES
): Promise<ScopeReading | null> {
  const out: ScopeReading = new Map()
  const self = await readSignature(absOf(rel))
  if (self === null) return out
  out.set(rel, self)
  if (self !== 'd') return out
  const queue: string[] = [rel]
  while (queue.length > 0) {
    const dir = queue.shift() as string
    let names: string[]
    try {
      names = await fs.readdir(absOf(dir))
    } catch {
      continue // vanished mid-read — its absence is what the reading shows
    }
    for (const name of names) {
      const child = dir === '' ? name : `${dir}/${name}`
      if (skipped(name, child, ignore)) continue
      const sig = await readSignature(absOf(child))
      if (sig === null) continue
      if (out.size >= max) return null
      out.set(child, sig)
      if (recursive && sig === 'd') queue.push(child)
    }
  }
  return out
}

/** The paths whose signature differs between two readings, each marked structural when it
 *  appeared, vanished or changed kind (a content change is not structural). */
export function diffReadings(before: ScopeReading, after: ScopeReading): Map<string, boolean> {
  const changed = new Map<string, boolean>()
  for (const [path, sig] of after) {
    const old = before.get(path)
    if (old === sig) continue
    changed.set(path, old === undefined || (old === 'd') !== (sig === 'd'))
  }
  for (const path of before.keys()) if (!after.has(path)) changed.set(path, true)
  return changed
}
