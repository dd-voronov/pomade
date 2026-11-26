// Pomade T-184 — the editor's link ambiguity picker.
//
// A wikilink basename or bare name that exists in several places opens this instead of guessing
// (the terminal's "no dead links, pick when ambiguous" invariant). The pick routes through the
// SAME `activatePickedMatch` the terminal picker uses. Renders through the shared ContextMenu
// primitive (T-158) — the same surface as the terminal link picker and every other menu.

import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { activatePickedMatch, type EditorLinkPickerState } from './editor-links'
import styles from './EditorPane.module.css'

export function EditorLinkPicker({
  state,
  onClose
}: {
  state: EditorLinkPickerState
  onClose: () => void
}): React.JSX.Element {
  return (
    <ContextMenu
      x={state.x}
      y={state.y}
      onClose={onClose}
      testId="editor-link-picker"
      // Esc in capture phase — the same discipline the terminal picker uses so an editor keymap
      // can't swallow the key first.
      escapeCapture
      items={[
        { header: `${state.matches.length} files named “${state.name}”` },
        ...state.matches.map<MenuItem>((match, i) => ({
          testId: `editor-link-candidate-${i}`,
          data: { 'data-path': match },
          label: (
            <span className={styles.linkPickerRow}>
              <span className={styles.linkPickerName}>{match.slice(match.lastIndexOf('/') + 1)}</span>
              <span className={styles.linkPickerDir}>{match.slice(0, match.lastIndexOf('/')) || '.'}</span>
            </span>
          ),
          onSelect: () => {
            const line = state.line
            void activatePickedMatch(match, line)
          }
        }))
      ]}
    />
  )
}
