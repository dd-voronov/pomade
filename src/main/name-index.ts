// Pomade — E-020 (T-086) terminal file links: the basename / stem / directory index that backs
// `fs.findByName` / `fs.findByStem` / `fs.findDirsBySuffix` / `fs.findFilesBySuffix`.
//
//   findByName(name)   a BARE filename → ws-relative paths of every match
//   findByStem(word)   an extension-LESS word → matches on basename-minus-extension
//                      (`VISION` → docs/VISION.md) or on the exact basename (`LICENSE`)
//
// The index lives in MAIN (it walks the workspace and compares ws-relative paths). Its per-token
// existence check — the "no dead links" guarantee — is `path-probe.ts`, a sibling. All lifecycle
// state (the built index, its watcher, dirty-dir bookkeeping, rebuild timers) is encapsulated in
// one `NameIndexService` instance — mirroring the other main-process services (SessionWatcher,
// SyncScheduler).

import { promises as fs, watch as fsWatch, type Dirent, type FSWatcher } from 'node:fs'
import { join, sep, dirname, basename } from 'node:path'

import { configStore } from './config-store'
import {
  INDEX_IGNORE_NAMES,
  hasIgnoredSegment,
  isSkippedAbs,
  splitName,
  toRel,
  walkWorkspace
} from './fs-shared'
import { foldKey, rankMatches } from './name-index-rank'
import { isSkippedRel, onUnwatchedChanged } from './skipped-paths'

/** Per-name result cap RETURNED to a caller. A name with more matches than this is still
 *  "ambiguous" — the picker shows the first few — but we never hand back an unbounded list for,
 *  say, `index.js`. */
const FIND_BY_NAME_MAX = 20

/** Per-key STORED-bucket cap. Larger than the return cap on purpose (T-188): keys fold to
 *  lowercase, so `README.md`/`readme.md`/`ReadMe.md` share one bucket, and ranking (exact-case-
 *  first, then current-project) must run at LOOKUP time — the query's case and the active project
 *  are both unknown at build time. If the bucket were truncated to the return cap in walk order,
 *  ranking could never see a rank-worthy candidate the walk truncated. Storing a wider bucket lets
 *  the lookup rank real candidates and then slice to FIND_BY_NAME_MAX. The extra memory is bounded
 *  and only ever spent on pathologically common basenames (`index.js`), which live in the vendored
 *  trees the index already refuses to walk. */
const STORE_CAP = 40

// T-091 — the index is EAGER and WATCHED, not lazy with a TTL.
//
// It used to build on the first `findByName`/`findByStem` of every 30 s window, which put a
// full workspace walk (~2 s on real git-base) in front of the first Cmd+hover of every terminal
// session. Now: built once when the workspace root is set (boot + workspace switch), kept for
// the app's lifetime, and kept FRESH by one index-owned recursive `fs.watch` at the root — the
// same primitive the tree watcher uses (FSEvents on macOS: ONE descriptor for the whole tree,
// never per-directory watchers, which is what caused the v1 EMFILE crash).
//
// Freshness path: event → mark that directory dirty → 200 ms debounce → re-read ONLY the dirty
// directories → diff against the remembered entry names → patch the two maps in place. A
// low-priority full rebuild every 5 minutes repairs any drift (a coalesced FSEvents batch, a
// missed event during sleep, or a per-key cap that a removal left under-filled), and it is
// stale-while-revalidate: the current maps keep serving lookups and the new index is swapped in
// atomically when its walk finishes.

/** Debounce for watcher-driven patching. Deliberately a WINDOW (the first event starts the
 *  clock) rather than a reset-on-every-event debounce: a build spewing events for a minute must
 *  still get the index patched every 200 ms instead of starving it until the storm ends. */
const INDEX_PATCH_DEBOUNCE_MS = 200
/** Belt-and-braces full rebuild interval (stale-while-revalidate — nothing blocks on it). */
const INDEX_REBUILD_MS = 5 * 60_000
/** Staleness bound used ONLY on the fallback path — when `fs.watch` is unavailable or its
 *  watcher died, the index degrades to exactly the old lazy+TTL behavior. */
