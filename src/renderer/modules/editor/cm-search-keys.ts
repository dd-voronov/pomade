// Pomade — the raw and live editors' search keys: CodeMirror's search keymap without its
// Cmd+G / Cmd+Shift+G binding (find next / previous, which also open the search panel).
// Cmd+Shift+G is the quick peek (git/DiffOverlay.tsx) and must open only the peek; Cmd+G is
// free. Cmd+F opens the panel (the Find in Document menu item), and the panel's own
// next / previous buttons and Enter / Shift+Enter in its field step through the matches.

import { searchKeymap } from '@codemirror/search'
import type { KeyBinding } from '@codemirror/view'

export const editorSearchKeymap: readonly KeyBinding[] = searchKeymap.filter((binding) => binding.key !== 'Mod-g')
