---
doc: docs/contracts/ipc-app.md
audience: engineers
holds: how the IPC boundary is typed and wired (CH, EV, PomadeApi, preload helpers, defineHandler) and the app/env namespaces — version, OS hand-offs, settings, clipboard, spellcheck, menu accelerators, wake, flush and quit
kind: reference
---

# IPC boundary and the `app` / `env` namespaces

## The typed boundary

The renderer reaches main only through `window.pomade` (contextIsolation; the renderer never
imports from `src/main/`). Three things in `src/shared/ipc-api.ts` define it:

- **`CH`** — invoke channel names, `namespace.method` (`'fs.read'`). Renderer → main, request/response.
- **`EV`** — event channel names, `namespace:event` (`'pty:data'`). Main → renderer, fire-and-forget.
- **`PomadeApi`** — the typed surface on `window.pomade`, the single source of truth for every
  channel's signature. **`ChannelMap`** flattens it to `{ 'namespace.method': signature }`, keyed by
  the exact strings `CH` holds.

Both ends derive their types from `PomadeApi`, so a handler whose parameters or return disagree is a
compile error:

- **Preload** (`src/preload/index.ts`): `invoke(channel)` — a bound `ipcRenderer.invoke` typed as
  that channel's method; `makeEvent(event)` — a broadcast subscription, returns unsubscribe;
  `makeTermEvent(event, project)` — a per-terminal subscription for `pty.on*(termId, cb)`, where
  `project(payload)` maps the wire payload to the callback args. Each per-terminal event channel has
  **one** `ipcRenderer.on` listener, registered at api construction, dispatching over a
  `Map<termId, Set<cb>>`: an emit reaches exactly the callbacks of its `termId`, an unsubscribe
  removes exactly its own callback, and N terminals add no listeners.
- **Main** (`src/main/ipc.ts`): `defineHandler(ipcMain, channel, handler)` registers an
  `ipcMain.handle` whose args after `event` are the channel's parameter tuple and whose return is
  the channel's type (a value or a promise of it). Every invoke handler uses it.
- Exceptions: `app.flushAck` is an `ipcRenderer.send` on `CH.app.flushed` (main listens with
  `ipcMain.on`); `env.home` is a value, not a channel.

**Errors.** A handler throws; the renderer gets a rejected promise. A result the caller must branch
on is data, not an error (`fs.write` → `WriteFileResult`, `apps.call` → `AppCallResult`).

**Namespaces and where they are specified:**

| Namespace | Contract |
|---|---|
| `workspace`, `state`, `workspaceUi`, `fs` | [ipc-workspace-and-files](./ipc-workspace-and-files.md) |
| `recovery`, `localHistory` | [documents](./documents.md) |
| `pty`, `agents`, `attached` | [ipc-terminal](./ipc-terminal.md) |
| `git` | [git-state-and-history](./git-state-and-history.md), [git-operations](./git-operations.md) |
| `apps` | [host-api-frames](./host-api-frames.md), [host-api-socket](./host-api-socket.md) |
| `events`, `notices` | [events-and-notices](./events-and-notices.md) |
| `commands` | [host-api-socket](./host-api-socket.md) |
| `app`, `env` | this page |

## `app` — invoke channels

```ts
version(): Promise<string>
openPath(rel: string): Promise<void>
showItemInFolder(abs: string): Promise<void>
openExternal(url: string): Promise<void>
getSettings(): Promise<AppSettings>
setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
clipboardRead(): Promise<string>
clipboardWrite(text: string): Promise<void>
replaceMisspelling(suggestion: string): Promise<void>
addToDictionary(word: string): Promise<void>
confirmQuit(): Promise<void>
flushAck(): void                       // send on 'app.flushed'
```

- `version` — Pomade's own version from `<root>/package.json` (two levels above the main bundle;
  holds in dev, e2e and `app.asar`), cached; also the Host API's `pomadeVersion`.
- `openPath(rel)` — opens a workspace-relative item with the OS (`shell.openPath`).
  `showItemInFolder(abs)` — reveals an **absolute** path in Finder (in- or outside the workspace).
  `openExternal(url)` — the default browser, **http/https only** (anything else is ignored: terminal
  output is untrusted text). Under `NODE_ENV=test` these three record to main globals instead of
  acting — see [test-hooks](./test-hooks.md).
- `getSettings` / `setSettings` — the active workspace's `.pomade/settings.json` (preferences) and
  `.pomade/state/view.json` (view state), read fresh on every call; `setSettings` merge-patches,
  writes only the file(s) its patch touches and returns the merged settings (`mergeAppSettings`,
  [types](./types.md) §"App settings"). Calls are serialized in main. With no workspace: the
  defaults, and `setSettings` writes nothing.
