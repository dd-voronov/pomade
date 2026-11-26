// scripts/bundle-apps.mjs against a local fixture repo: cloned at its tag, built with its own
// build, each named app folder copied out as `<out>/<id>/`; a wrong id fails the run.

import { execFileSync, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../../scripts/bundle-apps.mjs')

let tmp: string
let repo: string

const BUILD = `import { mkdirSync, writeFileSync } from 'node:fs'
for (const [dir, id] of [['dist/one', 'fx-one'], ['dist/two', 'fx-two']]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(dir + '/manifest.json', JSON.stringify({ id, name: id, version: process.env.npm_package_version, hostApi: 0, capabilities: [] }))
  writeFileSync(dir + '/index.html', '<!doctype html>')
}
`

function git(...argv: string[]): void {
  execFileSync('git', argv, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

async function list(apps: Record<string, string>, tag = 'v1.2.0'): Promise<string> {
  const file = join(tmp, `list-${Math.random().toString(36).slice(2)}.json`)
  await fs.writeFile(file, JSON.stringify({ repos: [{ repo, tag, apps }] }))
  return file
}

function bundle(listFile: string, out: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--list', listFile, '--out', out], { encoding: 'utf8', timeout: 60000 })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pomade-bundle-test-'))
  repo = join(tmp, 'repo')
  await fs.mkdir(repo)
  const pkg = { name: 'fx', version: '1.2.0', private: true, scripts: { build: 'node build.mjs' } }
  await fs.writeFile(join(repo, 'package.json'), JSON.stringify(pkg))
  await fs.writeFile(join(repo, 'package-lock.json'), JSON.stringify({ name: 'fx', version: '1.2.0', lockfileVersion: 3, requires: true, packages: { '': pkg } }))
  await fs.writeFile(join(repo, 'build.mjs'), BUILD)
  git('init', '-q')
  git('add', '.')
  git('commit', '-q', '-m', 'one')
  git('tag', 'v1.2.0')
  // A later commit the tag does not have.
  await fs.writeFile(join(repo, 'package.json'), JSON.stringify({ ...pkg, version: '9.9.9' }))
  git('commit', '-q', '-am', 'later')
}, 30000)

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('bundle-apps', () => {
  it('builds the repo at its tag and ships each named app folder under its id', async () => {
    const out = join(tmp, 'out')
    await fs.mkdir(join(out, 'stale'), { recursive: true })
    const r = bundle(await list({ 'fx-one': 'dist/one', 'fx-two': 'dist/two' }), out)
    expect(r.status, r.output).toBe(0)
    expect((await fs.readdir(out)).sort()).toEqual(['fx-one', 'fx-two'])
    const m = JSON.parse(await fs.readFile(join(out, 'fx-two', 'manifest.json'), 'utf8')) as { id: string; version: string }
    expect(m).toMatchObject({ id: 'fx-two', version: '1.2.0' })
  }, 60000)

  it('fails on a folder whose manifest has another id, and on a missing tag', async () => {
    const wrongId = bundle(await list({ 'fx-one': 'dist/two' }), join(tmp, 'out2'))
    expect(wrongId.status).not.toBe(0)
    expect(wrongId.output).toContain('holds "fx-two", not "fx-one"')
    expect(bundle(await list({ 'fx-one': 'dist/one' }, 'v404'), join(tmp, 'out3')).status).not.toBe(0)
  }, 60000)
})
