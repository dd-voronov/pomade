// Pomade — synthetic real-scale workspace generator (T-008).
//
// Builds a large, gnarly workspace tree under the OS temp dir to stress the app the way
// the real git-base tree did (the v1 chokidar watcher exploded on it). Cached by
// GEN_VERSION: if a matching manifest is already present the tree is reused, so only the
// first ("cold") run pays the generation cost.
//
// The tree deliberately contains everything that broke, or could break, a filesystem walk
// / watcher at scale:
//   - ~30k directories, ~60k small files (fan-out tree)
//   - deep nesting (a chain > 12 levels)
//   - a few real `git init`ed repos (real .git dirs)
//   - symlinks: a file symlink, a dir symlink, and a directory-symlink CYCLE candidate
//     (a symlink pointing back at an ancestor) to prove the tree walk is cycle-safe
//   - non-md binary files
//   - files/dirs with unicode and space names
//
// This module is pure generation + caching; the launch/assert harness lives in
// smoke-scale.mjs and imports generateScaleWorkspace().

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  rmSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Bump when the tree shape changes so a stale cache is not silently reused.
/** Records (each a blob + a paths file) in the synthetic local-history store. */
const STORE_RECORDS = 3000
export const GEN_VERSION = 2

// Fan-out shape. Tuned so the tree lands at ~30k dirs / ~60k files while cold generation
// stays inside the ~30s budget on a laptop SSD.
const TOP = 30 // top-level "space" dirs
const MID = 30 // mid dirs per top  -> 900
const LEAF = 30 // leaf dirs per mid -> 27000
const FILES_PER_LEAF = 2 // -> 54000 files
const FILES_PER_MID = 4 // -> 3600 files

const MANIFEST = '.smoke-scale-manifest.json'

function cacheRoot() {
  return join(tmpdir(), `pomade-smoke-scale-ws-v${GEN_VERSION}`)
}

/** True when a complete, version-matching workspace is already cached. */
function isCached(root) {
  const m = join(root, MANIFEST)
  if (!existsSync(m)) return false
  try {
    return JSON.parse(readFileSync(m, 'utf8')).version === GEN_VERSION
  } catch {
    return false
  }
}

