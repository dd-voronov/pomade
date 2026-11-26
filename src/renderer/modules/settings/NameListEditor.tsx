// Pomade — Settings' editable list of names: the file tree's ignored items (T-019), its unwatched
// folders and local history's two extension lists (T-274). Rows with a remove button, then one
// row: an input that takes the room, an optional pick button, Add, and Reset to default at the
// right end when the list has defaults. Every testid is `${testIdPrefix}-…`, so each list is
// addressed on its own.

import { useState } from 'react'

import { Tooltip } from '../../components/Tooltip'
import styles from './SettingsModal.module.css'

export interface NameListEditorProps {
  testIdPrefix: string
  items: readonly string[]
  /** What Reset to default restores; no Reset button without it. */
  defaults?: readonly string[]
  onChange: (items: string[]) => void
  /** Shown instead of the list when it is empty. */
  emptyText: string
  placeholder: string
  /** The remove button's tooltip and accessible name for one entry. */
  removeLabel: (name: string) => string
  /** The entry a typed draft becomes; null leaves the draft in the input, not added. */
  normalize?: (raw: string) => string | null
  /** A button beside the input that picks an entry (a folder dialog); its pick is added like a
   *  typed draft. The pick resolves null when nothing was picked. */
  pick?: { label: string; run: () => Promise<string | null> }
  /** Entries shown dimmed, with `dimmedLabel` as their tooltip (a folder that no longer exists). */
  dimmed?: (name: string) => boolean
  dimmedLabel?: string
}

export function NameListEditor({
  testIdPrefix: id,
  items,
  defaults,
  onChange,
  emptyText,
  placeholder,
  removeLabel,
  normalize = (raw) => raw.trim() || null,
  pick,
  dimmed,
  dimmedLabel
}: NameListEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState('')

  const add = (name: string): void => {
    if (!items.includes(name)) onChange([...items, name])
  }

  const addEntry = (): void => {
    if (!draft.trim()) {
      setDraft('')
      return
    }
    const name = normalize(draft)
    if (name === null) return
    add(name)
    setDraft('')
  }

  const pickEntry = async (): Promise<void> => {
    const picked = await pick?.run()
    const name = picked === null || picked === undefined ? null : normalize(picked)
    if (name !== null) add(name)
  }

  return (
    <>
      {items.length === 0 ? (
        <span className={styles.muted} data-testid={`${id}-empty`}>
          {emptyText}
        </span>
      ) : (
        <ul className={styles.ignoreList} data-testid={`${id}-list`}>
          {items.map((name) => (
            <li key={name} className={styles.ignoreRow}>
              {dimmed?.(name) ? (
                <Tooltip lines={[dimmedLabel ?? '']}>
                  <span
                    className={`${styles.ignoreName} ${styles.ignoreNameDimmed}`}
                    data-testid={`${id}-entry-${name}`}
                    data-dimmed="true"
                  >
                    {name}
                  </span>
                </Tooltip>
              ) : (
                <span className={styles.ignoreName} data-testid={`${id}-entry-${name}`}>
                  {name}
                </span>
              )}
              <Tooltip lines={[removeLabel(name)]}>
                <button
                  type="button"
                  className={styles.iconRemove}
                  aria-label={removeLabel(name)}
                  data-testid={`${id}-remove-${name}`}
                  onClick={() => onChange(items.filter((n) => n !== name))}
                >
                  ×
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.addRow}>
        <input
          className={styles.textInput}
          value={draft}
          placeholder={placeholder}
          data-testid={`${id}-add-input`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addEntry()
          }}
        />
        {pick && (
          <button type="button" className={styles.btn} data-testid={`${id}-pick`} onClick={() => void pickEntry()}>
            {pick.label}
          </button>
        )}
        <button type="button" className={styles.btn} data-testid={`${id}-add-submit`} onClick={addEntry}>
          Add
        </button>
        {defaults && (
          <button type="button" className={styles.btn} data-testid={`${id}-reset`} onClick={() => onChange([...defaults])}>
            Reset to default
          </button>
        )}
      </div>
    </>
  )
}
