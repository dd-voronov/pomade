// Pomade e2e — pressing a chord through Electron's real input pipeline. Playwright's keyboard
// (CDP) skips the main process's `before-input-event`, where Pomade takes some chords before the
// page (main/window-shortcuts.ts); `webContents.sendInputEvent` passes it. The event goes to the
// window's top document whatever the page has focused — a chord main takes never reaches it.

import type { ElectronApplication } from '@playwright/test'

type Modifier = 'meta' | 'shift' | 'alt' | 'control'

/** Key down + key up of `keyCode` (Electron accelerator key name, e.g. 'B') with `modifiers`. */
export async function pressThroughMain(app: ElectronApplication, keyCode: string, modifiers: Modifier[]): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { keyCode, modifiers }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    { keyCode, modifiers }
  )
}

/** Cmd+Shift+B (Ctrl+Shift+B off macOS) through the real input pipeline. */
export function toggleSidePanelKeys(app: ElectronApplication): Promise<void> {
  return pressThroughMain(app, 'B', [process.platform === 'darwin' ? 'meta' : 'control', 'shift'])
}
