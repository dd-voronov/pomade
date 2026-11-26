// Pomade — E-037: reading a comparison side's content in the renderer. Every text is normalized the
// way the editor normalizes its buffer (CRLF → LF), so the two sides never differ by line endings
// alone. Refusals (binary, over 2 MB) and gone versions come back as kinds the pane renders.

import { COMPARE_MAX_BYTES, type CompareSource, type RevisionInfo } from '@shared/compare'
import { commitDateLabel, commitTimestamp } from '@shared/git-history'
import { originLabel, type SnapshotOrigin } from '@shared/local-history'
import { normalize, readPath, statPath } from '../../editor/doc-io'

export type SideContent =
  | { status: 'ok'; text: string; label: string; detail?: string; commit?: RevisionInfo; exists: boolean }
  | { status: 'refused'; label: string; reason: string }

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** `HEAD · a1b2c3d · Oct 12` / `a1b2c3d · Oct 12`. */
export function revisionLabel(rev: string, commit: RevisionInfo, now: number): string {
  return `${rev === 'HEAD' ? 'HEAD · ' : ''}${commit.hash.slice(0, 7)} · ${commitDateLabel(commit.date, now)}`
}

/** The file as on disk. A file that is not there reads as empty (`exists: false`). */
export async function readDiskSide(path: string, label: string): Promise<SideContent> {
  let size: number
  try {
    size = (await statPath(path)).size
  } catch {
    return { status: 'ok', text: '', label, detail: 'not on disk', exists: false }
  }
  if (size > COMPARE_MAX_BYTES) return { status: 'refused', label, reason: `${base(path)} is larger than 2 MB.` }
  const raw = await readPath(path)
  if (raw.includes('\u0000')) return { status: 'refused', label, reason: `${base(path)} is a binary file.` }
  return { status: 'ok', text: normalize(raw).text, label, exists: true }
}

/** `Discarded draft · Nov 8, 2026, 14:32`. */
export function draftLabel(at: number): string {
  return `Discarded draft · ${commitTimestamp(at)}`
}

/** `Changed on disk · Nov 8, 2026, 14:32` / `Saved in Pomade · …` / `Renamed from T-2.md · …`.
 *  A version kept under another path (`pathThen`, before a rename) leads with that name —
 *  `T-2.md · Saved in Pomade · …` — unless the label already names it (the rename's own row). */
export function snapshotLabel(
  origin: SnapshotOrigin,
  at: number,
  from?: string,
  path?: string,
  pathThen?: string
): string {
  const label = originLabel(origin, from, path)
  const text = `${label[0].toUpperCase()}${label.slice(1)} · ${commitTimestamp(at)}`
  return pathThen && !(origin === 'renamed' && from === pathThen) ? `${base(pathThen)} · ${text}` : text
}

export async function readSide(source: CompareSource, now: number): Promise<SideContent> {
  switch (source.kind) {
    case 'none':
      return { status: 'ok', text: '', label: 'No earlier version', exists: false }
    case 'disk':
      return readDiskSide(source.path, 'On disk now')
    case 'file':
      return readDiskSide(source.path, 'Now')
    case 'draft': {
      const label = draftLabel(source.at)
      const draft = (await window.pomade.recovery.drafts(source.path)).find((d) => d.id === source.id)
      if (!draft) {
        return { status: 'refused', label, reason: 'This draft is no longer kept — discarded drafts are kept for 7 days.' }
      }
      return { status: 'ok', text: normalize(draft.content).text, label, exists: true }
    }
    case 'snapshot': {
      const label = snapshotLabel(source.origin, source.at, source.from, source.path, source.pathThen)
      const text = await window.pomade.localHistory.read(source.path, source.id)
      if (text === null) {
        return { status: 'refused', label, reason: 'This version is no longer kept — local history keeps 7 days.' }
      }
      return { status: 'ok', text: normalize(text).text, label, exists: true }
    }
    case 'rev': {
      const f = await window.pomade.git.fileAt(source.repo, source.rev, source.path)
      const short = source.rev === 'HEAD' ? 'HEAD' : source.rev.slice(0, 7)
      if (f.kind === 'no-revision') {
        return { status: 'refused', label: short, reason: `Version ${short} is no longer in this repository.` }
      }
      const label = revisionLabel(source.rev, f.commit, now)
      if (f.kind === 'absent') {
        return { status: 'ok', text: '', label, detail: 'not in this version', commit: f.commit, exists: false }
      }
      if (f.kind === 'binary') return { status: 'refused', label, reason: `${base(source.path)} is a binary file.` }
      if (f.kind === 'too-big') return { status: 'refused', label, reason: `${base(source.path)} is larger than 2 MB.` }
      return { status: 'ok', text: normalize(f.content).text, label, commit: f.commit, exists: true }
    }
  }
}
