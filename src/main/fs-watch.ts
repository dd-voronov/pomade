// Pomade — live filesystem watching. One native recursive fs.watch per workspace-relative root
// and per explicitly-mounted outside root. On macOS this is backed by FSEvents — a single file
// descriptor regardless of tree size, so watching a huge workspace root (many repos, node_modules,
// agent caches) cannot exhaust descriptors the way per-directory watchers do. Events are filtered
// against the ignore list, batched per root (`@shared/change-batch`: a quiet window with a maximum
// wait), and broadcast to all renderer windows as EV.fsChanged — the root plus each changed path
// and whether it exists when the batch closes, so the tree re-reads only listings that changed.
//
// E-027/E-030 — the same in-workspace entries also serve hosted apps' `files.watch`: an app watch
// HOLDS the entry that covers its path (an existing ancestor-or-self entry, else one on the path
// itself) and receives each raw event through a TAP. Apps never get a watcher of their own.
//
// E-036 — the git-state service listens through the same taps, plus a narrow second tap for git's
// own metadata (`.git/index`, `HEAD`, `refs/…`, `config`): those paths are ignored for the tree and for apps,
// but a commit, checkout or fetch changes repo state without touching a working file.

import { watch as fsWatch, statSync, promises as fsp, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'

import { createChangeBatch, type ChangeBatch } from '@shared/change-batch'
import { EV } from '@shared/ipc-api'
import type { FsChange, FsChangedEvent } from '@shared/types'

import { abs, requireAbs, WATCH_IGNORE_NAMES } from './fs-shared'
import { isSkippedRel } from './skipped-paths'
import { tunedMs } from './test-tuning'
import { safeBroadcast } from './windows'

interface WatchEntry {
  // Nullable for outside mounts: at cold start the mounted root may not exist yet, so the
  // recursive descriptor on the root itself cannot be opened until the folder appears (see
  // startWatchOutside/armOutside). In-workspace roots always exist, so `watcher` is set there.
  watcher: FSWatcher | null
  /** The changed paths (workspace-relative, or absolute for an outside mount) awaiting broadcast. */
  batch: ChangeBatch<true>
}

/** An in-workspace entry has two kinds of holders: the renderer's file tree (`fs.watch` /
 *  `fs.unwatch`, idempotent per key — the tree's own contract) and hosted-app watches (counted).
 *  The descriptor closes only when neither holds it; only a tree-held entry broadcasts
 *  EV.fsChanged. */
interface WorkspaceWatchEntry extends WatchEntry {
  treeHeld: boolean
  appHolds: number
}

const watchers = new Map<string, WorkspaceWatchEntry>()

/** A raw in-workspace change, before debouncing: the workspace-relative POSIX path of the
 *  changed entry and the native event kind. */
export interface RawWorkspaceChange {
  path: string
  event: 'rename' | 'change'
}

const taps = new Set<(change: RawWorkspaceChange) => void>()
const gitMetaTaps = new Set<(change: RawWorkspaceChange) => void>()

/** Receive every raw in-workspace change any held entry sees (ignored trees filtered). Entries
 *  can overlap, so one change may arrive more than once — subscribers dedupe. Returns untap. */
export function tapWorkspaceChanges(fn: (change: RawWorkspaceChange) => void): () => void {
  taps.add(fn)
  return () => {
    taps.delete(fn)
  }
}

/** Receive raw changes to git metadata inside any held entry: a `.git` entry itself (a repo
 *  appeared or vanished) and the files whose change moves repo state — `index`, `HEAD`,
 *  `packed-refs`, `MERGE_HEAD`, `refs/…` — or its remotes (`config`). Lock files are skipped.
 *  Returns untap. */
export function tapGitMetaChanges(fn: (change: RawWorkspaceChange) => void): () => void {
  gitMetaTaps.add(fn)
  return () => {
    gitMetaTaps.delete(fn)
  }
}

const GIT_META = /(^|\/)\.git(\/(HEAD|index|packed-refs|MERGE_HEAD|config|refs\/.+))?$/

/** Derived from `WATCH_IGNORE_NAMES` at module init (rider on T-154) so it can never drift from
 *  the ignore list by hand. Matches any path segment equal to one of those names. */
const WATCH_IGNORE = new RegExp(
  `(^|[/\\\\])(${WATCH_IGNORE_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([/\\\\]|$)`
)

// Test hook (docs/contracts/test-hooks.md): POMADE_TEST_WATCH_LOSS_MS simulates the native
// watcher's event loss that the watchers' settle (`@shared/settle`) exists for, so e2e can prove
// it deterministically — an in-workspace descriptor hears nothing for its first N ms (the stream
// is not live yet), and an event for a path that had one less than N ms before is dropped (the
// second change FSEvents coalesces or drops). Unset: no loss, and no bookkeeping.
const SIMULATED_LOSS_MS = tunedMs('POMADE_TEST_WATCH_LOSS_MS', 0)

function simulatedLoss(): ((filename: string | Buffer | null) => boolean) | null {
  if (SIMULATED_LOSS_MS <= 0) return null
  const deafUntil = Date.now() + SIMULATED_LOSS_MS
  const lastHeard = new Map<string, number>()
  return (filename) => {
    const now = Date.now()
    if (now < deafUntil) return true
    const key = String(filename)
    const last = lastHeard.get(key)
    if (last !== undefined && now - last < SIMULATED_LOSS_MS) return true
    lastHeard.set(key, now)
    return false
  }
}

/** Quiet window of a root's batch; `BATCH_MAX_WAIT_MS` bounds how long a stream defers it. */
const WATCH_QUIET_MS = 180

/** Each changed path with its existence now — what the tree compares with the listing it shows. */
async function withExistence(paths: Iterable<string>, toAbs: (path: string) => string): Promise<FsChange[]> {
  return Promise.all(
    [...paths].map(async (path) => {
      try {
        await fsp.lstat(toAbs(path))
        return { path, exists: true }
      } catch {
        return { path, exists: false }
      }
    })
  )
}

function broadcast(event: FsChangedEvent): void {
  safeBroadcast(EV.fsChanged, event)
}

/** Open the descriptor for `key` (no holder set). Null when it cannot be watched. */
function openEntry(key: string): WorkspaceWatchEntry | null {
  const absRoot = abs(key)
  const batch = createChangeBatch<true>((paths) => {
    if (paths === null) {
      if (entry.treeHeld) broadcast({ root: key, changes: null })
      return
    }
    void withExistence(paths.keys(), abs).then((changes) => {
      if (entry.treeHeld && watchers.get(key) === entry) broadcast({ root: key, changes })
    })
  }, WATCH_QUIET_MS)
  const entry: WorkspaceWatchEntry = { watcher: null, batch, treeHeld: false, appHolds: 0 }
  const lost = simulatedLoss()
  const onEvent = (event: string, filename: string | Buffer | null): void => {
    if (lost?.(filename)) return
    // Skipped paths — the local-history stores (Pomade's own data) and the unwatched folders: no
    // tap (git state, apps, local history) and no tree hears their writes, git metadata inside
    // them included. Matched by workspace-relative path, never by name, against the live list.
    if (typeof filename === 'string' && isSkippedRel(key ? `${key}/${filename.split('\\').join('/')}` : filename.split('\\').join('/'))) return
    // 'change' events are included so the editor can detect external modification of
    // an open file (Wave 3); add/unlink keep the file tree live.
    if (typeof filename === 'string' && gitMetaTaps.size > 0) {
      const rel = filename.split('\\').join('/')
      if (GIT_META.test(rel) && !rel.endsWith('.lock')) {
        const change: RawWorkspaceChange = {
          path: key ? `${key}/${rel}` : rel,
          event: event === 'change' ? 'change' : 'rename'
        }
        for (const tap of [...gitMetaTaps]) tap(change)
        return
      }
    }
    if (typeof filename === 'string' && WATCH_IGNORE.test(filename)) return
    if (typeof filename === 'string' && taps.size > 0) {
      const rel = filename.split('\\').join('/')
      const change: RawWorkspaceChange = {
        path: key ? `${key}/${rel}` : rel,
        event: event === 'change' ? 'change' : 'rename'
      }
      for (const tap of [...taps]) tap(change)
    }
    if (!entry.treeHeld) return
    if (typeof filename !== 'string') {
      batch.add(null, true)
      return
    }
    const rel = filename.split('\\').join('/')
    batch.add(key ? `${key}/${rel}` : rel, true)
  }
  try {
    entry.watcher = fsWatch(absRoot, { recursive: true, persistent: false }, onEvent)
  } catch {
    return null // watching is best-effort; the tree still refreshes on user actions
  }
  // Without an error handler a watcher failure becomes an uncaught exception that
  // can take down the main process.
  entry.watcher.on('error', () => {
    closeEntry(key)
  })
  watchers.set(key, entry)
  return entry
}

function closeEntry(key: string): void {
  const entry = watchers.get(key)
  if (!entry) return
  entry.batch.cancel()
  watchers.delete(key)
  entry.watcher?.close()
}

/** The file tree's watch (`fs.watch`): idempotent per key. */
function startWatch(rootRel: string): void {
  const key = rootRel || ''
  const entry = watchers.get(key) ?? openEntry(key)
  if (entry) entry.treeHeld = true
}

/** The file tree's unwatch (`fs.unwatch`): the descriptor survives while an app still holds it. */
async function stopWatch(rootRel: string): Promise<void> {
  const key = rootRel || ''
  const entry = watchers.get(key)
  if (!entry) return
  entry.treeHeld = false
  entry.batch.cancel()
  if (entry.appHolds === 0) closeEntry(key)
}

function covers(key: string, rel: string): boolean {
  return key === '' || rel === key || rel.startsWith(`${key}/`)
}

/** E-027/E-030 — hold an entry covering the workspace-relative folder `dirRel` for an app watch:
 *  the nearest existing ancestor-or-self entry when there is one (no new descriptor), else a new
 *  entry on `dirRel` itself. Returns the held key (pass it to `releaseAppWatch`), or null when
 *  the folder cannot be watched. */
export function holdAppWatch(dirRel: string): string | null {
  let best: string | null = null
  for (const key of watchers.keys()) {
    if (covers(key, dirRel) && (best === null || key.length > best.length)) best = key
  }
  const entry = best !== null ? watchers.get(best) : openEntry(dirRel)
  if (!entry) return null
  entry.appHolds += 1
  return best ?? dirRel
}

/** Release one app hold taken by `holdAppWatch`. */
export function releaseAppWatch(key: string): void {
  const entry = watchers.get(key)
  if (!entry) return
  entry.appHolds = Math.max(0, entry.appHolds - 1)
  if (entry.appHolds === 0 && !entry.treeHeld) closeEntry(key)
}

// ─── T-131/T-132/T-137 (E-026): outside-workspace bounded recursive watcher ────
// One native recursive fs.watch per EXPLICITLY-MOUNTED outside root — the SAME single-descriptor
// primitive the in-workspace watcher and the name index use (FSEvents on macOS: ONE descriptor
// for the whole subtree). NEVER per-directory watchers (the v1 EMFILE crash). Change events are
// broadcast on the SAME EV.fsChanged channel the in-workspace watcher uses, keyed by the ABSOLUTE
// root path: ws-relative keys never start with a separator and absolute keys always do, so the
// two key spaces never collide and the renderer treats the change signal uniformly. Watching the
// root also catches the root's OWN deletion — the change (or the watcher error on some platforms)
// makes the renderer re-read via treeOutside, which then throws, surfacing the missing-root state.
interface OutsideWatchEntry extends WatchEntry {
  // T-132 (E-026) — outside mounts only: a NON-recursive watch on the root's nearest EXISTING
  // ancestor (its immediate parent once that exists), so the root's OWN creation/deletion/rename
  // is detected live. A recursive watch on the watched dir is torn down by the OS when that dir is
  // deleted, often WITHOUT emitting an event; and it cannot be opened at all while the dir is
  // missing. The ancestor watch (one bounded descriptor, non-recursive — never a recursive
  // $HOME/ walk) closes both gaps: it catches the absent→present cold-start create AND the
  // present→absent deletion, driving the same broadcast/re-arm path in every direction.
  parent: FSWatcher | null
  // T-137 (E-026): set when a fired event may have changed WHICH descriptors are valid (the root
  // appeared or vanished), so the batch's flush re-arms after broadcasting. Plain content
  // changes leave it unset and only broadcast — never thrashing the descriptors.
  rearm: boolean
}

const outsideWatchers = new Map<string, OutsideWatchEntry>()

// Main-process diagnostics — no IPC surface, no renderer contract. Read from e2e/smoke via
// `app.evaluate(() => globalThis.__pomadeOutsideWatch)` to assert one descriptor per root
// (idempotent add) without shelling out to lsof.
const outsideWatchStats = { size: 0 }
;(globalThis as { __pomadeOutsideWatch?: { size: number } }).__pomadeOutsideWatch = outsideWatchStats

// Walk up from the root's immediate parent to the NEAREST EXISTING directory, returning it plus
// the name of the direct child of that directory that lies on the path toward the root (the entry
// whose appearance/removal we care about). At a cold start the mounted root and even some of its
// parents may not exist yet; the non-recursive ancestor watch is armed on the closest dir that
// DOES exist, so the root's eventual creation is observed. `child === rootName` in the common case
// (the immediate parent already exists). Returns null when nothing up to the fs root exists.
function nearestExistingAncestor(key: string): { dir: string; child: string } | null {
  let child = basename(key)
  let dir = dirname(key)
  while (dir && dir !== dirname(dir)) {
    try {
      if (statSync(dir).isDirectory()) return { dir, child }
    } catch {
      /* dir missing — keep climbing */
    }
    child = basename(dir)
    dir = dirname(dir)
  }
  // filesystem root ('/')
  try {
    if (dir && statSync(dir).isDirectory()) return { dir, child }
  } catch {
    /* nothing exists */
  }
  return null
}

// (Re)establish an outside root's TWO bounded descriptors against the CURRENT disk state, then
// keep them fresh. This one function drives ALL FOUR transitions identically (T-137):
//   • recursive watch on the root itself — present only while the root exists; carries every
//     content change under the subtree (one FSEvents descriptor for the whole tree, never
//     per-directory — the v1 EMFILE lesson);
//   • non-recursive watch on the nearest existing ancestor — catches the root's OWN
//     appearance (absent→present cold start), deletion and rename (present→absent), and the
//     delete→recreate cycle. Bounded to that ancestor's direct entries — never a recursive walk.
// A fired event schedules a debounced broadcast (renderer re-reads treeOutside → active or
// missing). Events that may have changed WHICH descriptors are valid (the root just appeared or
// vanished) additionally set `rearm`, so the debounced handler re-runs armOutside afterwards —
// promoting a cold-started ancestor watch to the recursive root watch, or demoting the other way.
// Plain content changes never re-arm, so descriptors are not thrashed on ordinary edits.
function armOutside(key: string, entry: OutsideWatchEntry): void {
  try {
    entry.watcher?.close()
  } catch {
    /* already closed */
  }
  try {
    entry.parent?.close()
  } catch {
    /* already closed */
  }
  entry.watcher = null
  entry.parent = null

  // `path` is the changed absolute path, or null when the event names none or is structural.
  const fire = (rearm: boolean, path: string | null): void => {
    if (rearm) entry.rearm = true
    entry.batch.add(path, true)
  }

  // 1) Recursive watch on the root itself — only openable while the root exists.
  try {
    entry.watcher = fsWatch(key, { recursive: true, persistent: false }, (_event, filename) => {
      // A null filename (some overflow events) still broadcasts; a named entry inside an ignored
      // tree is dropped. Content change → broadcast only (no re-arm).
      if (typeof filename === 'string' && WATCH_IGNORE.test(filename)) return
      fire(false, typeof filename === 'string' && filename ? `${key}/${filename.split('\\').join('/')}` : null)
    })
    // Without an error handler a watcher failure becomes an uncaught exception that can take down
    // the main process. On macOS the root's deletion often surfaces here (the recursive stream is
    // torn down without a final event); re-arm falls back to the ancestor watch so a later
    // recreate is still caught.
    entry.watcher.on('error', () => {
      try {
        entry.watcher?.close()
      } catch {
        /* already closed */
      }
      entry.watcher = null
      fire(true, null)
    })
  } catch {
    entry.watcher = null // root missing (cold start) — the ancestor watch below covers it
  }

  // 2) Non-recursive watch on the nearest existing ancestor — catches the root's own
  //    create/delete/rename. Bounded to that ancestor's direct entries — never recursive.
  const anc = nearestExistingAncestor(key)
  if (anc) {
    try {
      entry.parent = fsWatch(anc.dir, { recursive: false, persistent: false }, (_e, filename) => {
        // Only react to events for the child on the path to THIS root.
        if (filename !== null && filename !== anc.child) return
        fire(true, null) // structural: the root may have appeared or vanished → re-arm after broadcast
      })
      entry.parent.on('error', () => {
        try {
          entry.parent?.close()
        } catch {
          /* already closed */
        }
        entry.parent = null
      })
    } catch {
      entry.parent = null // best-effort; content changes still refresh via the recursive watcher
    }
  }
}

function startWatchOutside(absPath: string): void {
  const key = requireAbs(absPath)
  if (outsideWatchers.has(key)) return // idempotent — one entry (≤2 descriptors) per root
  const entry: OutsideWatchEntry = {
    watcher: null,
    parent: null,
    rearm: false,
    batch: createChangeBatch<true>((paths) => {
      const shouldRearm = entry.rearm
      entry.rearm = false
      // Keyed by the ABSOLUTE root path; an outside path's existence is read as is.
      if (paths === null) broadcast({ root: key, changes: null })
      else
        void withExistence(paths.keys(), (p) => p).then((changes) => {
          if (outsideWatchers.get(key) === entry) broadcast({ root: key, changes })
        })
      // Guard against a re-arm racing an unmount/teardown that already dropped this entry.
      if (shouldRearm && outsideWatchers.get(key) === entry) armOutside(key, entry)
    }, WATCH_QUIET_MS)
  }
  // Register BEFORE arming: at a cold start the root does not exist, so no descriptor may open —
  // but the entry must still be tracked (and re-arm-able) so the folder's later creation promotes
  // it. (The pre-T-137 code bailed out here, which is exactly why a cold-start mount stayed dead
  // until a project switch re-ran the mount flow.)
  outsideWatchers.set(key, entry)
  outsideWatchStats.size = outsideWatchers.size
  armOutside(key, entry)
}

async function stopWatchOutside(absPath: string): Promise<void> {
  const key = requireAbs(absPath)
  const entry = outsideWatchers.get(key)
  if (!entry) return // safe remove — unwatching an unwatched root is a no-op
  entry.batch.cancel()
  outsideWatchers.delete(key)
  outsideWatchStats.size = outsideWatchers.size
  try {
    entry.watcher?.close()
  } catch {
    /* already closed */
  }
  try {
    entry.parent?.close()
  } catch {
    /* already closed */
  }
}

/** E-006 (T-027) — tear down every active watcher. Watchers are bound to the current
 *  workspace root; on a workspace switch they must all be closed so the renderer can
 *  re-establish them against the new root. T-131 — outside-mount watchers are torn down here
 *  too: mounts are per-project state, so a workspace switch invalidates them all (the renderer
 *  re-mounts and re-watches the new workspace's projects). */
export function stopAllWatchers(): void {
  for (const [key, entry] of watchers) {
    entry.batch.cancel()
    try {
      entry.watcher?.close()
    } catch {
      /* already closed */
    }
    watchers.delete(key)
  }
  for (const [key, entry] of outsideWatchers) {
    entry.batch.cancel()
    try {
      entry.watcher?.close()
    } catch {
      /* already closed */
    }
    try {
      entry.parent?.close()
    } catch {
      /* already closed */
    }
    outsideWatchers.delete(key)
  }
  outsideWatchStats.size = 0
}

export { startWatch, stopWatch, startWatchOutside, stopWatchOutside }
