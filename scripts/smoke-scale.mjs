// ============================================================================
// Pomade — real-scale smoke test (T-008).
//
// HOW TO RUN
//   npm run smoke:scale
//
//   Builds the app (electron-vite build), generates OR reuses a cached synthetic
//   ~30k-dir / ~60k-file workspace under the OS temp dir, launches Pomade against it,
//   and asserts the scale invariants below. This is a STANDALONE script — it is NOT
//   part of the Playwright e2e suite and is not run by `npm run e2e`. Run it before
//   release-ish milestones. macOS only: the file-descriptor assertion uses `lsof`.
//
//   Re-run to exercise the cache (second run reuses the generated tree, ~0s to prepare).
//   Force a fresh tree with:  node scripts/gen-scale-workspace.mjs --force
//
// WHAT EACH ASSERTION GUARDS (and why it retro-fails a per-directory watcher)
//
//   [A] Startup / tree-render budget (< 15s).
//       Pomade watches the workspace with ONE native recursive fs.watch (FSEvents on
//       macOS) — a single syscall regardless of tree size. A chokidar-style design adds
//       one watcher per directory, so establishing ~30k watchers at startup would take
//       many seconds and push this past budget. Guards against reintroducing per-dir
//       watching (and against gross tree-walk regressions generally).
//
//   [B] Main-process file-descriptor count stays sane (< 1000) after startup AND after a
//       triggered watcher event. THIS is the definitive retro-fail: one FSEvents watcher
//       holds ~1 fd for the whole tree; a per-directory watcher holds one fd PER directory,
//       so on ~28k dirs it would sit in the tens of thousands and hit EMFILE ("too many
//       open files") — the exact v1 chokidar crash this script exists to prevent.
//
//   [C] The watcher actually works at scale: creating a new top-level file must propagate
//       (fs.watch event -> EV.fsChanged -> renderer refetch) and become visible in the
//       tree. A watcher that silently dies under load (as the v1 one did) fails here.
//
//   [D] A symlinked file shows its E-012 symlink indicator in the rendered tree — the
//       lstat-based, cycle-safe walk stays correct at scale (the tree also contains a
//       directory-symlink cycle candidate; the app rendering at all proves it did not loop).
//
//   [E] No uncaught errors on the main-process stderr or the renderer console.
//
//   [F] Clean exit (exit code 0), and no new `pomade-*` folder left in the temp dir.
//
//   [G] E-020 (T-086) basename index — the SECOND full-workspace walk Pomade performs (it backs
//       Cmd+click on a bare filename in a terminal). T-091 made that walk EAGER (built when the
//       workspace root is set) and watcher-fresh, so this section asserts: the walk fits the
//       budget on ~30k dirs (the best of the eager build and two re-walks once start-up settled —
//       machine load slows one sample, a slower walk slows them all),
//       every lookup is then effectively free, a name with many matches stays capped, the round-2
//       STEM lookup (an extension-less word) rides the same index, and — the retro-fail that
//       matters — the index holds at most its ONE recursive watcher's descriptor, i.e. it never
//       quietly grew into per-directory watching.
//
//   [H] E-026 (T-132) outside mounts — mounting N outside-workspace roots arms N recursive
//       fs.watchOutside descriptors (ONE per mount, never per-directory), the fd count stays
//       under budget, and unwatchOutside releases every descriptor. Same EMFILE retro-fail as
//       [B]/[G], now guarding the mount watcher.
//
//   [I] E-036 git state — repo discovery (depth-bounded walk) + one `git status` per repo, served
//       within budget at scale, finding the scale tree's real repos by folder name, with no fd
//       growth (git state listens through the platform watcher's taps, never a watcher of its own).
//
//   [J] E-044 local history — snapshots ride the platform watcher's taps, never a watcher of
//       their own. A burst of LOCAL_HISTORY_BURST text files written at once is coalesced per
//       path and read on a bounded worker pool: every file ends up snapshotted, the main process
//       stays responsive while it drains (a round trip per ping stays under budget), and the fd
//       count stays flat.
//
//   [K] T-314 the local-history store in the workspace (`Apps/Pomade/local-history/`, 3000 records
//       = 6000 files in the generated tree) is skipped BY PATH: the name index never lists its
//       files, the tree hides it (shown dimmed only with the ignored items) while a user folder
//       also called `local-history` stays visible, and a burst of STORE_BURST writes into the store
//       reaches no tree listener, no name-index patch and no git-state broadcast — while a control
//       write elsewhere proves the listeners were live.
//
//   [L] T-315 an unwatched folder (Settings ▸ File tree) is skipped by path like the store: put on
//       the list at runtime, a folder that then gets UNWATCHED_FILES files reaches no tree
//       listener, no name-index patch and no git-state broadcast, a fresh walk of the workspace
//       counts the same files as before the folder existed, and the tree still lists the folder,
//       marked unwatched — while a control write elsewhere proves the listeners were live.
// ============================================================================

