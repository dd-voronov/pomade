// Pomade — the `pomade` command (docs/HOST-API.md §2): install, remove and dev-link hosted apps;
// add or remove the PATH line that puts a Pomade's command folder on PATH in other terminals; list
// the workspace's projects with their stable ids.
// Runs under plain Node (type stripping, no build, no Pomade running): `bin/pomade` imports this
// file directly, so it and everything it imports use erasable TypeScript and explicit `.ts`
// import paths. A running Pomade picks every change up through its watcher on the user-data
// folder — nothing here talks to Pomade.

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  APP_ID_RE,
  APP_LINKS_FILE,
  callCycles,
  APPS_DIR,
  MANIFEST_FILE,
  manifestSummary,
  parseAppLinks,
  parseDevTarget,
  parseManifest,
  serializeAppLinks,
  type AppLink,
  type AppManifest,
  type ManifestResult
} from '../shared/app-manifest.ts'
import { HOME_FILES } from 'pomade-kit/protocol'

import { missingSkills, skillLines } from './app-skills.ts'
import { projectLines, projectsWorkspace, readProjects } from './projects.ts'
import { ensureAppKey, removeAppKey } from '../main/app-keys.ts'
import { clearRemoval, collectRetiredBuilds, installBuild, installedIds, recordRemoval, removeInstalled } from '../main/app-install-core.ts'
import { refusedUnderTest, resolveShellRc } from '../main/owner-paths.ts'
import { installPathLine, readPathLine, removePathLine, type PathLineState } from '../main/shell-path-line.ts'

const USAGE = `Usage: pomade apps <command> [--stable]
       pomade path <install | remove | status> [--stable]
       pomade projects [--json] [--stable]

Apps:
  install <build-folder>                   validate, print the summary, copy into <userData>/apps/<id>/,
                                           and say where each skill the app ships is
  remove <id>                              remove an installed app (a bundled app stays removed)
  link <build-folder | http://localhost:PORT>  register a dev link (wins over an install)
  unlink <id>                              remove a dev link
  list                                     installed apps and dev links, with versions

Path (your apps' commands in terminals Pomade did not start):
  install                                  add one marked line to \${ZDOTDIR:-~}/.zprofile that puts
                                           the Pomade's command folder (<home>/bin) on PATH
  remove                                   take Pomade's line out; the rest of the file stays as it was
  status                                   say whether the line is there and which folder it names

Projects (works with Pomade closed):
  projects                                 the open workspace's projects: stable id, name, folder
                                           (read from <workspace>/.pomade/workspace.json); --json
                                           prints { workspace, projects: [{ id, name, root, path }] }

Targets the dev Pomade (user data pomade-dev, home ~/.pomade-dev) by default. --stable targets the
stable Pomade (~/.pomade) — apps only on the Owner's explicit word (HOST-API.md §8). POMADE_USER_DATA and
POMADE_HOME override them (a Pomade terminal, and the pomade shim in a Pomade's command folder, set
them to that Pomade's). The workspace is POMADE_WORKSPACE (a Pomade terminal sets it), else the one
the target Pomade has open.`

class CliError extends Error {}

/** Electron's appData folder for this platform (where `userData` lives by default). */
function appDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  return process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
}

/** The target Pomade's user-data folder. Mirrors main/index.ts: dev = `pomade-dev`; stable =
 *  the packaged productName `Pomade`. A test run (`NODE_ENV=test`) has only `POMADE_USER_DATA`,
 *  never the Owner's real folder (`owner-paths.ts`). */
export function userDataDir(stable: boolean): string {
  const override = process.env['POMADE_USER_DATA']
  if (process.env['NODE_ENV'] === 'test') return testHook('POMADE_USER_DATA', override)
  if (override && override.trim()) return override
  return join(appDataDir(), stable ? 'Pomade' : 'pomade-dev')
}

/** A test run's folder from its test hook; refused when unset or the Owner's real one. */
function testHook(name: string, value: string | undefined): string {
  if (!value || !value.trim() || refusedUnderTest(process.env, name, value, homedir())) {
    throw new CliError(`a test run needs ${name} set to a test folder, not the Owner's real one`)
  }
  return value
}

