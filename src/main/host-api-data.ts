// Pomade — E-030: the workspace-data methods of the Host API (docs/HOST-API.md §4 "files.read",
// "files.write"). Main runs them after `host-api.ts` has gated the capability; this module
// validates params (`host-api-data-core.ts`) and does the filesystem work.
//
// Every write goes through the platform's guarded file door: the workspace-path rule, the
// `ws-path` escape guard, and a real-path check — a write never lands outside the workspace by
// way of a symlink. Writes are atomic (tmp + rename; an exclusive create links its tmp file into
// place). Field and body writes run the kit's field-only code (`pomade-kit/frontmatter`, the
// same code the editor's properties panel runs) and skip the write when the bytes are
// identical. App writes to one file run one at a time (`withFileLock`), so two apps' field writes
// never lose each other's change; a conditional write (`ifMtime`) checks the mtime right before
// the rename (`writeFileAtomic`). Pomade does not tell its editor about an app's write: the open-doc watcher
// (`doc-watch.ts`, rule 8) sees it like any other writer's, so a doc with unsaved edits shows
// "File changed since your edits" and nothing is overwritten in the editor.

import { promises as fs } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'

import { shell } from 'electron'

import { removeField, setBody, setField, setKeyLines, type FieldWriteResult } from 'pomade-kit/frontmatter'
import {
  isMarkdownPath,
  isPomadeFolderPath,
  readFrontmatter,
  parseAgentTabsParams,
  symlinkScopeCovers,
  type AgentTabsMethod,
  type DeleteFileResult,
  type MethodParams,
  type MethodResult
} from 'pomade-kit/protocol'

import type { AppCallResult } from '@shared/types'
import { callScopeFolders } from './app-scope-folders'
import { ChangedOnDiskError, createFileAtomic, writeFileAtomic } from './atomic-write'
import { deletePath, fieldWriteError, hasExtension, isSelfOrInside, parseDataParams, pickStart, revealRepoRoot, type DataMethod } from './host-api-data-core'
import { absOf, CallError, fsError, requireNotPomadeFolder, requireRealAllowed } from './host-api-fs'
import { showDialog } from './windows'
import { requireRoot, toRel } from './ws-path'

/** An existing regular file (symlinks followed), checked to resolve inside the workspace and
 *  outside its `.pomade` folder. */
async function existingFile(rel: string): Promise<{ absPath: string; mode: number }> {
  const absPath = absOf(rel)
  let st
  try {
    st = await fs.stat(absPath)
  } catch (err) {
    throw fsError(err, rel)
  }
  if (!st.isFile()) throw new CallError('io-error', `${JSON.stringify(rel)} is not a file`)
  await requireRealAllowed(absPath, rel)
  return { absPath, mode: st.mode & 0o7777 }
}

/** The tail of each file's queue of app writes, by real path. */
const fileLocks = new Map<string, Promise<unknown>>()

/** Run `write` once every earlier app write to the same real file has settled. */
async function withFileLock<T>(realPath: string, write: () => Promise<T>): Promise<T> {
  const before = fileLocks.get(realPath) ?? Promise.resolve()
  const run = before.then(write, write)
  const tail = run.catch(() => {})
  fileLocks.set(realPath, tail)
  try {
    return await run
  } finally {
    if (fileLocks.get(realPath) === tail) fileLocks.delete(realPath)
  }
}

function changedOnDisk(rel: string): CallError {
  return new CallError('changed-on-disk', `${JSON.stringify(rel)} changed on disk since it was read; nothing was written`)
}

/** Refuse a conditional write up front when the file is no longer the one read. */
async function requireMtime(rel: string, realPath: string, ifMtime: number | undefined): Promise<void> {
  if (ifMtime === undefined) return
  let st
  try {
    st = await fs.stat(realPath)
  } catch (err) {
    throw fsError(err, rel)
  }
  if (st.mtimeMs !== ifMtime) throw changedOnDisk(rel)
}

/** Replace an existing file's text atomically at its real path (a symlinked file's link stays a
 *  link), keeping the file's permission bits; with `ifMtime`, only while its mtime is that. */
async function replaceText(rel: string, realPath: string, mode: number, text: string, ifMtime: number | undefined): Promise<void> {
  try {
    await writeFileAtomic(realPath, text, { mode, ifMtime })
  } catch (err) {
    if (err instanceof ChangedOnDiskError) throw changedOnDisk(rel)
    throw fsError(err, rel)
  }
}