const INDEX_FALLBACK_STALE_MS = 30_000

interface DirEntryNames {
  /** Non-directory entries (files AND symlinks — a symlink is indexed by name, never walked). */
  files: Set<string>
  /** Real sub-directories, i.e. the ones the walk descended into. */
  subdirs: Set<string>
}

interface NameIndex {
  root: string
  /** Stamped AFTER the walk finishes (T-091 — it used to be stamped before, which silently
   *  shortened the old TTL by the build's own duration). */
  builtAt: number
  /** LOWERCASED basename → ws-relative paths (`contracts.md` → `docs/CONTRACTS.md`). Case-folded
   *  (T-188): a link token matches its file whatever case either was typed in, and the exact case is
   *  recovered from the stored ws-relative path at lookup time (which is also where results rank
   *  exact-case-first). Holds files AND directories (a bare folder token is a link target too). */
  map: Map<string, string[]>
  /** LOWERCASED basename MINUS its last extension → ws-relative paths (`contracts` → `docs/
   *  CONTRACTS.md`). Same walk, same fold, same per-key cap as `map`: an extension-less word costs
   *  no extra I/O. */
  stems: Map<string, string[]>
  /** absolute directory → its entry names, so a watcher event can be resolved into an exact
   *  add/remove diff by re-reading one directory instead of re-walking the workspace. */
  dirs: Map<string, DirEntryNames>
  /** The ignore set this index was built with (also filters incoming watcher events). */
  ignore: Set<string>
}

/** Main-process diagnostics — no IPC surface, no renderer contract. Read from e2e via
 *  `app.evaluate(() => globalThis.__pomadeNameIndex)` and handy in a dev console;
 *  `globalThis.__pomadeNameIndexRewalk()` walks the workspace again and updates them. */
interface NameIndexStats {
  builds: number
  patches: number
  watching: boolean
  lastBuildMs: number
  files: number
  dirs: number
}

/** Append `rel` under `key`, honoring the per-key result cap. Idempotent (T-091): a patch may
 *  legitimately re-visit a directory the index already knows — e.g. `mkdir -p a/b` reported as
 *  two events whose dirty dirs are processed deepest-first, so `a`'s subtree walk re-reads `a/b`.
 *  A duplicated path would make a UNIQUE file look ambiguous and pop the link picker. The
 *  membership scan is on a ≤20-element array, so it costs nothing on the build path. */
function pushCapped(map: Map<string, string[]>, key: string, rel: string): void {
  const existing = map.get(key)
  if (!existing) map.set(key, [rel])
  else if (!existing.includes(rel) && existing.length < STORE_CAP) existing.push(rel)
}

/** Drop `rel` from `key`'s list (and the key itself once empty). A key that was at the cap can
 *  end up under-filled — the periodic full rebuild is what repairs that. */
function dropFrom(map: Map<string, string[]>, key: string, rel: string): void {
  const existing = map.get(key)
  if (!existing) return
  const i = existing.indexOf(rel)
  if (i >= 0) existing.splice(i, 1)
  if (existing.length === 0) map.delete(key)
}

// T-086 round 3 — indexes BOTH files and directories by name. Folders are link targets too
// (E-020 r2 reveals an in-project folder in the tree), so a BARE, slash-less folder token
// (`docs`, `.superpowers`) must resolve through this index exactly as a bare filename does —
// otherwise the same folder is clickable when the agent prints `docs/` (probePath handles the
// slash) but dead when it prints `docs` (round-2 bug: the index held files only).
//
// T-188 — keys are FOLDED to lowercase. A prose `Northwind` links its `northwind.md` (and
// `[[Northwind]]` resolves like `[[northwind]]`, Obsidian parity); the exact case is recovered from
// the stored ws-relative path at lookup, where results rank exact-case-first. No parallel
// case-preserving map: the fold is one `toLowerCase()` per entry on the build/patch path.
function addNameEntry(index: NameIndex, dirAbs: string, name: string): void {
  const rel = toRel(index.root, join(dirAbs, name))
  pushCapped(index.map, foldKey(name), rel)
  const { stem } = splitName(name)
  if (stem !== name) pushCapped(index.stems, foldKey(stem), rel)
}

