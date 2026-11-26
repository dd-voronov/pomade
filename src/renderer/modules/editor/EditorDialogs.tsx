// Pomade — the editor pane's confirm/prompt dialogs, each a thin presentational component
// over the pane-scoped modal shell (dialog.module.css). The save pipeline owns Save-As / overwrite
// / outside-save / save-conflict; the close guard owns the unsaved-changes prompt. Extracted from
// EditorPane so the pane holds state + wiring, not markup.

import { RESTORE_UNDER_DETAIL, restoreUnderQuestion } from '@shared/doc-history'
import { replaceDirtyLine, replaceQuestion } from '@shared/doc-version'
import { basename } from './doc-kind'
import { DialogShell } from '../../components/DialogShell'
import styles from '../../components/dialog.module.css'

// A new (untitled) document being named + saved for the first time.
export function SaveAsDialog({
  name,
  rootPath,
  onNameChange,
  onCancel,
  onConfirm
}: {
  name: string
  rootPath: string
  onNameChange: (name: string) => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <DialogShell
      testId="saveas-modal"
      ariaLabel="Save file as"
      title="Save new document"
      footer={
        <>
          <button type="button" className={styles.btnGhost} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="saveas-confirm"
            onClick={onConfirm}
          >
            Save
          </button>
        </>
      }
    >
      <label className={styles.modalLabel}>
        File name (relative to {rootPath || 'workspace root'})
        <input
          className={styles.input}
          data-testid="saveas-name"
          autoFocus
          value={name}
          placeholder="notes.md"
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm()
            if (e.key === 'Escape') onCancel()
          }}
        />
      </label>
    </DialogShell>
  )
}

// Save-As collided with an existing sibling.
export function OverwriteDialog({
  rel,
  onCancel,
  onConfirm
}: {
  rel: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <DialogShell
      testId="overwrite-confirm"
      ariaLabel="Overwrite file"
      title="File already exists"
      footer={
        <>
          <button
            type="button"
            className={styles.btnGhost}
            data-testid="overwrite-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="overwrite-confirm-btn"
            onClick={onConfirm}
          >
            Overwrite
          </button>
        </>
      }
    >
      <p className={styles.modalText}>
        “{basename(rel)}” already exists. Overwrite it with this document?
      </p>
    </DialogShell>
  )
}

// T-102 — first save of an outside-workspace doc in a tab session.
export function OutsideSaveDialog({
  title,
  onCancel,
  onConfirm
}: {
  title: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <DialogShell
      testId="outside-save-confirm"
      ariaLabel="Save outside workspace"
      title="Save outside your workspace?"
      footer={
        <>
          <button
            type="button"
            className={styles.btnGhost}
            data-testid="outside-save-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="outside-save-confirm-ok"
            onClick={onConfirm}
          >
            Save anyway
          </button>
        </>
      }
    >
      <p className={styles.modalText}>“{title}” is outside your workspace. Save anyway?</p>
    </DialogShell>
  )
}

// T-142 — the file diverged on disk since our last load/save.
export function SaveConflictDialog({
  title,
  onCancel,
  onReload,
  onOverwrite
}: {
  title: string
  onCancel: () => void
  onReload: () => void
  onOverwrite: () => void
}): React.JSX.Element {
  return (
    <DialogShell
      testId="save-conflict-confirm"
      ariaLabel="File changed on disk"
      title="File changed on disk"
      footer={
        <>
          <button
            type="button"
            className={styles.btnGhost}
            data-testid="conflict-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnGhost}
            data-testid="conflict-reload"
            onClick={onReload}
          >
            Reload instead
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="conflict-overwrite"
            onClick={onOverwrite}
          >
            Overwrite
          </button>
        </>
      }
    >
      <p className={styles.modalText}>
        “{title}” was modified on disk since you opened it. Overwrite it with this version, reload
        the disk copy (discarding your edits), or cancel?
      </p>
    </DialogShell>
  )
}

// T-020/T-044 — the dirty-close guard prompt.
export function CloseGuardDialog({
  title,
  onCancel,
  onDiscard,
  onSave
}: {
  title: string
  onCancel: () => void
  onDiscard: () => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <DialogShell
      testId="close-guard"
      ariaLabel="Unsaved changes"
      title="Unsaved changes"
      footer={
        <>
          <button
            type="button"
            className={styles.btnGhost}
            data-testid="guard-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnGhost}
            data-testid="guard-discard"
            onClick={onDiscard}
          >
            Discard
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="guard-save"
            onClick={onSave}
          >
            Save
          </button>
        </>
      }
    >
      <p className={styles.modalText}>“{title}” has unsaved changes. Save before closing?</p>
    </DialogShell>
  )
}

// T-226 — a version tab's Save replaces its document: one confirm, saying what happens to the
// document's own unsaved edits when it has any.
export function ReplaceWithVersionDialog({
  path,
  docDirty,
  onCancel,
  onConfirm
}: {
  path: string
  docDirty: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <DialogShell
      testId="replace-version-confirm"
      ariaLabel="Replace the document with this version"
      title="Replace with this version"
      footer={
        <>
          <button type="button" className={styles.btnGhost} data-testid="replace-version-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="replace-version-ok"
            autoFocus
            onClick={onConfirm}
          >
            Replace
          </button>
        </>
      }
    >
      <p className={styles.modalText} data-testid="replace-version-text">
        {replaceQuestion(path)}
      </p>
      {docDirty && (
        <p className={styles.modalText} data-testid="replace-version-dirty">
          {replaceDirtyLine(path)}
        </p>
      )}
    </DialogShell>
  )
}

// T-230 — Document history's Restore of a version kept under another path (before a rename):
// one confirm that the document is renamed back.
export function RestoreUnderDialog({
  path,
  earlier,
  onCancel,
  onConfirm
}: {
  path: string
  earlier: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <DialogShell
      testId="restore-under-confirm"
      ariaLabel="Restore under the earlier name"
      title="Restore under the earlier name"
      footer={
        <>
          <button type="button" className={styles.btnGhost} data-testid="restore-under-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={styles.btnPrimary} data-testid="restore-under-ok" autoFocus onClick={onConfirm}>
            Rename back and restore
          </button>
        </>
      }
    >
      <p className={styles.modalText} data-testid="restore-under-text">
        {restoreUnderQuestion(path, earlier)}
      </p>
      <p className={styles.modalText}>{RESTORE_UNDER_DETAIL}</p>
    </DialogShell>
  )
}
