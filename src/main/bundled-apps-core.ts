// Pomade — bundled apps (docs/HOST-API.md §8 "Bundled apps"): what the stable Pomade does at start
// with each app its release carries. Pure: the disk side is `bundled-apps.ts`.

/** A bundled app: its id and its build's version. */
export interface BundledApp {
  id: string
  version: string
}

export type BundledStep =
  | { id: string; action: 'install'; version: string }
  | { id: string; action: 'update'; version: string; from: string | null }
  /** The installed build is the same or newer (an install by hand): kept. */
  | { id: string; action: 'keep' }
  /** The user removed the app at this build or a newer one: not put back. */
  | { id: string; action: 'skip-removed' }

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Semver precedence of `a` against `b` (-1, 0, 1); an unparsable version sorts below any other. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return Math.sign(d)
  }
  const ra = pa[4]
  const rb = pb[4]
  if (ra === undefined || rb === undefined) return ra === rb ? 0 : ra === undefined ? 1 : -1
  const xa = ra.split('.')
  const xb = rb.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1
    if (xb[i] === undefined) return 1
    const na = /^\d+$/.test(xa[i]) ? Number(xa[i]) : null
    const nb = /^\d+$/.test(xb[i]) ? Number(xb[i]) : null
    if (na !== null && nb !== null) {
      if (na !== nb) return Math.sign(na - nb)
    } else if (na !== null) return -1
    else if (nb !== null) return 1
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1
  }
  return 0
}

/**
 * One step per bundled app:
 * - removed by the user at this build's version or a newer one → `skip-removed`;
 * - not installed → `install`;
 * - installed older (or with no readable version: `null`) → `update`;
 * - installed at the same or a newer version → `keep`.
 *
 * `installed` maps an installed id to its version (`null`: the install has no valid manifest).
 * `removals` maps a removed id to the version it had when removed.
 */
export function planBundledInstall(
  bundled: readonly BundledApp[],
  installed: ReadonlyMap<string, string | null>,
  removals: Readonly<Record<string, string>>
): BundledStep[] {
  return bundled.map((b): BundledStep => {
    const removed = removals[b.id]
    if (removed !== undefined && compareVersions(b.version, removed) <= 0) return { id: b.id, action: 'skip-removed' }
    if (!installed.has(b.id)) return { id: b.id, action: 'install', version: b.version }
    const have = installed.get(b.id) ?? null
    if (have === null || compareVersions(b.version, have) > 0) return { id: b.id, action: 'update', version: b.version, from: have }
    return { id: b.id, action: 'keep' }
  })
}

/** The paths outside the workspace a step shows the user (HOST-API §1 `outsideWorkspace`, shown once
 *  at install): every one for an install, those the installed build did not declare for an update,
 *  none otherwise. */
export function outsidePathsToShow(step: BundledStep, bundled: readonly string[], installed: readonly string[]): string[] {
  if (step.action === 'install') return [...bundled]
  if (step.action === 'update') return bundled.filter((p) => !installed.includes(p))
  return []
}

/** The title of the notice that names an app's paths outside the workspace. */
export const OUTSIDE_TITLE = 'Outside the workspace'

/** One notice per installed or updated app with paths outside the workspace to show (`outside`,
 *  from `outsidePathsToShow`), titled "Outside the workspace"; the body names the app and the paths.
 *  Posted after `bundledNotice`, so a toast shows the paths and the install notice is "1 more". */
export function outsideNotices(
  steps: readonly BundledStep[],
  names: ReadonlyMap<string, string>,
  outside: ReadonlyMap<string, readonly string[]>
): { title: string; body: string }[] {
  return steps.flatMap((s) => {
    const paths = s.action === 'install' || s.action === 'update' ? (outside.get(s.id) ?? []) : []
    if (paths.length === 0) return []
    const name = names.get(s.id) ?? s.id
    return [{ title: OUTSIDE_TITLE, body: `${name} ${s.action === 'install' ? 'uses' : 'now also uses'} ${paths.join(', ')}` }]
  })
}

/** The notice after start, when something was installed or updated: `null` otherwise. `names`
 *  gives each id's display name. */
export function bundledNotice(
  steps: readonly BundledStep[],
  names: ReadonlyMap<string, string>
): { title: string; body: string } | null {
  const name = (id: string): string => names.get(id) ?? id
  const installed = steps.flatMap((s) => (s.action === 'install' ? [`${name(s.id)} ${s.version}`] : []))
  const updated = steps.flatMap((s) =>
    s.action === 'update' ? [`${name(s.id)} ${s.from !== null ? `${s.from} → ` : ''}${s.version}`] : []
  )
  if (installed.length === 0 && updated.length === 0) return null
  const count = installed.length + updated.length
  const title =
    updated.length === 0
      ? `${count === 1 ? 'An app' : `${count} apps`} installed with Pomade`
      : installed.length === 0
        ? `${count === 1 ? 'An app' : `${count} apps`} updated with Pomade`
        : `${count} apps installed or updated with Pomade`
  const lines: string[] = []
  if (installed.length > 0) lines.push(`Installed: ${installed.join(', ')}`)
  if (updated.length > 0) lines.push(`Updated: ${updated.join(', ')}`)
  return { title, body: lines.join('\n') }
}
