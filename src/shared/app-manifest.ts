// Pomade — the app manifest as Pomade holds it, and the on-disk app layout (docs/HOST-API.md
// §1–§2). Validation is pomade-kit's `parseManifest`; this file adds Pomade's side: the
// normalized manifest (entry defaulted, name trimmed, capabilities deduped, strip defaulted to
// []), the install summary, and dev links. Shared by the main process (discovery) and
// the `bin/pomade` command, which runs this file directly under Node's type stripping: keep it
// to erasable TypeScript (no enums, namespaces, parameter properties) and import packages only.

import {
  APP_ID_RE,
  DEFAULT_ENTRY,
  launchPanelIcon,
  parseManifest as parseKitManifest,
  type AppBackend,
  type AppCommand,
  type AppShortcut,
  type AppSkill,
  type AppTabKind,
  type Capability,
  type ManifestEvents,
  type StripIcon
} from 'pomade-kit/protocol'

export { APP_ID_RE, DEFAULT_ENTRY, MANIFEST_FILE } from 'pomade-kit/protocol'

/** Installed apps live in `<userData>/<APPS_DIR>/<id>/`. */
export const APPS_DIR = 'apps'
/** Dev links live in `<userData>/<APP_LINKS_FILE>`. */
export const APP_LINKS_FILE = 'app-links.json'

// A dev-server link: plain http on the loopback host with an explicit port.
const DEV_URL_RE = /^http:\/\/(localhost|127\.0\.0\.1):(\d{1,5})\/?$/

export interface AppManifest {
  id: string
  name: string
  version: string
  hostApi: number
  /** Path inside the build folder; defaulted to `index.html`. */
  entry: string
  icon?: string
  capabilities: Capability[]
  /** The app's left-strip icons, in manifest order; `[]` when the manifest declares none. */
  strip: StripIcon[]
  /** T-268 — the app's tab kinds by id (`tabs.openApp` `kind`); `{}` when the manifest declares none. */
  tabKinds: Record<string, AppTabKind>
  /** E-030 — folder patterns where the app may create and remove symlinks (`files.symlink`);
   *  `[]` when the manifest declares none. */
  symlinks: string[]
  /** The strip icon whose panel loads, hidden, at Pomade launch (`startOnLaunch`); null = none. */
  launchPanel: string | null
  /** The app's Pomade-wide shortcuts as declared, keys canonical; `[]` when none. */
  shortcuts: AppShortcut[]
  /** The agent skills the app ships (folders in the build); `[]` when none. */
  skills: AppSkill[]
  /** E-031 — the events the app publishes (its own names) and subscribes to; empty lists when none. */
  events: ManifestEvents
  /** E-028 — the app's background process; null when it has none. */
  backend: AppBackend | null
  /** E-028 — the methods it serves through the broker; `[]` when none. */
  api: string[]
  /** E-028 — the apps whose APIs it calls; `[]` when none. */
  calls: string[]
  /** E-028 — the command-line entries it ships; `[]` when none. */
  commands: AppCommand[]
  /** The paths outside the workspace it uses, as written (`~/.claude/`); `[]` when none. */
  outsideWorkspace: string[]
}

export type ManifestResult =
  | {
      ok: true
      manifest: AppManifest
      /** Top-level keys this Pomade does not support yet — accepted, reported in the summary. */
      unsupportedKeys: string[]
    }
  | { ok: false; errors: string[] }

/** Validate a parsed `manifest.json` with the kit's rules (HOST-API §1, `strip` included). Every
 *  invalid field is reported; each message names the field and the value received. */
