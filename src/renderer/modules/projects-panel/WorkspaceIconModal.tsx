// Pomade — E-010 (round-3) minimal modal for the workspace identity icon. Reuses the shared
// IconPicker (emoji grid + image upload, mutually exclusive). Icon only — no name editing,
// nothing else (the Workspace project has no other editable fields).

import { useState } from 'react'

import type { WorkspaceIdentity } from '@shared/types'
import { Modal } from '../../components/Modal'
import { Field, Button } from '../../components/fields'
import { IconPicker } from './IconPicker'

const DEFAULT_WORKSPACE_GLYPH = '💠'

interface WorkspaceIconModalProps {
  identity: WorkspaceIdentity | undefined
  onSave: (identity: WorkspaceIdentity | undefined) => void
  onClose: () => void
}

export function WorkspaceIconModal({
  identity,
  onSave,
  onClose
}: WorkspaceIconModalProps): React.JSX.Element {
  const [icon, setIcon] = useState(identity?.icon ?? '')
  const [image, setImage] = useState(identity?.image ?? '')

  const submit = (): void => {
    const next: WorkspaceIdentity | undefined = icon.trim()
      ? { icon: icon.trim() }
      : image.trim()
        ? { image: image.trim() }
        : undefined
    onSave(next)
    onClose()
  }

  return (
    <Modal
      title="Workspace icon"
      onClose={onClose}
      testId="workspace-icon-modal"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" data-testid="workspace-icon-save" onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Icon">
        <IconPicker
          icon={icon}
          image={image}
          onIconChange={setIcon}
          onImageChange={setImage}
          defaultGlyph={DEFAULT_WORKSPACE_GLYPH}
          testIdPrefix="workspace"
        />
      </Field>
    </Modal>
  )
}