/** Replace an existing file's whole text (`files.write`). */
async function writeWhole(rel: string, text: string, ifMtime: number | undefined): Promise<void> {
  const { absPath, mode } = await existingFile(rel)
  const realPath = await fs.realpath(absPath)
  await withFileLock(realPath, async () => {
    await requireMtime(rel, realPath, ifMtime)
    await replaceText(rel, realPath, mode, text, ifMtime)
  })
}

async function readText(rel: string, absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, 'utf8')
  } catch (err) {
    throw fsError(err, rel)
  }
}

/** Run a kit edit on a file; write only when the bytes changed. With `ifMtime`, refused when the
 *  file is not the one read — before the edit (a stale no-op is refused too) and again at the
 *  rename. */
async function editFile(rel: string, ifMtime: number | undefined, run: (text: string) => FieldWriteResult): Promise<{ changed: boolean }> {
  const { absPath, mode } = await existingFile(rel)
  const realPath = await fs.realpath(absPath)
  return withFileLock(realPath, async () => {
    await requireMtime(rel, realPath, ifMtime)
    const r = run(await readText(rel, realPath))
    if (!r.ok) {
      const e = fieldWriteError(r.reason, rel, r.message)
      throw new CallError(e.code, e.message)
    }
    if (r.changed) await replaceText(rel, realPath, mode, r.text, ifMtime)
    return { changed: r.changed }
  })
}

/** `files.readFile`: the text, size and mtime from one open file (so `mtimeMs` is the text's), and
 *  with `frontmatter` a Markdown file's record as `files.readFolder` reports it. */
