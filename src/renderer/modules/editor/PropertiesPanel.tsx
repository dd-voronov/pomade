// Pomade E-013 — frontmatter properties panel. Renders the YAML frontmatter block (split off
// by EditorPane in rendered markdown mode) as Obsidian-style typed rows above the body, inside
// the same scroll. Edits go through pomade-kit's surgical block writeback
// (`pomade-kit/frontmatter`) and flow up via onChange as a NEW frontmatter block; EditorPane
// re-attaches the body, marks the doc dirty, and Cmd+S owns the disk write (one document, one
// dirty state).
//
// Expand/collapse is PER-PROJECT (ProjectState, T-053 round-3) and passed in — the panel is a pure
// view of it, so a toggle in one pane updates every open pane of the same project live (EditorPane
// subscribes to the tabs-store).
//
// E-014 (v2) adds: a native date picker for date rows; workspace-frequency autocomplete for keys
// (add-property) and list values (tags/aliases/…); drag-to-reorder keys (surgical line-block
// move); and inline raw-YAML editing of complex values (js-yaml validated). Plus a chip edit
// input that auto-grows to the value's length (E-013 round-4).

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  parseFrontmatter,
  setScalarValue,
  setBooleanValue,
  setListValue,
  addProperty,
  removeProperty,
  moveKey,
  getKeyLines,
  setComplexKeyLines,
  validateYaml,
  type PropRow,
  type PropType
} from 'pomade-kit/frontmatter'

import type { FrontmatterIndex } from '@shared/types'
import { Tooltip } from '../../components/Tooltip'
import styles from './PropertiesPanel.module.css'

interface PropertiesPanelProps {
  block: string
  expanded: boolean
  onToggleExpanded: () => void
  onChange: (nextBlock: string) => void
  // When true, open the add-property row immediately (used by the editor ⋯ "Add properties"
  // action on a file that has no frontmatter yet — `block` is '' until the first commit).
  startAdding?: boolean
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/

function keyGlyph(row: PropRow): string {
  switch (row.type) {
    case 'list':
      return row.isTags ? '#' : '⋮⋮'
    case 'date':
      return '📅'
    case 'boolean':
      return '☑'
    case 'complex':
      return row.complexGlyph
    default:
      return '≡'
  }
}

// T-053 round-3 (3e) — human-readable type names for the glyph tooltip, so the Owner can name the
// type when reporting a bug.
function typeLabel(row: PropRow): string {
  switch (row.type) {
    case 'number':
      return 'Number'
    case 'boolean':
      return 'Checkbox'
    case 'date':
      return 'Date'
    case 'list':
      return row.isTags ? 'Tags' : 'List'
    case 'complex':
      return 'Complex'
    default:
      return 'Text'
  }
}

// E-014 — a small keyboard-navigable suggestion dropdown (↑↓ + Enter + Esc handled by the host
// input; a mousedown here picks without blurring the input first).
function SuggestBox({
  items,
  active,
  onPick,
  testid
}: {
  items: string[]
  active: number
  onPick: (value: string) => void
  testid: string
}): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <div className={styles.suggest} data-testid={testid} role="listbox">
      {items.map((it, i) => (
        <button
          key={it}
          type="button"
          role="option"
          aria-selected={i === active}
          className={i === active ? `${styles.suggestItem} ${styles.suggestActive}` : styles.suggestItem}
          data-testid={`${testid}-${it}`}
          onMouseDown={(e) => {
            // preventDefault keeps the input focused; stopPropagation keeps the picked item's
            // mousedown from reaching the add-row's document-level click-outside handler (React 18
            // flushes the dropdown's unmount before the event bubbles to `document`, so the target
            // would look "outside" and wrongly cancel the row).
            e.preventDefault()
            e.stopPropagation()
            onPick(it)
          }}
        >
          {it}
        </button>
      ))}
    </div>
  )
}