function removeNameEntry(index: NameIndex, dirAbs: string, name: string): void {
  const rel = toRel(index.root, join(dirAbs, name))
  dropFrom(index.map, foldKey(name), rel)
  const { stem } = splitName(name)
  if (stem !== name) dropFrom(index.stems, foldKey(stem), rel)
}

/** Index everything under a newly appeared directory (a `mkdir -p a/b/c` arrives as one event). */
async function indexSubtree(index: NameIndex, dirAbs: string): Promise<void> {
  if (isSkippedAbs(index.root, dirAbs)) return
  await walkWorkspace(dirAbs, index.ignore, (d, entries) => {
    const names: DirEntryNames = { files: new Set(), subdirs: new Set() }
    for (const entry of entries) {
      if (index.ignore.has(entry.name)) continue
      const isDir = entry.isDirectory()
      addNameEntry(index, d, entry.name) // files AND dirs are lookup targets (T-086 r3)
      if (isDir) names.subdirs.add(entry.name)
      else names.files.add(entry.name)
    }
    index.dirs.set(d, names)
  }, index.root)
}

/** Forget a vanished directory and everything the index knows below it. The dir's OWN name entry
 *  is dropped by whoever calls purgeDir on it (its parent's reconcile, or the ENOENT branch's
 *  later parent reconcile); here we drop each child's name entry as we recurse. */
function purgeDir(index: NameIndex, dirAbs: string): void {
  const known = index.dirs.get(dirAbs)
  if (!known) return
  index.dirs.delete(dirAbs)
  for (const name of known.files) removeNameEntry(index, dirAbs, name)
  for (const name of known.subdirs) {
    removeNameEntry(index, dirAbs, name) // the subdir's own name entry (T-086 r3)
    purgeDir(index, join(dirAbs, name))
  }
}

/** Is `rel` a DIRECTORY per the index? Since T-188 folded `map`, a dedicated lowercased directory
 *  map is redundant: `index.dirs` is keyed by the ABSOLUTE path of every directory the walk
 *  descended into, so a rel is a directory iff its absolute form is a key there. One Map lookup.
 *  (A symlink-to-directory is indexed by name but never descended, so it is correctly NOT a `dirs`
 *  key — it counts as a file here, exactly as the old dir-basename map treated it.) */
function isDirRel(index: NameIndex, rel: string): boolean {
  return index.dirs.has(join(index.root, rel))
}

/** T-188 — the ws-relative form of the active project's root, for current-project ranking. The
 *  resolver threads the absolute `projectRootAbs` (it already carries it through `LinkContext`);
 *  here it becomes the ws-relative prefix `rankMatches` compares against. `''` (no project, or a
 *  project rooted AT the workspace root — the Workspace project (`__workspace__`)) means "no project
 *  bias". A path that somehow escapes the workspace also folds to `''` rather than a `..`-prefixed
 *  string that could never match a stored ws-relative path. */
function projectRelOf(index: NameIndex, projectRootAbs?: string): string {
  if (!projectRootAbs) return ''
  const rel = toRel(index.root, projectRootAbs)
  return rel === '' || rel.startsWith('..') ? '' : rel
}

class NameIndexService {
  private nameIndex: NameIndex | null = null
  // In-flight guard, KEYED BY ROOT (T-091 fix): several hovers can race the first build and must
  // share it, but a workspace SWITCH mid-build must start its own — the old code handed the new
  // root's caller the old root's build, whose result it then rejected, silently yielding [].
  private nameIndexBuild: { root: string; promise: Promise<NameIndex> } | null = null

  private readonly stats: NameIndexStats = {
    builds: 0,
    patches: 0,
    watching: false,
    lastBuildMs: -1,
    files: 0,
    dirs: 0
  }

