// Pomade — name prompt for creating files/folders from the tree (Wave 2a).
// Reuses the Projects panel Modal shell (Electron has no window.prompt).

import { useState } from 'react'

import { Modal } from '../../components/Modal'
import { Button, TextInput } from '../../components/fields'

interface NamePromptProps {
  title: string
  placeholder?: string
  /** E-012 — pre-fill the input (rename). Empty for create. */
  initial?: string
  /** E-012 — primary-button label; defaults to "Create" (rename passes "Rename"). */
  submitLabel?: string
  onSubmit: (name: string) => void
  onClose: () => void
}

export function NamePrompt({
  title,
  placeholder,
  initial = '',
  submitLabel = 'Create',
  onSubmit,
  onClose
}: NamePromptProps): React.JSX.Element {
  const [name, setName] = useState(initial)
  const submit = (): void => {
    if (name.trim()) onSubmit(name)
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
      testId="name-prompt"
      width={360}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} data-testid="name-submit" onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <TextInput
        value={name}
        autoFocus
        placeholder={placeholder}
        data-testid="name-input"
        onChange={(e) => setName(e.target.value)}
        // E-012 — on a rename, select the stem (before the extension) so typing replaces the
        // name but keeps the extension by default. No-op for create (empty value).
        onFocus={(e) => {
          const dot = e.target.value.lastIndexOf('.')
          if (dot > 0) e.target.setSelectionRange(0, dot)
          else e.target.select()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
    </Modal>
  )
}
