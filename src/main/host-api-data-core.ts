// Pomade — E-030: the workspace-data methods' pure decisions (docs/HOST-API.md §4 "files.write"):
// params validation for every E-030 method and the kit-refusal → error-code mapping. No
// Electron, no fs — `host-api-data.ts` runs the methods.

import { isAbsolute, relative, sep } from 'node:path'

import type { FieldWriteError } from 'pomade-kit/frontmatter'
import {
  FILES_DELETE_MAX_PATHS,
  checkSessionRef,
  isInside,
  jsonProblem,
  normalizeVisibleAgents,
  type ErrorPayload,
  type FrontmatterValue,
  type JsonValue,
  type MethodName,
  type MethodParams
} from 'pomade-kit/protocol'

import { workspacePath } from './host-api-core'

/** `git.reveal`: the repo root `realPath` names, workspace-relative (`""` = the workspace root), or
 *  null when it lies outside the workspace. Both paths are real (symlinks resolved), so a `/tmp/…`
 *  path and its `/private/tmp/…` target name the same repo. */
export function revealRepoRoot(realPath: string, realWorkspace: string): string | null {
  const rel = relative(realWorkspace, realPath)
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** The methods `host-api-data.ts` serves. */
export const DATA_METHODS = [
  'files.readFile',
  'files.create',
  'files.write',
  'files.setBody',
  'files.setField',
  'files.removeField',
  'files.setKeyLines',
  'files.move',
  'files.delete',
  'tabs.openFile',
  'tabs.openTerminal',
  'tabs.openAttached',
  'project.list',
  'project.getSettings',
  'project.setSettings',
  'project.getAgents',
  'project.setAgents',
  'files.symlink',
  'files.removeSymlink',
  'files.pickFolder',
  'files.pickFile',
  'files.reveal',
  'git.getState',
  'git.watch',
  'git.unwatch',
  'project.getScopeFolders',
  'project.addScopeFolder',
  'project.removeScopeFolder',
  'git.reveal',
  'project.activate'
] as const satisfies readonly MethodName[]
export type DataMethod = (typeof DATA_METHODS)[number]

export function isDataMethod(method: MethodName): method is DataMethod {
  return (DATA_METHODS as readonly string[]).includes(method)
}

type Parsed<M extends DataMethod> = { ok: true; params: MethodParams<M> } | { ok: false; error: ErrorPayload }

function err(code: ErrorPayload['code'], message: string): { ok: false; error: ErrorPayload } {
  return { ok: false, error: { code, message } }
}

class ParamError extends Error {
  constructor(readonly error: ErrorPayload) {
    super(error.message)
  }
}

function fail(code: ErrorPayload['code'], message: string): never {
  throw new ParamError({ code, message })
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string') fail('invalid-params', `"${key}" must be a string`)
  return v
}

/** A path param naming an entry below the workspace root (never the root itself). */
function entry(o: Record<string, unknown>, key: string): string {
  if (o[key] === undefined) fail('invalid-params', `"${key}" is required`)
  const p = workspacePath(o[key])
  if (!p.ok) fail(p.error.code, p.error.code === 'invalid-params' ? p.error.message.replace('"path"', `"${key}"`) : p.error.message)
  if (p.path === '') fail('invalid-params', `"${key}" must name an entry inside the workspace, not its root`)
  return p.path
}

/** A path param that may be the workspace root (`""`). */
function anyPath(o: Record<string, unknown>, key: string): string {
  if (o[key] === undefined) fail('invalid-params', `"${key}" is required`)
  const p = workspacePath(o[key])
  if (!p.ok) fail(p.error.code, p.error.code === 'invalid-params' ? p.error.message.replace('"path"', `"${key}"`) : p.error.message)
  return p.path
}

/** An optional string param, absent when omitted. */
function optional<K extends string>(o: Record<string, unknown>, key: K): { [P in K]?: string } {
  return o[key] === undefined ? {} : ({ [key]: str(o, key) } as { [P in K]?: string })
}

/** The optional `ifMtime` param (a conditional write): the `mtimeMs` the app read. */
function ifMtime(o: Record<string, unknown>): { ifMtime?: number } {
  const v = o.ifMtime
  if (v === undefined) return {}
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('invalid-params', '"ifMtime" must be a finite number')
  return { ifMtime: v }
}

/** The optional `extensions` param of a file picker: a non-empty list of bare extensions (letters
 *  and digits, no dot), lowercased. */
function extensionsOf(o: Record<string, unknown>): { extensions?: string[] } {
  const v = o.extensions
  if (v === undefined) return {}
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && /^[A-Za-z0-9]+$/.test(x))) {
    fail('invalid-params', '"extensions" must be a non-empty list of extensions without the dot')
  }
  return { extensions: (v as string[]).map((x) => x.toLowerCase()) }
}

