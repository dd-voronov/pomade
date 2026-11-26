// Pomade — `pomade projects` (docs/HOST-API.md §2): the workspace's projects with their stable ids,
// read from the workspace's project file (`<root>/.pomade/workspace.json`) — Pomade running or
// closed. Runs under plain Node with the CLI (erasable TypeScript, explicit `.ts` imports).

import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { HOME_FILES } from 'pomade-kit/protocol'

/** Where the workspace keeps its projects (main/config-store.ts writes it). */
export const WORKSPACE_FILE = join('.pomade', 'workspace.json')
/** Pomade's own record in its user data: the open workspace (`workspaceRoot`). */
const APP_FILE = 'app.json'

export interface ListedProject {
  /** The stable id: survives renames and moves. */
  id: string
  name: string
  /** Workspace-relative folder; `""` = the workspace root. */
  root: string
  /** The folder, absolute. */
  path: string
}

/** The workspace a Pomade has open: `POMADE_WORKSPACE` (a Pomade terminal sets it), else the
 *  workspace pointer in its home (`<home>/workspace`, rewritten on every switch), else the
 *  `workspaceRoot` it records in `<userData>/app.json`; null when none names one. */
export async function projectsWorkspace(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  userData: string
): Promise<string | null> {
  const fromEnv = env['POMADE_WORKSPACE']?.trim()
  if (fromEnv && isAbsolute(fromEnv)) return fromEnv.replace(/\/+$/, '') || '/'
  const pointer = (await fs.readFile(join(home, HOME_FILES.workspace), 'utf8').catch(() => '')).trim()
  if (pointer && isAbsolute(pointer)) return pointer
  try {
    const raw = JSON.parse(await fs.readFile(join(userData, APP_FILE), 'utf8')) as { workspaceRoot?: unknown } | null
    const root = raw?.workspaceRoot
    return typeof root === 'string' && isAbsolute(root) ? root : null
  } catch {
    return null
  }
}

/** The projects in `<root>/.pomade/workspace.json`, by name (then id). No file: none. An entry
 *  without a string id, name and folder is skipped. Throws on a file that is not JSON. */
export async function readProjects(root: string): Promise<ListedProject[]> {
  let text: string
  try {
    text = await fs.readFile(join(root, WORKSPACE_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const projects = (JSON.parse(text) as { projects?: unknown } | null)?.projects
  const list: unknown[] = Array.isArray(projects) ? projects : []
  const out: ListedProject[] = []
  for (const p of list) {
    const { id, name, rootPath } = (p ?? {}) as { id?: unknown; name?: unknown; rootPath?: unknown }
    if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof rootPath !== 'string') continue
    out.push({ id, name, root: rootPath, path: rootPath === '' ? root : join(root, rootPath) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The table `pomade projects` prints: the workspace, then one aligned row per project — id, name,
 *  folder (`.` for the workspace root). */
export function projectLines(root: string, projects: readonly ListedProject[]): string[] {
  const lines = [`Workspace: ${root}`]
  if (projects.length === 0) return [...lines, '  (no projects)']
  const idWidth = Math.max(...projects.map((p) => p.id.length))
  const nameWidth = Math.max(...projects.map((p) => p.name.length))
  for (const p of projects) lines.push(`  ${p.id.padEnd(idWidth)}  ${p.name.padEnd(nameWidth)}  ${p.root === '' ? '.' : p.root}`)
  return lines
}
