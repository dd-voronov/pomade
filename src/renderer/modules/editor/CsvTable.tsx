// Pomade E-009 — CSV table view. Header-aware, lossless, and (when it can round-trip the file
// exactly) editable in place.
//   - Parsing lives in csv-model.ts: it detects the delimiter, folds a ragged free-text tail
//     back into the last column (T-034 fix), and keeps each field's exact source so a save
//     changes ONLY the edited cell (T-002).
//   - Editing is offered only when the model reproduces the file byte-for-byte; otherwise the
//     grid is read-only (round-trip discipline — never risk a lossy write). Genuinely
//     unparseable input is reported via parseCsv().ok so EditorPane can fall back to raw.

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  parseCsvModel,
  serialize,
  headerValues,
  dataRecordIndices,
  cellValue,
  editCell,
  insertColumn,
  deleteColumn,
  insertRow,
  deleteRow,
  type CsvModelData
} from './csv-model'
import type { EditorController, FindMatchInfo } from './editor-controller'
import { ContextMenu } from '../../components/ContextMenu'
import styles from './EditorPane.module.css'

// A find match points at a display cell: row -1 is the header, row >= 0 is a body display row.
interface FindCell {
  r: number
  c: number
}
interface CsvFindState {
  query: string
  caseSensitive: boolean
  matches: FindCell[]
  current: number // index into matches, -1 when none
}
const EMPTY_FIND: CsvFindState = { query: '', caseSensitive: false, matches: [], current: -1 }
const NO_MATCHES: FindMatchInfo = { count: 0, current: 0 }

export interface CsvParseResult {
  ok: boolean
  header: string[]
  rows: string[][]
  error?: string
}

/** Back-compat summary used by `useEditorMode` for the malformed (parse-fail) decision. */
export function parseCsv(text: string): CsvParseResult {
  const model = parseCsvModel(text)
  if (!model.ok) {
    return { ok: false, header: [], rows: [], error: model.error }
  }
  const rowIdx = dataRecordIndices(model)
  const rows = rowIdx.map((ri) =>
    Array.from({ length: model.colCount }, (_, c) => cellValue(model, ri, c))
  )
  return { ok: true, header: headerValues(model), rows }
}

interface EditPos {
  recordIndex: number
  col: number
}

