// Pomade E-024 — the ONE place that decides which mode a freshly-opened doc gets.
// Every opener (file tree, symlink popover, terminal links, go-to-path, editor-internal
// opens) calls initialDocMode, so the two settings compose in exactly one spot:
//   • "New markdown opens as" (raw ⇄ rich) picks WHETHER markdown opens rich;
//   • "Editing markdown: Keep/Adjust formatting" (E-024) picks WHICH rich view —
//     Keep → 'live' (byte-true CodeMirror), Adjust → 'rendered' (Milkdown, E-023 contract).
// Read from the store at OPEN time only — a setting change never re-renders open docs,
// and restored tabs bypass this entirely (they keep their persisted mode).

import { useAppSettingsStore } from '../../stores/app-settings-store'
import { isMarkdownPath } from './doc-kind'

/** The rich view the current "Keep/Adjust formatting" setting selects. */
export function richViewDefault(): 'live' | 'rendered' {
  return useAppSettingsStore.getState().markdownFormatting === 'adjust' ? 'rendered' : 'live'
}

/** The mode a freshly-opened doc at `path` starts in. Non-markdown is always raw
 *  (CSV's table mode is a per-tab choice, not an open default). */
export function initialDocMode(path: string): 'raw' | 'rendered' | 'live' {
  if (!isMarkdownPath(path)) return 'raw'
  if (useAppSettingsStore.getState().markdownDefaultMode === 'raw') return 'raw'
  return richViewDefault()
}
