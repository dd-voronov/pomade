// Pomade — main-process config store.
// Owns app.json (userData: the workspace root), and per-workspace .pomade/{workspace.json,
// settings.json, agents.json, state/<id>.json, state/view.json}.
// Atomic writes (tmp + rename), debounced 500ms. Wave 1.

import { app, clipboard, ipcMain, shell } from 'electron'
import { promises as fs, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { CH } from '@shared/ipc-api'
import { localHistoryStoreDir } from '@shared/local-history'
import {
  DEFAULT_FILETREE_SETTINGS,
  EMPTY_WORKSPACE_CONFIG,
  type AgentOverrides,
  type AppSettings,
  type OverlayPosition,
  type ProjectState,
  type WorkspaceConfig,
  type WorkspaceUiState
} from '@shared/types'
import { tunedMs } from './test-tuning'
import { writeJsonAtomic } from './atomic-write'
import { showDialog } from './windows'
import { defineHandler } from './ipc'
import {
  filesTouchedBy,
  mergeAppSettings,
  buildFlavor,
  preferencesOf,
  readAppSettings,
  viewStateOf,
  type AppJson
} from './app-settings-files'
import { createStoreDirs } from './local-history-store'
import { setUnwatchedFolders } from './skipped-paths'
import { upgradeProject } from './project-upgrade'

// e2e shrinks the persist debounce via POMADE_TEST_CONFIG_DEBOUNCE_MS (docs/contracts/test-hooks.md;
// unset ⇒ production value). Writes stay atomic (tmp + rename) at any window.
const DEBOUNCE_MS = tunedMs('POMADE_TEST_CONFIG_DEBOUNCE_MS', 500)

// ─── Debounced atomic JSON writer, keyed by absolute path ─────────────────────
const pending = new Map<string, { data: unknown; timer: NodeJS.Timeout }>()

async function writeConfigJson(absPath: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(absPath), { recursive: true })
  await writeJsonAtomic(absPath, data)
}

// Writes to one path are SERIALIZED through a per-path promise chain. An atomic write is not
// instantaneous: once the debounce timer fires, the write is in flight and no longer pending —
// a save landing right behind it (or the quit flush) would otherwise start a SECOND concurrent
// writeJsonAtomic for the same path, and the OLDER snapshot's rename can finish last, silently
// clobbering the newer data. The chain guarantees renames land in schedule order.
const writeChains = new Map<string, Promise<void>>()

function chainWrite(absPath: string, data: unknown): Promise<void> {
  const next = (writeChains.get(absPath) ?? Promise.resolve()).then(() =>
    writeConfigJson(absPath, data).catch((err) => {
      console.error('[config-store] write failed', absPath, err)
    })
  )
  writeChains.set(absPath, next)
  return next
}

function scheduleWrite(absPath: string, data: unknown): void {
  const existing = pending.get(absPath)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    pending.delete(absPath)
    void chainWrite(absPath, data)
  }, DEBOUNCE_MS)
  pending.set(absPath, { data, timer })
}

export async function flushPendingWrites(): Promise<void> {
  const entries = [...pending.entries()]
  pending.clear()
  for (const [absPath, { data, timer }] of entries) {
    clearTimeout(timer)
    void chainWrite(absPath, data)
  }
  // Wait for every chain — the just-flushed writes AND any still-in-flight debounced ones.
  await Promise.all([...writeChains.values()])
}

// T-156 — a per-project state key names ONE path segment (`.pomade/state/<key>.json`), so a
// `..`/slash in it would let a buggy renderer's `state.remove` unlink OUTSIDE the state dir.
// Project ids are nanoids; anything but the nanoid alphabet is refused outright. The destructive
// remove is escape-guarded here even though load/save trust the id (a wrong read/write is
// recoverable — a wrong delete is not); mirrors pty-manager's snapshot-key guard.
function isValidStateKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(key)
}

/** `raw` read off disk, keeping only the entries that are a finite `{ left, top }`. */
function normalizeOverlayPositions(raw: unknown): Record<string, OverlayPosition> {
  const out: Record<string, OverlayPosition> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [appId, pos] of Object.entries(raw)) {
    const p = pos as Partial<OverlayPosition> | null
    if (typeof p?.left === 'number' && typeof p.top === 'number' && Number.isFinite(p.left) && Number.isFinite(p.top)) {
      out[appId] = { left: p.left, top: p.top }
    }
  }
  return out
}