async function readFolderManifest(folder: string): Promise<ManifestResult> {
  let text: string
  try {
    text = await fs.readFile(join(folder, MANIFEST_FILE), 'utf8')
  } catch {
    return { ok: false, errors: [`no ${MANIFEST_FILE} in ${folder}`] }
  }
  return parseManifest(text)
}

async function fetchUrlManifest(url: string): Promise<ManifestResult> {
  let text: string
  try {
    const res = await fetch(`${url}/${MANIFEST_FILE}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (err) {
    return { ok: false, errors: [`cannot fetch ${url}/${MANIFEST_FILE}: ${(err as Error).message}`] }
  }
  return parseManifest(text)
}

function requireValid(result: ManifestResult, where: string): { manifest: AppManifest; unsupportedKeys: string[] } {
  if (!result.ok) {
    throw new CliError(`invalid manifest in ${where}:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`)
  }
  return result
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function readLinks(ud: string): Promise<AppLink[]> {
  try {
    return parseAppLinks(await fs.readFile(join(ud, APP_LINKS_FILE), 'utf8'))
  } catch {
    return []
  }
}

/** Atomic write (temp file + rename), so a watching Pomade never reads half a file. */
async function writeLinks(ud: string, links: AppLink[]): Promise<void> {
  await fs.mkdir(ud, { recursive: true })
  const tmp = join(ud, `.${APP_LINKS_FILE}.${process.pid}.tmp`)
  await fs.writeFile(tmp, serializeAppLinks(links), 'utf8')
  await fs.rename(tmp, join(ud, APP_LINKS_FILE))
}

type Print = (line: string) => void

async function install(ud: string, folderArg: string, print: Print): Promise<void> {
  const folder = resolve(folderArg)
  if (!(await isDir(folder))) throw new CliError(`not a folder: ${folder}`)
  const { manifest, unsupportedKeys } = requireValid(await readFolderManifest(folder), folder)
  try {
    if (!(await fs.stat(join(folder, manifest.entry))).isFile()) throw new Error()
  } catch {
    throw new CliError(`the entry file "${manifest.entry}" is missing in ${folder}`)
  }
  const missing = await missingSkills(manifest, folder)
  if (missing.length > 0) {
    throw new CliError(`no SKILL.md in the skill folder${missing.length === 1 ? '' : 's'} ${missing.join(', ')} of ${folder}`)
  }
  for (const line of manifestSummary(manifest, unsupportedKeys)) print(line)

  // A fresh build folder, then the app's link swapped to it: a watching Pomade sees the old build or
  // the new one, never a half-copied folder, and a process still running from the old build (an
  // app's keeper) keeps its files until it is done with them.
  const { replaced, dest } = await installBuild(ud, manifest.id, folder)
  await clearRemoval(ud, manifest.id)
  await collectRetiredBuilds(ud)
  // E-028 — the app's key for its backend and commands on the Host API socket (kept on update).
  await ensureAppKey(ud, manifest.id)
  print(`${replaced ? 'Updated' : 'Installed'} into ${dest}`)
  await reportCycles(ud, manifest, print)
  for (const line of skillLines(manifest, dest)) print(line)
  if ((await readLinks(ud)).some((l) => l.id === manifest.id)) {
    print(`Note: a dev link for "${manifest.id}" is registered and takes precedence (pomade apps unlink ${manifest.id}).`)
  }
}

/** E-028 — every hosted app's `calls` (installs, then folder links over them), with `extra` (the
 *  app just installed or linked) winning. */
async function hostedCalls(ud: string, extra: AppManifest): Promise<{ id: string; calls: string[] }[]> {
  const byId = new Map<string, string[]>()
  const apps = join(ud, APPS_DIR)
  for (const name of await installedIds(ud)) {
    const r = await readFolderManifest(join(apps, name))
    if (r.ok) byId.set(r.manifest.id, r.manifest.calls)
  }
  for (const l of await readLinks(ud)) {
    if (!l.target.startsWith('/')) continue
    const r = await readFolderManifest(l.target)
    if (r.ok) byId.set(r.manifest.id, r.manifest.calls)
  }
  byId.set(extra.id, extra.calls)
  return [...byId].map(([id, calls]) => ({ id, calls }))
}

/** PLATFORM rule 4: report call cycles the app takes part in (not refused — the user decides). */
async function reportCycles(ud: string, manifest: AppManifest, print: Print): Promise<void> {
  for (const cycle of callCycles(await hostedCalls(ud, manifest))) {
    if (cycle.includes(manifest.id)) print(`Warning: call cycle ${cycle.join(' → ')} — PLATFORM rule 4 allows no call cycles.`)
  }
}

async function remove(ud: string, id: string, print: Print): Promise<void> {
  const dest = join(ud, APPS_DIR, id)
  if (!APP_ID_RE.test(id) || !(await isDir(dest))) {
    throw new CliError(`"${id}" is not installed in ${join(ud, APPS_DIR)}`)
  }
  const r = await readFolderManifest(dest)
  await removeInstalled(ud, id)
  // A bundled app removed by the user is not put back by the Pomade release carrying this build.
  if (r.ok) await recordRemoval(ud, id, r.manifest.version)
  await removeAppKey(ud, id)
  await collectRetiredBuilds(ud)
  print(`Removed ${id}`)
}

async function link(ud: string, targetArg: string, print: Print): Promise<void> {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(targetArg)
  const target = parseDevTarget(isUrl ? targetArg : resolve(targetArg))
  if ('error' in target) throw new CliError(target.error)
  let result: ManifestResult
  let stored: string
  if (target.kind === 'url') {
    result = await fetchUrlManifest(target.url)
    stored = target.url
  } else {
    if (!(await isDir(target.path))) throw new CliError(`not a folder: ${target.path}`)
    result = await readFolderManifest(target.path)
    stored = target.path
  }
  const { manifest, unsupportedKeys } = requireValid(result, stored)
  if (target.kind === 'folder') {
    const missing = await missingSkills(manifest, target.path)
    if (missing.length > 0) {
      throw new CliError(`no SKILL.md in the skill folder${missing.length === 1 ? '' : 's'} ${missing.join(', ')} of ${target.path}`)
    }
  }
  for (const line of manifestSummary(manifest, unsupportedKeys)) print(line)
  const links = (await readLinks(ud)).filter((l) => l.id !== manifest.id)
  links.push({ id: manifest.id, target: stored })
  await writeLinks(ud, links)
  await ensureAppKey(ud, manifest.id)
  print(`Linked ${manifest.id} → ${stored}`)
  await reportCycles(ud, manifest, print)
  if (target.kind === 'folder') for (const line of skillLines(manifest, target.path)) print(line)
}

async function unlink(ud: string, id: string, print: Print): Promise<void> {
  const links = await readLinks(ud)
  if (!links.some((l) => l.id === id)) throw new CliError(`no dev link for "${id}"`)
  await writeLinks(ud, links.filter((l) => l.id !== id))
  print(`Unlinked ${id}`)
}

async function list(ud: string, print: Print): Promise<void> {
  const apps = join(ud, APPS_DIR)
  const names = await installedIds(ud)
  const links = await readLinks(ud)
  print(`User data: ${ud}`)
  print('Installed:')
  if (names.length === 0) print('  (none)')
  for (const name of names) {
    const r = await readFolderManifest(join(apps, name))
    const linked = links.some((l) => l.id === name) ? '  [overridden by a dev link]' : ''
    print(r.ok ? `  ${name}  ${r.manifest.version}  ${r.manifest.name}${linked}` : `  ${name}  (invalid manifest)${linked}`)
  }
  print('Dev links:')
  if (links.length === 0) print('  (none)')
  for (const l of links) print(`  ${l.id}  → ${l.target}`)
}

/** The target Pomade's home: `POMADE_HOME`, else `~/.pomade` (stable) / `~/.pomade-dev` (dev); a
 *  test run has only `POMADE_HOME`. Mirrors main/app-commands-core.ts#resolvePomadeHome. */
export function pomadeHomeDir(stable: boolean): string {
  const override = process.env['POMADE_HOME']
  if (process.env['NODE_ENV'] === 'test') return testHook('POMADE_HOME', override)
  if (override && override.trim()) return override
  return join(homedir(), stable ? '.pomade' : '.pomade-dev')
}

function tilde(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function pathStatusLine(s: PathLineState): string {
  if (s.lineTarget === s.binDir) return `On: ${tilde(s.rcFile)} puts ${tilde(s.binDir)} on PATH.`
  if (s.lineTarget === null) return `Off: ${tilde(s.rcFile)} has no Pomade line.`
  if (s.lineTarget === '') return `${tilde(s.rcFile)} has a Pomade line that was edited; \`pomade path install\` repairs it.`
  return `${tilde(s.rcFile)} puts another Pomade's commands on PATH (${tilde(s.lineTarget)}).`
}

async function pathCommand(command: string, stable: boolean, print: Print): Promise<void> {
  const rcFile = resolveShellRc(process.env, homedir())
  if (!rcFile) throw new CliError('no shell rc file in a test run without POMADE_SHELL_RC')
  const binDir = join(pomadeHomeDir(stable), HOME_FILES.bin)
  switch (command) {
    case 'install':
      print(pathStatusLine(await installPathLine(rcFile, binDir)))
      print('New terminals pick it up; an open one does after `exec zsh -l`.')
      break
    case 'remove': {
      const before = await readPathLine(rcFile, binDir)
      await removePathLine(rcFile, binDir)
      print(before.lineTarget === null ? `Nothing to remove: ${tilde(rcFile)} has no Pomade line.` : `Removed Pomade's line from ${tilde(rcFile)}.`)
      break
    }
    case 'status':
      print(pathStatusLine(await readPathLine(rcFile, binDir)))
      break
    default:
      throw new CliError(`unknown command: path ${command}\n\n${USAGE}`)
  }
}

async function projectsCommand(stable: boolean, json: boolean, print: Print): Promise<void> {
  const ud = userDataDir(stable)
  const root = await projectsWorkspace(process.env, pomadeHomeDir(stable), ud)
  if (!root) throw new CliError(`no workspace: the Pomade with user data ${ud} has none open, and POMADE_WORKSPACE is not set`)
  let projects: Awaited<ReturnType<typeof readProjects>>
  try {
    projects = await readProjects(root)
  } catch (err) {
    throw new CliError(`cannot read the projects of ${root}: ${(err as Error).message}`)
  }
  if (json) print(JSON.stringify({ workspace: root, projects }, null, 2))
  else for (const line of projectLines(root, projects)) print(line)
}

/** Run the command; returns the process exit code. */
export async function main(
  argv: string[],
  print: Print = (l) => console.log(l),
  printErr: Print = (l) => console.error(l)
): Promise<number> {
  const stable = argv.includes('--stable')
  const json = argv.includes('--json')
  const args = argv.filter((a) => a !== '--stable' && a !== '--json')
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    print(USAGE)
    return args.length === 0 ? 1 : 0
  }
  const [group, command, arg, ...extra] = args
  try {
    if (json && group !== 'projects') throw new CliError(`--json is only for "projects"\n\n${USAGE}`)
    if (group === 'projects') {
      if (command) throw new CliError(`wrong arguments for "projects"\n\n${USAGE}`)
      await projectsCommand(stable, json, print)
      return 0
    }
    if (group === 'path' && command) {
      if (arg || extra.length > 0) throw new CliError(`wrong arguments for "path ${command}"\n\n${USAGE}`)
      await pathCommand(command, stable, print)
      return 0
    }
    if (group !== 'apps' || !command) throw new CliError(`unknown command: ${args.join(' ')}\n\n${USAGE}`)
    const needsArg = command !== 'list'
    if ((needsArg && !arg) || extra.length > 0 || (!needsArg && arg)) {
      throw new CliError(`wrong arguments for "apps ${command}"\n\n${USAGE}`)
    }
    const ud = userDataDir(stable)
    switch (command) {
      case 'install':
        await install(ud, arg, print)
        break
      case 'remove':
        await remove(ud, arg, print)
        break
      case 'link':
        await link(ud, arg, print)
        break
      case 'unlink':
        await unlink(ud, arg, print)
        break
      case 'list':
        await list(ud, print)
        break
      default:
        throw new CliError(`unknown command: apps ${command}\n\n${USAGE}`)
    }
    return 0
  } catch (err) {
    printErr(`pomade: ${err instanceof CliError ? err.message : (err as Error).stack ?? String(err)}`)
    return 1
  }
}