export function validateManifest(raw: unknown): ManifestResult {
  const r = parseKitManifest(raw)
  if ('errors' in r) return { ok: false, errors: r.errors.map((e) => e.message) }
  const m = r.manifest
  return {
    ok: true,
    manifest: {
      id: m.id,
      name: m.name.trim(),
      version: m.version,
      hostApi: m.hostApi,
      entry: m.entry ?? DEFAULT_ENTRY,
      ...(m.icon !== undefined ? { icon: m.icon } : {}),
      capabilities: [...new Set(m.capabilities)],
      strip: m.strip ?? [],
      tabKinds: m.tabKinds ?? {},
      symlinks: m.symlinks ?? [],
      launchPanel: launchPanelIcon(m)?.id ?? null,
      shortcuts: m.shortcuts ?? [],
      skills: m.skills ?? [],
      events: m.events ?? { publish: [], subscribe: [] },
      backend: m.backend ?? null,
      api: m.api ?? [],
      calls: m.calls ?? [],
      commands: m.commands ?? [],
      outsideWorkspace: m.outsideWorkspace ?? []
    },
    unsupportedKeys: r.unsupportedKeys
  }
}

/** Parse + validate the text of a `manifest.json`. */
export function parseManifest(text: string): ManifestResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`manifest.json is not valid JSON: ${(err as Error).message}`] }
  }
  return validateManifest(raw)
}

/** The install summary `pomade apps install` prints (§1: declares what the manifest carries). */
export function manifestSummary(manifest: AppManifest, unsupportedKeys: string[]): string[] {
  const lines = [
    `${manifest.name} ${manifest.version} (${manifest.id})`,
    `  Host API:      ${manifest.hostApi}`,
    `  Entry:         ${manifest.entry}`,
    `  Icon:          ${manifest.icon ?? '(none)'}`,
    `  Capabilities:  ${manifest.capabilities.length > 0 ? manifest.capabilities.join(', ') : '(none)'}`,
    `  Strip icons:   ${
      manifest.strip.length > 0 ? manifest.strip.map((s) => `${s.title} (${s.action})`).join(', ') : '(none)'
    }`
  ]
  const kinds = Object.values(manifest.tabKinds)
  if (kinds.length > 0) lines.push(`  Tab kinds:     ${kinds.map((k) => k.title).join(', ')}`)
  if (manifest.symlinks.length > 0) lines.push(`  Symlinks in:   ${manifest.symlinks.join(', ')}`)
  if (manifest.launchPanel !== null) {
    const icon = manifest.strip.find((s) => s.id === manifest.launchPanel)
    lines.push(`  Start on launch: the "${icon?.title ?? manifest.launchPanel}" panel loads hidden when Pomade starts`)
  }
  lines.push(
    `  Shortcuts:     ${
      manifest.shortcuts.length > 0
        ? manifest.shortcuts.map((k) => `${k.title} ${k.key} (${k.action}${k.route ? ` "${k.route}"` : ''})`).join(', ')
        : '(none)'
    }`
  )
  const conflicts = pomadeShortcutConflicts(manifest.shortcuts)
  if (conflicts.length > 0) lines.push(`  Shortcut conflicts — Pomade wins, these do nothing: ${conflicts.join('; ')}`)
  lines.push(
    `  Skills:        ${manifest.skills.length > 0 ? manifest.skills.map((k) => `${k.name} (${k.path})`).join(', ') : '(none)'}`
  )
  lines.push(
    `  Events:        ${
      manifest.events.publish.length + manifest.events.subscribe.length > 0
        ? [
            `publishes ${manifest.events.publish.join(', ') || '(none)'}`,
            `subscribes to ${manifest.events.subscribe.join(', ') || '(none)'}`
          ].join(' · ')
        : '(none)'
    }`
  )
  lines.push(`  Backend:       ${backendLine(manifest.backend)}`)
  lines.push(`  API offered:   ${manifest.api.length > 0 ? manifest.api.join(', ') : '(none)'}`)
  lines.push(`  Calls apps:    ${manifest.calls.length > 0 ? manifest.calls.join(', ') : '(none)'}`)
  lines.push(
    `  Commands:      ${
      manifest.commands.length > 0 ? manifest.commands.map((c) => `${c.name} (${c.title || c.entry})`).join(', ') : '(none)'
    }`
  )
  lines.push(`  Outside the workspace: ${outsideLine(manifest.outsideWorkspace)}`)
  if (unsupportedKeys.length > 0) {
    lines.push(`  Not supported by this Pomade yet: ${unsupportedKeys.join(', ')}`)
  }
  return lines
}