/** An optional boolean param, `false` when omitted. */
function flag(o: Record<string, unknown>, key: string): boolean {
  const v = o[key]
  if (v === undefined) return false
  if (typeof v !== 'boolean') fail('invalid-params', `"${key}" must be a boolean`)
  return v
}

/** A frontmatter value: text, a number, a boolean, null, or a list of text. Whether a number
 *  can be written (finite) is the kit's call (`invalid-value`). */
function fieldValue(o: Record<string, unknown>): FrontmatterValue {
  if (!Object.prototype.hasOwnProperty.call(o, 'value')) fail('invalid-params', '"value" is required')
  const v = o.value
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return [...(v as string[])]
  fail('invalid-params', '"value" must be a string, a number, a boolean, null or a list of strings')
}

/** Validate an E-030 call's params: omitted params are `{}`, unknown keys are dropped, paths are
 *  normalized by the workspace-path rule and must name an entry below the root. */
export function parseDataParams<M extends DataMethod>(method: M, params: unknown): Parsed<M> {
  if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
    return err('invalid-params', 'params must be an object')
  }
  const o = (params ?? {}) as Record<string, unknown>
  try {
    const out = ((): MethodParams<DataMethod> => {
      switch (method as DataMethod) {
        case 'files.readFile':
          return { path: entry(o, 'path'), frontmatter: flag(o, 'frontmatter') }
        case 'files.create':
          return { path: entry(o, 'path'), content: o.content === undefined ? '' : str(o, 'content') }
        case 'files.write':
          return { path: entry(o, 'path'), content: str(o, 'content'), ...ifMtime(o) }
        case 'files.setBody':
          return { path: entry(o, 'path'), body: str(o, 'body'), ...ifMtime(o) }
        case 'files.setField':
          return { path: entry(o, 'path'), key: str(o, 'key'), value: fieldValue(o), ...ifMtime(o) }
        case 'files.removeField':
          return { path: entry(o, 'path'), key: str(o, 'key'), ...ifMtime(o) }
        case 'files.setKeyLines':
          return { path: entry(o, 'path'), key: str(o, 'key'), text: str(o, 'text'), ...ifMtime(o) }
        case 'files.move':
          return { from: entry(o, 'from'), to: entry(o, 'to') }
        case 'files.delete': {
          const paths = o.paths
          if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) {
            fail('invalid-params', '"paths" must be a list of strings')
          }
          if (paths.length > FILES_DELETE_MAX_PATHS) fail('invalid-params', `"paths" takes at most ${FILES_DELETE_MAX_PATHS} paths`)
          return { paths: [...(paths as string[])] }
        }
        case 'tabs.openFile':
          return { path: entry(o, 'path'), ...optional(o, 'projectId') }
        case 'files.reveal':
          return { path: anyPath(o, 'path'), ...optional(o, 'projectId') }
        case 'tabs.openTerminal': {
          const command = optional(o, 'command')
          if (command.command !== undefined && (command.command.trim() === '' || /[\r\n]/.test(command.command))) {
            fail('invalid-params', '"command" must be one non-empty line')
          }
          const title = optional(o, 'title')
          if (title.title !== undefined) {
            if (title.title.trim() === '') fail('invalid-params', '"title" must not be empty')
            title.title = title.title.trim()
          }
          return { cwd: anyPath(o, 'cwd'), ...command, ...title, ...optional(o, 'projectId') }
        }
        case 'tabs.openAttached': {
          const ref = checkSessionRef(o.session)
          if (!ref.ok) fail('invalid-params', ref.message)
          const title = optional(o, 'title')
          if (title.title !== undefined) {
            if (title.title.trim() === '') fail('invalid-params', '"title" must not be empty')
            title.title = title.title.trim()
          }
          return { session: ref.value, ...title, ...optional(o, 'projectId') }
        }
        case 'project.list':
          return {}
        case 'project.getSettings':
        case 'project.getAgents':
        case 'project.activate':
          return { projectId: str(o, 'projectId') }
        case 'project.setSettings': {
          const projectId = str(o, 'projectId')
          const settings = o.settings
          if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
            fail('invalid-params', '"settings" must be an object')
          }
          const problem = jsonProblem(settings)
          if (problem) fail('invalid-params', `"settings": ${problem}`)
          return { projectId, settings: settings as Record<string, JsonValue> }
        }
        case 'files.symlink':
          return { path: entry(o, 'path'), target: entry(o, 'target') }
        case 'files.removeSymlink':
          return { path: entry(o, 'path') }
        case 'files.pickFolder':
          return {
            ...optional(o, 'root'),
            ...(o.initial === undefined ? {} : { initial: anyPath(o, 'initial') })
          }
        case 'files.pickFile':
          return {
            ...(o.under === undefined ? {} : { under: anyPath(o, 'under') }),
            ...extensionsOf(o)
          }
        case 'project.setAgents': {
          const projectId = str(o, 'projectId')
          const visibleAgents = normalizeVisibleAgents(o.visibleAgents)
          if (typeof visibleAgents === 'string') fail('invalid-params', visibleAgents)
          return { projectId, visibleAgents }
        }
        case 'git.getState':
        case 'git.watch':
          return optional(o, 'projectId')
        case 'git.unwatch':
          return { watchId: str(o, 'watchId') }
        case 'git.reveal': {
          const path = str(o, 'path')
          if (!isAbsolute(path)) fail('invalid-params', '"path" must be an absolute path')
          return { path, ...optional(o, 'projectId') }
        }
        // E-047 — the path rule (`scopeFolderPath`) needs the workspace's folder: `app-scope-folders.ts`.
        case 'project.getScopeFolders':
          return { projectId: str(o, 'projectId') }
        case 'project.addScopeFolder':
        case 'project.removeScopeFolder':
          return { projectId: str(o, 'projectId'), path: str(o, 'path') }
      }
    })()
    return { ok: true, params: out as MethodParams<M> }
  } catch (e) {
    if (e instanceof ParamError) return { ok: false, error: e.error }
    throw e
  }
}