/** Remove any older-version cache dirs so the temp dir does not accumulate stale trees. */
function pruneOldVersions() {
  const base = tmpdir()
  const prefix = 'pomade-smoke-scale-ws-v'
  for (const name of readdirSync(base)) {
    if (name.startsWith(prefix) && name !== `${prefix}${GEN_VERSION}`) {
      try {
        rmSync(join(base, name), { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}

const SMALL = '# note\n\nsmall synthetic file for scale testing.\n'

function build(root) {
  let dirs = 0
  let files = 0

  // ── Main fan-out tree (the bulk of the dirs/files). ──────────────────────────
  for (let t = 0; t < TOP; t++) {
    const top = join(root, `space-${String(t).padStart(2, '0')}`)
    for (let m = 0; m < MID; m++) {
      const mid = join(top, `mod-${String(m).padStart(2, '0')}`)
      // Creating the deepest dir first (recursive) also makes the parents in one call.
      for (let l = 0; l < LEAF; l++) {
        const leaf = join(mid, `leaf-${String(l).padStart(2, '0')}`)
        mkdirSync(leaf, { recursive: true })
        dirs++
        for (let f = 0; f < FILES_PER_LEAF; f++) {
          writeFileSync(join(leaf, `f${f}.md`), SMALL)
          files++
        }
      }
      dirs++ // the mid dir itself
      for (let f = 0; f < FILES_PER_MID; f++) {
        writeFileSync(join(mid, `m${f}.txt`), SMALL)
        files++
      }
    }
    dirs++ // the top dir itself
  }

  // ── Deep nesting: a chain > 12 levels. ───────────────────────────────────────
  {
    let p = join(root, 'deep-nest')
    for (let i = 1; i <= 15; i++) p = join(p, `l${String(i).padStart(2, '0')}`)
    mkdirSync(p, { recursive: true })
    dirs += 16
    writeFileSync(join(p, 'deep-file.md'), '# 15 levels deep\n')
    files++
  }

  // ── Real git repos (real .git dirs — ignored by the tree, but on disk to stress
  //    the recursive watcher / any walk that does not honour the ignore list). ───
  const reposDir = join(root, 'repos')
  mkdirSync(reposDir, { recursive: true })
  dirs++
  for (const name of ['repo-alpha', 'repo-beta', 'repo-gamma']) {
    const repo = join(reposDir, name)
    mkdirSync(repo, { recursive: true })
    dirs++
    writeFileSync(join(repo, 'README.md'), `# ${name}\n`)
    files++
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  }

  // ── Non-md binaries. ─────────────────────────────────────────────────────────
  const assets = join(root, 'assets')
  mkdirSync(assets, { recursive: true })
  dirs++
  // A real PNG signature + IHDR start, and a random-ish blob.
  writeFileSync(
    join(assets, 'logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  )
  writeFileSync(join(assets, 'blob.dat'), Buffer.alloc(2048, 7))
  files += 2

  // ── Unicode / space names (top-level so they render in the initial tree). ─────
  writeFileSync(join(root, 'café résumé.md'), '# accents\n')
  writeFileSync(join(root, '文档-测试.md'), '# unicode\n')
  writeFileSync(join(root, 'my report (final) v2.txt'), 'spaces and parens\n')
  const spacedDir = join(root, 'a spaced dir')
  mkdirSync(spacedDir, { recursive: true })
  dirs++
  writeFileSync(join(spacedDir, 'inside space.md'), '# nested spaced\n')
  files += 4

  // ── Symlinks. Targets must already exist. ────────────────────────────────────
  // (a) A top-level FILE symlink — proves the E-012 symlink indicator at scale.
  symlinkSync(join('space-00', 'mod-00', 'leaf-00', 'f0.md'), join(root, 'linked-note.md'))
  // (b) A top-level DIR symlink — a transparent link to a real subtree.
  symlinkSync('space-01', join(root, 'mirror-space'))
  // (c) A directory-symlink CYCLE candidate: `cycle-dir/self` points back at its own
  //     parent, so a naive recursive walk that follows dir symlinks would loop forever.
  //     The E-012 walk only follows a symlinked dir when it is the explicit expand root,
  //     never auto-deeper, so it stays cycle-safe — this is the fixture that proves it.
  const cycleDir = join(root, 'cycle-dir')
  mkdirSync(cycleDir, { recursive: true })
  dirs++
  symlinkSync('..', join(cycleDir, 'self')) // -> cycle-dir's parent (the workspace root)
  symlinkSync('.', join(cycleDir, 'here')) // -> itself
  writeFileSync(join(cycleDir, 'real.md'), '# real file beside the cycle links\n')
  files++

  // ── A local-history store (T-314): Pomade's own data in the workspace, which every walk,
  //    watcher and tree skips by path. The stable flavor's folder — a dev Pomade (the smoke run)
  //    never writes or prunes it, so the cache stays as generated. Records are dated 2100 so no
  //    prune would ever drop them. Beside it, a user folder that is also called `local-history`
  //    and must stay visible: the skip is by path, never by name. ───────────────────────────
  const store = join(root, 'Apps', 'Pomade', 'local-history')
  mkdirSync(join(store, 'blobs'), { recursive: true })
  mkdirSync(join(store, 'paths'), { recursive: true })
  dirs += 5
  writeFileSync(join(store, '.gitignore'), '*\n')
  files++
  for (let i = 0; i < STORE_RECORDS; i++) {
    const hash = `lhsmoke${String(i).padStart(5, '0')}`
    writeFileSync(join(store, 'blobs', `${hash}.txt`), SMALL)
    const entries = [{ at: 4102444800000 + i, hash, size: SMALL.length, origin: 'disk' }]
    writeFileSync(join(store, 'paths', `${hash}.json`), JSON.stringify({ path: `space-00/lh-${i}.md`, entries }))
    files += 2
  }
  const userFolder = join(root, 'notes', 'local-history')
  mkdirSync(userFolder, { recursive: true })
  dirs += 2
  writeFileSync(join(userFolder, 'user-history-note.md'), '# a user folder called local-history\n')
  files++

  return { dirs, files }
}

/**
 * Ensure a scale workspace exists and return details about it.
 * @returns {{ root: string, cached: boolean, genMs: number, counts: {dirs:number,files:number}|null }}
 */
export function generateScaleWorkspace({ force = false } = {}) {
  const root = cacheRoot()

  if (!force && isCached(root)) {
    const counts = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')).counts ?? null
    return { root, cached: true, genMs: 0, counts }
  }

  pruneOldVersions()
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  const t0 = Date.now()
  const counts = build(root)
  const genMs = Date.now() - t0

  writeFileSync(
    join(root, MANIFEST),
    JSON.stringify({ version: GEN_VERSION, counts, generatedAt: new Date().toISOString() }, null, 2)
  )

  return { root, cached: false, genMs, counts }
}

// Allow running the generator standalone: `node scripts/gen-scale-workspace.mjs [--force]`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force')
  const r = generateScaleWorkspace({ force })
  console.log(JSON.stringify(r, null, 2))
}
