// Pomade — E-038: what Document history's rows do. A click compares a row's version with the
// current document, two picked rows compare with each other, Restore reads a row's text so the
// editor can put it in as an unsaved edit. All comparisons open as real tabs: a preview tab would
// replace the very doc tab the panel lives in.

import type { CompareSource } from '@shared/compare'
import { isVersionSource, type VersionSource } from '@shared/doc-version'
import { orderPair, rowSource, rowVsCurrent, type HistoryContext, type HistoryRow } from '@shared/doc-history'
import type { Id } from '@shared/types'
import { normalize, readPath } from '../../editor/doc-io'
import { openComparison } from '../open-compare'
import { readVersion } from './version-text'

/** A click on a row: its version ↔ the current document. */
export function openRow(projectId: Id, row: HistoryRow, ctx: HistoryContext): Promise<void> {
  const [left, right] = rowVsCurrent(row, ctx)
  return openComparison(projectId, left, right, { preview: false })
}

/** Two picked rows: the older version ↔ the newer one. The unsaved row is the live document, so a
 *  pair that holds it compares with an editable right side. */
export function openPair(
  projectId: Id,
  rows: readonly HistoryRow[],
  a: string,
  b: string,
  ctx: HistoryContext
): Promise<void> {
  const pair = orderPair(rows, a, b)
  if (!pair) return Promise.resolve()
  return openComparison(projectId, rowSource(pair[0], ctx), rowSource(pair[1], ctx), { preview: false })
}

/** The fixed version a row opens in its own tab: its source when that is a fixed version, the
 *  absorbed local version for the saved row; null when it has none. */
export function rowVersion(row: HistoryRow, ctx: HistoryContext): VersionSource | null {
  if (row.kind === 'saved') {
    if (!row.snapshot) return null
    return { kind: 'snapshot', path: ctx.path, id: row.snapshot.snapshotId, at: row.at, origin: row.snapshot.origin }
  }
  const source = rowSource(row, ctx)
  return isVersionSource(source) ? source : null
}

/** Two files from the tree: the first read-only on the left, the second (editable) on the right. */
export function openFileCompare(projectId: Id, left: string, right: string): Promise<void> {
  const l: CompareSource = { kind: 'disk', path: left }
  const r: CompareSource = { kind: 'file', path: right }
  return openComparison(projectId, l, r, { preview: false })
}

/** The text a row stands for, normalized like the editor's buffer; throws a plain sentence when
 *  the version cannot be restored (binary, over 2 MB, gone). */
export async function readRowText(row: HistoryRow, ctx: HistoryContext): Promise<string> {
  switch (row.kind) {
    case 'unsaved':
      throw new Error('This is the document you are editing.')
    case 'saved': {
      const raw = await readPath(ctx.path)
      if (raw.includes('\u0000')) throw new Error('The saved file is binary.')
      return normalize(raw).text
    }
    default: {
      const source = rowSource(row, ctx)
      if (!isVersionSource(source)) throw new Error('This row has no fixed version.')
      return normalize(await readVersion(source)).text
    }
  }
}