  // ── watcher-driven incremental freshness ──────────────────────────────────
  private indexWatcher: FSWatcher | null = null
  private indexWatchRoot: string | null = null
  private readonly dirtyDirs = new Set<string>()
  private dirtyTimer: NodeJS.Timeout | null = null
  private rebuildTimer: NodeJS.Timeout | null = null
  private rebuilding = false
  /** Dirty directories seen WHILE a full rebuild walks; replayed onto the new index after the
   *  swap so an event that raced the walk can't be lost. */
  private dirtyDuringRebuild: Set<string> | null = null

  constructor() {
    ;(globalThis as { __pomadeNameIndex?: NameIndexStats }).__pomadeNameIndex = this.stats
    // Walk the workspace again now, as the periodic rebuild does; `stats.lastBuildMs` then times
    // the walk alone (scripts/smoke-scale.mjs holds its budget to the walk, not to start-up).
    ;(globalThis as { __pomadeNameIndexRewalk?: () => Promise<void> }).__pomadeNameIndexRewalk = () => this.rebuildNameIndex()
    // A folder entering or leaving the unwatched folders changes its parent's listing as the
    // index sees it: reconciling the parent purges the folder's subtree, or walks it in.
    onUnwatchedChanged((added, removed) => {
      const index = this.nameIndex
      if (!index) return
      for (const rel of [...added, ...removed]) this.markDirty(dirname(join(index.root, rel)))
    })
  }

  private async indexIgnoreSet(): Promise<Set<string>> {
    // The workspace's configured tree ignored items (a display choice) UNION the hardcoded
    // artifact list — see INDEX_IGNORE_NAMES for why the latter can't be user-controlled.
    return new Set([...(await configStore.getTreeIgnore()), ...INDEX_IGNORE_NAMES])
  }

  private async buildNameIndex(root: string, ignore: Set<string>): Promise<NameIndex> {
    const t0 = Date.now()
    const index: NameIndex = {
      root,
      builtAt: 0,
      map: new Map(),
      stems: new Map(),
      dirs: new Map(),
      ignore
    }
    let files = 0
    await walkWorkspace(root, ignore, (dirAbs, entries) => {
      const names: DirEntryNames = { files: new Set(), subdirs: new Set() }
      for (const entry of entries) {
        if (ignore.has(entry.name)) continue
        // Both files and directories are indexed by name (T-086 r3 — a bare folder token is a link
        // target too). A symlink is indexed by NAME but never descended into (cycle-safe, mirroring
        // buildTree); probePath resolves what it actually points at when the link is clicked.
        const isDir = entry.isDirectory()
        addNameEntry(index, dirAbs, entry.name)
        if (isDir) {
          names.subdirs.add(entry.name)
          continue
        }
        names.files.add(entry.name)
        files++
      }
      index.dirs.set(dirAbs, names)
    }, root)
    index.builtAt = Date.now() // AFTER the walk — see NameIndex.builtAt
    this.stats.builds++
    this.stats.lastBuildMs = index.builtAt - t0
    this.stats.files = files
    this.stats.dirs = index.dirs.size
    return index
  }

