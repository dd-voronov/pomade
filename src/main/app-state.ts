// Pomade — the app's machine-local state folder, `<userData>/app-state/<id>/` (PLATFORM "Locations"):
// Pomade creates it and names it to the app's backend and commands as `POMADE_APP_STATE`
// (docs/HOST-API.md §2). E-027 app state lives in it: the key/value store behind `state.get` /
// `state.set` (docs/HOST-API.md §4 `state`). One JSON object per app at
// `<userData>/app-state/<id>/state.json`, shared by every frame of the app (tab, panel, overlay).
// Writes are atomic (tmp + rename) and serialized per app; a `set` resolves only once its write
// is on disk. The file is read once per app run and then served from memory — Pomade is its only
// writer. An unreadable or malformed file is an error, never silently replaced.

import { promises as fs, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'
import type { JsonValue } from 'pomade-kit/protocol'

import { writeJsonAtomic } from './atomic-write'

/** `<userData>/<APP_STATE_DIR>/<id>/` — PLATFORM "Locations": machine-local app state. */
export const APP_STATE_DIR = 'app-state'
const STATE_FILE = 'state.json'

/** The app's machine-local state folder: `<userData>/app-state/<id>`. */
export function appStateFolder(userData: string, appId: string): string {
  return join(userData, APP_STATE_DIR, appId)
}

/** The app's state folder, created when missing — what `POMADE_APP_STATE` names. */
export function ensureAppStateFolder(userData: string, appId: string): string {
  const folder = appStateFolder(userData, appId)
  mkdirSync(folder, { recursive: true })
  return folder
}

interface AppStore {
  /** Loaded values (key → value); null until the first read succeeds. */
  values: Map<string, JsonValue> | null
  /** The tail of this app's read/write queue. */
  queue: Promise<unknown>
}

const stores = new Map<string, AppStore>()

function statePath(appId: string): string {
  return join(appStateFolder(app.getPath('userData'), appId), STATE_FILE)
}

function storeOf(appId: string): AppStore {
  let s = stores.get(appId)
  if (!s) {
    s = { values: null, queue: Promise.resolve() }
    stores.set(appId, s)
  }
  return s
}

/** Run `fn` after everything queued for this app; the queue survives a failed step. */
function enqueue<T>(s: AppStore, fn: () => Promise<T>): Promise<T> {
  const run = s.queue.then(fn, fn)
  s.queue = run.catch(() => undefined)
  return run
}

async function load(appId: string, s: AppStore): Promise<Map<string, JsonValue>> {
  if (s.values) return s.values
  let text: string
  try {
    text = await fs.readFile(statePath(appId), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      s.values = new Map()
      return s.values
    }
    throw err
  }
  const raw = JSON.parse(text) as unknown
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${statePath(appId)} is not a JSON object`)
  }
  s.values = new Map(Object.entries(raw as Record<string, JsonValue>))
  return s.values
}

/** The value stored under `key`, or null. */
export function getAppState(appId: string, key: string): Promise<JsonValue | null> {
  const s = storeOf(appId)
  return enqueue(s, async () => (await load(appId, s)).get(key) ?? null)
}

/** Store `value` under `key` (null removes it); resolves once the file is written. */
export function setAppState(appId: string, key: string, value: JsonValue): Promise<void> {
  const s = storeOf(appId)
  return enqueue(s, async () => {
    const next = new Map(await load(appId, s))
    if (value === null) next.delete(key)
    else next.set(key, value)
    const target = statePath(appId)
    await fs.mkdir(join(target, '..'), { recursive: true })
    await writeJsonAtomic(target, Object.fromEntries(next))
    s.values = next
  })
}
