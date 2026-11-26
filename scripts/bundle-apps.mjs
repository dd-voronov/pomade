// Pomade packaging — the bundled apps (docs/HOST-API.md §8 "Bundled apps"). For each repo pinned in
// `bundled-apps.json` (git URL + tag, like the kit pin): clone it at its tag, run its own build
// (`npm ci`, `npm run build`), and copy each app folder it names into the output folder as
// `<out>/<id>/`. electron-builder ships that folder as `Contents/Resources/bundled-apps/`, which a
// packaged Pomade installs from at start.
//
// Usage: node scripts/bundle-apps.mjs [--list <bundled-apps.json>] [--out <folder>]
// Defaults: the repo's `bundled-apps.json`, output `bundled/`. The output is made anew; a repo
// that is missing its tag, fails its build, or names a folder whose manifest is invalid or has
// another id fails the run.

import { execFileSync } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseManifest } from 'pomade-kit/protocol'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** @param {string[]} argv */
function args(argv) {
  const out = { list: join(ROOT, 'bundled-apps.json'), out: join(ROOT, 'bundled') }
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if ((flag !== '--list' && flag !== '--out') || !value) throw new Error(`usage: bundle-apps.mjs [--list <file>] [--out <folder>] (got ${flag})`)
    out[flag.slice(2)] = resolve(value)
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {{ repo: string, tag: string, apps: Record<string, string> }[]}
 */
function parseList(value) {
  const repos = /** @type {{ repos?: unknown }} */ (value)?.repos
  if (!Array.isArray(repos)) throw new Error('bundled-apps.json: "repos" must be a list')
  return repos.map((r, i) => {
    if (!r || typeof r.repo !== 'string' || typeof r.tag !== 'string' || !r.apps || typeof r.apps !== 'object') {
      throw new Error(`bundled-apps.json: repos[${i}] needs "repo", "tag" and "apps" ({ "<id>": "<folder>" })`)
    }
    return r
  })
}

/** @param {string} cwd @param {string} cmd @param {string[]} argv */
function run(cwd, cmd, argv) {
  execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
}

const opts = args(process.argv.slice(2))
const list = parseList(JSON.parse(await readFile(opts.list, 'utf8')))
await rm(opts.out, { recursive: true, force: true })
await mkdir(opts.out, { recursive: true })
const work = await mkdtemp(join(tmpdir(), 'pomade-bundle-'))
const seen = new Set()
try {
  for (const [i, entry] of list.entries()) {
    const src = join(work, String(i))
    console.log(`bundle-apps: ${entry.repo} @ ${entry.tag}`)
    run(work, 'git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--branch', entry.tag, entry.repo, src])
    run(src, 'npm', ['ci', '--no-audit', '--no-fund'])
    run(src, 'npm', ['run', 'build'])
    for (const [id, folder] of Object.entries(entry.apps)) {
      if (seen.has(id)) throw new Error(`bundle-apps: "${id}" is bundled twice`)
      seen.add(id)
      const from = join(src, folder)
      const parsed = parseManifest(JSON.parse(await readFile(join(from, 'manifest.json'), 'utf8').catch(() => 'null')))
      if (!parsed.ok) {
        const errors = /** @type {{ errors?: { field: string, message: string }[] }} */ (parsed).errors
        const why = Array.isArray(errors) ? errors.map((e) => `${e.field}: ${e.message}`).join('; ') : 'missing'
        throw new Error(`bundle-apps: ${entry.repo}@${entry.tag} ${folder}: invalid manifest.json (${why})`)
      }
      if (parsed.manifest.id !== id) throw new Error(`bundle-apps: ${folder} holds "${parsed.manifest.id}", not "${id}"`)
      await access(join(from, parsed.manifest.entry ?? 'index.html')).catch(() => {
        throw new Error(`bundle-apps: ${folder}: the entry file is missing`)
      })
      await cp(from, join(opts.out, id), { recursive: true, dereference: true })
      console.log(`bundle-apps: ${id} ${parsed.manifest.version} ← ${entry.repo}@${entry.tag}:${folder}`)
    }
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
