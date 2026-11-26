// Pomade — document I/O primitives for the editor pane: the fs-door router (in-workspace vs
// outside-workspace), CRLF/trailing-newline normalization, the frontmatter split, and the
// load-guard limits. Pure logic + thin window.pomade.fs wrappers, so load/reload/save/stat all
// route a path the same way.

import type { WriteFileResult } from '@shared/ipc-api'
import { contentHash, syncVerdict, type SyncPoint } from '@shared/recovery'

// The frontmatter split is pomade-kit's, shared with the Host API's frontmatter reads (one block
// detection).
export { splitFrontmatter } from 'pomade-kit/frontmatter'

export const MAX_BYTES = 2 * 1024 * 1024

export type Refusal =
  | { reason: 'binary' | 'too-big' }
  /** T-226 — a version tab whose version cannot be read (gone, binary, over 2 MB): `message` says why. */
  | { reason: 'version'; message: string }
  | null

export interface Normalized {
  text: string
  hadCRLF: boolean
  hadTrailingNewline: boolean
}

export function normalize(raw: string): Normalized {
  const hadCRLF = /\r\n/.test(raw)
  const text = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw
  return { text, hadCRLF, hadTrailingNewline: text.endsWith('\n') }
}

export function reconstruct(text: string, n: Normalized): string {
  let out = text
  if (n.hadTrailingNewline && !out.endsWith('\n')) out += '\n'
  if (n.hadCRLF) out = out.replace(/\n/g, '\r\n')
  return out
}

// ─── T-102 (E-021): outside-workspace doc object class ─────────────────────────
// A DocTab.path is workspace-RELATIVE for every in-workspace file (leading slashes are stripped
// at the source, so it never begins with '/'); an ABSOLUTE path is stored ONLY for a file that
// resolved outside the workspace (see term-link-open.routeProbe). So a leading '/' is the exact,
// reliable signal for the outside-workspace object class — it never assumes workspace membership.
export function isOutsidePath(p: string): boolean {
  return p.startsWith('/')
}

// The editor's fs access routes an absolute (outside) path through the sanctioned outside-workspace
// door and everything else through the workspace-guarded channels. One place decides, so load,
// reload, external-change stat and save all agree.
export function statPath(p: string): ReturnType<typeof window.pomade.fs.stat> {
  return isOutsidePath(p) ? window.pomade.fs.statOutside(p) : window.pomade.fs.stat(p)
}
export function readPath(p: string): Promise<string> {
  return isOutsidePath(p) ? window.pomade.fs.readOutside(p) : window.pomade.fs.read(p)
}
export async function writePath(
  p: string,
  content: string,
  opts?: { exclusive?: boolean }
): Promise<WriteFileResult> {
  // Outside-workspace writes never come from Save-As (which builds a rootPath-relative path), so
  // the exclusive-collision option is workspace-only — writeOutside always succeeds or rejects.
  if (isOutsidePath(p)) {
    await window.pomade.fs.writeOutside(p, content)
    return { ok: true }
  }
  return window.pomade.fs.write(p, content, opts)
}
// T-133 — a tab's "Duplicate file" on an outside doc routes through the outside door (returns the
// new absolute path); an in-workspace doc keeps the ws-relative `duplicate`.
export function duplicatePath(p: string): Promise<string> {
  return isOutsidePath(p) ? window.pomade.fs.duplicateOutside(p) : window.pomade.fs.duplicate(p)
}

// ─── E-035 (rule 8): has another writer changed the file since the sync point? ──────────────────
// Stat first; only a differing mtime pays a read + hash (bytes decide, never the clock alone).
// `readBytes: false` (a refused file, never read) treats any mtime change as a change.
// `mtimeMs` is the observed disk mtime, so an 'in-sync' caller can move its sync point to it.
export async function probeDisk(
  p: string,
  sync: SyncPoint,
  readBytes = true
): Promise<{ verdict: 'in-sync' | 'changed' | 'missing'; mtimeMs: number }> {
  let mtimeMs: number
  try {
    mtimeMs = (await statPath(p)).mtimeMs
  } catch {
    return { verdict: 'missing', mtimeMs: 0 }
  }
  const first = syncVerdict(sync, { mtimeMs })
  if (first !== 'needs-hash') return { verdict: first === 'in-sync' ? 'in-sync' : 'changed', mtimeMs }
  if (!readBytes) return { verdict: 'changed', mtimeMs }
  try {
    const hash = contentHash(await readPath(p))
    const v = syncVerdict(sync, { mtimeMs, hash })
    return { verdict: v === 'in-sync' ? 'in-sync' : 'changed', mtimeMs }
  } catch {
    return { verdict: 'missing', mtimeMs: 0 }
  }
}