/** The paths outside the workspace an app uses, as the install summary and notice name them. */
export function outsideLine(paths: readonly string[]): string {
  return paths.length > 0 ? paths.join(', ') : '(none)'
}

/** E-028 — what the summary says about the backend. */
function backendLine(backend: AppBackend | null): string {
  if (backend === null) return '(none)'
  if (backend.mode === 'with-pomade') return `${backend.entry} — runs while Pomade runs, restarted if it crashes`
  return `${backend.entry} — always on: a login item that keeps running when Pomade quits${
    backend.restartOnUpdate ? '; an update restarts it' : '; an update does not restart it'
  }`
}

/** E-028 — PLATFORM rule 4: the call cycles `calls` forms among these apps, each as the ids along it
 *  (`["a", "b", "a"]`), each cycle reported once, starting at its smallest id. */
export function callCycles(apps: readonly { id: string; calls: readonly string[] }[]): string[][] {
  const calls = new Map(apps.map((a) => [a.id, a.calls]))
  const found = new Map<string, string[]>()
  const walk = (path: string[]): void => {
    const last = path[path.length - 1]
    for (const next of calls.get(last) ?? []) {
      const at = path.indexOf(next)
      if (at !== -1) {
        const cycle = path.slice(at)
        const start = cycle.indexOf([...cycle].sort()[0])
        const canon = [...cycle.slice(start), ...cycle.slice(0, start)]
        found.set(canon.join(' '), [...canon, canon[0]])
      } else if (calls.has(next)) walk([...path, next])
    }
  }
  for (const id of calls.keys()) walk([id])
  return [...found.values()]
}

// ─── Shortcuts (§1 `shortcuts`) ──────────────────────────────────────────────────

/** Pomade's chords that main runs whatever has focus (canonical spelling): the menu accelerators
 *  (`main/index.ts` `buildAppMenu` and its standard role menus) and the chords main takes before
 *  the page (`main/window-shortcuts.ts`). An app frame leaves them unhandled and they reach main
 *  natively, so the frame bridge never re-dispatches a forwarded one (it would run twice). */
export const MAIN_SHORTCUTS: Readonly<Record<string, string>> = {
  'Cmd+T': 'New Terminal Tab',
  'Cmd+W': 'Close Tab',
  'Cmd+Shift+T': 'Reopen Closed Tab',
  'Cmd+F': 'Find in Document',
  'Cmd+Shift+W': 'Close Window',
  'Cmd+B': 'Toggle Projects Panel',
  'Cmd+Shift+B': 'Toggle Side Panel',
  'Cmd+Q': 'Quit Pomade',
  'Cmd+H': 'Hide Pomade',
  'Cmd+Alt+H': 'Hide Others',
  'Cmd+M': 'Minimize',
  'Cmd+Z': 'Undo',
  'Cmd+Shift+Z': 'Redo',
  'Cmd+X': 'Cut',
  'Cmd+C': 'Copy',
  'Cmd+V': 'Paste',
  'Cmd+A': 'Select All',
  'Cmd+Alt+Shift+V': 'Paste and Match Style',
  'Cmd+R': 'Reload',
  'Cmd+Alt+I': 'Toggle Developer Tools',
  'Cmd+0': 'Actual Size',
  'Cmd+Ctrl+F': 'Toggle Full Screen'
}

/** Pomade's own Cmd chords: `MAIN_SHORTCUTS`, the renderer's window-level shortcuts and the
 *  editors' keymaps. An app shortcut on one of these is a conflict: Pomade wins. Keep in sync when
 *  Pomade gains a Cmd chord. */