export function CsvTable({
  text,
  onChange,
  onController
}: {
  text: string
  onChange?: (next: string) => void
  onController?: (controller: EditorController | null) => void
}): React.JSX.Element | null {
  const model = useMemo(() => parseCsvModel(text), [text])
  const [editing, setEditing] = useState<EditPos | null>(null)
  const [draft, setDraft] = useState('')
  const [find, setFind] = useState<CsvFindState>(EMPTY_FIND)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  // Set by an explicit Enter/Tab/Esc so the blur it triggers (the input unmounts / focus moves)
  // doesn't fire a SECOND, stale commit that would clobber Tab's move to the next cell.
  const keyHandledRef = useRef(false)
  // After finishing an edit (Enter/Esc) we pull focus back into the (focusable) table host, so
  // the pane-root Cmd+S capture keeps working — otherwise focus escapes to <body> and the save
  // keystroke never reaches the editor.
  const refocusRef = useRef(false)
  // T-051 — Excel-like row/column context menu (on a row-number or column header).
  const [headerMenu, setHeaderMenu] = useState<{
    x: number
    y: number
    axis: 'row' | 'col'
    index: number
  } | null>(null)
  // T-051 — text-snapshot undo/redo for the table's edit model (cell edits + structural ops).
  // The parent (EditorPane) holds the content; we drive it via onChange, keeping our own stacks
  // (this component is not remounted on a text change, so the refs persist across edits).
  const undoStack = useRef<string[]>([])
  const redoStack = useRef<string[]>([])
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => {
    if (editing) inputRef.current?.focus()
    else if (refocusRef.current) {
      refocusRef.current = false
      hostRef.current?.focus()
    }
  }, [editing])

  // ── T-043: expose an EditorController so the selection context menu + Cmd+F work here too ──
  // Latest values are read via refs so the controller (registered once) always acts on live
  // state. getSelection/replaceRange target the cell-edit input; find searches across cells.
  const onControllerRef = useRef(onController)
  onControllerRef.current = onController
  const modelRef = useRef(model)
  modelRef.current = model
  const draftRef = useRef(draft)
  draftRef.current = draft
  const editingRef = useRef(editing)
  editingRef.current = editing
  const findRef = useRef(find)
  findRef.current = find

  const cellText = (mm: CsvModelData, r: number, c: number): string =>
    r < 0 ? (headerValues(mm)[c] ?? '') : cellValue(mm, dataRecordIndices(mm)[r], c)

  const computeMatches = (mm: CsvModelData, query: string, cs: boolean): FindCell[] => {
    if (!query) return []
    const needle = cs ? query : query.toLowerCase()
    const out: FindCell[] = []
    const cols = mm.colCount
    const rows = dataRecordIndices(mm).length
    for (let c = 0; c < cols; c++) {
      const hv = cellText(mm, -1, c)
      if ((cs ? hv : hv.toLowerCase()).includes(needle)) out.push({ r: -1, c })
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = cellText(mm, r, c)
        if ((cs ? v : v.toLowerCase()).includes(needle)) out.push({ r, c })
      }
    }
    return out
  }

  const findInfo = (fs: CsvFindState): FindMatchInfo =>
    fs.matches.length ? { count: fs.matches.length, current: fs.current + 1 } : NO_MATCHES

  useEffect(() => {
    const controller: EditorController = {
      kind: 'table',
      getSelection: () => {
        const el = inputRef.current
        if (editingRef.current && el) {
          const from = el.selectionStart ?? 0
          const to = el.selectionEnd ?? 0
          return { text: draftRef.current.slice(from, to), empty: from === to, from, to }
        }
        return { text: '', empty: true, from: 0, to: 0 }
      },
      replaceRange: (from, to, text) => {
        const el = inputRef.current
        if (!editingRef.current || !el) return
        const cur = draftRef.current
        const next = cur.slice(0, from) + text + cur.slice(to)
        draftRef.current = next
        setDraft(next)
        // Reflect immediately so the caret lands correctly before React re-renders.
        el.value = next
        const caret = from + text.length
        el.setSelectionRange(caret, caret)
        el.focus()
      },
      focus: () => {
        if (editingRef.current) inputRef.current?.focus()
        else hostRef.current?.focus()
      },
      find: {
        setQuery: (query, opts) => {
          const mm = modelRef.current
          if (!mm.ok) return NO_MATCHES
          const matches = computeMatches(mm, query, opts.caseSensitive)
          const fs: CsvFindState = {
            query,
            caseSensitive: opts.caseSensitive,
            matches,
            current: matches.length ? 0 : -1
          }
          setFind(fs)
          return findInfo(fs)
        },
        next: () => {
          const fs = findRef.current
          if (!fs.matches.length) return findInfo(fs)
          const nfs = { ...fs, current: (fs.current + 1) % fs.matches.length }
          setFind(nfs)
          return findInfo(nfs)
        },
        prev: () => {
          const fs = findRef.current
          if (!fs.matches.length) return findInfo(fs)
          const nfs = { ...fs, current: (fs.current - 1 + fs.matches.length) % fs.matches.length }
          setFind(nfs)
          return findInfo(nfs)
        },
        clear: () => setFind(EMPTY_FIND)
      }
    }
    onControllerRef.current?.(controller)
    return () => onControllerRef.current?.(null)
    // Registered once; all state is read through refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once; state is read through refs and the captured helpers are pure over their arguments
  }, [])

  // Keep the current match scrolled into view as the user steps through.
  useEffect(() => {
    if (find.current < 0) return
    hostRef.current
      ?.querySelector('[data-find-current]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [find])

  // The parent only mounts CsvTable for an ok model (EditorBody's `tableShown` gates on
  // `csvParse.ok`, which runs the same `parseCsvModel`), so this branch is unreachable — it exists
  // solely to narrow `CsvModel` to `CsvModelData` for the render below.
  if (!model.ok) return null

  const m: CsvModelData = model
  const editable = m.editable && !!onChange
  const rowIdx = dataRecordIndices(m)
  const header = headerValues(m)
  const cols = Array.from({ length: m.colCount })

  // ── T-051: edit-model transitions with undo/redo ─────────────────────────────
  // Every mutation (cell edit + structural op) pushes the pre-change text so a single Cmd+Z
  // restores it; the redo stack is cleared on a fresh edit.
  const applyText = (next: string): void => {
    if (!onChange || next === textRef.current) return
    undoStack.current.push(textRef.current)
    redoStack.current = []
    onChange(next)
  }
  const applyModel = (nextModel: CsvModelData): void => applyText(serialize(nextModel))
  const undo = (): void => {
    if (!onChange || !undoStack.current.length) return
    redoStack.current.push(textRef.current)
    onChange(undoStack.current.pop() as string)
  }
  const redo = (): void => {
    if (!onChange || !redoStack.current.length) return
    undoStack.current.push(textRef.current)
    onChange(redoStack.current.pop() as string)
  }

  const runStructural = (fn: () => CsvModelData): void => {
    setHeaderMenu(null)
    applyModel(fn())
    refocusRef.current = true
    hostRef.current?.focus()
  }

  // Find-highlight lookup for the current render (T-043).
  const curCell = find.current >= 0 ? find.matches[find.current] : null
  const matchKeys = new Set(find.matches.map((mm) => `${mm.r}:${mm.c}`))
  const isMatch = (r: number, c: number): boolean => matchKeys.has(`${r}:${c}`)
  const isCurrent = (r: number, c: number): boolean => !!curCell && curCell.r === r && curCell.c === c
  const findClass = (r: number, c: number): string =>
    isCurrent(r, c) ? ` ${styles.csvFindMatch} ${styles.csvFindCurrent}` : isMatch(r, c) ? ` ${styles.csvFindMatch}` : ''

  const startEdit = (recordIndex: number, col: number): void => {
    if (!editable) return
    setEditing({ recordIndex, col })
    const v = cellValue(m, recordIndex, col)
    draftRef.current = v // sync ref with the state so a commit before re-render reads this cell
    setDraft(v)
  }

  // Commit the current draft (if changed) and optionally move focus to `next`. `next` is read
  // from the CURRENT model — safe because only the just-committed cell changes, so an
  // unedited neighbour's value is identical before and after the write.
  const commit = (next: EditPos | null): void => {
    if (!editing) return
    const cur = cellValue(m, editing.recordIndex, editing.col)
    // Read the draft from the ref, not the render-closure `draft` state: a context-menu Paste
    // updates `draftRef.current` synchronously (the controller's replaceRange) while `setDraft`
    // re-renders asynchronously, so an Enter that fires before that re-render would otherwise
    // commit the STALE pre-paste value (a paste→Enter race the newer Chromium's input timing
    // exposed). The ref is always the freshest intended text — for typed edits too (kept in sync
    // in the input's onChange and on every render).
    const value = draftRef.current
    if (value !== cur && onChange) {
      applyModel(editCell(m, editing.recordIndex, editing.col, value))
    }
    if (next) {
      setEditing(next)
      const nv = cellValue(m, next.recordIndex, next.col)
      draftRef.current = nv // sync ref for a rapid follow-up commit (Tab-Tab) before re-render
      setDraft(nv)
    } else {
      refocusRef.current = true
      setEditing(null)
    }
  }

  const cancel = (): void => {
    refocusRef.current = true
    setEditing(null)
  }

  const nextCell = (recordIndex: number, col: number, dir: 1 | -1): EditPos | null => {
    const dr = rowIdx.indexOf(recordIndex)
    let c = col + dir
    let r = dr
    if (c >= m.colCount) {
      c = 0
      r++
    } else if (c < 0) {
      c = m.colCount - 1
      r--
    }
    if (r < 0 || r >= rowIdx.length) return null
    return { recordIndex: rowIdx[r], col: c }
  }

  const onInputKeyDown = (e: React.KeyboardEvent, recordIndex: number, col: number): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      keyHandledRef.current = true
      commit(null)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      keyHandledRef.current = true
      commit(nextCell(recordIndex, col, e.shiftKey ? -1 : 1))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      keyHandledRef.current = true
      cancel()
    }
  }

  const onInputBlur = (): void => {
    if (keyHandledRef.current) {
      keyHandledRef.current = false
      return
    }
    commit(null)
  }

  const openHeaderMenu = (
    e: React.MouseEvent,
    axis: 'row' | 'col',
    index: number
  ): void => {
    if (!editable) return
    e.preventDefault()
    e.stopPropagation() // don't let the pane's editor context menu open too
    setHeaderMenu({ x: e.clientX, y: e.clientY, axis, index })
  }

  const onHostKeyDown = (e: React.KeyboardEvent): void => {
    // Undo/redo for the table edit model — but let a focused cell input own its own text undo.
    if (editingRef.current) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
  }

  return (
    <div
      ref={hostRef}
      className={styles.tableHost}
      data-testid="csv-table"
      data-editable={editable}
      tabIndex={-1}
      onKeyDown={onHostKeyDown}
    >
      <table className={styles.table}>
        <thead>
          <tr>
            {editable && <td className={styles.csvCorner} aria-hidden="true" />}
            {cols.map((_, i) => (
              <th
                key={i}
                className={findClass(-1, i).trim() || undefined}
                data-testid={`csv-col-header-${i}`}
                data-find-match={isMatch(-1, i) || undefined}
                data-find-current={isCurrent(-1, i) || undefined}
                onContextMenu={(e) => openHeaderMenu(e, 'col', i)}
              >
                {header[i] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowIdx.map((ri, r) => (
            <tr key={r}>
              {editable && (
                <th
                  scope="row"
                  className={styles.csvRowHeader}
                  data-testid={`csv-row-header-${r}`}
                  onContextMenu={(e) => openHeaderMenu(e, 'row', r)}
                >
                  {r + 1}
                </th>
              )}
              {cols.map((_, c) => {
                const isEditing = editing?.recordIndex === ri && editing.col === c
                return (
                  <td
                    key={c}
                    data-testid={`csv-cell-${r}-${c}`}
                    className={`${editable ? styles.csvCellEditable : ''}${findClass(r, c)}`.trim() || undefined}
                    data-find-match={isMatch(r, c) || undefined}
                    data-find-current={isCurrent(r, c) || undefined}
                    onClick={() => !isEditing && startEdit(ri, c)}
                  >
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        className={styles.csvCellInput}
                        data-testid="csv-cell-input"
                        value={draft}
                        onChange={(e) => {
                          // Keep draftRef current synchronously so a commit (Enter/Tab/blur) that
                          // fires before this change's re-render still reads the latest text.
                          draftRef.current = e.target.value
                          setDraft(e.target.value)
                        }}
                        onKeyDown={(e) => onInputKeyDown(e, ri, c)}
                        onBlur={onInputBlur}
                      />
                    ) : (
                      cellValue(m, ri, c)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          testId="csv-header-menu"
          scrimTestId="csv-menu-scrim"
          data={{ 'data-axis': headerMenu.axis }}
          items={
            headerMenu.axis === 'col'
              ? [
                  {
                    label: 'Insert column left',
                    testId: 'csv-menu-insert-col-left',
                    onSelect: () => runStructural(() => insertColumn(m, headerMenu.index))
                  },
                  {
                    label: 'Insert column right',
                    testId: 'csv-menu-insert-col-right',
                    onSelect: () => runStructural(() => insertColumn(m, headerMenu.index + 1))
                  },
                  { separator: true },
                  {
                    label: 'Delete column',
                    testId: 'csv-menu-delete-col',
                    disabled: m.colCount <= 1,
                    onSelect: () => runStructural(() => deleteColumn(m, headerMenu.index))
                  }
                ]
              : [
                  {
                    label: 'Insert row above',
                    testId: 'csv-menu-insert-row-above',
                    onSelect: () => runStructural(() => insertRow(m, headerMenu.index))
                  },
                  {
                    label: 'Insert row below',
                    testId: 'csv-menu-insert-row-below',
                    onSelect: () => runStructural(() => insertRow(m, headerMenu.index + 1))
                  },
                  { separator: true },
                  {
                    label: 'Delete row',
                    testId: 'csv-menu-delete-row',
                    disabled: rowIdx.length <= 1,
                    onSelect: () => runStructural(() => deleteRow(m, headerMenu.index))
                  }
                ]
          }
        />
      )}
    </div>
  )
}
