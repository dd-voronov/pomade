// Pomade — the Host API's pure decisions (docs/HOST-API.md §3–§4): handshake negotiation, the
// method → capability gate, params validation and watch matching. No Electron, no fs —
// `host-api.ts` wires these to frames, the filesystem and the platform watcher.

import {
  HOST_API_VERSION,
  METHOD_CAPABILITY,
  checkOpenAppParams,
  checkOverlayAnchor,
  checkShowPanelParams,
  checkTabRoute,
  checkTabTitle,
  checkOverlayHeight,
  checkStateKey,
  checkStateValue,
  isPomadeFolderPath,
  normalizeWorkspacePath,
  pomadeFolderMessage,
  type AppTabKind,
  type Capability,
  type ErrorPayload,
  type FileChange,
  type JsonValue,
  type MethodName,
  type MethodParams,
  type OverlayAnchor,
  type RejectReason
} from 'pomade-kit/protocol'

/** Answer a `hello` (§3). Version 0 requires an exact match: a newer app gets
 *  `needs-newer-pomade`, an older one `app-too-old`. A non-integer `hostApi` is not a hello at
 *  all (`ignore`). */
export function negotiate(appHostApi: unknown): 'welcome' | 'ignore' | RejectReason {
  if (typeof appHostApi !== 'number' || !Number.isInteger(appHostApi)) return 'ignore'
  if (appHostApi > HOST_API_VERSION) return 'needs-newer-pomade'
  if (appHostApi < HOST_API_VERSION) return 'app-too-old'
  return 'welcome'
}

function err(code: ErrorPayload['code'], message: string): { ok: false; error: ErrorPayload } {
  return { ok: false, error: { code, message } }
}

/** The method gate: unknown methods and methods whose capability the manifest does not declare
 *  are refused. Runs in main — the renderer is never the only check. */
export function gateMethod(
  method: unknown,
  capabilities: readonly Capability[]
): { ok: true; method: MethodName } | { ok: false; error: ErrorPayload } {
  if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(METHOD_CAPABILITY, method)) {
    return err('unknown-method', `No method ${JSON.stringify(method)} in Host API ${HOST_API_VERSION}`)
  }
  const name = method as MethodName
  const cap = METHOD_CAPABILITY[name]
  // `platform` methods are for Pomade's own commands only: no manifest can declare them.
  if (cap !== null && !(capabilities as readonly string[]).includes(cap)) {
    return err('capability-denied', `${name} needs the "${cap}" capability, which the manifest does not declare`)
  }
  return { ok: true, method: name }
}

type Params<M extends MethodName> = MethodParams<M>

function asObject(params: unknown): Record<string, unknown> | null {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) return null
  return params as Record<string, unknown>
}

function optionalBool(o: Record<string, unknown>, key: string): ErrorPayload | null {
  return o[key] === undefined || typeof o[key] === 'boolean'
    ? null
    : { code: 'invalid-params', message: `"${key}" must be a boolean` }
}

/** An app-supplied path, normalized by the kit's workspace-path rule (§4). A non-string or a
 *  path with NUL is malformed (`invalid-params`); absolute paths and `..` escapes are
 *  `outside-workspace`; a path at or inside the workspace's `.pomade` folder is
 *  `capability-denied` (rule 3 — every path param of every method passes here; the real-path half
 *  is `requireRealAllowed` / `requireNotPomadeFolder` in `host-api-fs.ts`). */
export function workspacePath(path: unknown): { ok: true; path: string } | { ok: false; error: ErrorPayload } {
  if (typeof path !== 'string') return err('invalid-params', '"path" must be a string')
  if (path.includes('\0')) return err('invalid-params', '"path" must not contain NUL')
  const p = normalizeWorkspacePath(path)
  if (!p.ok) return err('outside-workspace', `${JSON.stringify(path)} is outside the workspace`)
  return isPomadeFolderPath(p.path) ? err('capability-denied', pomadeFolderMessage(path)) : p
}

/** An overlay height in whole pixels, at least 1. */
function wholePixels(px: number): number {
  return Math.max(1, Math.round(px))
}

/** Validate a call's params for `method`: omitted params are `{}`, unknown keys are dropped,
 *  paths are normalized (§4 path rules). */