async function readFile(p: MethodParams<'files.readFile'>): Promise<MethodResult<'files.readFile'>> {
  const absPath = absOf(p.path)
  let st
  try {
    st = await fs.stat(absPath)
  } catch (err) {
    throw fsError(err, p.path)
  }
  if (!st.isFile()) throw new CallError('io-error', `${JSON.stringify(p.path)} is not a file`)
  await requireNotPomadeFolder(absPath, p.path)
  let content: string
  try {
    const handle = await fs.open(absPath, 'r')
    try {
      st = await handle.stat()
      content = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (err) {
    throw fsError(err, p.path)
  }
  const result = { content, size: st.size, mtimeMs: st.mtimeMs }
  return p.frontmatter && isMarkdownPath(p.path) ? { ...result, ...readFrontmatter(content) } : result
}

async function createFile(p: MethodParams<'files.create'>): Promise<MethodResult<'files.create'>> {
  const absPath = absOf(p.path)
  await requireRealAllowed(dirname(absPath), p.path)
  try {
    await fs.mkdir(dirname(absPath), { recursive: true })
    await createFileAtomic(absPath, p.content ?? '')
  } catch (err) {
    throw fsError(err, p.path)
  }
  return {}
}

async function move(p: MethodParams<'files.move'>): Promise<MethodResult<'files.move'>> {
  const fromAbs = absOf(p.from)
  const toAbs = absOf(p.to)
  try {
    await fs.lstat(fromAbs)
  } catch (err) {
    throw fsError(err, p.from)
  }
  if (p.from === p.to) return {}
  if (isSelfOrInside(p.from, p.to)) {
    throw new CallError('invalid-params', `Cannot move ${JSON.stringify(p.from)} into itself`)
  }
  // The entry itself moves (a symlink stays a link); both folders must really be in the workspace.
  await requireRealAllowed(dirname(fromAbs), p.from)
  await requireRealAllowed(dirname(toAbs), p.to)
  const taken = await fs.lstat(toAbs).then(
    () => true,
    () => false
  )
  if (taken) throw new CallError('already-exists', `${JSON.stringify(p.to)} already exists`)
  try {
    await fs.mkdir(dirname(toAbs), { recursive: true })
    await fs.rename(fromAbs, toAbs)
  } catch (err) {
    throw fsError(err, p.to)
  }
  return {}
}

/** T-236 — move one file to the Trash (`shell.trashItem`: Finder can put it back); a symlink goes
 *  as the link itself, never its target. `raw` is the path as the app gave it, for messages. */
async function trashFile(rel: string, raw: string): Promise<void> {
  const absPath = absOf(rel)
  let st
  try {
    st = await fs.lstat(absPath)
  } catch (err) {
    throw fsError(err, raw)
  }
  // The entry's folder must really be in the workspace; what it names must not be in `.pomade`.
  await requireRealAllowed(dirname(absPath), raw)
  await requireNotPomadeFolder(absPath, raw)
  const folder =
    st.isDirectory() ||
    (st.isSymbolicLink() &&
      (await fs.stat(absPath).then(
        (t) => t.isDirectory(),
        () => false
      )))
  if (folder) throw new CallError('invalid-params', `${JSON.stringify(raw)} is a folder; files.delete deletes files only`)
  try {
    await shell.trashItem(absPath)
  } catch (err) {
    throw new CallError('io-error', `${JSON.stringify(raw)} could not be moved to the Trash: ${(err as Error)?.message ?? String(err)}`)
  }
}

/** T-236 — `files.delete`: each path on its own, in the order given; one path's failure never
 *  stops the others. The platform watcher and the open-doc watcher see the deletes like any
 *  other writer's (rule 8). */
async function deleteFiles(p: MethodParams<'files.delete'>): Promise<MethodResult<'files.delete'>> {
  const results: DeleteFileResult[] = []
  for (const raw of p.paths) {
    const checked = deletePath(raw)
    if (!checked.ok) {
      results.push({ path: raw, ok: false, error: checked.error })
      continue
    }
    try {
      await trashFile(checked.path, raw)
      results.push({ path: raw, ok: true })
    } catch (err) {
      const error =
        err instanceof CallError
          ? { code: err.code, message: err.message }
          : { code: 'io-error' as const, message: (err as Error)?.message ?? String(err) }
      results.push({ path: raw, ok: false, error })
    }
  }
  return { results }
}

/** Stat `rel` and require a file (`dir: false`) or a folder (`dir: true`) that does not really
 *  lie in the workspace's `.pomade` folder. */
async function requireKind(rel: string, dir: boolean): Promise<void> {
  const absPath = absOf(rel)
  let st
  try {
    st = await fs.stat(absPath)
  } catch (err) {
    throw fsError(err, rel)
  }
  if (st.isDirectory() !== dir) {
    throw new CallError('io-error', `${JSON.stringify(rel)} is not a ${dir ? 'folder' : 'file'}`)
  }
  await requireNotPomadeFolder(absPath, rel)
}

/** Stat `rel` and require a file or a folder that does not really lie in the workspace's `.pomade`
 *  folder. */
/** `git.reveal`'s path as a workspace-relative root; `not-found` when it does not exist or lies
 *  outside the workspace (no repo of Pomade's can be there). */
async function revealRoot(path: string): Promise<string> {
  const missing = new CallError('not-found', `No repository at ${JSON.stringify(path)}`)
  let real: string
  try {
    real = await fs.realpath(path)
  } catch {
    throw missing
  }
  const root = revealRepoRoot(real, await fs.realpath(requireRoot()))
  if (root === null) throw missing
  return root
}

async function requireExists(rel: string): Promise<void> {
  const absPath = absOf(rel)
  try {
    await fs.stat(absPath)
  } catch (err) {
    throw fsError(err, rel)
  }
  await requireNotPomadeFolder(absPath, rel)
}

// ─── Scoped symlinks ──────────────────────────────────────────────────────────

/** The calling app, as the data methods need it. */
export interface DataCaller {
  appId: string
  /** The manifest's `symlinks` folder patterns. */
  symlinks: readonly string[]
}

/** A link path the manifest grants: directly inside a declared `symlinks` folder, and reached
 *  without passing through any symlinked folder (the link lands exactly where the pattern says,
 *  never wherever another link points). */
async function grantedLinkPath(rel: string, caller: DataCaller): Promise<string> {
  if (!symlinkScopeCovers(caller.symlinks, rel)) {
    throw new CallError('capability-denied', `${JSON.stringify(rel)} is not in a folder the manifest's "symlinks" declares`)
  }
  const linkAbs = absOf(rel)
  const root = requireRoot()
  const canonRoot = await fs.realpath(root)
  // The nearest existing ancestor folder must be its own real path.
  for (let dir = dirname(linkAbs); ; dir = dirname(dir)) {
    let real: string
    try {
      real = await fs.realpath(dir)
    } catch {
      continue
    }
    if (real !== join(canonRoot, relative(root, dir))) {
      throw new CallError('capability-denied', `${JSON.stringify(rel)}: a folder on its path is a symlink`)
    }
    return linkAbs
  }
}

async function createSymlink(p: MethodParams<'files.symlink'>, caller: DataCaller): Promise<void> {
  const linkAbs = await grantedLinkPath(p.path, caller)
  const targetAbs = absOf(p.target)
  try {
    await fs.stat(targetAbs)
  } catch (err) {
    throw fsError(err, p.target)
  }
  await requireNotPomadeFolder(targetAbs, p.target)
  const taken = await fs.lstat(linkAbs).then(
    () => true,
    () => false
  )
  if (taken) throw new CallError('already-exists', `${JSON.stringify(p.path)} already exists`)
  try {
    await fs.mkdir(dirname(linkAbs), { recursive: true })
    // Relative, so the link survives moving the whole workspace.
    await fs.symlink(relative(dirname(linkAbs), targetAbs), linkAbs)
  } catch (err) {
    throw fsError(err, p.path)
  }
}

async function removeSymlink(p: MethodParams<'files.removeSymlink'>, caller: DataCaller): Promise<void> {
  const linkAbs = await grantedLinkPath(p.path, caller)
  let st
  try {
    st = await fs.lstat(linkAbs)
  } catch (err) {
    throw fsError(err, p.path)
  }
  if (!st.isSymbolicLink()) {
    throw new CallError('invalid-params', `${JSON.stringify(p.path)} is not a symlink; only links are removed`)
  }
  try {
    await fs.unlink(linkAbs)
  } catch (err) {
    throw fsError(err, p.path)
  }
}

// ─── Pickers ──────────────────────────────────────────────────────────────────

interface PickRequest {
  /** Absolute folder the picker opens in. */
  defaultPath: string
  message: string
  /** A file picker's extensions (lowercase, no dot); absent for a folder picker or any file. */
  extensions?: string[]
}

/** Testing hook (NODE_ENV=test only, docs/contracts/test-hooks.md): a spec queues the
 *  user's choices — absolute paths, or null to cancel — and reads every request. With no answer
 *  queued the picker is cancelled; a real dialog never opens under test. */
interface PickHook {
  answers: (string | null)[]
  requests: PickRequest[]
}

async function choosePath(kind: 'folder' | 'file', req: PickRequest): Promise<string | null> {
  if (process.env.NODE_ENV === 'test') {
    const g = globalThis as { __pomadePick?: PickHook }
    const hook = (g.__pomadePick ??= { answers: [], requests: [] })
    hook.requests.push(req)
    return hook.answers.shift() ?? null
  }
  const r = await showDialog(
    kind === 'folder'
      ? { defaultPath: req.defaultPath, properties: ['openDirectory', 'createDirectory'], message: req.message, buttonLabel: 'Choose' }
      : {
          defaultPath: req.defaultPath,
          properties: ['openFile'],
          message: req.message,
          buttonLabel: 'Choose',
          ...(req.extensions ? { filters: [{ name: req.extensions.join(', '), extensions: req.extensions }] } : {})
        }
  )
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
}

function isInsideAbs(path: string, folder: string): boolean {
  const r = relative(folder, path)
  return !r.startsWith('..') && !isAbsolute(r)
}

async function isFolder(absPath: string): Promise<boolean> {
  return fs.stat(absPath).then(
    (st) => st.isDirectory(),
    () => false
  )
}

async function isFile(absPath: string): Promise<boolean> {
  return fs.stat(absPath).then(
    (st) => st.isFile(),
    () => false
  )
}

/** The native folder picker bounded by `rootRel` (workspace-relative; '' = the workspace). The
 *  macOS panel cannot be fenced in, so a choice outside the root (by real path) is refused in the
 *  panel's own message and the panel opens again at the root, until the user picks a folder
 *  inside it or cancels. Returns the chosen folder's workspace-relative real path, or null. */
export async function pickFolder(rootRel: string, initialRel: string | undefined): Promise<string | null> {
  const canonWs = await fs.realpath(requireRoot())
  const rootAbs = absOf(rootRel)
  if (!(await isFolder(rootAbs))) throw new CallError('not-found', `${JSON.stringify(rootRel)} is not a folder`)
  const canonRoot = await fs.realpath(rootAbs)
  const label = rootRel === '' ? 'the workspace' : rootRel
  const startAbs = absOf(pickStart(rootRel, initialRel))
  let req: PickRequest = {
    defaultPath: (await isFolder(startAbs)) ? startAbs : rootAbs,
    message: `Choose a folder inside ${label}`
  }
  for (;;) {
    const picked = await choosePath('folder', req)
    if (picked === null) return null
    const real = await fs.realpath(picked).catch(() => null)
    if (real !== null && (await isFolder(real)) && isInsideAbs(real, canonRoot) && isInsideAbs(real, canonWs)) {
      const rel = toRel(canonWs, real)
      if (!isPomadeFolderPath(rel)) return rel
      req = { defaultPath: rootAbs, message: `Pomade's own .pomade folder can't be chosen. Choose another folder inside ${label}.` }
      continue
    }
    req = { defaultPath: rootAbs, message: `That folder is outside ${label}. Choose a folder inside it.` }
  }
}

/** The native file picker bounded by `underRel` (a workspace-relative folder; '' = the workspace),
 *  offering `extensions` when given. As for folders, a choice outside `under`, of another
 *  extension or inside Pomade's own `.pomade` folder (by real path) is refused in the panel's own
 *  message and the panel opens again at `under`, until the user picks a fitting file or cancels.
 *  Returns the chosen file's workspace-relative real path, or null. */
export async function pickFile(underRel: string, extensions: string[] | undefined): Promise<string | null> {
  const canonWs = await fs.realpath(requireRoot())
  const underAbs = absOf(underRel)
  if (!(await isFolder(underAbs))) throw new CallError('not-found', `${JSON.stringify(underRel)} is not a folder`)
  const canonUnder = await fs.realpath(underAbs)
  const label = underRel === '' ? 'the workspace' : underRel
  const kinds = extensions ? `${extensions.map((e) => `.${e}`).join(' or ')} file` : 'file'
  const base = { defaultPath: underAbs, ...(extensions ? { extensions } : {}) }
  let req: PickRequest = { ...base, message: `Choose a ${kinds} inside ${label}` }
  for (;;) {
    const picked = await choosePath('file', req)
    if (picked === null) return null
    const real = await fs.realpath(picked).catch(() => null)
    if (real === null || !(await isFile(real)) || !isInsideAbs(real, canonUnder) || !isInsideAbs(real, canonWs)) {
      req = { ...base, message: `That file is outside ${label}. Choose a ${kinds} inside it.` }
      continue
    }
    const rel = toRel(canonWs, real)
    if (isPomadeFolderPath(rel)) {
      req = { ...base, message: `Files in Pomade's own .pomade folder can't be chosen. Choose a ${kinds} inside ${label}.` }
    } else if (!hasExtension(rel, extensions)) {
      req = { ...base, message: `That is not a ${kinds}. Choose a ${kinds} inside ${label}.` }
    } else {
      return rel
    }
  }
}

async function run(method: DataMethod, params: MethodParams<DataMethod>, caller: DataCaller): Promise<unknown> {
  switch (method) {
    case 'files.readFile':
      return readFile(params as MethodParams<'files.readFile'>)
    case 'files.create':
      return createFile(params as MethodParams<'files.create'>)
    case 'files.write': {
      const p = params as MethodParams<'files.write'>
      await writeWhole(p.path, p.content, p.ifMtime)
      return {}
    }
    case 'files.setBody': {
      const p = params as MethodParams<'files.setBody'>
      return editFile(p.path, p.ifMtime, (text) => setBody(text, p.body))
    }
    case 'files.setField': {
      const p = params as MethodParams<'files.setField'>
      return editFile(p.path, p.ifMtime, (text) => setField(text, p.key, p.value))
    }
    case 'files.removeField': {
      const p = params as MethodParams<'files.removeField'>
      return editFile(p.path, p.ifMtime, (text) => removeField(text, p.key))
    }
    case 'files.setKeyLines': {
      const p = params as MethodParams<'files.setKeyLines'>
      return editFile(p.path, p.ifMtime, (text) => setKeyLines(text, p.key, p.text))
    }
    case 'files.move':
      return move(params as MethodParams<'files.move'>)
    case 'files.delete':
      return deleteFiles(params as MethodParams<'files.delete'>)
    case 'files.symlink':
      await createSymlink(params as MethodParams<'files.symlink'>, caller)
      return {}
    case 'files.removeSymlink':
      await removeSymlink(params as MethodParams<'files.removeSymlink'>, caller)
      return {}
    case 'files.reveal':
    case 'tabs.openFile':
    case 'tabs.openTerminal':
    case 'tabs.openAttached':
    case 'project.list':
    case 'project.getSettings':
    case 'project.setSettings':
    case 'project.getAgents':
    case 'project.setAgents':
    case 'files.pickFolder':
    case 'git.getState':
    case 'git.watch':
    case 'git.unwatch':
    case 'git.reveal':
    case 'project.activate':
      throw new Error(`${method} is served by the renderer`)
    case 'files.pickFile': {
      const p = params as MethodParams<'files.pickFile'>
      return { path: await pickFile(p.under ?? '', p.extensions) }
    }
    // E-047 — an app's scope folders are its own: the app id comes from the caller, never from params.
    case 'project.getScopeFolders':
    case 'project.addScopeFolder':
    case 'project.removeScopeFolder':
      return callScopeFolders(method, params as MethodParams<typeof method>, caller.appId)
  }
}

/** Serve one E-030 method (capability already gated). Throws CallError for protocol errors.
 *  Tab and project methods are validated here (tab paths: the path rule, the file or folder
 *  exists) and handed back as a delegated call: tabs, groups and projects are renderer-owned
 *  state. */
export async function callData(method: DataMethod, rawParams: unknown, caller: DataCaller): Promise<AppCallResult> {
  const { appId } = caller
  const p = parseDataParams(method, rawParams)
  if (!p.ok) return p
  switch (method) {
    case 'files.reveal': {
      const params = p.params as MethodParams<'files.reveal'>
      await requireExists(params.path)
      return { delegate: { method, params } }
    }
    case 'tabs.openFile': {
      const params = p.params as MethodParams<'tabs.openFile'>
      await requireKind(params.path, false)
      return { delegate: { method, params } }
    }
    case 'tabs.openTerminal': {
      const params = p.params as MethodParams<'tabs.openTerminal'>
      await requireKind(params.cwd, true)
      return { delegate: { method, params } }
    }
    // E-034 — any app's session, by reference: the owner is not asked (PLATFORM rule 4).
    case 'tabs.openAttached':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'project.list':
      return { delegate: { method, params: {} } }
    // An app's settings are its own: the app id comes from the calling frame, never from params.
    case 'project.getSettings':
      return { delegate: { method, params: p.params as MethodParams<typeof method>, appId } }
    case 'project.setSettings':
      return { delegate: { method, params: p.params as MethodParams<typeof method>, appId } }
    case 'project.getAgents':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'project.setAgents':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'project.activate':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    // The renderer resolves the root project, then asks main for the dialog (`apps.pickFolder`).
    case 'files.pickFolder':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    // Git state: the renderer serves its copy of the git-state snapshot, scoped by the project's
    // folder (`modules/apps/git-calls.ts`); watches live with the frame.
    case 'git.getState':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'git.watch':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'git.unwatch':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    // T-320 — main resolves the path to a workspace-relative root (real paths on both sides); the
    // renderer matches it against its git-state snapshot and shows the repo in the Git panel.
    case 'git.reveal': {
      const params = p.params as MethodParams<'git.reveal'>
      return { delegate: { method, params, root: await revealRoot(params.path) } }
    }
    default:
      return { ok: true, value: await run(method, p.params, caller) }
  }
}

/** E-033 — an `agentTabs.*` call (capability already gated): params checked by the kit's rule, a
 *  launch or resume folder checked to be a folder on disk, then handed to the renderer, which owns
 *  the tabs. Throws CallError for protocol errors. */
export async function callAgentTabs(method: AgentTabsMethod, rawParams: unknown): Promise<AppCallResult> {
  const p = parseAgentTabsParams(method, rawParams)
  if (!p.ok) return p
  switch (method) {
    case 'agentTabs.list':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'agentTabs.setTitle':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'agentTabs.focus':
      return { delegate: { method, params: p.params as MethodParams<typeof method> } }
    case 'agentTabs.launch': {
      const params = p.params as MethodParams<typeof method>
      if (params.cwd !== undefined) await requireKind(params.cwd, true)
      return { delegate: { method, params } }
    }
    case 'agentTabs.resume': {
      const params = p.params as MethodParams<typeof method>
      if (params.cwd !== undefined) await requireKind(params.cwd, true)
      return { delegate: { method, params } }
    }
  }
}
