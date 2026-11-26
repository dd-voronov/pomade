// Pomade — shared renderer error-message cleanup (T-166). Electron wraps a rejected
// ipcMain.handle error as "Error invoking remote method 'fs.rename': Error: <message>";
// every user-facing toast/error site routes its caught error through this ONE helper so
// no toast shows that raw wrapper. Not a data-path signal (see EEXIST, which is a
// structured `{ ok: false, code: 'EEXIST' }` result, not a message to grep) — purely
// cosmetic cleanup for display.
export function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const i = msg.lastIndexOf('Error: ')
  return i >= 0 ? msg.slice(i + 'Error: '.length) : msg
}
