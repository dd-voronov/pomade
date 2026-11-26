// Pomade Wave 3 — git module public surface.
import { DeletedFileOverlay } from './DeletedFileOverlay'
import { DiffOverlay } from './DiffOverlay'
import { HistoryShortcut } from './history/HistoryShortcut'
import { GitOpDialogHost } from './ops/GitOpDialog'

/** Every app-level git overlay: the Cmd+Shift+G diff, (E-036) the deleted-file view, the
 *  Cmd+Shift+H History shortcut (E-038) and the operation dialog (E-039/E-040). */
export function GitOverlays(): React.JSX.Element {
  return (
    <>
      <DiffOverlay />
      <DeletedFileOverlay />
      <HistoryShortcut />
      <GitOpDialogHost />
    </>
  )
}

export { useGitUiStore } from './git-ui-store'
export { GitBadge } from './GitBadge'
