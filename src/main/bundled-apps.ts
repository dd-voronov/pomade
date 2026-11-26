// Pomade — bundled apps (docs/HOST-API.md §8 "Bundled apps"). A packaged Pomade carries app builds
// in `Contents/Resources/bundled-apps/<id>/` (scripts/bundle-apps.mjs puts them there). At start,
// before the app registry's first scan, each is installed the way `pomade apps install` installs it
// (`app-install-core.ts`) when the plan says so (`bundled-apps-core.ts`); the registry then links
// its commands, starts its backend and loads its launch panel like any install. One notice lists
// what was installed or updated; one more per app names the paths outside the workspace it uses
// (an update: the ones it adds). Retired builds no process uses are deleted afterwards.
//
// Only a packaged Pomade has bundled apps; `POMADE_BUNDLED_APPS` names the folder instead (tests).

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'
import { queueNotice } from 'pomade-kit/node'

import { APPS_DIR, MANIFEST_FILE, parseManifest } from '@shared/app-manifest'
import { ensureAppKey } from './app-keys'
import { clearRemoval, collectRetiredBuilds, installBuild, installedIds, readRemovals } from './app-install-core'
import { bundledNotice, outsideNotices, outsidePathsToShow, planBundledInstall, type BundledApp } from './bundled-apps-core'

/** The notices' source for what Pomade itself posts. */
export const POMADE_NOTICE_SOURCE = 'pomade'

/** The folder of bundled app builds, or null when this Pomade carries none. */
export function bundledAppsDir(): string | null {
  const override = process.env['POMADE_BUNDLED_APPS']
  if (override && override.trim()) return override
  return app.isPackaged ? join(process.resourcesPath, 'bundled-apps') : null
}

async function readManifestIn(folder: string): Promise<ReturnType<typeof parseManifest> | null> {
  try {
    return parseManifest(await fs.readFile(join(folder, MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** The bundled builds in `dir`, each with a valid manifest whose id is its folder's name. */
async function readBundled(dir: string): Promise<(BundledApp & { name: string; folder: string; outsideWorkspace: string[] })[]> {
  let names: string[]
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
  } catch {
    return []
  }
  const out: (BundledApp & { name: string; folder: string; outsideWorkspace: string[] })[] = []
  for (const name of names.sort()) {
    const folder = join(dir, name)
    const r = await readManifestIn(folder)
    if (!r || !r.ok || r.manifest.id !== name) {
      console.error(`[bundled-apps] ${folder}: ${r && !r.ok ? r.errors.join('; ') : 'no valid manifest for this id'}`)
      continue
    }
    out.push({ id: name, version: r.manifest.version, name: r.manifest.name, folder, outsideWorkspace: r.manifest.outsideWorkspace })
  }
  return out
}

/** Install or update the bundled apps the plan calls for, post the notice, collect retired builds.
 *  Never throws: a failure is logged and start goes on. */
export async function installBundledApps(): Promise<void> {
  const userData = app.getPath('userData')
  try {
    const dir = bundledAppsDir()
    const bundled = dir ? await readBundled(dir) : []
    if (bundled.length > 0) {
      const installed = new Map<string, string | null>()
      const installedOutside = new Map<string, string[]>()
      for (const id of await installedIds(userData)) {
        const r = await readManifestIn(join(userData, APPS_DIR, id))
        installed.set(id, r && r.ok ? r.manifest.version : null)
        installedOutside.set(id, r && r.ok ? r.manifest.outsideWorkspace : [])
      }
      const steps = planBundledInstall(bundled, installed, await readRemovals(userData))
      const done: typeof steps = []
      for (const step of steps) {
        if (step.action !== 'install' && step.action !== 'update') continue
        const b = bundled.find((x) => x.id === step.id)!
        try {
          await installBuild(userData, b.id, b.folder)
          await ensureAppKey(userData, b.id)
          await clearRemoval(userData, b.id)
          done.push(step)
        } catch (err) {
          console.error(`[bundled-apps] installing ${b.id} failed`, err)
        }
      }
      const outside = new Map(
        done.map((step) => {
          const b = bundled.find((x) => x.id === step.id)!
          return [step.id, outsidePathsToShow(step, b.outsideWorkspace, installedOutside.get(step.id) ?? [])] as const
        })
      )
      const names = new Map(bundled.map((b) => [b.id, b.name]))
      const notice = bundledNotice(done, names)
      // HOST-API §1 `outsideWorkspace`: shown once, at install (an update: the paths it adds).
      const notices = [...(notice ? [notice] : []), ...outsideNotices(done, names, outside)]
      // The queue is read in posting order and a file's name carries its millisecond, so each
      // notice gets its own: the outside-paths notices come after the install notice, every time.
      const base = Date.now()
      for (const [i, n] of notices.entries()) {
        await queueNotice(n, { source: POMADE_NOTICE_SOURCE, userData, now: () => new Date(base + i) })
      }
    }
  } catch (err) {
    console.error('[bundled-apps] failed', err)
  }
  // Fire-and-forget: deleting old builds never delays start.
  void collectRetiredBuilds(userData).catch((err) => console.error('[bundled-apps] collecting retired builds failed', err))
}
