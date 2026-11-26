// Pomade — E-027 app registry: which apps Pomade can host, and the `pomade-app://` scheme that
// serves them (docs/HOST-API.md §1–§2, §5).
//
// Sources, highest precedence first (a dev link wins over an installed copy with the same id):
//   1. POMADE_DEV_APPS — `;`-separated folders / `http://localhost:PORT` URLs, for one run (tests)
//   2. `<userData>/app-links.json` — dev links written by `pomade apps link`
//   3. `<userData>/apps/<id>/` — installed copies written by `pomade apps install` and by the bundled
//      install at start (each a link to its current build folder, app-install-core.ts)
// `<userData>/apps/` and `app-links.json` are watched, so install / update / remove / (un)link
// take effect without a restart: EV.appsChanged carries the new list, and an app whose files or
// manifest changed gets a new `revision` (its open frames reload).

import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, net, protocol } from 'electron'

import {
  APP_LINKS_FILE,
  APPS_DIR,
  MANIFEST_FILE,
  parseAppLinks,
  parseDevTarget,
  parseManifest,
  resolveAppShortcuts,
  type AppManifest,
  type DevTarget
} from '@shared/app-manifest'
import { EV } from '@shared/ipc-api'
import { isTintableIcon } from './app-icon-tint'
import { installedIds } from './app-install-core'
import type { AppBackendStatus, HostedApp } from '@shared/types'
import { safeBroadcast } from './windows'

export const APP_SCHEME = 'pomade-app'

/** How long a dev-server manifest fetch may take before the app is reported unreachable. */
const DEV_FETCH_TIMEOUT_MS = 2000
/** Coalesces a burst of install/remove events (a copy is many events) into one rescan. */
const RESCAN_DEBOUNCE_MS = 150

interface AppRecord {
  id: string
  source: HostedApp['source']
  origin: DevTarget
  manifest: AppManifest | null
  error: string | null
  /** T-244 — per icon path (the app's, its strip icons' and its tab kinds'): Pomade may tint it (app-icon-tint.ts). */
  tints: Record<string, boolean>
  /** Change detector for `revision`: the manifest text, origin, error and icon tints. */
  signature: string
}

interface Loaded {
  manifest: AppManifest | null
  error: string | null
  text: string
  tints: Record<string, boolean>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
}

function userData(): string {
  return app.getPath('userData')
}

function appsDir(): string {
  return join(userData(), APPS_DIR)
}

/** Read and validate a build folder's manifest. `expectId` (an install's folder name, a dev
 *  link's registered id) must match the manifest's own id. */
async function loadFolderManifest(
  dir: string,
  expectId: string | null
): Promise<{ manifest: AppManifest | null; error: string | null; text: string }> {
  let text: string
  try {
    text = await fs.readFile(join(dir, MANIFEST_FILE), 'utf8')
  } catch {
    return { manifest: null, error: `${MANIFEST_FILE} is missing in ${dir}`, text: '' }
  }
  const parsed = parseManifest(text)
  if (!parsed.ok) return { manifest: null, error: `Invalid manifest: ${parsed.errors.join('; ')}`, text }
  if (expectId !== null && parsed.manifest.id !== expectId) {
    return {
      manifest: null,
      error: `The manifest's id "${parsed.manifest.id}" does not match "${expectId}"`,
      text
    }
  }
  try {
    const st = await fs.stat(join(dir, parsed.manifest.entry))
    if (!st.isFile()) throw new Error('not a file')
  } catch {
    return { manifest: null, error: `The entry file "${parsed.manifest.entry}" is missing`, text }
  }
  return { manifest: parsed.manifest, error: null, text }
}

