// Pomade — first-run workspace picker (S1). Shown when no workspace root is known.
// Opens the native directory dialog; on success re-hydrates the workspace store and the app
// settings, which live in the workspace.

import { useState } from 'react'

import { useWorkspaceStore } from '../stores/workspace-store'
import { useAppSettingsStore } from '../stores/app-settings-store'
import { useToast } from '../hooks/useToast'
import { cleanIpcError } from '../lib/ipc-errors'
import styles from './WorkspacePicker.module.css'

export function WorkspacePicker(): React.JSX.Element {
  const hydrate = useWorkspaceStore((s) => s.hydrate)
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const choose = async (): Promise<void> => {
    setBusy(true)
    try {
      const picked = await window.pomade.workspace.pick()
      if (picked) await Promise.all([hydrate(), useAppSettingsStore.getState().hydrate()])
    } catch (err) {
      toast(`Could not open workspace: ${cleanIpcError(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <div className={styles.diamond} aria-hidden="true" />
        <h1 className={styles.title}>Welcome to Pomade</h1>
        <p className={styles.subtitle}>
          Choose the workspace folder that holds your projects, apps, and agents. Pomade remembers
          it and reopens it next time.
        </p>
        <button
          type="button"
          className={styles.primary}
          onClick={() => void choose()}
          disabled={busy}
          data-testid="pick-workspace"
        >
          {busy ? 'Opening…' : 'Choose workspace folder'}
        </button>
      </div>
    </div>
  )
}