import { _electron as electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { generateScaleWorkspace } from './gen-scale-workspace.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const MAIN = join(REPO, 'out', 'main', 'index.js')

// Budgets.
const STARTUP_BUDGET_MS = 15_000
const FD_LIMIT = 1000
const WATCHER_EVENT_TIMEOUT_MS = 10_000
// E-036 [I] — a git.state() round trip once the startup discovery has run.
const GIT_STATE_BUDGET_MS = 3_000
// E-020 [G] — budget for the basename-index WALK (~30k dirs / ~60k files) and for a lookup
// served from it. T-091: the walk now happens eagerly at startup, so the lookup bound is what
// proves it is never re-walked per hover, and BUILD_BUDGET is checked against the build time the
// main process reports for that eager walk.
const NAME_INDEX_COLD_BUDGET_MS = 12_000
const NAME_INDEX_WARM_BUDGET_MS = 250
/** T-091 — the walk behind the eager build must not blow the startup budget on the ~30k-dir tree. */
const NAME_INDEX_BUILD_BUDGET_MS = 5_000
/** Re-walks timed after start-up; the best of them and the eager build meets the budget. */
const NAME_INDEX_REWALKS = 2
// E-026 (T-132) [H] — how many OUTSIDE-workspace roots to mount at once. Each outside mount arms
// ONE native recursive fs.watch descriptor (fs.watchOutside), never per-directory watchers, so
// arming this many must not move the fd count meaningfully (the same EMFILE retro-fail as [B]/[G]).
const OUTSIDE_MOUNT_COUNT = 10
// E-044 [J] — files written at once, how long the burst may take to drain into snapshots, and the
// slowest main-process round trip tolerated while it drains.
const LOCAL_HISTORY_BURST = 300
const LOCAL_HISTORY_DRAIN_MS = 60_000
const MAIN_PING_BUDGET_MS = 750
/** T-314 — files written into the local-history store at once. */
const STORE_BURST = 2000
/** T-315 — files written into an unwatched folder (three sub-folders). */
const UNWATCHED_FILES = 3000

// Main-process stderr / renderer console lines that count as a real error.
const DANGER = /(error|uncaught|unhandled|EMFILE|ENFILE|too many open files|rejection)/i
// Known-benign noise to ignore (Electron / macOS chatter, devtools, security warnings).
const BENIGN = [
  /ELECTRON_ENABLE_LOGGING/i,
  /Electron Security Warning/i,
  /DevTools listening/i,
  /Autofill\./i,
  /GPU stall/i,
  /CoreText/i,
  /IMKClient|IMKInputSession/i,
  /vsync/i
]

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}

// Every temp folder this run makes is recorded and removed when the process exits — pass, fail or
// crash — and the app it launched is killed then if it is still up. The
// scale workspace cache (`pomade-smoke-scale-ws-v*`) is the one folder meant to stay.
const tempDirs = new Set()
let appProcess = null
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}
function removeTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* reported by the leftovers check */
  }
  tempDirs.delete(dir)
}
process.on('exit', () => {
  if (appProcess && appProcess.exitCode === null) appProcess.kill('SIGKILL')
  for (const dir of tempDirs) removeTemp(dir)
})

/** The `pomade-*` folders in the OS temp dir, but the scale workspace cache. */
function pomadeTempFolders() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith('pomade-') && !/^pomade-smoke-scale-ws-v\d+$/.test(n))
}
const tempBefore = new Set(pomadeTempFolders())