async function readJson<T>(absPath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(absPath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ─── Workspace-switch teardown hooks (E-006 / T-027) ──────────────────────────
// Services with per-workspace resources (PTYs, fs watchers) register a teardown fn here;
// changeRoot() runs them all before switching. Registration lives in main/index.ts so
// config-store keeps no import edge to pty-manager / fs-service (avoids a cycle).
type TeardownFn = () => void | Promise<void>
const teardownHooks: TeardownFn[] = []
export function onWorkspaceTeardown(fn: TeardownFn): void {
  teardownHooks.push(fn)
}

// ─── Workspace-ready hooks (T-091) ────────────────────────────────────────────
// The counterpart of the teardown hooks: services that pre-warm per-workspace state (the
// terminal name index) register here and are called right after a NEW root is committed.
// Boot is NOT routed through here — resolveRoot() runs before services register — so the
// boot warm is an explicit call in main/index.ts.
type WorkspaceReadyFn = (root: string) => void
const readyHooks: WorkspaceReadyFn[] = []
export function onWorkspaceReady(fn: WorkspaceReadyFn): void {
  readyHooks.push(fn)
}
function fireWorkspaceReady(root: string): void {
  for (const fn of readyHooks) {
    try {
      fn(root)
    } catch (err) {
      console.error('[config-store] workspace ready hook failed', err)
    }
  }
}

// ─── App-settings listeners (T-274) ───────────────────────────────────────────
// Main-side services that act on an app setting (local history's extension lists) hear every
// change as it is saved, so an edit in Settings applies without a restart.
type AppSettingsListener = (settings: AppSettings) => void
const appSettingsListeners: AppSettingsListener[] = []
export function onAppSettingsChanged(fn: AppSettingsListener): void {
  appSettingsListeners.push(fn)
}

// ─── ConfigStore singleton ────────────────────────────────────────────────────
class ConfigStore {
  private root: string | null = null

  private appJsonPath(): string {
    return join(app.getPath('userData'), 'app.json')
  }

  private pomadeDir(): string {
    if (!this.root) throw new Error('No workspace root set')
    return join(this.root, '.pomade')
  }

  private settingsPath(): string {
    return join(this.pomadeDir(), 'settings.json')
  }

  private viewStatePath(): string {
    return join(this.pomadeDir(), 'state', 'view.json')
  }

  /** Resolve the active workspace root: POMADE_WORKSPACE wins, else persisted app.json. */
  async resolveRoot(): Promise<string | null> {
    const envRoot = process.env.POMADE_WORKSPACE
    if (envRoot && envRoot.trim()) {
      this.root = envRoot
      await this.bootstrapWorkspace()
      return this.root
    }
    const appJson = await readJson<AppJson>(this.appJsonPath())
    this.root = appJson?.workspaceRoot ?? null
    if (this.root) await this.bootstrapWorkspace()
    return this.root
  }

  getRoot(): string | null {
    return this.root
  }

  private async persistRoot(root: string | null): Promise<void> {
    await writeConfigJson(this.appJsonPath(), { workspaceRoot: root } satisfies AppJson)
  }

  // ── app settings (T-313) ─────────────────────────────────────────────────────
  // AppSettings live in the active workspace: preferences in `.pomade/settings.json`, view state
  // in `.pomade/state/view.json` (app-settings-files.ts). Read fresh on every get — the file on
  // disk is the truth, a `git pull` included. Every get and set runs through one queue,
  // so a set's read-merge-write never interleaves with another's. A set writes only the file(s)
  // its patch touches: a column drag never rewrites settings.json. With no workspace there is
  // nowhere to keep them: the defaults, and a set is answered without a write.
  private settingsQueue: Promise<unknown> = Promise.resolve()

  private serialSettings<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settingsQueue.then(fn, fn)
    this.settingsQueue = run.catch(() => undefined)
    return run
  }

  private async readSettingsFiles(): Promise<AppSettings> {
    if (!this.root) return mergeAppSettings(undefined)
    return readAppSettings(await readJson<unknown>(this.settingsPath()), await readJson<unknown>(this.viewStatePath()))
  }

  getAppSettings(): Promise<AppSettings> {
    return this.serialSettings(() => this.readSettingsFiles())
  }

  async setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const merged = await this.serialSettings(async () => {
      const next = mergeAppSettings(await this.readSettingsFiles(), patch)
      if (this.root) {
        const touched = filesTouchedBy(patch)
        if (touched.preferences) await writeConfigJson(this.settingsPath(), preferencesOf(next))
        if (touched.viewState) await writeConfigJson(this.viewStatePath(), viewStateOf(next))
      }
      return next
    })
    for (const fn of appSettingsListeners) {
      try {
        fn(merged)
      } catch (err) {
        console.error('[config-store] app settings listener failed', err)
      }
    }
    return merged
  }

  /** Ensure .pomade exists with a .gitignore that ignores machine-local state/. */
  private async bootstrapWorkspace(): Promise<void> {
    if (!this.root) return
    const dir = this.pomadeDir()
    // T-116 (E-022) — `state/scrollback/` holds the per-terminal scrollback snapshots
    // (pty-manager owns their contents). Created here so it exists before the first pty writes,
    // and INSIDE `state/` so the single `state/` gitignore line below already covers it.
    await fs.mkdir(join(dir, 'state', 'scrollback'), { recursive: true })
    const gitignore = join(dir, '.gitignore')
    try {
      await fs.access(gitignore)
    } catch {
      await fs.writeFile(gitignore, 'state/\n', 'utf8')
    }
    // T-314 — the local-history store (`Apps/Pomade/local-history/`, the dev build's under
    // `Apps/Pomade/dev/`) exists from activation on, like `.pomade/`: created before the tree and
    // the watchers start, so a first snapshot never makes `Apps/` or `Apps/Pomade/` appear
    // mid-session. A workspace Pomade cannot write to still opens; the store then has nowhere to go.
    try {
      await createStoreDirs(join(this.root, localHistoryStoreDir(buildFlavor(process.env, app.isPackaged))))
    } catch (err) {
      console.error('[config-store] cannot create the local-history store', err)
    }
    // The unwatched folders apply from activation on, before the tree and the watchers start.
    setUnwatchedFolders((await this.getWorkspace()).config.fileTree.unwatched)
  }

  // ── workspace.* ─────────────────────────────────────────────────────────────
  async pick(): Promise<string | null> {
    const result = await showDialog({
      title: 'Choose your Pomade workspace folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open Workspace'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    this.root = result.filePaths[0]
    await this.bootstrapWorkspace()
    await this.persistRoot(this.root)
    fireWorkspaceReady(this.root)
    return this.root
  }

  /** E-006 (T-027) — open an unconstrained native folder dialog and RETURN the chosen path
   *  without committing it as the active workspace. The renderer flushes the old workspace's
   *  state, then calls change() to commit. Returns null on cancel. */
  async pickRoot(): Promise<string | null> {
    // Testing hook (read fresh each call so a test can switch targets between calls):
    // POMADE_PICK_ROOT stands in for the native folder dialog's return value.
    const forced = process.env.POMADE_PICK_ROOT
    if (forced && forced.trim()) return forced
    const result = await showDialog({
      title: 'Change Pomade workspace folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Switch Workspace'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }

  /** E-006 (T-027) — commit a workspace switch. Runs registered teardown hooks (PTYs + fs
   *  watchers are per-workspace; killing them here is the one sanctioned exception to the
   *  "PTYs live for the app's life" invariant), then sets + bootstraps + persists the new
   *  root and returns the fresh snapshot. */
  async changeRoot(newRoot: string): Promise<{ root: string | null; config: WorkspaceConfig }> {
    // Land any debounced writes (incl. the tab state the renderer just flushed) to the OLD
    // workspace's .pomade before the root changes — writes are keyed by absolute path, but
    // flushing now guarantees the round-trip-survival of each workspace's .pomade.
    await flushPendingWrites()
    for (const fn of teardownHooks) {
      try {
        await fn()
      } catch (err) {
        console.error('[config-store] workspace teardown hook failed', err)
      }
    }
    // State is cached by project id, not by path: the old workspace's must not seed the new one's.
    this.stateCache.clear()
    this.root = newRoot
    await this.bootstrapWorkspace()
    await this.persistRoot(this.root)
    fireWorkspaceReady(this.root)
    return this.getWorkspace()
  }

  async getWorkspace(): Promise<{ root: string | null; config: WorkspaceConfig }> {
    if (!this.root) return { root: null, config: EMPTY_WORKSPACE_CONFIG }
    const raw = await readJson<WorkspaceConfig>(join(this.pomadeDir(), 'workspace.json'))
    // Built field by field: only the known keys are read (an unknown key in the file is
    // ignored, never passed on), and a missing required field is defaulted (T-019) rather
    // than let `undefined` flow to callers that treat it as required.
    const config: WorkspaceConfig = {
      groups: raw?.groups ?? [],
      // A project without a visible-agents list (older config files) offers every agent;
      // an empty list is a real choice — no agents — and passes through.
      projects: (raw?.projects ?? []).map((p) =>
        upgradeProject(Array.isArray(p.visibleAgents) ? p : { ...p, visibleAgents: ['*'] })
      ),
      fileTree: {
        ignore: raw?.fileTree?.ignore ?? DEFAULT_FILETREE_SETTINGS.ignore,
        unwatched: Array.isArray(raw?.fileTree?.unwatched)
          ? raw.fileTree.unwatched.filter((f): f is string => typeof f === 'string')
          : []
      },
      // E-010 (round-3) — optional; passed through as-is (undefined when never set).
      identity: raw?.identity,
      // E-015 — Ungrouped's top-level position; passed through as-is (undefined = sorts last).
      // Group-tree normalization/migration (dangling parentId, cycles, depth clamp) is done
      // renderer-side in workspace-store.hydrate via reorder.ts `normalizeGroupTree`, which
      // writes any correction back through the normal saveConfig.
      ungroupedOrder: raw?.ungroupedOrder
    }
    return { root: this.root, config }
  }

  /** The tree's configured ignored items (T-019), defaulted if unset. Read fresh each call —
   *  low-frequency, and keeps fs-service decoupled from caching workspace.json itself. */
  async getTreeIgnore(): Promise<string[]> {
    const { config } = await this.getWorkspace()
    return config.fileTree.ignore
  }

  /** E-047 (T-291) — the workspace's project ids as Pomade has them now: a `workspace.json`
   *  save still waiting for its debounce counts. */
  async projectIds(): Promise<string[]> {
    const queued = pending.get(join(this.pomadeDir(), 'workspace.json'))?.data as WorkspaceConfig | undefined
    const projects = queued?.projects ?? (await this.getWorkspace()).config.projects
    return projects.map((p) => p.id)
  }

  saveConfig(config: WorkspaceConfig): void {
    scheduleWrite(join(this.pomadeDir(), 'workspace.json'), config)
    setUnwatchedFolders(config.fileTree.unwatched)
  }

  // ── agents overrides (read here; Wave 2b writes) ─────────────────────────────
  async getAgentOverrides(): Promise<AgentOverrides> {
    const o = await readJson<AgentOverrides>(join(this.pomadeDir(), 'agents.json'))
    return o ?? { commands: {}, hidden: [] }
  }

  // ── state.* (per-project, gitignored) ────────────────────────────────────────
  //
  // E-026 — the per-project state file has MORE than one renderer-side owner now: tabs-store
  // owns {openTabs, activeTabId, propertiesPanelExpanded} and mounts-store owns
  // {mounts, collapsedRoots}. Because scheduleWrite COALESCES by path (it keeps only the last
  // payload before the debounce fires), two independent whole-object writers would clobber each
  // other even before touching disk. So saveState is a MERGE, not a replace: each caller sends a
  // PARTIAL patch of the fields it owns, and we merge it over the last-known state (seeded by
  // loadState, kept current by every save). The merge is serialized in main (single-threaded), so
  // there is no renderer-side TOCTOU race — a caller never has to read-modify-write. A field is
  // only ever overwritten by the owner that includes its key; a key the patch omits is preserved.
  private stateCache = new Map<string, ProjectState>()

  async loadState(projectId: string): Promise<ProjectState | null> {
    const path = join(this.pomadeDir(), 'state', `${projectId}.json`)
    // A save still waiting for its debounce is newer than the file: the cache holds it (every
    // save merges into it) — main's own writes (`updateState`) included, which no renderer
    // store has loaded yet.
    if (pending.has(path)) return this.stateCache.get(projectId) ?? null
    await writeChains.get(path)
    const state = await readJson<ProjectState>(path)
    if (pending.has(path)) return this.stateCache.get(projectId) ?? state
    if (!state) return null
    // E-026 — defensively default the mount fields for any state file written before they
    // existed (same pattern as WorkspaceConfig.fileTree). loadState is the ONE read path, so a
    // pre-E-026 file rehydrates as an empty mount set instead of `undefined`.
    if (!state.mounts) state.mounts = []
    if (!state.collapsedRoots) state.collapsedRoots = []
    this.stateCache.set(projectId, state)
    return state
  }

  /** E-047 (T-291) — main's own change to a project's state, merged like a renderer save: `fn`
   *  gets the state as it is now (null = none yet) and returns the patch, or null for no change.
   *  Callers serialize their own updates of a field. */
  async updateState(
    projectId: string,
    fn: (state: ProjectState | null) => Partial<ProjectState> | null
  ): Promise<void> {
    if (!this.root || !isValidStateKey(projectId)) return
    if (!this.stateCache.has(projectId)) await this.loadState(projectId)
    const patch = fn(this.stateCache.get(projectId) ?? null)
    if (patch) this.saveState(projectId, patch)
  }

  saveState(projectId: string, patch: Partial<ProjectState>): void {
    const base = this.stateCache.get(projectId) ?? ({ openTabs: [] } as ProjectState)
    const merged: ProjectState = { ...base, ...patch }
    this.stateCache.set(projectId, merged)
    scheduleWrite(join(this.pomadeDir(), 'state', `${projectId}.json`), merged)
  }

  /** T-156 — delete a project's per-project state file on project TEARDOWN. Escape-guarded (see
   *  `isValidStateKey`); a missing file is a no-op (`fs.rm` with `force`). Cancels any queued
   *  debounced write to that path and drops its `stateCache` entry FIRST, then awaits any
   *  already-in-flight atomic write for the path, so neither a scheduled save (the teardown's own
   *  tab-closes schedule one) nor a landing rename can re-create the file after the unlink. */
  async removeState(projectId: string): Promise<void> {
    if (!this.root || !isValidStateKey(projectId)) return
    const path = join(this.pomadeDir(), 'state', `${projectId}.json`)
    const queued = pending.get(path)
    if (queued) {
      clearTimeout(queued.timer)
      pending.delete(path)
    }
    this.stateCache.delete(projectId)
    // Let any in-flight chained write for this path settle so its rename can't outlive our unlink.
    await writeChains.get(path)
    await fs.rm(path, { force: true })
  }

  // ── workspace-ui.* (workspace-scoped, gitignored; T-140 / T-141) ─────────────
  //
  // `.pomade/state/workspace-ui.json` has TWO independent renderer-side owners:
  // workspace-ui-store's collapsed-groups writer (T-140) and its last-active-project writer
  // (T-141). Same clobber hazard as ProjectState (scheduleWrite coalesces by path), so this is a
  // MERGE, not a replace — each caller sends only the field(s) it owns and we merge over the
  // last-known state (seeded by loadWorkspaceUi, kept current by every save). To close the
  // seed-before-load race — a save that lands before the first load would otherwise merge over an
  // empty base and wipe the OTHER field on disk — saveWorkspaceUi lazily seeds the cache from a
  // SYNCHRONOUS read of the file when it is not yet cached.
  private workspaceUiCache = new Map<string, WorkspaceUiState>()

  private workspaceUiPath(): string {
    return join(this.pomadeDir(), 'state', 'workspace-ui.json')
  }

  private static readonly EMPTY_WORKSPACE_UI: WorkspaceUiState = {
    lastActiveProjectId: null,
    collapsedGroups: [],
    overlayPositions: {}
  }

  private normalizeWorkspaceUi(raw: Partial<WorkspaceUiState> | null): WorkspaceUiState {
    return {
      lastActiveProjectId: raw?.lastActiveProjectId ?? null,
      collapsedGroups: raw?.collapsedGroups ?? [],
      overlayPositions: normalizeOverlayPositions(raw?.overlayPositions)
    }
  }

  async loadWorkspaceUi(): Promise<WorkspaceUiState> {
    if (!this.root) return { ...ConfigStore.EMPTY_WORKSPACE_UI }
    const path = this.workspaceUiPath()
    const state = this.normalizeWorkspaceUi(await readJson<Partial<WorkspaceUiState>>(path))
    this.workspaceUiCache.set(path, state)
    return state
  }

  saveWorkspaceUi(patch: Partial<WorkspaceUiState>): void {
    if (!this.root) return
    const path = this.workspaceUiPath()
    let base = this.workspaceUiCache.get(path)
    if (!base) {
      // Seed synchronously from disk so a save that races ahead of the first load never merges
      // over an empty base and clobbers the sibling field written by the other owner.
      try {
        base = this.normalizeWorkspaceUi(JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkspaceUiState>)
      } catch {
        base = { ...ConfigStore.EMPTY_WORKSPACE_UI }
      }
    }
    const merged: WorkspaceUiState = { ...base, ...patch }
    this.workspaceUiCache.set(path, merged)
    scheduleWrite(path, merged)
  }
}

export const configStore = new ConfigStore()

// T-082 — Pomade's OWN version. app.getVersion() reports ELECTRON's version in unpackaged
// runs (dev/e2e launch the bare binary against out/main, so no app package.json is
// registered — the label read "v33.4.11"). The bundle always sits at <root>/out/main, so
// <root>/package.json is two levels up from __dirname in dev, e2e AND inside app.asar.
// Cached — it cannot change within a run. Also the Host API's `pomadeVersion` (E-027).
let appVersion: string | null = null
export function pomadeVersion(): string {
  if (appVersion) return appVersion
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
      version?: string
    }
    appVersion = pkg.version ?? app.getVersion()
  } catch {
    appVersion = app.getVersion()
  }
  return appVersion
}

// ─── IPC registration ─────────────────────────────────────────────────────────
export function registerConfigStore(ipc: typeof ipcMain): void {
  // Test mode changes three handlers below (clipboard, openPath/showItemInFolder, openExternal)
  // from "touch the machine" to "record it" — see each for why.
  const isTest = process.env.NODE_ENV === 'test'

  defineHandler(ipc, CH.workspace.pick, () => configStore.pick())
  defineHandler(ipc, CH.workspace.get, () => configStore.getWorkspace())
  defineHandler(ipc, CH.workspace.saveConfig, (_e, config) => {
    configStore.saveConfig(config)
  })
  // E-006 (T-027) — change workspace.
  defineHandler(ipc, CH.workspace.pickRoot, () => configStore.pickRoot())
  defineHandler(ipc, CH.workspace.change, (_e, root) => configStore.changeRoot(root))

  defineHandler(ipc, CH.state.load, (_e, projectId) => configStore.loadState(projectId))
  defineHandler(ipc, CH.state.save, (_e, projectId, state) => {
    configStore.saveState(projectId, state)
  })
  // T-156 — remove a project's per-project state file on teardown (escape-guarded; missing = no-op).
  defineHandler(ipc, CH.state.remove, (_e, projectId) => configStore.removeState(projectId))

  // E-026 (T-140 / T-141) — workspace-scoped Projects panel UI state.
  defineHandler(ipc, CH.workspaceUi.load, () => configStore.loadWorkspaceUi())
  defineHandler(ipc, CH.workspaceUi.save, (_e, patch) => {
    configStore.saveWorkspaceUi(patch)
  })

  defineHandler(ipc, CH.app.version, () => pomadeVersion())
  // T-083 — native spellchecker actions. `replaceMisspelling` swaps the word under the most
  // recent right-click (Chromium keeps that context); the dictionary add is session-scoped
  // (macOS: backed by the OS spellchecker's dictionary).
  defineHandler(ipc, CH.app.replaceMisspelling, (e, suggestion) => {
    e.sender.replaceMisspelling(suggestion)
  })
  defineHandler(ipc, CH.app.addToDictionary, (e, word) => {
    e.sender.session.addWordToSpellCheckerDictionary(word)
  })
  // E-020 — under NODE_ENV=test the two "hand this path to the OS" channels RECORD instead of
  // acting. Two reasons: e2e can assert the E-020 routing matrix (which reveals images, binaries
  // and out-of-workspace files in Finder), and a suite run stops spawning real Finder windows
  // that steal focus from the app under test — the same reasoning as the in-memory clipboard.
  const recordTestPath = (bucket: '__pomadeOpenedPaths' | '__pomadeRevealedPaths', value: string): void => {
    const g = globalThis as Partial<Record<typeof bucket, string[]>>
    ;(g[bucket] ??= []).push(value)
  }

  defineHandler(ipc, CH.app.openPath, async (_e, rel) => {
    const root = configStore.getRoot()
    if (!root) return
    const target = join(root, rel)
    if (isTest) {
      recordTestPath('__pomadeOpenedPaths', target)
      return
    }
    await shell.openPath(target)
  })
  // E-012 (final) — reveal an ABSOLUTE path in the OS file manager (outside-workspace
  // symlink targets, where the tree can't help). shell.showItemInFolder is synchronous.
  defineHandler(ipc, CH.app.showItemInFolder, (_e, abs) => {
    if (isTest) {
      recordTestPath('__pomadeRevealedPaths', abs)
      return
    }
    shell.showItemInFolder(abs)
  })
  // E-020 (T-086) — open a URL Cmd+clicked in a terminal in the DEFAULT BROWSER. Scheme-gated
  // to http/https: terminal output is untrusted text, and shell.openExternal would happily
  // hand `file:`/`mailto:`/custom-scheme URIs to whatever handler the OS has registered.
  // Under NODE_ENV=test nothing is launched — the URLs are recorded on the main-process global
  // so e2e can assert the routing without a real browser window stealing focus mid-suite
  // (same test-mode reasoning as the in-memory clipboard below).
  defineHandler(ipc, CH.app.openExternal, async (_e, url) => {
    if (!/^https?:\/\//i.test(url)) return
    if (process.env.NODE_ENV === 'test') {
      const g = globalThis as { __pomadeOpenedUrls?: string[] }
      ;(g.__pomadeOpenedUrls ??= []).push(url)
      return
    }
    await shell.openExternal(url)
  })

  // App settings, kept in the active workspace (T-313).
  defineHandler(ipc, CH.app.getSettings, () => configStore.getAppSettings())
  defineHandler(ipc, CH.app.setSettings, (_e, patch) => configStore.setAppSettings(patch))

  // E-001 (T-011) — editor Cut/Copy/Paste route through the Electron clipboard so there is
  // no navigator.clipboard permission prompt and e2e can read/write deterministically.
  //
  // T-037 — the OS clipboard is a SINGLE resource shared by every process on the machine.
  // Once the e2e suite runs file-level workers in parallel, several Electron apps are live at
  // once; a copy in one spec would clobber another spec's copy→read round-trip (and each run
  // would also stomp the developer's real clipboard). In test mode we therefore back the
  // clipboard with a per-process in-memory buffer: every app instance is fully isolated, the
  // read/write stays deterministic, and copy/paste (both directions route through here — see
  // EditorPane/FileTree/TabStrip/SymlinkPopover) remains self-consistent within an instance.
  let testClipboard = ''
  defineHandler(ipc, CH.app.clipboardRead, () => (isTest ? testClipboard : clipboard.readText()))
  // Electron 44's clipboard.writeText returns a Promise<void> (was void in 33); awaiting it
  // means the invoke round-trip resolves only after the OS write lands, so a renderer
  // copy→paste sequence can't race a not-yet-committed clipboard.
  defineHandler(ipc, CH.app.clipboardWrite, async (_e, text) => {
    if (isTest) testClipboard = text
    else await clipboard.writeText(text)
  })
}
