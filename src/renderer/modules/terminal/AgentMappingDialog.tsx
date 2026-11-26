// Pomade — AgentMappingDialog (renderer). Wave 2b.
// Shown when an agent's command doesn't resolve in interactive zsh. Lets the user map a
// working command; the override persists to .pomade/agents.json via agents.setCommand.

import { useState } from 'react'

import type { AgentInfo } from '@shared/types'
import { useToast } from '../../hooks/useToast'
import { cleanIpcError } from '../../lib/ipc-errors'
import { Modal } from '../../components/Modal'
import { Button } from '../../components/fields'
import styles from './AgentMappingDialog.module.css'

interface Props {
  agent: AgentInfo
  onClose: () => void
  onSaved: (updated: AgentInfo) => void
}

export function AgentMappingDialog({ agent, onClose, onSaved }: Props): React.JSX.Element {
  const [command, setCommand] = useState(agent.command)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  // Escape-to-close is Modal's own (window keydown listener) — no local handler needed.

  const save = async (): Promise<void> => {
    const trimmed = command.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const updated = await window.pomade.agents.setCommand(agent.id, trimmed)
      if (!updated.resolved) {
        toast(`"${trimmed}" still not found in your shell`, 'error')
      }
      onSaved(updated)
    } catch (err) {
      toast(cleanIpcError(err), 'error')
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Map “${agent.name}”`}
      onClose={onClose}
      testId="agent-mapping"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="agent-command-save"
            disabled={saving || command.trim().length === 0}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      <p className={styles.hint}>
        The command <code>{agent.command}</code> wasn’t found in your interactive login shell.
        Enter the command that starts this agent (it’s validated via <code>zsh -ilc</code>).
      </p>
      <label className={styles.label} htmlFor="agent-command-input">
        Command
      </label>
      <input
        id="agent-command-input"
        className={styles.input}
        data-testid="agent-command-input"
        value={command}
        autoFocus
        spellCheck={false}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
        }}
      />
    </Modal>
  )
}