export const POMADE_SHORTCUTS: Readonly<Record<string, string>> = {
  ...MAIN_SHORTCUTS,
  // Renderer and editors
  'Cmd+Shift+G': 'Quick peek',
  'Cmd+Shift+H': 'Document history',
  'Cmd+S': 'Save',
  'Cmd+I': 'Italic',
  'Cmd+E': 'Inline code',
  'Cmd+D': 'Select next occurrence',
  'Cmd+Alt+G': 'Go to line',
  'Cmd+Shift+L': 'Select all matches',
  'Cmd+Shift+K': 'Delete line',
  'Cmd+U': 'Undo selection',
  'Cmd+Shift+U': 'Redo selection',
  'Cmd+Y': 'Redo',
  'Cmd+Alt+C': 'Code block',
  'Cmd+Alt+0': 'Paragraph',
  'Cmd+Alt+1': 'Heading 1',
  'Cmd+Alt+2': 'Heading 2',
  'Cmd+Alt+3': 'Heading 3',
  'Cmd+Alt+4': 'Heading 4',
  'Cmd+Alt+5': 'Heading 5',
  'Cmd+Alt+6': 'Heading 6',
  'Cmd+Alt+7': 'Ordered list',
  'Cmd+Alt+8': 'Bullet list'
}

/** The app's shortcuts that Pomade itself uses, as readable conflicts. */
export function pomadeShortcutConflicts(shortcuts: readonly AppShortcut[]): string[] {
  return shortcuts
    .filter((k) => POMADE_SHORTCUTS[k.key] !== undefined)
    .map((k) => `${k.key} ("${k.title}") is Pomade's ${POMADE_SHORTCUTS[k.key]}`)
}

/** Which app shortcuts are live: every app's, minus chords Pomade uses and chords an earlier app
 *  (by id) already took. `conflicts` are readable reasons, per app. */
export function resolveAppShortcuts(
  apps: readonly { id: string; shortcuts: readonly AppShortcut[] }[]
): Map<string, { active: AppShortcut[]; conflicts: string[] }> {
  const out = new Map<string, { active: AppShortcut[]; conflicts: string[] }>()
  const taken = new Map<string, string>()
  for (const app of [...apps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const active: AppShortcut[] = []
    const conflicts: string[] = []
    for (const k of app.shortcuts) {
      const pomade = POMADE_SHORTCUTS[k.key]
      const other = taken.get(k.key)
      if (pomade !== undefined) conflicts.push(`${k.key} ("${k.title}") is Pomade's ${pomade}`)
      else if (other !== undefined) conflicts.push(`${k.key} ("${k.title}") is taken by the app "${other}"`)
      else {
        taken.set(k.key, app.id)
        active.push(k)
      }
    }
    out.set(app.id, { active, conflicts })
  }
  return out
}

// ─── Dev links (§2) ───────────────────────────────────────────────────────────

/** A dev link target: an absolute build-folder path or a loopback dev-server origin. */
export type DevTarget = { kind: 'folder'; path: string } | { kind: 'url'; url: string }

/** Classify a dev-link target. A URL must be `http://localhost:PORT` (or 127.0.0.1); its
 *  canonical form has no trailing slash. Anything that looks like a URL but isn't one of those
 *  is refused; everything else is a folder path (absolute, as stored). */
export function parseDevTarget(target: string): DevTarget | { error: string } {
  const t = target.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    const m = DEV_URL_RE.exec(t)
    if (!m) return { error: `dev-link URL must be http://localhost:PORT (got ${JSON.stringify(t)})` }
    return { kind: 'url', url: `http://${m[1]}:${m[2]}` }
  }
  if (!t.startsWith('/')) return { error: `dev-link folder must be an absolute path (got ${JSON.stringify(t)})` }
  return { kind: 'folder', path: t.replace(/\/+$/, '') || '/' }
}

export interface AppLink {
  id: string
  /** Absolute folder path, or `http://localhost:PORT`. */
  target: string
}

/** `<userData>/app-links.json` — `{ "links": [{ "id", "target" }] }`. Malformed entries are
 *  skipped; a malformed file reads as no links. */
export function parseAppLinks(text: string): AppLink[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  const links = (raw as { links?: unknown } | null)?.links
  if (!Array.isArray(links)) return []
  const out: AppLink[] = []
  for (const l of links as unknown[]) {
    const { id, target } = (l ?? {}) as { id?: unknown; target?: unknown }
    if (typeof id === 'string' && APP_ID_RE.test(id) && typeof target === 'string') {
      out.push({ id, target })
    }
  }
  return out
}

export function serializeAppLinks(links: AppLink[]): string {
  return JSON.stringify({ links }, null, 2) + '\n'
}
