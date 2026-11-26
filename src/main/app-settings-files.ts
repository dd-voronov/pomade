// Pomade — app settings in the workspace: the pure part. AppSettings travels over IPC as one
// object and is kept in two files of the active workspace (shared/types.ts `APP_VIEW_STATE_KEYS`):
// preferences in `.pomade/settings.json`, view state in `.pomade/state/view.json`. A file that is
// missing, unreadable or partial reads as the defaults for what it lacks; keys Pomade does not know
// are dropped on read. config-store does the I/O.

import {
  APP_VIEW_STATE_KEYS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_LAYOUT_SETTINGS,
  type AppPreferences,
  type AppSettings,
  type AppViewState,
  type AppViewStateKey
} from '@shared/types'
import { upgradeLayout } from './layout-settings'

/** `<userData>/app.json`: which workspace is active. Any other key in the file is ignored. */
export interface AppJson {
  workspaceRoot: string | null
}

export type BuildFlavor = 'stable' | 'dev'

const VIEW_KEYS: ReadonlySet<string> = new Set(APP_VIEW_STATE_KEYS)
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_APP_SETTINGS))

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Only the keys AppSettings has; anything else in a file is ignored. */
function knownOnly(raw: unknown): Partial<AppSettings> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (KNOWN_KEYS.has(k)) out[k] = v
  return out as Partial<AppSettings>
}

/** Stored settings and a patch over the defaults. `layout` merges field by field, so a partial
 *  layout patch keeps its sibling fields and a stored layout gains fields added since. */
export function mergeAppSettings(stored: unknown, patch: Partial<AppSettings> = {}): AppSettings {
  const base = knownOnly(stored)
  return {
    ...DEFAULT_APP_SETTINGS,
    ...base,
    ...patch,
    layout: {
      ...DEFAULT_LAYOUT_SETTINGS,
      ...upgradeLayout(isRecord(base.layout) ? base.layout : undefined),
      ...(patch.layout ?? {})
    }
  }
}

/** The settings both files hold, read together: preferences from settings.json, view state from
 *  view.json; each file contributes only its own keys. */
export function readAppSettings(settingsJson: unknown, viewJson: unknown): AppSettings {
  const prefs = knownOnly(settingsJson) as Record<string, unknown>
  const view = knownOnly(viewJson) as Record<string, unknown>
  const stored: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(prefs)) if (!VIEW_KEYS.has(k)) stored[k] = v
  for (const [k, v] of Object.entries(view)) if (VIEW_KEYS.has(k)) stored[k] = v
  return mergeAppSettings(stored)
}

export function preferencesOf(s: AppSettings): AppPreferences {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s)) if (!VIEW_KEYS.has(k)) out[k] = v
  return out as AppPreferences
}

export function viewStateOf(s: AppSettings): AppViewState {
  const out: Record<string, unknown> = {}
  for (const k of APP_VIEW_STATE_KEYS) out[k] = s[k]
  return out as AppViewState
}

/** Which of the two files a patch changes. */
export function filesTouchedBy(patch: Partial<AppSettings>): { preferences: boolean; viewState: boolean } {
  const keys = Object.keys(patch).filter((k) => KNOWN_KEYS.has(k))
  return {
    preferences: keys.some((k) => !VIEW_KEYS.has(k)),
    viewState: keys.some((k) => VIEW_KEYS.has(k as AppViewStateKey))
  }
}

/** Which Pomade this is — it decides where local history is kept: a packaged app is the stable
 *  one. Under test, `POMADE_TEST_BUILD_FLAVOR` (`stable` | `dev`) stands in, so e2e can run as the
 *  stable Pomade. */
export function buildFlavor(env: NodeJS.ProcessEnv, isPackaged: boolean): BuildFlavor {
  const forced = env['POMADE_TEST_BUILD_FLAVOR']
  if (env['NODE_ENV'] === 'test' && (forced === 'stable' || forced === 'dev')) return forced
  return isPackaged ? 'stable' : 'dev'
}