export function PropertiesPanel({
  block,
  expanded,
  onToggleExpanded,
  onChange,
  startAdding = false
}: PropertiesPanelProps): React.JSX.Element | null {
  // An empty block means "create on first commit" (⋯ Add properties on a frontmatter-less
  // file) — an editable panel with no rows yet, NOT a parse failure.
  const parsed = block === '' ? { ok: true, rows: [] as PropRow[] } : parseFrontmatter(block)

  // ── local editing state ──
  const [editKey, setEditKey] = useState<string | null>(null) // scalar being edited
  const [editVal, setEditVal] = useState('')
  // T-053 round-3 (3c) — which chip (list key + index) is being edited in place, and its draft.
  const [editChip, setEditChip] = useState<{ key: string; index: number } | null>(null)
  const [editChipVal, setEditChipVal] = useState('')
  const [adding, setAdding] = useState(startAdding)
  const [addKey, setAddKey] = useState('')
  const [addVal, setAddVal] = useState('')

  // ── E-014 (autocomplete) — workspace frontmatter index, fetched once per mount (cached in
  // main; a stale result is fine — suggestions only). ──
  const [fmIndex, setFmIndex] = useState<FrontmatterIndex | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.pomade.fs
      .frontmatterIndex()
      .then((idx) => {
        if (!cancelled) setFmIndex(idx)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // ── E-014 add-key autocomplete state ──
  const [keySugOpen, setKeySugOpen] = useState(false)
  const [keyActive, setKeyActive] = useState(-1)
  const addValRef = useRef<HTMLInputElement | null>(null)

  // ── E-014 key reordering (drag) state ──
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; pos: 'before' | 'after' } | null>(null)

  // ── E-014 complex-value inline editing state ──
  const [editComplexKey, setEditComplexKey] = useState<string | null>(null)
  const [editComplexVal, setEditComplexVal] = useState('')
  const [editComplexErr, setEditComplexErr] = useState<string | null>(null)

  // T-053 round-3 (3b) — click-outside cancels the open add-property row (typed input discarded).
  // Esc / Enter / the Add button keep their own handling; this only covers a mousedown elsewhere.
  const addRowRef = useRef<HTMLDivElement | null>(null)
  const cancelAdd = (): void => {
    setAdding(false)
    setAddKey('')
    setAddVal('')
    setKeySugOpen(false)
    setKeyActive(-1)
  }
  useEffect(() => {
    if (!adding) return
    const onDown = (e: MouseEvent): void => {
      if (addRowRef.current && !addRowRef.current.contains(e.target as Node)) cancelAdd()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [adding])

  const rowKeys = parsed.ok ? parsed.rows.map((r) => r.key) : []
  const existingKeys = new Set(rowKeys)

  // Keys ranked by workspace frequency, minus those already on this doc.
  const rankedKeys = useMemo(() => {
    if (!fmIndex) return [] as string[]
    return Object.entries(fmIndex.keys)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
  }, [fmIndex])
  const keySuggestions = rankedKeys
    .filter((k) => !existingKeys.has(k))
    .filter((k) => {
      const q = addKey.trim().toLowerCase()
      return q === '' || k.toLowerCase().includes(q)
    })
    .slice(0, 8)

  // Candidate values for a list key, ranked by frequency (filtering by the input happens in the
  // chip-add component). Excludes values already on the row.
  const listSuggestionsFor = (row: PropRow): string[] => {
    if (!fmIndex) return []
    const byVal = fmIndex.values[row.key]
    if (!byVal) return []
    const have = new Set(row.list)
    return Object.entries(byVal)
      .sort((a, b) => b[1] - a[1])
      .map(([v]) => v)
      .filter((v) => !have.has(v))
  }

  // Parse failure → collapsed marker, bytes untouched, no rows (E-013 decision).
  if (!parsed.ok) {
    return (
      <div className={styles.panel} data-testid="properties-panel" data-parse="failed">
        <div className={styles.header}>
          <span className={styles.tri}>▸</span>
          <span className={styles.headerLabel}>Properties</span>
          <span className={styles.rawMarker} data-testid="properties-raw-marker">
            raw frontmatter
          </span>
        </div>
      </div>
    )
  }

  const commitScalar = (key: string, value: string): void => {
    setEditKey(null)
    const original = parsed.rows.find((r) => r.key === key)?.scalar ?? ''
    if (value === original) return
    onChange(setScalarValue(block, key, value))
  }

  const toggleBool = (key: string, next: boolean): void => {
    onChange(setBooleanValue(block, key, next))
  }

  const addChip = (key: string, list: string[], chip: string): void => {
    const v = chip.trim()
    if (!v) return
    onChange(setListValue(block, key, [...list, v]))
  }

  const removeChip = (key: string, list: string[], index: number): void => {
    onChange(setListValue(block, key, list.filter((_, idx) => idx !== index)))
  }

  // T-053 round-3 (3c) — commit an in-place chip edit through the same surgical writeback as add/
  // remove (marks the doc dirty; Cmd+S owns the save). Empty result removes the chip; an unchanged
  // non-empty value is a no-op (no spurious dirty).
  const commitChip = (key: string, list: string[], index: number, value: string): void => {
    setEditChip(null)
    const v = value.trim()
    if (v === list[index]) return
    const next = v === '' ? list.filter((_, i) => i !== index) : list.map((it, i) => (i === index ? v : it))
    onChange(setListValue(block, key, next))
  }

  const removeRow = (key: string): void => {
    onChange(removeProperty(block, key))
  }

  const commitAdd = (): void => {
    const k = addKey.trim()
    if (!k) {
      cancelAdd()
      return
    }
    onChange(addProperty(block, k, addVal.trim()))
    cancelAdd()
  }

  const pickKeySuggestion = (k: string): void => {
    setAddKey(k)
    setKeySugOpen(false)
    setKeyActive(-1)
    addValRef.current?.focus()
  }

  // ── E-014 key reordering ──
  const commitDrop = (targetKey: string): void => {
    const src = dragKey
    setDragKey(null)
    const dt = dropTarget
    setDropTarget(null)
    if (!src || src === targetKey) return
    let beforeKey: string | null
    if (dt && dt.pos === 'after') {
      const idx = rowKeys.indexOf(targetKey)
      beforeKey = idx >= 0 && idx + 1 < rowKeys.length ? rowKeys[idx + 1] : null
    } else {
      beforeKey = targetKey
    }
    // Dropping right before/after itself is a no-op.
    if (beforeKey === src) return
    onChange(moveKey(block, src, beforeKey))
  }

  // ── E-014 complex-value inline editing ──
  const openComplexEdit = (key: string): void => {
    setEditComplexKey(key)
    setEditComplexVal(getKeyLines(block, key))
    setEditComplexErr(null)
  }
  const cancelComplexEdit = (): void => {
    setEditComplexKey(null)
    setEditComplexVal('')
    setEditComplexErr(null)
  }
  const commitComplexEdit = (): void => {
    if (editComplexKey == null) return
    const err = validateYaml(editComplexVal)
    if (err) {
      setEditComplexErr(err)
      return
    }
    onChange(setComplexKeyLines(block, editComplexKey, editComplexVal))
    cancelComplexEdit()
  }

  const count = parsed.rows.length

  return (
    <div
      className={styles.panel}
      data-testid="properties-panel"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className={styles.header}
        data-testid="properties-header"
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        <span className={styles.tri}>{expanded ? '▾' : '▸'}</span>
        <span className={styles.headerLabel}>Properties</span>
        <span className={styles.headerCount} data-testid="properties-count">
          · {count}
        </span>
      </button>

      {expanded && (
        <div className={styles.rows} data-testid="properties-rows">
          {parsed.rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              editing={editKey === row.key}
              editVal={editVal}
              onStartEdit={() => {
                setEditKey(row.key)
                setEditVal(row.scalar)
              }}
              onEditValChange={setEditVal}
              onCommitScalar={(v) => commitScalar(row.key, v)}
              onCancelEdit={() => setEditKey(null)}
              onToggleBool={(next) => toggleBool(row.key, next)}
              onAddChip={(chip) => addChip(row.key, row.list, chip)}
              onRemoveChip={(idx) => removeChip(row.key, row.list, idx)}
              onRemoveRow={() => removeRow(row.key)}
              listSuggestions={row.type === 'list' ? listSuggestionsFor(row) : []}
              editChipIndex={editChip?.key === row.key ? editChip.index : null}
              editChipVal={editChipVal}
              onStartChipEdit={(idx) => {
                setEditChip({ key: row.key, index: idx })
                setEditChipVal(row.list[idx] ?? '')
              }}
              onChipValChange={setEditChipVal}
              onCommitChip={(idx, v) => commitChip(row.key, row.list, idx, v)}
              onCancelChipEdit={() => setEditChip(null)}
              // drag reorder
              dragging={dragKey === row.key}
              dropPos={dropTarget?.key === row.key ? dropTarget.pos : null}
              onDragStartRow={() => setDragKey(row.key)}
              onDragOverRow={(before) =>
                setDropTarget({ key: row.key, pos: before ? 'before' : 'after' })
              }
              onDropRow={() => commitDrop(row.key)}
              onDragEndRow={() => {
                setDragKey(null)
                setDropTarget(null)
              }}
              // complex inline edit
              complexEditing={editComplexKey === row.key}
              complexEditVal={editComplexVal}
              complexEditErr={editComplexErr}
              onOpenComplexEdit={() => openComplexEdit(row.key)}
              onComplexValChange={(v) => {
                setEditComplexVal(v)
                if (editComplexErr) setEditComplexErr(null)
              }}
              onCommitComplex={commitComplexEdit}
              onCancelComplex={cancelComplexEdit}
            />
          ))}

          {adding ? (
            <div className={styles.addRow} data-testid="prop-add-editing" ref={addRowRef}>
              <span className={styles.suggestWrap}>
                <input
                  className={styles.addKeyInput}
                  data-testid="prop-add-key"
                  autoFocus
                  placeholder="property name"
                  value={addKey}
                  onFocus={() => setKeySugOpen(true)}
                  onChange={(e) => {
                    setAddKey(e.target.value)
                    setKeySugOpen(true)
                    setKeyActive(-1)
                  }}
                  onKeyDown={(e) => {
                    if (keySugOpen && keySuggestions.length) {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setKeyActive((i) => Math.min(i + 1, keySuggestions.length - 1))
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setKeyActive((i) => Math.max(i - 1, 0))
                        return
                      }
                      if (e.key === 'Enter' && keyActive >= 0) {
                        e.preventDefault()
                        pickKeySuggestion(keySuggestions[keyActive])
                        return
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setKeySugOpen(false)
                        return
                      }
                    }
                    if (e.key === 'Escape') cancelAdd()
                  }}
                />
                {keySugOpen && (
                  <SuggestBox
                    items={keySuggestions}
                    active={keyActive}
                    onPick={pickKeySuggestion}
                    testid="prop-key-suggest"
                  />
                )}
              </span>
              <input
                ref={addValRef}
                className={styles.addValInput}
                data-testid="prop-add-value"
                placeholder="value"
                value={addVal}
                onChange={(e) => setAddVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitAdd()
                  if (e.key === 'Escape') cancelAdd()
                }}
              />
              <Tooltip lines={['Add property']}>
                <button
                  type="button"
                  className={styles.addConfirm}
                  data-testid="prop-add-confirm"
                  onClick={commitAdd}
                >
                  Add
                </button>
              </Tooltip>
            </div>
          ) : (
            <button
              type="button"
              className={styles.addGhost}
              data-testid="prop-add"
              onClick={() => setAdding(true)}
            >
              + Add property
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface RowProps {
  row: PropRow
  editing: boolean
  editVal: string
  onStartEdit: () => void
  onEditValChange: (v: string) => void
  onCommitScalar: (v: string) => void
  onCancelEdit: () => void
  onToggleBool: (next: boolean) => void
  onAddChip: (chip: string) => void
  onRemoveChip: (index: number) => void
  onRemoveRow: () => void
  listSuggestions: string[]
  // T-053 round-3 (3c) — in-place chip editing. `editChipIndex` is the chip index being edited in
  // THIS row (null = none).
  editChipIndex: number | null
  editChipVal: string
  onStartChipEdit: (index: number) => void
  onChipValChange: (v: string) => void
  onCommitChip: (index: number, value: string) => void
  onCancelChipEdit: () => void
  // E-014 drag reorder
  dragging: boolean
  dropPos: 'before' | 'after' | null
  onDragStartRow: () => void
  onDragOverRow: (before: boolean) => void
  onDropRow: () => void
  onDragEndRow: () => void
  // E-014 complex inline edit
  complexEditing: boolean
  complexEditVal: string
  complexEditErr: string | null
  onOpenComplexEdit: () => void
  onComplexValChange: (v: string) => void
  onCommitComplex: () => void
  onCancelComplex: () => void
}

function Row(props: RowProps): React.JSX.Element {
  const { row } = props
  const dropClass =
    props.dropPos === 'before'
      ? ` ${styles.dropBefore}`
      : props.dropPos === 'after'
        ? ` ${styles.dropAfter}`
        : ''
  return (
    <div
      className={`${styles.row}${props.dragging ? ` ${styles.dragging}` : ''}${dropClass}`}
      data-testid={`prop-row-${row.key}`}
      data-type={row.type as PropType}
      draggable
      onDragStart={(e) => {
        const t = e.target as HTMLElement
        // Don't hijack text selection / interactions that start inside an input or textarea.
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
          e.preventDefault()
          return
        }
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', row.key)
        props.onDragStartRow()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = e.currentTarget.getBoundingClientRect()
        props.onDragOverRow(e.clientY < rect.top + rect.height / 2)
      }}
      onDrop={(e) => {
        e.preventDefault()
        props.onDropRow()
      }}
      onDragEnd={props.onDragEndRow}
    >
      <span className={styles.k}>
        <Tooltip lines={[`${typeLabel(row)} — drag to reorder`]}>
          <span className={styles.glyph} data-testid={`prop-glyph-${row.key}`}>
            {keyGlyph(row)}
          </span>
        </Tooltip>
        <span className={styles.keyName}>{row.key}</span>
      </span>
      <span className={styles.v} data-testid={`prop-value-${row.key}`}>
        <RowValue {...props} />
      </span>
      {row.editable && (
        <Tooltip lines={[`Remove ${row.key}`]}>
          <button
            type="button"
            className={styles.removeBtn}
            data-testid={`prop-remove-${row.key}`}
            aria-label={`Remove ${row.key}`}
            onClick={props.onRemoveRow}
          >
            ×
          </button>
        </Tooltip>
      )}
    </div>
  )
}

// T-065 — monochrome calendar glyph (currentColor), embedded at the right edge of a date row's
// text input. Matches the app's icon style (thin strokes, 16-box), consistent with the go-to-path
// clipboard icon (T-058).
function CalendarIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.4" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2.5 6.5h11" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5.5 2.2v2.4M10.5 2.2v2.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function RowValue(props: RowProps): React.JSX.Element {
  const { row, editing, editVal } = props
  // T-065 — hidden native `<input type="date">` used only as the picker trigger (showPicker());
  // the visible text input owns display + typing.
  const dateRef = useRef<HTMLInputElement | null>(null)

  if (row.type === 'complex') {
    // E-014 — inline raw-YAML editing. The "edit in Raw" marker is now a button that expands a
    // textarea seeded with this key's exact lines; commit validates via js-yaml (invalid → inline
    // error, no write), Esc collapses unchanged.
    if (props.complexEditing) {
      return (
        <span className={styles.complexEditWrap}>
          <textarea
            autoFocus
            className={styles.complexTextarea}
            data-testid={`prop-complex-edit-${row.key}`}
            value={props.complexEditVal}
            spellCheck={false}
            onChange={(e) => props.onComplexValChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                props.onCommitComplex()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                props.onCancelComplex()
              }
            }}
          />
          {props.complexEditErr && (
            <span className={styles.complexError} data-testid={`prop-complex-error-${row.key}`}>
              {props.complexEditErr}
            </span>
          )}
          <span className={styles.complexActions}>
            <button
              type="button"
              className={styles.addConfirm}
              data-testid={`prop-complex-save-${row.key}`}
              onClick={props.onCommitComplex}
            >
              Save
            </button>
          </span>
        </span>
      )
    }
    return (
      <>
        <span className={styles.yaml} data-testid={`prop-complex-${row.key}`}>
          {row.complexYaml}
        </span>
        <Tooltip lines={['Complex value — edit its raw YAML']}>
          <button
            type="button"
            className={styles.rawOnly}
            data-testid={`prop-rawonly-${row.key}`}
            onClick={props.onOpenComplexEdit}
          >
            edit in Raw
          </button>
        </Tooltip>
      </>
    )
  }

  if (row.type === 'boolean') {
    return (
      <input
        type="checkbox"
        className={styles.checkbox}
        data-testid={`prop-bool-${row.key}`}
        checked={row.bool}
        onChange={(e) => props.onToggleBool(e.target.checked)}
      />
    )
  }

  if (row.type === 'list') {
    return (
      <span className={styles.chips}>
        {row.list.map((item, idx) => (
          <span
            key={`${item}-${idx}`}
            className={row.isTags ? `${styles.pill} ${styles.pillTag}` : styles.pill}
            data-testid={`prop-chip-${row.key}-${idx}`}
          >
            {props.editChipIndex === idx ? (
              // T-053 round-3 (3c) — chip-sized inline input. Enter/blur commit, Esc reverts.
              // E-013 round-4 — auto-grows with the value (up to the row width) so long values
              // (e.g. folder paths) are editable without a fixed tiny box.
              <input
                autoFocus
                className={styles.chipEditInput}
                data-testid={`prop-chip-edit-${row.key}-${idx}`}
                value={props.editChipVal}
                style={{ width: `${Math.min(Math.max(props.editChipVal.length + 1, 3), 80)}ch` }}
                onChange={(e) => props.onChipValChange(e.target.value)}
                onBlur={() => props.onCommitChip(idx, props.editChipVal)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    props.onCommitChip(idx, props.editChipVal)
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    props.onCancelChipEdit()
                  }
                }}
              />
            ) : (
              // T-053 round-3 (3c/3d) — the text is its OWN click-to-edit zone; the remove X is a
              // separate sibling with a fixed trailing hit zone, so clicking text never lands on X.
              <span
                className={styles.chipText}
                data-testid={`prop-chip-text-${row.key}-${idx}`}
                onClick={() => props.onStartChipEdit(idx)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    props.onStartChipEdit(idx)
                  }
                }}
              >
                {item}
              </span>
            )}
            <button
              type="button"
              className={styles.chipRemove}
              data-testid={`prop-chip-remove-${row.key}-${idx}`}
              aria-label={`Remove ${item}`}
              onClick={() => props.onRemoveChip(idx)}
            >
              ×
            </button>
          </span>
        ))}
        <ChipAddInput
          row={row}
          suggestions={props.listSuggestions}
          onAddChip={props.onAddChip}
          onRemoveLast={() => {
            if (row.list.length) props.onRemoveChip(row.list.length - 1)
          }}
        />
      </span>
    )
  }

  // Scalar (string / number / date).
  if (editing) {
    const isDate = row.type === 'date'
    const invalidDate = isDate && editVal.trim() !== '' && !DATE_RE.test(editVal.trim())
    const pickerVal = isDate && DATE_RE.test(editVal.trim()) ? editVal.trim().slice(0, 10) : ''
    return (
      <span className={styles.editWrap}>
        {/* T-065 — ONE box: text input + calendar icon embedded at the right edge (like the
            go-to-path paste icon, T-058). No separate visible date control; the date is shown once. */}
        <span className={isDate ? `${styles.inputBox} ${styles.inputBoxDate}` : styles.inputBox}>
          <input
            autoFocus
            className={isDate ? `${styles.scalarInput} ${styles.scalarInputDate}` : styles.scalarInput}
            data-testid={`prop-input-${row.key}`}
            value={editVal}
            onChange={(e) => props.onEditValChange(e.target.value)}
            onBlur={() => props.onCommitScalar(editVal)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                props.onCommitScalar(editVal)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                props.onCancelEdit()
              }
            }}
          />
          {isDate && (
            <>
              {/* The embedded calendar icon opens the native picker. Keeps the prop-date-<key>
                  testid on whatever opens the picker. */}
              <Tooltip lines={['Pick a date']}>
                <button
                  type="button"
                  className={styles.dateIconBtn}
                  data-testid={`prop-date-${row.key}`}
                  aria-label="Open date picker"
                  // Don't commit-on-blur the text input before the picker opens.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => dateRef.current?.showPicker?.()}
                >
                  <CalendarIcon />
                </button>
              </Tooltip>
              {/* Hidden native date input — the picker trigger + the value the OS picker writes.
                  Picking a date fills the visible text input (and commits surgically). */}
              <input
                ref={dateRef}
                type="date"
                className={styles.dateNative}
                data-testid={`prop-date-native-${row.key}`}
                tabIndex={-1}
                aria-hidden="true"
                value={pickerVal}
                onMouseDown={(e) => e.preventDefault()}
                onChange={(e) => {
                  const v = e.target.value
                  props.onEditValChange(v)
                  props.onCommitScalar(v)
                }}
              />
            </>
          )}
        </span>
        {invalidDate && (
          <span className={styles.dateHint} data-testid={`prop-date-hint-${row.key}`}>
            Use YYYY-MM-DD
          </span>
        )}
      </span>
    )
  }

  return (
    <span
      className={row.scalar ? styles.scalarText : styles.nullText}
      data-testid={`prop-scalar-${row.key}`}
      onClick={props.onStartEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          props.onStartEdit()
        }
      }}
    >
      {row.scalar || 'empty — type a value…'}
    </span>
  )
}

