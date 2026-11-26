// Pomade — T-299 the bulk close confirm. "Stop all terminals" and "Exit all agents" ask ONCE for
// the whole batch when a tab they would close holds work in progress (terminals-store
// `bulkClose`). It is the per-tab close guard's dialog (`terminal-close-guard` in TerminalPane):
// the same pane-scoped DialogShell, centred over the pane area, the same words, Cancel / Close.
// It shows only while its project is the active one — like the per-tab guard, a pending ask
// waits while you look elsewhere. Cancel closes nothing; Close runs the action over the project's
// tabs as they are at that moment.

import { DialogShell } from '../../components/DialogShell'
import dialogStyles from '../../components/dialog.module.css'
import { useTerminalsStore, type BulkCloseRequest } from '../../stores/terminals-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

function copy({ action, busyTitles }: BulkCloseRequest): { title: string; text: string } {
  const n = busyTitles.length
  const one = `“${busyTitles[0]}”`
  if (action === 'stop-terminals') {
    return n === 1
      ? {
          title: 'Close running terminal?',
          text: `A command is still running in ${one}. Closing it will stop the process.`
        }
      : {
          title: 'Close running terminals?',
          text: `A command is still running in ${n} terminals. Closing them will stop the processes.`
        }
  }
  return n === 1
    ? {
        title: 'Close working agent?',
        text: `${one} is in the middle of a turn. Closing it ends the session and stops that work.`
      }
    : {
        title: 'Close working agents?',
        text: `${n} agents are in the middle of a turn. Closing them ends their sessions and stops that work.`
      }
}

export function BulkCloseConfirm(): React.JSX.Element | null {
  const pending = useTerminalsStore((s) => s.bulkClose)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  if (!pending || pending.projectId !== activeProjectId) return null
  const { title, text } = copy(pending)
  return (
    <DialogShell
      testId="bulk-close-guard"
      ariaLabel={title}
      title={title}
      onScrimClick={(e) => e.stopPropagation()}
      footer={
        <>
          <button
            type="button"
            className={dialogStyles.btnGhost}
            data-testid="bulk-close-cancel"
            onClick={() => useTerminalsStore.getState().cancelBulkClose()}
          >
            Cancel
          </button>
          <button
            type="button"
            className={dialogStyles.btnPrimary}
            data-testid="bulk-close-confirm"
            onClick={() => void useTerminalsStore.getState().confirmBulkClose()}
          >
            Close
          </button>
        </>
      }
    >
      <p className={dialogStyles.modalText}>{text}</p>
    </DialogShell>
  )
}
