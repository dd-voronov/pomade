// Pomade E-006 (T-027) — optional launch-time workspace confirmation. Shown once per launch
// only when the app-level setting `confirmWorkspaceOnStartup` is on (default off = continue
// silently, as today). Offers "Continue" (dismiss) or "Change workspace…" (the switch flow).

import { useEffect, useState } from 'react'

import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { Modal } from '../../components/Modal'
import styles from './SettingsModal.module.css'

export function StartupWorkspacePrompt(): React.JSX.Element | null {
  const settingsHydrated = useAppSettingsStore((s) => s.hydrated)
  const confirmOnStartup = useAppSettingsStore((s) => s.confirmWorkspaceOnStartup)
  const wsHydrated = useWorkspaceStore((s) => s.hydrated)
  const root = useWorkspaceStore((s) => s.root)
  const changeWorkspace = useWorkspaceStore((s) => s.changeWorkspace)

  const [dismissed, setDismissed] = useState(false)
  // Latch the decision to show on the FIRST launch-time hydration only; flipping the setting
  // later (in Settings) must not pop this prompt mid-session.
  const [armed, setArmed] = useState<boolean | null>(null)

  useEffect(() => {
    if (armed !== null) return
    if (!settingsHydrated || !wsHydrated) return
    setArmed(confirmOnStartup && root !== null)
  }, [armed, settingsHydrated, wsHydrated, confirmOnStartup, root])

  if (!armed || dismissed || root === null) return null

  return (
    <Modal
      title="Continue in this workspace?"
      onClose={() => setDismissed(true)}
      testId="startup-workspace-prompt"
      width={460}
      footer={
        <>
          <button
            type="button"
            className={styles.btn}
            data-testid="startup-change-workspace"
            onClick={() => {
              setDismissed(true)
              void changeWorkspace()
            }}
          >
            Change workspace…
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="startup-continue"
            onClick={() => setDismissed(true)}
          >
            Continue
          </button>
        </>
      }
    >
      <p className={styles.rowLabel}>Pomade will open your last workspace:</p>
      <p className={styles.wsPath} data-testid="startup-workspace-root">
        {root}
      </p>
    </Modal>
  )
}