export function parseParams<M extends MethodName>(
  method: M,
  params: unknown
): { ok: true; params: Params<M> } | { ok: false; error: ErrorPayload } {
  const o = asObject(params)
  if (!o) return err('invalid-params', 'params must be an object')
  switch (method) {
    case 'host.info':
    case 'project.getActive':
    case 'overlay.close':
    case 'tabs.close':
      return { ok: true, params: {} as Params<M> }
    case 'tabs.setRoute': {
      const bad = checkTabRoute(o.route)
      if (bad) return err('invalid-params', bad)
      return { ok: true, params: { route: o.route as string } as Params<M> }
    }
    case 'tabs.setTitle': {
      const bad = checkTabTitle(o.title)
      if (bad) return err('invalid-params', bad)
      return { ok: true, params: { title: (o.title as string).trim() } as Params<M> }
    }
    case 'files.readFolder':
    case 'files.watch': {
      if (o.path === undefined) return err('invalid-params', '"path" is required')
      const p = workspacePath(o.path)
      if (!p.ok) return p
      const flags = method === 'files.readFolder' ? ['recursive', 'frontmatter'] : ['recursive']
      const out: Record<string, unknown> = { path: p.path }
      for (const key of flags) {
        const bad = optionalBool(o, key)
        if (bad) return { ok: false, error: bad }
        if (o[key] !== undefined) out[key] = o[key]
      }
      return { ok: true, params: out as Params<M> }
    }
    case 'files.unwatch':
      if (typeof o.watchId !== 'string') return err('invalid-params', '"watchId" must be a string')
      return { ok: true, params: { watchId: o.watchId } as Params<M> }
    case 'strip.setBadge': {
      if (typeof o.icon !== 'string') return err('invalid-params', '"icon" must be a strip icon id')
      if (typeof o.count !== 'number' || !Number.isInteger(o.count) || o.count < 0) {
        return err('invalid-params', '"count" must be a non-negative integer')
      }
      const bad = optionalBool(o, 'urgent')
      if (bad) return { ok: false, error: bad }
      return {
        ok: true,
        params: { icon: o.icon, count: o.count, ...(o.urgent === true ? { urgent: true } : {}) } as Params<M>
      }
    }
    case 'overlay.open': {
      if (o.route !== undefined && typeof o.route !== 'string') return err('invalid-params', '"route" must be a string')
      const heightProblem = o.height === undefined ? null : checkOverlayHeight(o.height)
      if (heightProblem) return err('invalid-params', heightProblem)
      const anchorProblem = o.anchor === undefined ? null : checkOverlayAnchor(o.anchor)
      if (anchorProblem) return err('invalid-params', anchorProblem)
      return {
        ok: true,
        params: {
          route: o.route ?? '',
          ...(o.height !== undefined ? { height: wholePixels(o.height as number) } : {}),
          ...(o.anchor !== undefined ? { anchor: o.anchor as OverlayAnchor } : {})
        } as Params<M>
      }
    }
    case 'panel.show': {
      const r = checkShowPanelParams(o)
      return r.ok ? { ok: true, params: r.value as Params<M> } : err('invalid-params', r.message)
    }
    case 'overlay.resize': {
      const heightProblem = checkOverlayHeight(o.height)
      if (heightProblem) return err('invalid-params', heightProblem)
      return { ok: true, params: { height: wholePixels(o.height as number) } as Params<M> }
    }
    case 'state.get': {
      const bad = checkStateKey(o.key)
      if (bad) return err('invalid-params', bad)
      return { ok: true, params: { key: o.key as string } as Params<M> }
    }
    case 'state.set': {
      const bad = checkStateKey(o.key) ?? checkStateValue(o.value)
      if (bad) return err('invalid-params', bad)
      return { ok: true, params: { key: o.key as string, value: o.value as JsonValue } as Params<M> }
    }
    // E-031 — the bus checks the names and the payload against the manifest (`event-bus.ts`).
    case 'events.publish':
    case 'events.subscribe':
    case 'events.unsubscribe':
    case 'events.hasSubscribers':
    case 'notices.post':
      return { ok: true, params: o as Params<M> }
  }
  return err('unknown-method', `No method ${JSON.stringify(method)}`)
}

/** T-268 — `tabs.openApp` params, checked against the calling app's manifest `tabKinds`: `route`
 *  defaulted to `""`, a keyed tab's `title` trimmed; `title` and `kind` need `key`, `kind` must be
 *  declared. */
export function parseOpenAppParams(
  params: unknown,
  tabKinds: Readonly<Record<string, AppTabKind>>
): { ok: true; params: Params<'tabs.openApp'> } | { ok: false; error: ErrorPayload } {
  const r = checkOpenAppParams(params, tabKinds)
  return r.ok ? { ok: true, params: r.value } : err('invalid-params', r.message)
}

/** One path a watch batch saw, with what is on disk now. `structural` = the watcher reported a
 *  create/delete/rename-shaped event for it (not only a content change). */
export interface ObservedChange {
  path: string
  structural: boolean
  present: boolean
  isDir: boolean
}

/** Turn a batch of observed paths into FileChanges (§4). A missing path is a `delete`; a present
 *  one is a `create` when structural, else a `change`. fs.watch cannot tell a rename from a
 *  delete + create, so a batch holding exactly one deleted path and exactly one created FOLDER is
 *  that folder's rename — one `rename` change; any other delete + create stays the pair. */
export function classifyChanges(observed: ObservedChange[]): FileChange[] {
  const changes: FileChange[] = observed.map((o) => ({
    kind: !o.present ? 'delete' : o.structural ? 'create' : 'change',
    path: o.path
  }))
  const deletes = changes.filter((c) => c.kind === 'delete')
  const creates = changes.filter((c) => c.kind === 'create')
  if (deletes.length === 1 && creates.length === 1) {
    const created = observed.find((o) => o.path === creates[0].path)
    if (created?.isDir) {
      return [
        ...changes.filter((c) => c !== deletes[0] && c !== creates[0]),
        { kind: 'rename', path: creates[0].path, oldPath: deletes[0].path }
      ]
    }
  }
  return changes
}

/** True when a change at `changed` (workspace-relative) falls under a watch on `watched`: the
 *  watched path itself, a direct child, or — when recursive — any descendant. */
export function watchCovers(watched: string, recursive: boolean, changed: string): boolean {
  if (changed === watched) return true
  if (watched !== '' && !changed.startsWith(`${watched}/`)) return false
  if (recursive) return true
  const rest = watched === '' ? changed : changed.slice(watched.length + 1)
  return !rest.includes('/')
}
