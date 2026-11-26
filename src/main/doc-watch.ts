// Pomade — E-035 (rule 8): the open-doc watcher. Detects a write to ANY doc open in ANY project
// (and outside-workspace docs), the moment it lands — independent of which project is active
// and of the file tree's per-root watchers in fs-watch.ts.
//
// The renderer declares the full set of open doc paths (`fs.watchDocs`, replace semantics). Main
// keeps ONE non-recursive fs.watch per distinct parent directory of those docs — bounded by the
// number of open docs, never a recursive walk — and broadcasts EV.fsDocChanged(docPath) for each
// doc whose directory entry changed. Watching the directory (not the file's inode) survives
// writers that replace the file by rename (atomic saves, git checkout, most editors).
//
// Every writer trips it — agents, git, Finder, other editors, apps through the platform file
// layer, and Pomade's own saves. Telling Pomade's own writes apart is the renderer's job: it
// compares the disk against the doc's sync point (mtime + content hash, shared/recovery.ts).

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

import { EV } from '@shared/ipc-api'

import { abs, requireAbs } from './ws-path'
import { safeBroadcast } from './windows'

const DEBOUNCE_MS = 120

interface DirEntry {
  watcher: FSWatcher
  /** basename → the doc paths (as the renderer named them) that live under it. */
  docs: Map<string, Set<string>>
}

const dirs = new Map<string, DirEntry>()
/** Every doc path the renderer declared open, as it named them — local history asks `isDocOpen`. */
const open = new Set<string>()
const timers = new Map<string, NodeJS.Timeout>()

// Main-process diagnostics (no IPC surface): the number of directory descriptors held, read by
// e2e via `app.evaluate(() => globalThis.__pomadeDocWatch)`.
const stats = { dirs: 0 }
;(globalThis as { __pomadeDocWatch?: { dirs: number } }).__pomadeDocWatch = stats

function emit(docPath: string): void {
  const t = timers.get(docPath)
  if (t) clearTimeout(t)
  timers.set(
    docPath,
    setTimeout(() => {
      timers.delete(docPath)
      safeBroadcast(EV.fsDocChanged, docPath)
    }, DEBOUNCE_MS)
  )
}

function resolveDoc(docPath: string): string | null {
  try {
    return docPath.startsWith('/') ? requireAbs(docPath) : abs(docPath)
  } catch {
    return null
  }
}

function closeDir(dir: string): void {
  const entry = dirs.get(dir)
  if (!entry) return
  dirs.delete(dir)
  stats.dirs = dirs.size
  try {
    entry.watcher.close()
  } catch {
    /* already closed */
  }
}

function openDir(dir: string): DirEntry | null {
  const docs = new Map<string, Set<string>>()
  let watcher: FSWatcher
  try {
    watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
      const entry = dirs.get(dir)
      if (!entry) return
      // A null filename (overflow) may concern any doc in the directory.
      const hit = typeof filename === 'string' ? entry.docs.get(filename) : null
      const targets = hit ? [...hit] : filename === null ? [...entry.docs.values()].flatMap((s) => [...s]) : []
      for (const docPath of targets) emit(docPath)
    })
  } catch {
    return null // directory missing — the doc shows its missing notice; a later set re-arms
  }
  // Without an error handler a watcher failure is an uncaught exception in main. The directory
  // was deleted or renamed: drop it and tell its docs to re-check (they'll find themselves gone).
  watcher.on('error', () => {
    const entry = dirs.get(dir)
    closeDir(dir)
    if (entry) for (const set of entry.docs.values()) for (const p of set) emit(p)
  })
  const entry = { watcher, docs }
  dirs.set(dir, entry)
  stats.dirs = dirs.size
  return entry
}

/** Replace the watched set with `docPaths` (ws-relative, or absolute for outside docs). */
export function setWatchedDocs(docPaths: string[]): void {
  open.clear()
  for (const p of docPaths) if (p) open.add(p)
  const wanted = new Map<string, Map<string, Set<string>>>()
  for (const p of new Set(docPaths)) {
    if (!p) continue
    const absPath = resolveDoc(p)
    if (!absPath) continue
    const dir = dirname(absPath)
    const name = basename(absPath)
    const byName = wanted.get(dir) ?? new Map<string, Set<string>>()
    const set = byName.get(name) ?? new Set<string>()
    set.add(p)
    byName.set(name, set)
    wanted.set(dir, byName)
  }
  for (const dir of [...dirs.keys()]) if (!wanted.has(dir)) closeDir(dir)
  for (const [dir, byName] of wanted) {
    const entry = dirs.get(dir) ?? openDir(dir)
    if (entry) entry.docs = byName
  }
}

/** Is the document at `docPath` (ws-relative, or absolute for an outside doc) open in the Editor
 *  of any project? A set lookup — local history asks it for every change it considers. */
export function isDocOpen(docPath: string): boolean {
  return open.has(docPath)
}

/** Workspace switch: every open doc belongs to the old root. */
export function stopDocWatch(): void {
  open.clear()
  for (const dir of [...dirs.keys()]) closeDir(dir)
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}
