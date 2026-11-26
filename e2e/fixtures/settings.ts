// Pomade e2e — the app settings files of a fixture workspace (T-313): preferences in
// `.pomade/settings.json`, view state (widths, collapses, folds, view switches) in
// `.pomade/state/view.json`. A missing or half-written file reads as `{}`, so callers poll.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

async function readObject(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export const settingsJsonPath = (workspaceRoot: string): string => join(workspaceRoot, '.pomade/settings.json')
export const viewStatePath = (workspaceRoot: string): string => join(workspaceRoot, '.pomade/state/view.json')

/** `.pomade/settings.json` — the preferences. */
export const readSettingsJson = (workspaceRoot: string): Promise<Record<string, unknown>> =>
  readObject(settingsJsonPath(workspaceRoot))

/** `.pomade/state/view.json` — the view state. */
export const readViewState = (workspaceRoot: string): Promise<Record<string, unknown>> =>
  readObject(viewStatePath(workspaceRoot))