/** Count open file descriptors for a pid via lsof (tolerates lsof's partial-read exit 1). */
function fdCount(pid) {
  const r = spawnSync('lsof', ['-p', String(pid)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = r.stdout || ''
  const lines = out.split('\n').filter((l) => l.trim().length > 0)
  return Math.max(0, lines.length - 1) // drop the header row
}

async function main() {
  console.log('Pomade real-scale smoke test (T-008)\n')

  // ── 1. Generate (or reuse cached) the scale workspace. ──────────────────────
  const gen = generateScaleWorkspace()
  console.log(
    `Workspace: ${gen.root}\n` +
      `  ${gen.cached ? 'CACHED (reused)' : `GENERATED cold in ${gen.genMs} ms`} — ` +
      `${gen.counts?.dirs ?? '?'} dirs / ${gen.counts?.files ?? '?'} files\n`
  )

  const userDataDir = tempDir('pomade-smoke-ud-')

  // ── 2. Launch the built app against the scale workspace. ────────────────────
  const stderrLines = []
  const consoleErrors = []

  const t0 = Date.now()
  const app = await electron.launch({
    args: [MAIN],
    env: {
      // The invoking shell's Pomade host vars (a run from a Pomade terminal carries
      // POMADE_HOME=~/.pomade) would point this instance at the Owner's real home: dropped.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('POMADE_'))),
      POMADE_WORKSPACE: gen.root,
      POMADE_USER_DATA: userDataDir,
      NODE_ENV: 'test'
    }
  })

  const mainProc = app.process()
  appProcess = mainProc
  mainProc.stderr?.on('data', (b) => {
    for (const line of b.toString().split('\n')) {
      if (line.trim()) stderrLines.push(line)
    }
  })
  // T-091 — the eager name-index build reports itself on stdout; that line is the only place the
  // BUILD time is observable (every IPC lookup is served from the finished index).
  const stdoutLines = []
  mainProc.stdout?.on('data', (b) => {
    for (const line of b.toString().split('\n')) {
      if (line.trim()) stdoutLines.push(line)
    }
  })

  const page = await app.firstWindow()
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(String(err)))
  await page.waitForLoadState('domcontentloaded')

  // ── [A] Startup / tree-render budget. ───────────────────────────────────────
  let treeMs = -1
  try {
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: STARTUP_BUDGET_MS })
    await page.waitForSelector('[data-testid="filetree-root"]', { timeout: STARTUP_BUDGET_MS })
    await page
      .locator('[data-testid^="tree-node-"]')
      .first()
      .waitFor({ state: 'visible', timeout: STARTUP_BUDGET_MS })
    treeMs = Date.now() - t0
    check(
      `[A] tree renders within budget (${STARTUP_BUDGET_MS} ms)`,
      treeMs < STARTUP_BUDGET_MS,
      `rendered in ${treeMs} ms`
    )
  } catch (err) {
    check(`[A] tree renders within budget (${STARTUP_BUDGET_MS} ms)`, false, `did not render: ${err}`)
  }

  const topNodeCount = await page.locator('[data-testid^="tree-node-"]').count()

  // ── [B] File-descriptor count after startup. ────────────────────────────────
  const fdAfterStartup = fdCount(mainProc.pid)
  check(
    `[B1] main-process fd count < ${FD_LIMIT} after startup`,
    fdAfterStartup > 0 && fdAfterStartup < FD_LIMIT,
    `${fdAfterStartup} fds (main pid ${mainProc.pid}, ${topNodeCount} top-level nodes)`
  )

  // ── [D] Symlinked file shows its E-012 indicator. ───────────────────────────
  try {
    await page.waitForSelector('[data-testid="tree-symlink-linked-note.md"]', { timeout: 8_000 })
    const flagged = await page
      .locator('[data-testid="tree-node-linked-note.md"]')
      .getAttribute('data-symlink')
    check(
      '[D] symlinked file shows the E-012 indicator',
      flagged === 'true',
      `data-symlink=${flagged}`
    )
  } catch (err) {
    check('[D] symlinked file shows the E-012 indicator', false, `indicator not found: ${err}`)
  }

  // ── [C] Watcher works at scale: new top-level file must appear in the tree. ──
  const touchName = `smoke-touch-${Date.now()}.md`
  const touchPath = join(gen.root, touchName)
  let watcherOk = false
  try {
    writeFileSync(touchPath, '# created by smoke-scale to prove the watcher fires\n')
    await page.waitForSelector(`[data-testid="tree-node-${touchName}"]`, {
      timeout: WATCHER_EVENT_TIMEOUT_MS
    })
    watcherOk = true
  } catch (err) {
    watcherOk = false
    console.log(`      (watcher wait failed: ${err})`)
  } finally {
    try {
      rmSync(touchPath, { force: true })
    } catch {
      /* ignore */
    }
  }
  check(
    '[C] watcher propagates a new file to the tree at scale',
    watcherOk,
    watcherOk ? `${touchName} appeared` : 'new file never appeared in tree'
  )

  // ── [B2] File-descriptor count after the watcher event (stability check). ───
  const fdAfterEvent = fdCount(mainProc.pid)
  check(
    `[B2] main-process fd count < ${FD_LIMIT} after a watcher event`,
    fdAfterEvent > 0 && fdAfterEvent < FD_LIMIT,
    `${fdAfterEvent} fds (delta from startup: ${fdAfterEvent - fdAfterStartup})`
  )

  // ── [G] E-020 basename index (fs.findByName) at scale. ──────────────────────
  // `deep-file.md` is the single file 15 levels down; `f0.md` exists in every leaf directory, so
  // it exercises the per-name result cap. Both lookups go through the real IPC surface.
  let indexColdMs = -1
  let indexWarmMs = -1
  let indexBuildMs = -1
  let indexWalkMs = -1
  let fdAfterIndex = -1
  try {
    // T-091 — wait for the eager build to report itself, then hold it to the build budget. The
    // stats object is main-process-only (no IPC surface), same seam e2e uses.
    let buildStats = await app.evaluate(() => globalThis.__pomadeNameIndex)
    for (let i = 0; i < 60 && !(buildStats?.builds > 0); i++) {
      await page.waitForTimeout(250) // the eager build races startup on a cold FS cache
      buildStats = await app.evaluate(() => globalThis.__pomadeNameIndex)
    }
    const buildLine = stdoutLines.find((l) => l.includes('[name-index] built in')) ?? ''
    indexBuildMs = buildStats?.lastBuildMs ?? -1
    // The budget judges the walk, not the machine: the eager build shares the CPU and the disk
    // with the rest of start-up and with whatever else runs, and only ever gets slower for it.
    // So the walk is timed again twice once start-up has settled, and the best of the three is
    // held to the budget — load inflates one sample, a slower walk inflates all three.
    const walks = indexBuildMs >= 0 ? [indexBuildMs] : []
    for (let i = 0; i < NAME_INDEX_REWALKS && walks.length > 0; i++) {
      walks.push(await app.evaluate(async () => {
        await globalThis.__pomadeNameIndexRewalk()
        return globalThis.__pomadeNameIndex.lastBuildMs
      }))
    }
    indexWalkMs = walks.length ? Math.min(...walks) : -1
    check(
      `[G] the index walk fits the budget (${NAME_INDEX_BUILD_BUDGET_MS} ms)`,
      indexWalkMs >= 0 && indexWalkMs < NAME_INDEX_BUILD_BUDGET_MS,
      `best of ${walks.join(' / ')} ms (eager at start-up, then re-walks) — ${buildLine || `lastBuildMs=${indexBuildMs}`}`
    )
    check(
      '[G] the index is watched (one recursive watcher, not per-hover rebuilds)',
      buildStats?.watching === true,
      `watching=${buildStats?.watching}`
    )

    const cold = await page.evaluate(async () => {
      const t = performance.now()
      const hits = await window.pomade.fs.findByName('deep-file.md')
      return { ms: performance.now() - t, hits }
    })
    indexColdMs = Math.round(cold.ms)
    check(
      `[G] the first lookup of the session is within budget (${NAME_INDEX_COLD_BUDGET_MS} ms)`,
      indexColdMs < NAME_INDEX_COLD_BUDGET_MS,
      `${indexColdMs} ms (T-091: served by the eager build, so this is now a warm number)`
    )
    check(
      '[G] basename index finds a file 15 levels deep',
      cold.hits.some((p) => p.endsWith('/deep-file.md')),
      cold.hits.length ? cold.hits[0] : 'no match'
    )

    const warm = await page.evaluate(async () => {
      const t = performance.now()
      const many = await window.pomade.fs.findByName('f0.md')
      return { ms: performance.now() - t, count: many.length }
    })
    indexWarmMs = Math.round(warm.ms)
    check(
      `[G] a cached lookup is effectively free (< ${NAME_INDEX_WARM_BUDGET_MS} ms)`,
      indexWarmMs < NAME_INDEX_WARM_BUDGET_MS,
      `${indexWarmMs} ms warm`
    )
    check(
      '[G] a many-match name stays capped',
      warm.count > 1 && warm.count <= 20,
      `${warm.count} matches for f0.md`
    )

    // E-020 round 2 — the extension-less-word lookup (`VISION` → VISION.md) rides on the SAME
    // walk and the same cache (one extra map built during the existing traversal), so it has to
    // be warm-fast here too; a second walk would show up immediately in this budget.
    const stem = await page.evaluate(async () => {
      const t = performance.now()
      const hits = await window.pomade.fs.findByStem('deep-file')
      return { ms: performance.now() - t, hits }
    })
    const stemMs = Math.round(stem.ms)
    check(
      `[G] a stem lookup is served from the same cached index (< ${NAME_INDEX_WARM_BUDGET_MS} ms)`,
      stemMs < NAME_INDEX_WARM_BUDGET_MS,
      `${stemMs} ms warm`
    )
    check(
      '[G] the stem index finds a file by basename-minus-extension',
      stem.hits.some((p) => p.endsWith('/deep-file.md')),
      stem.hits.length ? stem.hits[0] : 'no match'
    )

    // The definitive retro-fail: a per-directory-watching implementation of this index would
    // show up as thousands of extra descriptors right here.
    fdAfterIndex = fdCount(mainProc.pid)
    check(
      `[G] the index adds no file descriptors (< ${FD_LIMIT})`,
      fdAfterIndex > 0 && fdAfterIndex < FD_LIMIT,
      `${fdAfterIndex} fds (delta from watcher event: ${fdAfterIndex - fdAfterEvent})`
    )
  } catch (err) {
    check('[G] basename index at scale', false, `threw: ${err}`)
  }

  // ── [H] E-026 (T-132) outside mounts: N recursive watchers, not per-dir. ─────
  // Mount OUTSIDE_MOUNT_COUNT throwaway dirs (each a tiny subtree) through the fs.watchOutside
  // door and assert (1) exactly one descriptor per mount is tracked, and (2) the main-process fd
  // count stays sane. A per-directory implementation of the mount watcher would blow the fd count
  // here just as the v1 chokidar design did — the same retro-fail [B]/[G] guard, now for mounts.
  const outsideDirs = []
  let fdAfterMounts = -1
  let outsideWatchSize = -1
  try {
    for (let i = 0; i < OUTSIDE_MOUNT_COUNT; i++) {
      const d = tempDir('pomade-smoke-mount-')
      mkdirSync(join(d, 'sub'), { recursive: true })
      writeFileSync(join(d, 'sub', 'deep.md'), '# deep\n')
      writeFileSync(join(d, 'top.md'), '# top\n')
      outsideDirs.push(d)
    }
    // Arm every mount's watcher through the real IPC door, exactly as the file tree does.
    await page.evaluate(async (dirs) => {
      for (const d of dirs) await window.pomade.fs.watchOutside(d)
    }, outsideDirs)

    outsideWatchSize = await app.evaluate(
      () => globalThis.__pomadeOutsideWatch?.size ?? -1
    )
    check(
      `[H] one recursive watcher per outside mount (${OUTSIDE_MOUNT_COUNT})`,
      outsideWatchSize === OUTSIDE_MOUNT_COUNT,
      `__pomadeOutsideWatch.size=${outsideWatchSize}`
    )

    fdAfterMounts = fdCount(mainProc.pid)
    check(
      `[H] outside mounts add no fd blowup (< ${FD_LIMIT})`,
      fdAfterMounts > 0 && fdAfterMounts < FD_LIMIT,
      `${fdAfterMounts} fds (delta from index: ${fdAfterMounts - fdAfterIndex})`
    )

    // Unwatch every mount and confirm the descriptors are released (safe teardown on unmount /
    // project switch / workspace teardown).
    await page.evaluate(async (dirs) => {
      for (const d of dirs) await window.pomade.fs.unwatchOutside(d)
    }, outsideDirs)
    const afterUnwatch = await app.evaluate(() => globalThis.__pomadeOutsideWatch?.size ?? -1)
    check(
      '[H] unwatchOutside releases every mount descriptor',
      afterUnwatch === 0,
      `__pomadeOutsideWatch.size=${afterUnwatch}`
    )
  } catch (err) {
    check('[H] outside mounts at scale', false, `threw: ${err}`)
  } finally {
    for (const d of outsideDirs) {
      removeTemp(d)
    }
  }

  // ── [I] E-036 git state at scale: bounded discovery + per-repo status. ───────
  // The tree subscribes to git state at startup, so discovery (a depth-bounded walk for `.git`)
  // and one `git status` per repo already ran. A fresh `git.state()` must be fast, find the scale
  // tree's real repos (repos/repo-*), and leave the fd count sane — git state rides the platform
  // watcher's taps and never opens a watcher of its own.
  try {
    const t0 = Date.now()
    const repos = await page.evaluate(async () =>
      (await window.pomade.git.state()).repos.map((r) => ({ root: r.root, name: r.name, error: r.error }))
    )
    const ms = Date.now() - t0
    check(`[I] git state is served within budget (${GIT_STATE_BUDGET_MS} ms)`, ms < GIT_STATE_BUDGET_MS, `${ms} ms`)
    const names = repos.map((r) => r.name).sort().join(',')
    check(
      '[I] discovery finds the scale tree repos, named by folder',
      ['repo-alpha', 'repo-beta', 'repo-gamma'].every((n) => repos.some((r) => r.name === n && !r.error)),
      names || 'none'
    )
    const fdAfterGit = fdCount(mainProc.pid)
    check(`[I] git state adds no fd blowup (< ${FD_LIMIT})`, fdAfterGit > 0 && fdAfterGit < FD_LIMIT, `${fdAfterGit} fds`)
  } catch (err) {
    check('[I] git state at scale', false, `threw: ${err}`)
  }

  // ── [J] E-044 local history under a write burst. ─────────────────────────────
  const burstDir = join(gen.root, `__lh-burst-${Date.now()}__`)
  let burstDrainMs = -1
  let burstWorstPing = -1
  try {
    mkdirSync(burstDir, { recursive: true })
    const fdBefore = fdCount(mainProc.pid)
    const tBurst = Date.now()
    for (let i = 0; i < LOCAL_HISTORY_BURST; i++) writeFileSync(join(burstDir, `f${i}.md`), `# burst ${i}\n\n${'x'.repeat(200)}\n`)
    const rel = (i) => `${burstDir.slice(gen.root.length + 1)}/f${i}.md`
    let worst = 0
    // At least one: the store lives in the cached workspace, so a file whose text an earlier run's
    // (since removed) burst file held arrives as that file renamed — its versions follow it.
    const done = async (i) => (await page.evaluate((p) => window.pomade.localHistory.list(p), rel(i))).length >= 1
    let drained = false
    while (Date.now() - tBurst < LOCAL_HISTORY_DRAIN_MS) {
      const tp = Date.now()
      await app.evaluate(() => 1)
      worst = Math.max(worst, Date.now() - tp)
      if ((await done(0)) && (await done(LOCAL_HISTORY_BURST - 1))) {
        drained = true
        break
      }
      await page.waitForTimeout(200)
    }
    burstDrainMs = Date.now() - tBurst
    burstWorstPing = worst
    let all = 0
    for (let i = 0; i < LOCAL_HISTORY_BURST; i += 7) if (await done(i)) all += 1
    check(
      `[J] a burst of ${LOCAL_HISTORY_BURST} files is snapshotted (within ${LOCAL_HISTORY_DRAIN_MS} ms)`,
      drained && all === Math.ceil(LOCAL_HISTORY_BURST / 7),
      `${burstDrainMs} ms, ${all}/${Math.ceil(LOCAL_HISTORY_BURST / 7)} sampled files have a snapshot`
    )
    check(
      `[J] the main process stays responsive while it drains (< ${MAIN_PING_BUDGET_MS} ms per round trip)`,
      burstWorstPing < MAIN_PING_BUDGET_MS,
      `worst round trip ${burstWorstPing} ms`
    )
    const fdAfterBurst = fdCount(mainProc.pid)
    check(
      `[J] the burst adds no file descriptors beyond its own reads (< ${FD_LIMIT})`,
      fdAfterBurst > 0 && fdAfterBurst < FD_LIMIT,
      `${fdAfterBurst} fds (delta ${fdAfterBurst - fdBefore})`
    )
  } catch (err) {
    check('[J] local history under a write burst', false, `threw: ${err}`)
  } finally {
    try {
      rmSync(burstDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  // ── [K] T-314 the local-history store is skipped by path. ───────────────────
  const storeChurnDir = join(gen.root, 'Apps', 'Pomade', 'local-history', 'blobs')
  const controlFile = join(gen.root, 'notes', `__store-control-${Date.now()}__.md`)
  try {
    const storeHits = await page.evaluate(() => window.pomade.fs.findByName('lhsmoke00042.txt'))
    const userHits = await page.evaluate(() => window.pomade.fs.findByName('user-history-note.md'))
    const folderHits = await page.evaluate(() => window.pomade.fs.findByName('local-history'))
    check(
      '[K] the name index never lists the store, but finds a user folder called local-history',
      storeHits.length === 0 &&
        userHits.some((p) => p.endsWith('notes/local-history/user-history-note.md')) &&
        folderHits.some((p) => p.endsWith('notes/local-history')) &&
        !folderHits.some((p) => p.includes('Apps/Pomade/local-history')),
      `store hits ${storeHits.length}; user hits ${userHits.join(', ') || 'none'}; folder hits ${folderHits.join(', ') || 'none'}`
    )
    const names = (node) => (node.children ?? []).map((c) => `${c.name}${c.ignored ? '(ignored)' : ''}`)
    const pomadeDir = await page.evaluate(() => window.pomade.fs.tree('Apps/Pomade', 1))
    const pomadeAll = await page.evaluate(() => window.pomade.fs.tree('Apps/Pomade', 1, { includeIgnored: true }))
    const notesDir = await page.evaluate(() => window.pomade.fs.tree('notes', 1))
    check(
      '[K] the tree hides the store (dimmed with the ignored items) and shows notes/local-history',
      !names(pomadeDir).some((n) => n.startsWith('local-history')) &&
        names(pomadeAll).includes('local-history(ignored)') &&
        names(notesDir).includes('local-history'),
      `Apps/Pomade: [${names(pomadeDir)}] / with ignored: [${names(pomadeAll)}]; notes: [${names(notesDir)}]`
    )

    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.__t314 = { fs: [], git: 0 }
      w.__t314.offFs = window.pomade.fs.onChanged((e) => {
        for (const c of e.changes ?? [{ path: '(overflow)' }]) w.__t314.fs.push(c.path)
      })
      w.__t314.offGit = window.pomade.git.onState(() => {
        w.__t314.git += 1
      })
    })
    // Let [J]'s own cleanup settle first: wait for a full quiet second (no tree event, no index
    // patch), then count from zero.
    let patchesBefore = -1
    for (let i = 0; i < 30; i++) {
      const p0 = (await app.evaluate(() => globalThis.__pomadeNameIndex)).patches
      const n0 = await page.evaluate(() => /** @type {any} */ (window).__t314.fs.length + /** @type {any} */ (window).__t314.git)
      await page.waitForTimeout(1000)
      const p1 = (await app.evaluate(() => globalThis.__pomadeNameIndex)).patches
      const n1 = await page.evaluate(() => /** @type {any} */ (window).__t314.fs.length + /** @type {any} */ (window).__t314.git)
      if (p0 === p1 && n0 === n1) {
        patchesBefore = p1
        break
      }
    }
    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.__t314.fs = []
      w.__t314.git = 0
    })
    for (let i = 0; i < STORE_BURST; i++) writeFileSync(join(storeChurnDir, `churn${String(i).padStart(5, '0')}.txt`), `${i}\n`)
    await page.waitForTimeout(3000)
    const afterBurst = await page.evaluate(() => ({ fs: [.../** @type {any} */ (window).__t314.fs], git: /** @type {any} */ (window).__t314.git }))
    const patchesAfter = (await app.evaluate(() => globalThis.__pomadeNameIndex)).patches
    const churnHits = await page.evaluate(() => window.pomade.fs.findByName('churn00007.txt'))
    check(
      `[K] ${STORE_BURST} writes into the store reach no tree listener, no index patch, no git-state broadcast`,
      afterBurst.fs.length === 0 && afterBurst.git === 0 && patchesAfter === patchesBefore && churnHits.length === 0,
      `tree events ${afterBurst.fs.length}${afterBurst.fs.length ? ` (${afterBurst.fs.slice(0, 3).join(', ')}…)` : ''}, ` +
        `git broadcasts ${afterBurst.git}, index patches ${patchesAfter - patchesBefore}, index hits ${churnHits.length}`
    )
    writeFileSync(controlFile, '# control\n')
    const controlRel = controlFile.slice(gen.root.length + 1)
    let heard = false
    for (let i = 0; i < 50 && !heard; i++) {
      await page.waitForTimeout(100)
      heard = await page.evaluate((p) => /** @type {any} */ (window).__t314.fs.includes(p), controlRel)
    }
    check('[K] control: a write beside the store is heard by the tree', heard, heard ? controlRel : 'no event')
    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.__t314.offFs()
      w.__t314.offGit()
    })
  } catch (err) {
    check('[K] the local-history store is skipped by path', false, `threw: ${err}`)
  } finally {
    try {
      for (const n of readdirSync(storeChurnDir)) if (n.startsWith('churn')) rmSync(join(storeChurnDir, n), { force: true })
      rmSync(controlFile, { force: true })
    } catch {
      /* ignore */
    }
  }

  // ── [L] T-315 an unwatched folder is skipped by path. ──────────────────────
  const unwatchedRel = `__unwatched-${Date.now()}__`
  const unwatchedDir = join(gen.root, unwatchedRel)
  const unwatchedControl = join(gen.root, 'notes', `__unwatched-control-${Date.now()}__.md`)
  const setUnwatched = (list) =>
    page.evaluate((l) => /** @type {any} */ (window).__pomadeStores.useWorkspaceStore.getState().updateFileTree({ unwatched: l }), list)
  const walkedFiles = async () => {
    await app.evaluate(() => globalThis.__pomadeNameIndexRewalk())
    return (await app.evaluate(() => globalThis.__pomadeNameIndex)).files
  }
  try {
    const filesBefore = await walkedFiles()
    await setUnwatched([unwatchedRel])
    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.__t315 = { fs: [], git: 0 }
      w.__t315.offFs = window.pomade.fs.onChanged((e) => {
        for (const c of e.changes ?? [{ path: '(overflow)' }]) w.__t315.fs.push(c.path)
      })
      w.__t315.offGit = window.pomade.git.onState(() => {
        w.__t315.git += 1
      })
    })
    let patchesBefore = -1
    for (let i = 0; i < 30; i++) {
      const p0 = (await app.evaluate(() => globalThis.__pomadeNameIndex)).patches
      const n0 = await page.evaluate(() => /** @type {any} */ (window).__t315.fs.length + /** @type {any} */ (window).__t315.git)
      await page.waitForTimeout(1000)
      const p1 = (await app.evaluate(() => globalThis.__pomadeNameIndex)).patches
      const n1 = await page.evaluate(() => /** @type {any} */ (window).__t315.fs.length + /** @type {any} */ (window).__t315.git)
      if (p0 === p1 && n0 === n1) {
        patchesBefore = p1
        break
      }
    }
    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.__t315.fs = []
      w.__t315.git = 0
    })
    for (const sub of ['a', 'b', 'c']) mkdirSync(join(unwatchedDir, sub), { recursive: true })
    for (let i = 0; i < UNWATCHED_FILES; i++) {
      writeFileSync(join(unwatchedDir, ['a', 'b', 'c'][i % 3], `uw${String(i).padStart(5, '0')}.log`), `${i}\n`)
    }
    await page.waitForTimeout(3000)
    const afterBurst = await page.evaluate(() => ({ fs: [.../** @type {any} */ (window).__t315.fs], git: /** @type {any} */ (window).__t315.git }))
    const patchesAfter = (await app.evaluate(() => globalThis.__pomadeNameIndex)).patches
    const hits = await page.evaluate(() => window.pomade.fs.findByName('uw00007.log'))
    check(
      `[L] ${UNWATCHED_FILES} files written into an unwatched folder reach no tree listener, no index patch, no git-state broadcast`,
      afterBurst.fs.length === 0 && afterBurst.git === 0 && patchesAfter === patchesBefore && hits.length === 0,
      `tree events ${afterBurst.fs.length}${afterBurst.fs.length ? ` (${afterBurst.fs.slice(0, 3).join(', ')}…)` : ''}, ` +
        `git broadcasts ${afterBurst.git}, index patches ${patchesAfter - patchesBefore}, index hits ${hits.length}`
    )
    const filesAfter = await walkedFiles()
    check('[L] a fresh walk adds no index entries for the unwatched folder', filesAfter === filesBefore, `files ${filesBefore} → ${filesAfter}`)
    const top = await page.evaluate(() => window.pomade.fs.tree('', 1))
    const row = (top.children ?? []).find((c) => c.name === unwatchedRel)
    check('[L] the tree still lists the unwatched folder, marked', row?.unwatched === true, row ? `unwatched=${row.unwatched}` : 'not listed')
    writeFileSync(unwatchedControl, '# control\n')
    const controlRel = unwatchedControl.slice(gen.root.length + 1)
    let heard = false
    for (let i = 0; i < 50 && !heard; i++) {
      await page.waitForTimeout(100)
      heard = await page.evaluate((p) => /** @type {any} */ (window).__t315.fs.includes(p), controlRel)
    }
    check('[L] control: a write beside the unwatched folder is heard by the tree', heard, heard ? controlRel : 'no event')
    await page.evaluate(() => {
      const w = /** @type {any} */ (window)
      w.__t315.offFs()
      w.__t315.offGit()
    })
  } catch (err) {
    check('[L] an unwatched folder is skipped by path', false, `threw: ${err}`)
  } finally {
    try {
      await setUnwatched([])
      rmSync(unwatchedDir, { recursive: true, force: true })
      rmSync(unwatchedControl, { force: true })
    } catch {
      /* ignore */
    }
  }

  // ── [E] No uncaught errors on stderr / console. ─────────────────────────────
  const badStderr = stderrLines.filter((l) => DANGER.test(l) && !BENIGN.some((b) => b.test(l)))
  const badConsole = consoleErrors.filter((l) => !BENIGN.some((b) => b.test(l)))
  check(
    '[E] no uncaught errors on main stderr',
    badStderr.length === 0,
    badStderr.length ? `\n      ${badStderr.slice(0, 5).join('\n      ')}` : 'clean'
  )
  check(
    '[E] no errors on renderer console',
    badConsole.length === 0,
    badConsole.length ? `\n      ${badConsole.slice(0, 5).join('\n      ')}` : 'clean'
  )

  // ── [F] Clean exit. ─────────────────────────────────────────────────────────
  await app.close()
  const exitCode = mainProc.exitCode
  check('[F] clean exit (code 0)', exitCode === 0 || exitCode === null, `exitCode=${exitCode}`)

  // ── Cleanup: transient userData goes (the workspace itself is intentionally cached), and
  // the run leaves no new pomade-* folder in the temp dir.
  removeTemp(userDataDir)
  const leftovers = pomadeTempFolders().filter((n) => !tempBefore.has(n))
  check('[F] leaves no new pomade-* folder in the temp dir', leftovers.length === 0, leftovers.join(', ') || 'clean')

  // ── Summary. ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok)
  console.log('\n──────── measured numbers ────────')
  console.log(`  workspace prepare : ${gen.cached ? 'cached (0 ms)' : `${gen.genMs} ms (cold)`}`)
  console.log(`  tree render       : ${treeMs} ms (budget ${STARTUP_BUDGET_MS} ms)`)
  console.log(`  fds after startup : ${fdAfterStartup} (limit ${FD_LIMIT})`)
  console.log(`  fds after event   : ${fdAfterEvent} (limit ${FD_LIMIT})`)
  console.log(`  name index walk   : ${indexWalkMs} ms best (budget ${NAME_INDEX_BUILD_BUDGET_MS} ms); eager at startup ${indexBuildMs} ms`)
  console.log(`  name index lookup : ${indexColdMs} ms first / ${indexWarmMs} ms next (budget ${NAME_INDEX_WARM_BUDGET_MS} ms)`)
  console.log(`  fds after index   : ${fdAfterIndex} (limit ${FD_LIMIT})`)
  console.log(`  outside mounts    : ${outsideWatchSize} watchers / ${fdAfterMounts} fds (${OUTSIDE_MOUNT_COUNT} mounted)`)
  console.log(`  local history     : ${LOCAL_HISTORY_BURST} files drained in ${burstDrainMs} ms, worst main round trip ${burstWorstPing} ms`)
  console.log(`  tree top nodes    : ${topNodeCount}`)
  console.log('──────────────────────────────────\n')

  if (failed.length) {
    console.log(`SMOKE-SCALE FAILED — ${failed.length}/${results.length} assertion(s) failed.`)
    process.exit(1)
  }
  console.log(`SMOKE-SCALE PASSED — all ${results.length} assertions green.`)
  process.exit(0)
}

main().catch((err) => {
  console.error('smoke-scale crashed:', err)
  process.exit(1)
})
