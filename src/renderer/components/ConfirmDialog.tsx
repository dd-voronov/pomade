// Pomade — a small confirm dialog (Wave 2a). Used for project/group deletes, which
// only touch .pomade config — never files on disk.

import { Modal } from './Modal'
import { Button } from './fields'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onClose
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onClose}
      testId="confirm-dialog"
      width={400}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" data-testid="confirm-ok" onClick={() => {
            onConfirm()
            onClose()
          }}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 'var(--lh)' }}>{message}</p>
    </Modal>
  )
}
