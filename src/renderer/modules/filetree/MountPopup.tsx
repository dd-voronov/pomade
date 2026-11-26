// Pomade — the "Mount a folder" popup (E-026 / T-132), extracted in T-159. One path input, a live
// scope hint (the mounts-store validation), the Add to project scope box (E-047), Enter/Mount to
// add. An outside-workspace path mounts too (carrying a red mark unless in scope); only empty is
// refused. The commit logic (dedupe-flash vs add-and-flash) stays in FileTree — this component is
// input + hint + box + buttons.

import { Modal } from '../../components/Modal'
import { Button } from '../../components/fields'
import { Tooltip } from '../../components/Tooltip'
import type { MountValidation } from '../../stores/mounts-store'
import { SCOPE_ADD_TIP } from './filetree-ops'
import styles from './FileTree.module.css'

export interface MountPopupProps {
  input: string
  onInput: (value: string) => void
  validation: MountValidation
  addToScope: boolean
  onAddToScope: (value: boolean) => void
  onSubmit: () => void
  onClose: () => void
}

export function MountPopup({
  input,
  onInput,
  validation,
  addToScope,
  onAddToScope,
  onSubmit,
  onClose
}: MountPopupProps): React.JSX.Element {
  return (
    <Modal
      title="Mount a folder"
      testId="tree-mount-dialog"
      width={420}
      onClose={onClose}
      footer={
        <>
          <Button data-testid="tree-mount-cancel" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="tree-mount-submit"
            disabled={validation.reason === 'empty'}
            onClick={onSubmit}
          >
            Mount
          </Button>
        </>
      }
    >
      <input
        className={styles.mountInput}
        data-testid="tree-mount-input"
        type="text"
        spellCheck={false}
        autoComplete="off"
        autoFocus
        placeholder="Folder path (e.g. Knowledge)"
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}
      />
      {input.trim() !== '' && (
        <div className={styles.mountHint} data-testid="tree-mount-hint">
          {validation.reason === 'duplicate' ? (
            <span className={styles.mountHintMuted}>Already shown — Mount jumps to it.</span>
          ) : validation.scope === 'in-project' ? (
            <span className={styles.mountHintInfo}>Inside this project — already visible in the tree.</span>
          ) : addToScope ? (
            <span className={styles.mountHintInfo}>
              {validation.scope === 'outside-project' ? 'Outside this project' : 'Outside the workspace'} — in
              project scope, so no mark.
            </span>
          ) : validation.scope === 'outside-project' ? (
            <span className={styles.mountHintWarning}>
              Outside this project — mounts with an orange mark.
            </span>
          ) : (
            <span className={styles.mountHintDanger}>Outside the workspace — mounts with a red mark.</span>
          )}
        </div>
      )}
      <div className={styles.mountScopeRow}>
        <label className={styles.mountScopeLabel}>
          <input
            type="checkbox"
            data-testid="tree-mount-scope"
            checked={addToScope}
            onChange={(e) => onAddToScope(e.target.checked)}
          />
          <span>Add to project scope</span>
        </label>
        <Tooltip lines={[SCOPE_ADD_TIP]} testId="tree-mount-scope-tip">
          <span className={styles.mountScopeInfo} tabIndex={0} role="img" aria-label="About project scope" data-testid="tree-mount-scope-info">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7 6.2v3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="7" cy="4.2" r="0.8" fill="currentColor" />
            </svg>
          </span>
        </Tooltip>
      </div>
    </Modal>
  )
}
