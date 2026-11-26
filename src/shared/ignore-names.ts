// Pomade — the names every workspace walk skips, and how many reads one keeps in flight. Pure data,
// shared by the main process's indexes and watcher (`main/fs-shared.ts` re-exports them) and by
// repo discovery in `git-core`, which runs in the `pomade-git` command as well.

/** The live tree watcher's ignore set: the subset of `INDEX_IGNORE_NAMES` the FSEvents watchers
 *  filter on. `WATCH_IGNORE` (the regex) is derived from this at module init in `fs-watch.ts`, so
 *  the two never drift by hand. Broader on purpose than the display tree's own ignored items. */
export const WATCH_IGNORE_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  '.DS_Store',
  '.pomade',
  'dist',
  'out',
  '.venv',
  '__pycache__'
]

/** Names never descended into by either index walk. Superset of the live watcher's
 *  `WATCH_IGNORE_NAMES` plus the usual build/cache/vendor artifact directories. Hardcoded on
 *  purpose: a user who un-ignores `node_modules` in the TREE (a display choice) must not thereby
 *  turn every index build into a 100k-entry walk. What is lost by skipping a tree is only its
 *  BARE-name / stem lookups — any token containing a `/` is resolved by `probePath`, which never
 *  consults an index. */
export const INDEX_IGNORE_NAMES: readonly string[] = [
  ...WATCH_IGNORE_NAMES,
  // Build outputs, tool caches, vendored dependency trees.
  'build',
  'target',
  'release',
  '.next',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'coverage',
  'test-results',
  'playwright-report',
  '.turbo',
  '.cache',
  'site-packages',
  'Pods',
  '.repo'
]

/** How many `readdir`s are in flight at once. The walk is I/O-bound, so a serial recursion
 *  spends nearly all of its time waiting; ~24 concurrent reads saturates an SSD queue without
 *  risking descriptor pressure (each read holds a descriptor only for its own duration). */
export const INDEX_WALK_CONCURRENCY = 24
