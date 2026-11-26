// Pomade — create/edit a group (Wave 2a). Groups are app-only bundles of projects.

import { useState } from 'react'
import { nanoid } from 'nanoid'

import type { Group } from '@shared/types'
import { Modal } from '../../components/Modal'
import { Field, TextInput, TextArea, Button } from '../../components/fields'
import { IconPicker } from './IconPicker'

interface GroupModalProps {
  /** When editing, the existing group; when creating, undefined. */
  group?: Group
  /** E-015 — when creating a SUB-group, the parent group's id (nests the new group). */
  parentId?: string
  nextOrder: number
  onSave: (group: Group) => void
  onClose: () => void
}

export function GroupModal({ group, parentId, nextOrder, onSave, onClose }: GroupModalProps): React.JSX.Element {
  const editing = Boolean(group)
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [image, setImage] = useState(group?.image ?? '')
  const [icon, setIcon] = useState(group?.icon ?? '')

  const canSave = name.trim().length > 0

  const submit = (): void => {
    if (!canSave) return
    const result: Group = {
      id: group?.id ?? nanoid(),
      name: name.trim(),
      description: description.trim() || undefined,
      image: image.trim() || undefined,
      icon: icon.trim() || undefined,
      // E-015 — preserve an edited group's existing parent; a new sub-group nests under `parentId`.
      parentId: group?.parentId ?? parentId,
      order: group?.order ?? nextOrder
    }
    onSave(result)
    onClose()
  }

  return (
    <Modal
      title={editing ? 'Edit group' : parentId ? 'New sub-group' : 'New group'}
      onClose={onClose}
      testId="group-modal"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSave}
            data-testid="group-save"
            onClick={submit}
          >
            {editing ? 'Save' : 'Create group'}
          </Button>
        </>
      }
    >
      <Field label="Name">
        <TextInput
          value={name}
          autoFocus
          placeholder="e.g. Work"
          data-testid="group-name"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Description">
        <TextArea
          value={description}
          placeholder="(optional)"
          data-testid="group-description"
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Icon">
        <IconPicker
          icon={icon}
          image={image}
          onIconChange={setIcon}
          onImageChange={setImage}
          defaultGlyph="📁"
          testIdPrefix="group"
        />
      </Field>
    </Modal>
  )
}