function ChipAddInput({
  row,
  suggestions,
  onAddChip,
  onRemoveLast
}: {
  row: PropRow
  suggestions: string[]
  onAddChip: (chip: string) => void
  onRemoveLast: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  // E-014 — filter the ranked candidate values by the current input.
  const filtered = open
    ? suggestions
        .filter((s) => {
          const q = value.trim().toLowerCase()
          return q === '' || s.toLowerCase().includes(q)
        })
        .slice(0, 8)
    : []

  const pick = (v: string): void => {
    onAddChip(v)
    setValue('')
    setActive(-1)
    setOpen(false)
  }

  return (
    <span className={styles.suggestWrap}>
      <input
        className={styles.chipInput}
        data-testid={`prop-chip-input-${row.key}`}
        placeholder={row.list.length ? '' : 'add…'}
        value={value}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setValue(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onKeyDown={(e) => {
          if (open && filtered.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, filtered.length - 1))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
              return
            }
            if (e.key === 'Enter' && active >= 0) {
              e.preventDefault()
              pick(filtered[active])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setOpen(false)
              return
            }
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            if (value.trim()) {
              onAddChip(value)
              setValue('')
            }
          } else if (e.key === 'Backspace' && value === '') {
            e.preventDefault()
            onRemoveLast()
          }
        }}
      />
      {open && (
        <SuggestBox
          items={filtered}
          active={active}
          onPick={pick}
          testid={`prop-val-suggest-${row.key}`}
        />
      )}
    </span>
  )
}
