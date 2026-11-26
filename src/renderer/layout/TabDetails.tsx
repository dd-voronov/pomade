// Pomade T-150 — "Show tab details" admin/debug popup. Shows a tab's RAW persisted JSON (the exact
// Tab object stored in ProjectState.openTabs, rendered from the LIVE tabs-store — the .pomade state
// file is only its 500ms-debounced mirror), editable as free JSON text. Save is:
//   • STATE-ONLY — it patches the store via updateTab; NO side actions (no relaunch, rebind, or
//     validation calls). Edited values take effect wherever the app naturally consumes them (the
//     title repaints immediately since the strip renders from the store; `resumeSessionId` is read
//     at the next revive/relaunch).
//   • CHANGED-FIELDS-ONLY — only fields that DIFFER from the snapshot captured at open are applied,
//     so a concurrent self-update to an untouched field survives; on a field both edited AND
//     concurrently updated, the manual edit wins (the patch carries the edited value). Deleting a
//     key that WAS in the snapshot clears that field (applied as `undefined`; JSON persistence then
//     drops the key — see docs/modules/tabs/tab-details.md).
//   • VALIDATED — the parsed object is checked against the per-kind key allowlist + field-type map
//     co-located with the Tab types (src/shared/types.ts). Invalid JSON, an unknown key, a wrong
//     type for a known key, or a changed/removed immutable `id`/`kind` each REJECT: the popup stays
//     open with the user's text intact and shows the error.
// A subtle "changed underneath" hint appears when the underlying object updates while the popup is
// open — view-only awareness; the textarea is never reloaded and Save is never blocked.
//
// Esc and a scrim click both CANCEL (Modal's conventions); a successful Save closes the popup.

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  TAB_FIELD_ALLOWLIST,
  TAB_FIELD_TYPES,
  TAB_IMMUTABLE_FIELDS,
  type Id,
  type Tab
} from '@shared/types'
import { Modal } from '../components/Modal'
import { Button } from '../components/fields'
import { useTabsStore } from '../stores/tabs-store'
import styles from './TabDetails.module.css'

/** The raw persisted form, pretty-printed (2-space). JSON.stringify already drops `undefined`
 *  keys, so this is exactly what lands in the .pomade state file. */
function pretty(tab: Tab): string {
  return JSON.stringify(tab, null, 2)
}

type ValidateOutcome = { ok: true; patch: Partial<Tab> } | { ok: false; error: string }

/** Parse + validate the edited text against the snapshot's KIND, and (on success) compute the
 *  changed-fields-only patch. Pure — no store access, so it is trivially unit-testable and the
 *  component only decides open/close from its result. */
export function validateAndDiff(text: string, snapshot: Tab): ValidateOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'The tab must be a JSON object.' }
  }
  const obj = parsed as Record<string, unknown>
  const snap = snapshot as unknown as Record<string, unknown>
  const kind = snapshot.kind
  const allow = TAB_FIELD_ALLOWLIST[kind]
  const types = TAB_FIELD_TYPES[kind]

  // `id` and `kind` are immutable: reject a change OR a removal (panes / PTYs / scrollback
  // snapshots key off `id`; a mid-life `kind` change is meaningless).
  for (const key of TAB_IMMUTABLE_FIELDS) {
    if (!(key in obj) || obj[key] !== snap[key]) {
      return {
        ok: false,
        error: `"${key}" is immutable — panes, PTYs, and scrollback snapshots key off it. Keep ${key}: ${JSON.stringify(
          snap[key]
        )}.`
      }
    }
  }

  // Unknown keys reject (guards against a silent typo like "resumeSesionId").
  for (const key of Object.keys(obj)) {
    if (!allow.includes(key)) {
      return {
        ok: false,
        error: `Unknown key "${key}" for a ${kind} tab. Allowed keys: ${allow.join(', ')}.`
      }
    }
  }

  // Wrong type for a known, present key rejects (a JSON `null` or wrong primitive).
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    const expected = types[key]
    const got = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val
    // T-185 — 'object' (DocTab.viewport) accepts a plain JSON object only: `typeof null` and
    // `typeof []` are both 'object', so the extra null/array guard is what makes the check honest.
    const okType = expected === 'object' ? got === 'object' : typeof val === expected
    if (!okType) {
      return { ok: false, error: `Field "${key}" must be a ${expected} (got ${got}).` }
    }
  }

  // Changed-fields-only diff against the snapshot captured at open.
  const patch: Record<string, unknown> = {}
  // Edited or added: present now, differs from the snapshot.
  for (const key of Object.keys(obj)) {
    if (JSON.stringify(obj[key]) !== JSON.stringify(snap[key])) patch[key] = obj[key]
  }
  // Deleted: present in the snapshot, absent now → clear the field (apply as undefined).
  for (const key of Object.keys(snap)) {
    if (!(key in obj) && snap[key] !== undefined) patch[key] = undefined
  }
  return { ok: true, patch: patch as Partial<Tab> }
}

export function TabDetails({
  projectId,
  tabId,
  onClose
}: {
  projectId: Id
  tabId: Id
  onClose: () => void
}): React.JSX.Element | null {
  const liveTab = useTabsStore((s) =>
    (s.tabsByProject[projectId] ?? []).find((t) => t.id === tabId)
  )
  const updateTab = useTabsStore((s) => s.updateTab)

  // The snapshot the changed-fields-only diff runs against, captured at OPEN (first render). The
  // tab exists when the menu launches this popup, so `liveTab` is defined here; the ref never
  // updates afterwards, so a concurrent store change can never move the diff baseline.
  const snapshotRef = useRef<Tab | undefined>(liveTab)
  const [text, setText] = useState<string>(() => (liveTab ? pretty(liveTab) : ''))
  const [error, setError] = useState<string | null>(null)

  // The tab was closed elsewhere while the popup was open — nothing left to show.
  useEffect(() => {
    if (!liveTab) onClose()
  }, [liveTab, onClose])

  // "Changed underneath": the underlying object differs from the snapshot shown at open. View-only
  // — the textarea is never reloaded and Save is never blocked (the diff still runs against the
  // snapshot, so the user's edits win on the fields they touched).
  const changedUnderneath = useMemo(
    () => !!liveTab && !!snapshotRef.current && pretty(liveTab) !== pretty(snapshotRef.current),
    [liveTab]
  )

  if (!liveTab || !snapshotRef.current) return null
  const snapshot = snapshotRef.current

  const save = (): void => {
    const outcome = validateAndDiff(text, snapshot)
    if (!outcome.ok) {
      setError(outcome.error) // keep the popup open with the text intact
      return
    }
    updateTab(projectId, tabId, outcome.patch)
    onClose()
  }

  return (
    <Modal
      title="Tab details"
      onClose={onClose}
      testId="tab-details"
      width={560}
      footer={
        <>
          <Button data-testid="tab-details-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="tab-details-save" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <p className={styles.subtitle}>
        The raw persisted JSON for this tab. Editing is state-only — no relaunch or rebind. Deleting
        a key clears that field.
      </p>
      <textarea
        className={styles.editor}
        data-testid="tab-details-textarea"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (error) setError(null)
        }}
      />
      {changedUnderneath && (
        <div className={styles.hint} data-testid="tab-details-hint">
          Updated underneath — your edits apply over the version shown.
        </div>
      )}
      {error && (
        <div className={styles.error} data-testid="tab-details-error" role="alert">
          {error}
        </div>
      )}
    </Modal>
  )
}
