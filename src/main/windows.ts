// Pomade — shared BrowserWindow helpers: the one broadcast path and the one focused-window
// picker, so every module that talks to "all renderer windows" or "the window to anchor a
// native dialog on" goes through the same, hardened idiom instead of a hand-rolled copy.

import { BrowserWindow, dialog, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'

// T-037 — set once the app is quitting for good. Suppresses every broadcast (the windows are
// being torn down), so a late event (pty exit, fs-watch tick, git sync report, wake notice)
// racing the quit can't send into a webContents Electron is disposing.
let shuttingDown = false

/** Flip the shutdown flag. Idempotent, never reset — the app only quits once. */
export function setShuttingDown(): void {
  shuttingDown = true
}

/** True once `setShuttingDown()` has been called. */
export function isShuttingDown(): boolean {
  return shuttingDown
}

/** Send `channel`/`payload` to every live renderer window. Dropped entirely once the app is
 *  quitting (see `setShuttingDown`), and wrapped per-window so a webContents torn down between
 *  the `isDestroyed()` check and the `send` (a real race, not hypothetical — T-037) can't throw
 *  out of the loop and stop the remaining windows from receiving it. */
export function safeBroadcast(channel: string, payload?: unknown): void {
  if (shuttingDown) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      /* window/webContents torn down between the check and the send */
    }
  }
}

/** The focused window, falling back to the first live one — the shared anchor for a native
 *  dialog (a picker with no anchor still works, just without window-modal behavior). In test
 *  mode (T-078) the window is deliberately never activated, so `getFocusedWindow()` is null
 *  there and this always falls through to the first live window. */
export function focusedOrFirstWindow(): BrowserWindow | undefined {
  return (
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  )
}

/** `dialog.showOpenDialog`, anchored to the focused (or first live) window when one exists —
 *  same idiom as `focusedOrFirstWindow`, just applied to the one dialog call every native
 *  picker in main makes. A window-modal dialog when possible, an unanchored one when not
 *  (e.g. no window yet, or test mode's deliberately-unfocused window). */
export function showDialog(opts: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const win = focusedOrFirstWindow()
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)
}