async function loadUrlManifest(
  url: string,
  expectId: string | null
): Promise<{ manifest: AppManifest | null; error: string | null; text: string }> {
  let text: string
  try {
    const res = await net.fetch(`${url}/${MANIFEST_FILE}`, {
      signal: AbortSignal.timeout(DEV_FETCH_TIMEOUT_MS),
      headers: { 'cache-control': 'no-cache' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (err) {
    return {
      manifest: null,
      error: `The dev server at ${url} is not reachable (${(err as Error).message})`,
      text: ''
    }
  }
  const parsed = parseManifest(text)
  if (!parsed.ok) return { manifest: null, error: `Invalid manifest: ${parsed.errors.join('; ')}`, text }
  if (expectId !== null && parsed.manifest.id !== expectId) {
    return {
      manifest: null,
      error: `The manifest's id "${parsed.manifest.id}" does not match "${expectId}"`,
      text
    }
  }
  return { manifest: parsed.manifest, error: null, text }
}

/** An icon file's text, or null when it cannot be read (the renderer then shows its fallback). */
async function readIcon(target: DevTarget, rel: string): Promise<string | null> {
  try {
    if (target.kind === 'folder') {
      const file = resolve(target.path, rel)
      if (!file.startsWith(target.path + sep)) return null
      return await fs.readFile(file, 'utf8')
    }
    const res = await net.fetch(`${target.url}/${rel}`, { signal: AbortSignal.timeout(DEV_FETCH_TIMEOUT_MS) })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

/** T-244 — which of the manifest's icon images Pomade may tint. */
async function iconTints(target: DevTarget, m: AppManifest): Promise<Record<string, boolean>> {
  const paths = [
    ...new Set(
      [m.icon, ...m.strip.map((s) => s.icon), ...Object.values(m.tabKinds).map((k) => k.icon)].filter((p): p is string => !!p)
    )
  ]
  const out: Record<string, boolean> = {}
  for (const rel of paths) {
    const text = /\.svg$/i.test(rel) ? await readIcon(target, rel) : null
    out[rel] = text !== null && isTintableIcon(rel, text)
  }
  return out
}

async function loadTarget(target: DevTarget, expectId: string | null): Promise<Loaded> {
  const loaded =
    target.kind === 'folder' ? await loadFolderManifest(target.path, expectId) : await loadUrlManifest(target.url, expectId)
  const tints = loaded.manifest && !loaded.error ? await iconTints(target, loaded.manifest) : {}
  return { ...loaded, tints }
}

function record(id: string, source: HostedApp['source'], origin: DevTarget, loaded: Loaded): AppRecord {
  return {
    id,
    source,
    origin,
    manifest: loaded.manifest,
    error: loaded.error,
    tints: loaded.tints,
    signature: JSON.stringify([source, origin, loaded.text, loaded.error, loaded.tints])
  }
}

async function scanInstalled(): Promise<AppRecord[]> {
  // Each install is a link to its current build folder; dot-entries (the build folders) are skipped.
  const names = await installedIds(userData())
  return Promise.all(
    names.map(async (name) => {
      const dir = join(appsDir(), name)
      const origin: DevTarget = { kind: 'folder', path: dir }
      return record(name, 'installed', origin, await loadTarget(origin, name))
    })
  )
}

async function scanLinksFile(): Promise<AppRecord[]> {
  let text: string
  try {
    text = await fs.readFile(join(userData(), APP_LINKS_FILE), 'utf8')
  } catch {
    return []
  }
  return Promise.all(
    parseAppLinks(text).map(async (link) => {
      const target = parseDevTarget(link.target)
      if ('error' in target) {
        return record(link.id, 'dev-link', { kind: 'folder', path: link.target }, {
          manifest: null,
          error: target.error,
          text: '',
          tints: {}
        })
      }
      return record(link.id, 'dev-link', target, await loadTarget(target, link.id))
    })
  )
}

/** POMADE_DEV_APPS (testing hook, §2): each entry's id comes from its own manifest. */
async function scanEnvLinks(): Promise<AppRecord[]> {
  const raw = process.env['POMADE_DEV_APPS']
  if (!raw || !raw.trim()) return []
  const out: AppRecord[] = []
  for (const item of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const target = parseDevTarget(/^[a-z][a-z0-9+.-]*:\/\//i.test(item) ? item : resolve(item))
    if ('error' in target) {
      console.error(`[apps] POMADE_DEV_APPS: ${target.error}`)
      continue
    }
    const loaded = await loadTarget(target, null)
    const id = loaded.manifest?.id
    if (!id) {
      console.error(`[apps] POMADE_DEV_APPS: ${item}: ${loaded.error ?? 'no manifest id'}`)
      continue
    }
    out.push(record(id, 'dev-link', target, loaded))
  }
  return out
}

// ─── The registry ─────────────────────────────────────────────────────────────

const records = new Map<string, AppRecord>()
const revisions = new Map<string, number>()
/** Installed ids whose folder saw a file event since the last scan (content-only updates). */
const touched = new Set<string>()
let scanning: Promise<void> | null = null
let rescanQueued = false
/** E-028 — main-side listeners of registry changes (backends, commands, keys). */
const changeListeners: (() => void)[] = []

/** E-028 — run `fn` after every scan that changed the registry (install, update, remove, link). */
export function onAppsChanged(fn: () => void): void {
  changeListeners.push(fn)
}

/** E-028 — a hosted app's backend status (`app-backends.ts`, `app-launchd.ts` supply it). */
let backendStatus: (id: string) => AppBackendStatus | null = () => null

export function setBackendStatusProvider(fn: (id: string) => AppBackendStatus | null): void {
  backendStatus = fn
}

/** E-028 — push the app list again (a backend's status changed; nothing was rescanned). */
export function broadcastApps(): void {
  safeBroadcast(EV.appsChanged, listApps())
}

function notifyChanged(): void {
  safeBroadcast(EV.appsChanged, listApps())
  for (const fn of changeListeners) {
    try {
      fn()
    } catch (err) {
      console.error('[apps] change listener failed', err)
    }
  }
}

async function scan(): Promise<boolean> {
  const next = new Map<string, AppRecord>()
  // Lowest precedence first; a later source overwrites the same id.
  for (const r of await scanInstalled()) next.set(r.id, r)
  for (const r of await scanLinksFile()) next.set(r.id, r)
  for (const r of await scanEnvLinks()) next.set(r.id, r)

  let changed = next.size !== records.size
  for (const [id, r] of next) {
    const prev = records.get(id)
    const contentTouched = r.source === 'installed' && touched.has(id)
    if (!prev || prev.signature !== r.signature || contentTouched) {
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
      changed = true
    }
  }
  for (const id of records.keys()) if (!next.has(id)) changed = true
  touched.clear()
  records.clear()
  for (const [id, r] of next) records.set(id, r)
  return changed
}

/** Rescan now (serialized: a rescan requested mid-scan runs once more after it). */
export async function refreshApps(): Promise<void> {
  if (scanning) {
    rescanQueued = true
    return scanning
  }
  scanning = (async () => {
    do {
      rescanQueued = false
      if (await scan()) notifyChanged()
    } while (rescanQueued)
  })().finally(() => {
    scanning = null
  })
  return scanning
}

function frameBase(r: AppRecord): string {
  return r.origin.kind === 'url' ? r.origin.url : `${APP_SCHEME}://${r.id}`
}

export function listApps(): HostedApp[] {
  const shortcuts = resolveAppShortcuts(
    [...records.values()].filter((r) => r.manifest && !r.error).map((r) => ({ id: r.id, shortcuts: r.manifest!.shortcuts }))
  )
  return [...records.values()]
    .map((r): HostedApp => {
      const m = r.manifest
      const base = frameBase(r)
      const keys = shortcuts.get(r.id)
      return {
        id: r.id,
        name: m?.name ?? r.id,
        version: m?.version ?? null,
        source: r.source,
        location: r.origin.kind === 'url' ? r.origin.url : r.origin.path,
        entryUrl: m && !r.error ? `${base}/${m.entry}` : null,
        iconUrl: m?.icon && !r.error ? `${base}/${m.icon}` : null,
        iconTint: m?.icon && !r.error ? r.tints[m.icon] === true : false,
        revision: revisions.get(r.id) ?? 0,
        unavailable: r.error ?? (m ? null : 'The app has no valid manifest'),
        strip:
          m && !r.error
            ? m.strip.map((s) => {
                const img = s.icon ?? m.icon
                return { ...s, iconUrl: img ? `${base}/${img}` : null, iconTint: img ? r.tints[img] === true : false }
              })
            : [],
        tabKinds:
          m && !r.error
            ? Object.fromEntries(
                Object.entries(m.tabKinds).map(([id, k]) => {
                  const img = k.icon ?? m.icon
                  return [id, { ...k, iconUrl: img ? `${base}/${img}` : null, iconTint: img ? r.tints[img] === true : false }]
                })
              )
            : {},
        launchPanel: m && !r.error ? m.launchPanel : null,
        shortcuts: keys?.active ?? [],
        shortcutConflicts: keys?.conflicts ?? [],
        backend: m && !r.error ? backendStatus(r.id) : null
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The validated manifest of an available app, or null. */
export function appManifest(id: string): AppManifest | null {
  const r = records.get(id)
  return r && !r.error ? r.manifest : null
}

/** E-028 — an available app's local build folder (installed copy or folder dev link); null for an
 *  unavailable app or a dev-server link. */
export function appFolder(id: string): string | null {
  const r = records.get(id)
  return r && !r.error && r.manifest && r.origin.kind === 'folder' ? r.origin.path : null
}

/** E-028 — every id the registry knows (available or not). */
export function knownAppIds(): string[] {
  return [...records.keys()]
}

/** E-028 — the app's revision (bumped on every update); 0 for an unknown app. */
export function appRevision(id: string): number {
  return revisions.get(id) ?? 0
}

// ─── pomade-app:// ────────────────────────────────────────────────────────────

/** Must run BEFORE app `ready`: scheme privileges can only be declared pre-ready. `standard`
 *  gives each app a real origin (`pomade-app://<id>`) — cross-origin to the Pomade renderer, so
 *  an app can never reach `window.pomade` or the host DOM; `secure` + `supportFetchAPI` let it
 *  fetch its own files. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/** Serve `pomade-app://<id>/<path>` from the app's build folder (installed or dev-linked),
 *  traversal-guarded, never cached — a reinstall shows on the next frame load. */
async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const r = records.get(url.hostname)
  if (!r || r.origin.kind !== 'folder' || !r.manifest || r.error) return notFound()
  const dir = r.origin.path
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    return notFound()
  }
  if (rel === '' || rel === '/') rel = `/${r.manifest.entry}`
  const target = resolve(dir, `.${rel}`)
  if (!target.startsWith(dir + sep)) return notFound()
  try {
    const st = await fs.stat(target)
    if (!st.isFile()) return notFound()
    const res = await net.fetch(pathToFileURL(target).toString())
    const headers = new Headers(res.headers)
    const mime = MIME[extname(target).toLowerCase()]
    if (mime) headers.set('content-type', mime)
    headers.set('cache-control', 'no-store')
    return new Response(res.body, { status: 200, headers })
  } catch {
    return notFound()
  }
}

// ─── Watching + boot ──────────────────────────────────────────────────────────

let appsWatcher: FSWatcher | null = null
let linksWatcher: FSWatcher | null = null
let rescanTimer: NodeJS.Timeout | null = null

function scheduleRescan(): void {
  if (rescanTimer) clearTimeout(rescanTimer)
  rescanTimer = setTimeout(() => {
    rescanTimer = null
    void refreshApps()
  }, RESCAN_DEBOUNCE_MS)
}

function startWatching(): void {
  try {
    // One recursive descriptor for every installed app (FSEvents on macOS).
    appsWatcher = fsWatch(appsDir(), { recursive: true, persistent: false }, (_e, filename) => {
      const first = typeof filename === 'string' ? filename.split(/[/\\]/)[0] : ''
      if (first && !first.startsWith('.')) touched.add(first)
      scheduleRescan()
    })
    appsWatcher.on('error', () => {
      appsWatcher?.close()
      appsWatcher = null
    })
  } catch {
    appsWatcher = null
  }
  try {
    // Non-recursive: userData's direct entries, filtered to the links file.
    linksWatcher = fsWatch(userData(), { recursive: false, persistent: false }, (_e, filename) => {
      if (filename === APP_LINKS_FILE) scheduleRescan()
    })
    linksWatcher.on('error', () => {
      linksWatcher?.close()
      linksWatcher = null
    })
  } catch {
    linksWatcher = null
  }
}

let markScanned: () => void = () => {}
const firstScan = new Promise<void>((done) => {
  markScanned = done
})

/** Resolves once the registry's first scan has finished: until then no app is known, so a
 *  question about one (the Host API socket authenticating a client) waits for it. */
export function appsScanned(): Promise<void> {
  return firstScan
}

/** Run AFTER app `ready`: serve the scheme, scan, and start watching. */
export async function startAppRegistry(): Promise<void> {
  protocol.handle(APP_SCHEME, serve)
  await fs.mkdir(appsDir(), { recursive: true })
  await refreshApps()
  markScanned()
  startWatching()
}
