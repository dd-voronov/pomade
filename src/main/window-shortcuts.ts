// Pomade — chords the main process takes before the page sees them (`before-input-event` on the
// window's web contents). A chord here has exactly one handler whatever has focus: Pomade's own
// document, a terminal, an editor, or an app frame (tab, panel, overlay) — the page never gets the
// keystroke, so no frame forwards it and no menu key-equivalent matches it.
//
// Cmd+Shift+B (Toggle Side Panel) lives here: matched on the physical key (`KeyB`), so it holds
// under any keyboard layout — macOS fails to match Shift+letter menu accelerators under non-US
// layouts. Its View-menu item keeps the accelerator for display and the click.

/** The fields of Electron's `Input` the match reads. */
export interface ShortcutInput {
  type: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

/** Cmd+Shift+B on macOS (Ctrl+Shift+B elsewhere), by physical key, on key down. */
export function isToggleSidePanel(input: ShortcutInput, platform: NodeJS.Platform): boolean {
  const mac = platform === 'darwin'
  const mod = mac ? input.meta && !input.control : input.control && !input.meta
  return input.type === 'keyDown' && mod && input.shift && !input.alt && input.code === 'KeyB'
}
