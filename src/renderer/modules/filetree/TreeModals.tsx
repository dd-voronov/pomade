// Pomade — the file-tree confirm/collision modals (E-016 / E-018 / T-133), extracted in T-159.
// Each is a thin presentational wrapper over the shared Modal; all decision logic and state live in
// FileTree/useTreeOps. Every data-testid is preserved verbatim.

import { Modal } from '../../components/Modal'
import { Button } from '../../components/fields'
import { nameOf, type CollisionState, type SelItem } from './filetree-ops'
import styles from './FileTree.module.css'

// E-018 — "Open in editor" above 10 files asks first: N real tabs is a big, slow, hard-to-undo
// change to the tab strip (locked decision 4).
export function OpenManyModal({
  items,
  onCancel,
  onConfirm
}: {
  items: SelItem[]
  onCancel: () => void
  onConfirm: (items: SelItem[]) => void
}): React.JSX.Element {
  return (
    <Modal
      title={`Open ${items.length} files?`}
      testId="tree-open-many"
      width={380}
      onClose={onCancel}
      footer={
        <>
          <Button data-testid="open-many-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="open-many-confirm" onClick={() => onConfirm(items)}>
            Open {items.length} files
          </Button>
        </>
      }
    >
      <p className={styles.collisionText}>{`This opens ${items.length} editor tabs at once.`}</p>
    </Modal>
  )
}

// T-133 — deleting an OUTSIDE node always confirms first: it lives outside the workspace, so the
// delete is not something the user reasons about as "just my vault". Confirming trashes it
// (recoverable); cancelling leaves it. In-workspace deletes never reach this dialog.
export function DeleteConfirmModal({
  items,
  onCancel,
  onConfirm
}: {
  items: SelItem[]
  onCancel: () => void
  onConfirm: (items: SelItem[]) => void
}): React.JSX.Element {
  return (
    <Modal
      title={items.length === 1 ? `Delete “${nameOf(items[0].path)}”?` : `Delete ${items.length} items?`}
      testId="tree-delete-confirm"
      width={400}
      onClose={onCancel}
      footer={
        <>
          <Button data-testid="delete-confirm-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" data-testid="delete-confirm-ok" onClick={() => onConfirm(items)}>
            Move to Trash
          </Button>
        </>
      }
    >
      <p className={styles.collisionText}>
        {items.length === 1
          ? `“${nameOf(items[0].path)}” is outside your workspace and will be moved to the Trash.`
          : `These ${items.length} items are outside your workspace and will be moved to the Trash.`}
      </p>
    </Modal>
  )
}

// E-016 — move-collision dialog: replaces the raw "already exists" error toast for drag-and-drop /
// Cut→Paste moves.
export function CollisionModal({
  collision,
  onCancel,
  onResolve
}: {
  collision: CollisionState
  onCancel: () => void
  onResolve: (c: CollisionState, how: 'rename' | 'overwrite') => void
}): React.JSX.Element {
  return (
    <Modal
      title={`“${collision.name}” already exists`}
      testId="tree-collision"
      width={380}
      onClose={onCancel}
      footer={
        <>
          <Button data-testid="collision-cancel" onClick={onCancel}>
            Cancel
          </Button>
          {collision.canOverwrite && (
            <Button
              variant="danger"
              data-testid="collision-overwrite"
              onClick={() => onResolve(collision, 'overwrite')}
            >
              Overwrite
            </Button>
          )}
          <Button
            variant="primary"
            data-testid="collision-rename"
            onClick={() => onResolve(collision, 'rename')}
          >
            Move with a new name
          </Button>
        </>
      }
    >
      <p className={styles.collisionText}>
        {collision.canOverwrite
          ? `A file named “${collision.name}” already exists here. Move it with a collision-safe name, or overwrite the existing file (it goes to the Trash).`
          : `An item named “${collision.name}” already exists here. Move it with a collision-safe name instead.`}
      </p>
    </Modal>
  )
}
