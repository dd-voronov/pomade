// Pomade — E-032: the closed-Pomade notice queue's folder logic, Electron-free. A poster
// (`pomade-kit/node`'s `postNotice`: backends and commands) writes `<name>.json` atomically — a
// dot-file renamed into place — into `<userData>/notices/queue/`; Pomade drains it: each `*.json`
// in name (= time) order is read, checked (`parseQueuedNotice`) and deleted. A file that is not a
// valid notice is renamed to `<name>.invalid` so it is never read again, and kept for inspection.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { parseQueuedNotice, type QueuedNotice } from 'pomade-kit/protocol'

/** The queue files to read now, in posting order: `*.json`, never a dot-file (a write in progress). */
export function queueFiles(names: readonly string[]): string[] {
  return names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()
}

/** Drain `dir` once: the valid notices in posting order; their files are gone, invalid ones set
 *  aside. A missing folder is an empty queue. */
export async function drainQueueDir(dir: string, warn: (message: string) => void = () => {}): Promise<QueuedNotice[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: QueuedNotice[] = []
  for (const name of queueFiles(names)) {
    const path = join(dir, name)
    let parsed: ReturnType<typeof parseQueuedNotice>
    try {
      parsed = parseQueuedNotice(JSON.parse(await fs.readFile(path, 'utf8')))
    } catch (err) {
      // Vanished meanwhile (another drain took it), or not JSON.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      parsed = { ok: false, message: (err as Error).message }
    }
    if (parsed.ok) {
      await fs.rm(path, { force: true })
      out.push(parsed.notice)
    } else {
      warn(`notice queue: ${name} is not a valid notice (${parsed.message}); kept as ${name}.invalid`)
      await fs.rename(path, `${path}.invalid`).catch(() => {})
    }
  }
  return out
}