  private markDirty(dirAbs: string): void {
    this.dirtyDirs.add(dirAbs)
    if (this.dirtyDuringRebuild) this.dirtyDuringRebuild.add(dirAbs)
    if (this.dirtyTimer) return // a window is already open — see INDEX_PATCH_DEBOUNCE_MS
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null
      void this.flushDirtyDirs()
    }, INDEX_PATCH_DEBOUNCE_MS)
  }

  /** Re-read one directory and patch the maps by diffing its entry names against what the index
   *  remembers. Tolerates being handed a FILE path (watcher events name the changed entry, whose
   *  parent we also mark — the entry itself may or may not be a directory). */
  private async reconcileDir(index: NameIndex, dirAbs: string): Promise<void> {
    const root = index.root
    if (dirAbs !== root && !dirAbs.startsWith(root + sep)) return // outside the workspace
    if (dirAbs !== root && hasIgnoredSegment(dirAbs.slice(root.length + 1), index.ignore)) return
    if (isSkippedAbs(root, dirAbs)) return

    let entries: Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Gone, or replaced by a file: drop what we knew. Any other error (EPERM…) leaves the
      // index as-is — the periodic rebuild is the safety net.
      if (code === 'ENOENT' || code === 'ENOTDIR') purgeDir(index, dirAbs)
      return
    }

    const files = new Set<string>()
    const subdirs = new Set<string>()
    for (const entry of entries) {
      if (index.ignore.has(entry.name) || isSkippedAbs(root, join(dirAbs, entry.name))) continue
      if (entry.isDirectory()) subdirs.add(entry.name)
      else files.add(entry.name)
    }

    const known = index.dirs.get(dirAbs)
    if (!known) {
      // A directory the index never saw (created just now, or unreadable at build time).
      await indexSubtree(index, dirAbs)
      // Keep the parent's picture consistent so a later purge of the parent also drops this
      // subtree (purgeDir walks the remembered `subdirs`, not the whole `dirs` map), and index the
      // new directory's OWN name (indexSubtree only adds its contents).
      const parent = index.dirs.get(dirname(dirAbs))
      if (parent && !parent.subdirs.has(basename(dirAbs))) {
        parent.subdirs.add(basename(dirAbs))
        addNameEntry(index, dirname(dirAbs), basename(dirAbs))
      }
      this.stats.patches++
      return
    }

    for (const name of known.files) {
      if (!files.has(name)) removeNameEntry(index, dirAbs, name)
    }
    for (const name of files) {
      if (!known.files.has(name)) addNameEntry(index, dirAbs, name)
    }
    for (const name of known.subdirs) {
      if (!subdirs.has(name)) {
        removeNameEntry(index, dirAbs, name) // the vanished subdir's own name (T-086 r3)
        purgeDir(index, join(dirAbs, name))
      }
    }
    for (const name of subdirs) {
      if (!known.subdirs.has(name)) {
        addNameEntry(index, dirAbs, name) // the new subdir's own name (T-086 r3)
        await indexSubtree(index, join(dirAbs, name))
      }
    }
    known.files = files
    known.subdirs = subdirs
    this.stats.patches++
  }

  private async flushDirtyDirs(): Promise<void> {
    const index = this.nameIndex
    if (!index) {
      // No published index yet. If a build is in flight, KEEP the marks and retry once it lands —
      // a file created during the initial walk must not be lost. Otherwise (no workspace) drop them.
      if (this.nameIndexBuild && this.dirtyDirs.size > 0) {
        this.dirtyTimer ??= setTimeout(() => {
          this.dirtyTimer = null
          void this.flushDirtyDirs()
        }, INDEX_PATCH_DEBOUNCE_MS)
      } else {
        this.dirtyDirs.clear()
      }
      return
    }
    const batch = [...this.dirtyDirs]
    this.dirtyDirs.clear()
    for (const dirAbs of batch) {
      try {
        await this.reconcileDir(index, dirAbs)
      } catch {
        /* best-effort patching — the periodic rebuild repairs anything missed */
      }
    }
  }

  private stopIndexWatch(): void {
    this.stats.watching = false
    this.indexWatchRoot = null
    const w = this.indexWatcher
    this.indexWatcher = null
    if (!w) return
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }

  /** ONE recursive fs.watch at the workspace root, owned by the index (the tree owns its own —
   *  they are independent consumers of the same cheap primitive). Failure is not fatal: without a
   *  watcher `ensureNameIndex` falls back to the old lazy + INDEX_FALLBACK_STALE_MS behavior. */
  private startIndexWatch(root: string): void {
    if (this.indexWatcher && this.indexWatchRoot === root) return
    this.stopIndexWatch()
    try {
      const watcher = fsWatch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (typeof filename !== 'string' || filename.length === 0) return
        const ignore = this.nameIndex?.ignore
        if (ignore && hasIgnoredSegment(filename, ignore)) return
        if (isSkippedRel(filename.split('\\').join('/'))) return
        const full = join(root, filename)
        this.markDirty(dirname(full))
        // The named entry may itself BE a directory whose contents never generate their own
        // events (a recursive `mkdir`/rename arrives coalesced); reconcileDir tolerates files.
        this.markDirty(full)
      })
      // Without an error handler a watcher failure becomes an uncaught exception that can take
      // down the main process.
      watcher.on('error', () => {
        this.stopIndexWatch()
      })
      this.indexWatcher = watcher
      this.indexWatchRoot = root
      this.stats.watching = true
    } catch {
      this.stopIndexWatch() // no watcher → TTL fallback
    }
  }

  /** Low-priority full rebuild (stale-while-revalidate): the current maps keep serving lookups
   *  during the walk and the finished index is swapped in atomically. */
  private async rebuildNameIndex(): Promise<void> {
    const root = configStore.getRoot()
    if (this.rebuilding || !root || !this.nameIndex || this.nameIndex.root !== root) return
    this.rebuilding = true
    this.dirtyDuringRebuild = new Set()
    try {
      const built = await this.buildNameIndex(root, await this.indexIgnoreSet())
      if (configStore.getRoot() !== root) return
      this.nameIndex = built // atomic swap — readers saw the previous maps until this assignment
      const raced = this.dirtyDuringRebuild
      this.dirtyDuringRebuild = null
      this.rebuilding = false
      for (const dirAbs of raced) this.markDirty(dirAbs)
    } catch {
      /* keep serving the existing index */
    } finally {
      this.rebuilding = false
      this.dirtyDuringRebuild = null
    }
  }

  private startIndexRebuildTimer(): void {
    if (this.rebuildTimer) return
    this.rebuildTimer = setInterval(() => {
      void this.rebuildNameIndex()
    }, INDEX_REBUILD_MS)
    this.rebuildTimer.unref?.() // never a reason to keep the process alive
  }

  /** The live index for `root`. Built on demand only when the eager warm has not landed yet (or
   *  failed); with a live watcher it is never considered stale. Null only when the root changed
   *  underneath. */
  private async ensureNameIndex(root: string): Promise<NameIndex | null> {
    const current = this.nameIndex?.root === root ? this.nameIndex : null
    const watched = this.indexWatcher !== null && this.indexWatchRoot === root
    const fresh = current && (watched || Date.now() - current.builtAt < INDEX_FALLBACK_STALE_MS)
    if (!fresh) {
      let inflight = this.nameIndexBuild
      if (!inflight || inflight.root !== root) {
        const promise = (async () => {
          const ignore = await this.indexIgnoreSet()
          // Watch BEFORE walking: a file created DURING the initial build would otherwise fall in
          // the gap between "the walk read that directory" and "the watcher exists". Events that
          // arrive now sit in dirtyDirs until the built index is published (see flushDirtyDirs).
          this.startIndexWatch(root)
          return this.buildNameIndex(root, ignore)
        })()
        const entry = { root, promise }
        this.nameIndexBuild = entry
        inflight = entry
        void promise
          .then((built) => {
            // A build superseded by a workspace switch must not publish over the newer index.
            if (this.nameIndexBuild !== entry) return
            this.nameIndex = built
            this.startIndexRebuildTimer()
            // One line, on stdout: the number that T-091 exists to keep small (and what
            // scripts/smoke-scale.mjs reports for the ~30k-dir tree).
            console.log(
              `[name-index] built in ${this.stats.lastBuildMs} ms — ` +
                `${this.stats.files} files / ${this.stats.dirs} dirs` +
                `${this.stats.watching ? '' : ' (unwatched — TTL fallback)'}`
            )
          })
          .catch(() => {
            /* surfaced to this call's awaiter below */
          })
          .finally(() => {
            if (this.nameIndexBuild === entry) this.nameIndexBuild = null
          })
      }
      try {
        await inflight.promise
      } catch {
        return null // unreadable root — behave like "no matches" rather than throwing at a hover
      }
    }
    if (!this.nameIndex || this.nameIndex.root !== root) return null
    return this.nameIndex
  }

  /** T-091 — build the index for the CURRENT workspace root up front: at boot and on a workspace
   *  switch, so the first Cmd+hover of a session never waits on a walk. Fire-and-forget. */
  warm(): void {
    const root = configStore.getRoot()
    if (!root) return
    void this.ensureNameIndex(root).catch(() => {
      /* best-effort warm — a lookup would rebuild */
    })
  }

  /** T-091 — drop the index and its watcher (workspace switch). The new root's index is built by
   *  the `warm()` that follows the switch. */
  reset(): void {
    this.stopIndexWatch()
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = null
    }
    this.dirtyDirs.clear()
    this.nameIndex = null
    this.nameIndexBuild = null
  }

  /** E-020 (T-086) — ws-relative paths of every file/dir whose BASENAME folds to `name` (T-188:
   *  case-insensitive — `Northwind` finds `northwind.md`). `projectRootAbs` biases ranking toward the
   *  active project. Ranked exact-case-first, then current-project, then walk order; sliced to the
   *  return cap (the stored bucket holds up to STORE_CAP so ranking sees real candidates). */
  async findByName(root: string, name: string, projectRootAbs?: string): Promise<string[]> {
    const base = basename(name.trim())
    if (!base || base === '.' || base === '..') return []
    const index = await this.ensureNameIndex(root)
    if (!index) return []
    const matches = index.map.get(foldKey(base)) ?? []
    return rankMatches(matches, { query: base, projectRel: projectRelOf(index, projectRootAbs) }).slice(
      0,
      FIND_BY_NAME_MAX
    )
  }

  /** E-020 round 2 — an extension-less word: files whose basename-minus-extension folds to `word`,
   *  plus files named exactly `word` (LICENSE, Makefile). Stem hits come before exact-basename hits
   *  in the pre-rank order (`VISION` means `VISION.md` far more often than a file literally called
   *  `VISION`); the stable exact-case/current-project rank (T-188) preserves that within ties. */
  async findByStem(root: string, word: string, projectRootAbs?: string): Promise<string[]> {
    const base = basename(word.trim())
    if (!base || base === '.' || base === '..') return []
    const index = await this.ensureNameIndex(root)
    if (!index) return []
    const key = foldKey(base)
    const out = [...(index.stems.get(key) ?? [])]
    for (const rel of index.map.get(key) ?? []) {
      if (!out.includes(rel)) out.push(rel)
    }
    return rankMatches(out, {
      query: base,
      projectRel: projectRelOf(index, projectRootAbs),
      byStem: true
    }).slice(0, FIND_BY_NAME_MAX)
  }

  /** E-020 round 4 — DIRECTORIES whose ws-relative path ENDS WITH the token's full segment sequence
   *  (case-insensitively). Backs the fallback for a slashed folder token that resolves against no
   *  probe base — `Docs/`, `_templates/`, `docs/superpowers/specs/` printed as a bare "statement of
   *  the folder". The whole suffix must match (so `docs/superpowers/specs` needs all three trailing
   *  segments, not just `specs`). The token's last segment is looked up in the FOLDED shared `map`
   *  (T-188 removed the separate lowercased dir map — the fold made it redundant), candidates are
   *  narrowed to real directories via `isDirRel`, then each is suffix-filtered case-insensitively.
   *  Ranked exact-case-first, then current-project (T-188). Zero ⇒ not a link; one ⇒ open; many ⇒
   *  the picker. Capped at FIND_BY_NAME_MAX. */
  async findDirsBySuffix(root: string, token: string, projectRootAbs?: string): Promise<string[]> {
    const index = await this.ensureNameIndex(root)
    if (!index) return []
    // Strip a leading `./` or `/`, a leading `~`, and any trailing slashes, then split into segments.
    const clean = token.trim().replace(/^~/, '').replace(/^\.?\/+/, '').replace(/\/+$/, '')
    const segs = clean.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..')
    if (segs.length === 0) return []
    const wantLower = segs.map(foldKey)
    const lastLower = wantLower[wantLower.length - 1]
    const out: string[] = []
    for (const rel of index.map.get(lastLower) ?? []) {
      if (!isDirRel(index, rel)) continue // directories only — the FILE fallback owns files
      const relSegs = rel.split('/')
      if (relSegs.length < wantLower.length) continue
      const from = relSegs.length - wantLower.length
      let matches = true
      for (let i = 0; i < wantLower.length; i++) {
        if (foldKey(relSegs[from + i]) !== wantLower[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        out.push(rel)
        if (out.length >= STORE_CAP) break
      }
    }
    return rankMatches(out, {
      query: segs[segs.length - 1],
      projectRel: projectRelOf(index, projectRootAbs)
    }).slice(0, FIND_BY_NAME_MAX)
  }

  /** T-086 (Fix A) — the FILE counterpart of `findDirsBySuffix`: FILES whose ws-relative path ENDS
   *  WITH the token's full segment sequence, matched on SEGMENT BOUNDARIES. Backs the fallback for a
   *  slashed FILE token that resolves against no probe base — a path printed relative to some deep
   *  folder (`session-docs-reviewed/4f75f0a0-…-reviewed.md`) whose base is neither the cwd, the
   *  project root, nor the workspace root. The token's BASENAME (its last segment) is looked up in the
   *  FOLDED basename map (`map`), then each candidate is kept only when its trailing segments EQUAL
   *  the token's segments case-INSENSITIVELY (so `docs-reviewed/x.md` must NOT match a path ending
   *  `session-docs-reviewed/x.md` — the boundary is a full path segment, never a substring).
   *
   *  Case sensitivity — case-insensitive (the Owner's explicit call: explicit paths fold
   *  too, so an agent that prints a path in a different case than disk still resolves it; an
   *  exact-case file wins when both exist, via the exact-case-first rank). The lookup and the segment
   *  compare both fold; ranking recovers the exact case from the stored ws-relative path. Directory
   *  entries in `map` are excluded here (the DIR fallback owns those); a trailing slash means "this is
   *  a directory reference" and is left entirely to `findDirsBySuffix`.
   *
   *  Performance: NO new walk, NO new I/O — one `map` lookup + a suffix filter over the stored bucket,
   *  run only after every probe base missed. Zero ⇒ not a link; one ⇒ open; many ⇒ the picker; capped
   *  at `FIND_BY_NAME_MAX`. Existence is re-confirmed by `probePath` before anything is linked. */
  async findFilesBySuffix(root: string, token: string, projectRootAbs?: string): Promise<string[]> {
    const index = await this.ensureNameIndex(root)
    if (!index) return []
    const raw = token.trim()
    // A trailing slash is a DIRECTORY reference — leave it to findDirsBySuffix entirely.
    if (raw.endsWith('/')) return []
    // Strip a leading `./`, `/`, or `~`, then split into segments (dropping `.`/`..`).
    const clean = raw.replace(/^~/, '').replace(/^\.?\/+/, '')
    const segs = clean.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..')
    if (segs.length < 2) return [] // a bare basename is served by findByName, not here
    const base = segs[segs.length - 1]
    const wantLower = segs.map(foldKey)
    const out: string[] = []
    for (const rel of index.map.get(foldKey(base)) ?? []) {
      if (isDirRel(index, rel)) continue // files only — the DIR fallback owns directories
      const relSegs = rel.split('/')
      if (relSegs.length < segs.length) continue
      const from = relSegs.length - segs.length
      let matches = true
      for (let i = 0; i < segs.length; i++) {
        if (foldKey(relSegs[from + i]) !== wantLower[i]) {
          matches = false
          break
        }
      }
      if (matches) {
        out.push(rel)
        if (out.length >= STORE_CAP) break
      }
    }
    return rankMatches(out, {
      query: base,
      projectRel: projectRelOf(index, projectRootAbs)
    }).slice(0, FIND_BY_NAME_MAX)
  }

}

export const nameIndexService = new NameIndexService()