- `clipboardRead` / `clipboardWrite` — Electron's main-process clipboard (no renderer permission
  prompt). `clipboardWrite` resolves after the OS write lands. Under `NODE_ENV=test` the clipboard is
  a per-process in-memory string.
- `replaceMisspelling(suggestion)` — `webContents.replaceMisspelling`: replaces the word under the
  last right-click (Chromium keeps undo and marker bookkeeping). `addToDictionary(word)` —
  `session.addWordToSpellCheckerDictionary`.
- `confirmQuit()` — the **only** thing that flips main's quit gate; main then calls `app.quit()`.

## `app` — events (main → renderer)

| Event | Payload | Subscription | Raised by |
|---|---|---|---|
| `app:flush` | — | `onFlush(cb)` | `before-quit` (after the quit is confirmed) |
| `app:confirm-quit` | `QuitRequest { liveTerms, liveTermIds }` | `onConfirmQuit(cb)` | every quit attempt |
| `app:wake` | — | `onWake(cb)` | `powerMonitor` `resume` and `unlock-screen` |
| `app:spell-context` | `{ misspelledWord, suggestions }` (≤ 5) | `onSpellContext(cb)` | every right-click (`webContents` `context-menu`); empty word = none |
| `app:open-settings` | — | `onOpenSettings(cb)` | menu `menu-settings`, Cmd+, |
| `app:change-workspace` | — | `onChangeWorkspace(cb)` | menu `menu-change-workspace` |
| `tabs:close-active` | — | `onCloseActiveTab(cb)` | menu `menu-close-tab`, Cmd+W |
| `tabs:new-terminal` | — | `onNewTerminalTab(cb)` | menu `menu-new-terminal-tab`, Cmd+T |
| `tabs:reopen-closed` | — | `onReopenClosedTab(cb)` | menu `menu-reopen-closed-tab`, Cmd+Shift+T |
| `editor:find` | — | `onEditorFind(cb)` | menu `menu-editor-find`, Cmd+F |
| `layout:toggle-projects-panel` | — | `onToggleProjectsPanel(cb)` | menu `menu-toggle-projects-panel`, Cmd+B |
| `layout:toggle-filetree` | — | `onToggleFileTree(cb)` | menu `menu-toggle-filetree`; the chord Cmd+Shift+B is taken in `before-input-event` on the physical `KeyB` (`window-shortcuts.ts`), so it holds under any keyboard layout and whatever has focus |

Menu accelerators are matched before the page sees the keystroke, so they never reach a focused
terminal. A menu item sends to the window it was invoked on, else the focused or first window; no
window = no-op. `menu-close-window` (Cmd+Shift+W) is the role `close`. The renderer decides what an
accelerator acts on (Cmd+W closes the active tab through its close guard; Cmd+F acts only when the
active tab is a doc pane; Cmd+T opens a terminal right of the active tab).

## Quit pipeline

1. `window.on('close')` and `app.on('before-quit')` are intercepted while the gate is closed and
   forwarded as `app:confirm-quit` to the focused window (fallback: first window).
   `liveTermIds` comes from `ptyManager.list()` — main is the authority on liveness; the renderer
   splits the count into agents and terminals by tab kind. Main keeps no dialog state: a repeat
   attempt re-sends and the renderer ignores it while its dialog is open.
2. Never unquittable: with no window, a page that has not finished its first load, or a crashed
   renderer, `requestQuitConfirm()` returns false and the quit proceeds unconfirmed.
3. The renderer's confirmation (stages and the dirty-docs stage are in
   `docs/modules/tabs/closing-tabs.md`) ends in `app.confirmQuit()`.
4. `before-quit` (gate open) → `app:flush` to every window; each renderer awaits
   `flushAllProjectState()` and calls `flushAck()`; main waits for all acks or 1 s.
5. `will-quit` → `ptyManager.flushSnapshots()` (synchronous) → stop the host socket →
   `flushPendingWrites()` + `ptyManager.killAll(true)` + `stopAllBackends()` → `app.exit(0)`.

Closing the window quits the app (a single-window hub never leaves a windowless process holding
PTYs). Under `NODE_ENV=test` the gate is open unless `POMADE_TEST_QUIT_CONFIRM=1`.

## `env`

```ts
env: { home: string }   // os.homedir(), snapshotted at preload time; '' only if the OS reports none
```

A synchronous value, no channel. Used to `~`-relativise paths for display.

Tickets: T-036, T-049, T-081, T-082, T-083, T-098, T-149, T-164, T-168, E-001, E-002, E-006, E-007, E-020, E-021.