/** One `files.delete` path, checked on its own: the workspace-path rule, and a file below the root
 *  (the root is a folder). Its error fails only that path's entry. */
export function deletePath(raw: string): { ok: true; path: string } | { ok: false; error: ErrorPayload } {
  const p = workspacePath(raw)
  if (!p.ok) return p
  if (p.path === '') return err('invalid-params', 'The workspace root is a folder, not a file')
  return p
}

/** A kit field/body write refusal as a protocol error: the kit's reason is the error code,
 *  except `invalid-value` (a key or value that cannot be written), which is `invalid-params`. */
export function fieldWriteError(reason: FieldWriteError, path: string, message: string): ErrorPayload {
  return {
    code: reason === 'invalid-value' ? 'invalid-params' : reason,
    message: `${JSON.stringify(path)}: ${message}`
  }
}

/** Where a folder picker starts: `initial` when it lies inside `root`, else `root`. */
export function pickStart(root: string, initial: string | undefined): string {
  return initial !== undefined && isInside(initial, root) ? initial : root
}

/** True when `path`'s extension (lowercase, no dot; a leading dot is not one) is among `extensions`;
 *  any file when none are given. */
export function hasExtension(path: string, extensions: readonly string[] | undefined): boolean {
  if (extensions === undefined) return true
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && extensions.includes(name.slice(dot + 1).toLowerCase())
}

/** True when `to` is `from` itself or lies inside it (a folder moved into itself). */
export function isSelfOrInside(from: string, to: string): boolean {
  return to === from || to.startsWith(`${from}/`)
}
