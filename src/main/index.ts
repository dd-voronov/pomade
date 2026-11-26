// Pomade — main process entry.
// Registers one service per line; leaves explicit anchors for later waves.

import { app, BrowserWindow, ipcMain, Menu, powerMonitor, screen } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CH, EV } from '@shared/ipc-api'
import {
  configStore,
  registerConfigStore,
  flushPendingWrites,
  onWorkspaceTeardown,
  onWorkspaceReady
} from './config-store'
import { registerFsService, stopAllWatchers, warmNameIndex, resetNameIndex } from './fs-service'
// WAVE2B: pty + agents services.
import { registerPtyManager, ptyManager } from './pty-manager'
import { registerAgentService } from './agent-service'
// WAVE3: git service.
import { registerGitRuns } from './git-runs'
import { registerGitService } from './git-service'
import { refusedUnderTest } from './owner-paths'
import { defineHandler } from './ipc'
import { registerLocalHistory, startLocalHistory } from './local-history'
import { pruneDrafts, registerRecoveryStore } from './recovery-store'
import { stopDocWatch } from './doc-watch'
import { safeBroadcast } from './windows'
// E-027: app hosting — the app registry (pomade-app:// + discovery) and the Host API.
import { registerAppScheme, startAppRegistry } from './app-registry'
import { registerHostApi } from './host-api'
import { registerEventBus } from './event-bus'
import { registerThemeTestHook } from './theme'
import { registerNoticeQueue } from './notice-queue'
// E-028: app backends and commands — the Host API socket.
import { registerHostSocket, startHostSocket, stopHostSocket } from './host-socket'
import { reapLeftoverBackends, registerAppBackends, stopAllBackends } from './app-backends'
import { registerAttachedTerminals } from './attached-terminals'
import { refreshCommands, registerAppCommands } from './app-commands'
import { registerAppLaunchd } from './app-launchd'
import { registerAppScopeFolders, sweepRemovedApps } from './app-scope-folders'
import { installBundledApps } from './bundled-apps'
import { isToggleSidePanel } from './window-shortcuts'

// E-027 — the pomade-app:// scheme's privileges can only be declared before app `ready`.
registerAppScheme()

// Redirect all app-level storage (incl. app.json) when tests set POMADE_USER_DATA.
// Must run before app is ready. A test run has only its own user data folder: without one, or
// handed the Owner's real one (`owner-paths.ts`), it quits before writing anything.
const userDataOverride = process.env.POMADE_USER_DATA
if (
  process.env['NODE_ENV'] === 'test' &&
  !(userDataOverride?.trim() && !refusedUnderTest(process.env, 'POMADE_USER_DATA', userDataOverride, homedir()))
) {
  console.error('Pomade (test run): no test user data folder (POMADE_USER_DATA) — quitting.')
  process.exit(1)
}
if (userDataOverride && userDataOverride.trim()) {
  app.setPath('userData', userDataOverride)
} else if (!app.isPackaged) {
  // T-007 — dev/stable isolation. A `npm run dev` instance must never share app-level
  // storage with the INSTALLED Pomade.app: the dev app name ("pomade") and the packaged
  // productName ("Pomade") collide into one dir on case-insensitive APFS, so a dev
  // experiment could corrupt the stable app's app.json (or hold conflicting schema).
  // Dev gets its own home; the packaged app keeps the default.
  app.setPath('userData', join(app.getPath('appData'), 'pomade-dev'))
}

let mainWindow: BrowserWindow | null = null

// T-078 — unobtrusive e2e windows. The suite runs 4 app instances in parallel; by default
// each one would activate itself, stealing keyboard focus, yanking macOS to the Space it
// was created on and bouncing 4 dock icons. In test mode the window therefore NEVER
// activates: it is revealed with `showInactive()` (never `show()`/`focus()`/`moveTop()` —
// those all activate the app), parked in the far screen corner and made transparent, and
// the dock icon is suppressed.
// It is still genuinely *shown*, on purpose: a window that is never shown reports
// `document.visibilityState === 'hidden'`, which pauses requestAnimationFrame and breaks
// xterm/CodeMirror measurement. Inactive-but-visible keeps rendering fully live while
// Playwright drives input over CDP (which does not need an active window).
// Escape hatch for a spec that genuinely needs real OS activation: POMADE_TEST_ACTIVATE=1
// (none today — every opt-in reintroduces the disturbance, so justify it in the spec).
// Bracket-notation env reads so no bundler can statically inline them.
const testMode = process.env['NODE_ENV'] === 'test'
const unobtrusive = testMode && process.env['POMADE_TEST_ACTIVATE'] !== '1'

// T-098 — quit confirmation. ON for real use (Pomade is an operating hub with agents running;
// an accidental Cmd+Q used to kill it with zero friction). BYPASSED in test mode unless a spec
// opts in with POMADE_TEST_QUIT_CONFIRM=1: every spec's teardown calls app.close(), and a
// blocking dialog would hang all of them. Same env-switch pattern as POMADE_TEST_ACTIVATE.
const quitConfirmEnabled = !testMode || process.env['POMADE_TEST_QUIT_CONFIRM'] === '1'
// Flipped ONLY by the renderer's final confirmation (CH.app.confirmQuit). Until then every
// quit path is bounced back to the dialogs; afterwards the existing shutdown pipeline runs
// exactly as before.
let quitConfirmed = false
// The renderer can only answer once its page has actually loaded. Before that (and after a
// crash) an unconfirmed quit must proceed — otherwise a wedged renderer makes the app
// unquittable, which is worse than the accident T-098 guards against.
let rendererLoaded = false

// An off-screen, fully transparent window reads as "occluded" to macOS, which lets Chromium
// throttle rendering and timers to a crawl (xterm/CodeMirror measure via rAF). Test mode
// opts out of every backgrounding heuristic so an unobtrusive window renders like a normal
// foreground one. Switches must be appended before the app is ready.
if (unobtrusive) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

/** Park a test window in the far corner of the primary display, all but 1px off-screen.
 *  Two constraints learned the hard way:
 *   - macOS clamps a frame that is *fully* off-screen back into view, so 1px must stay on
 *     screen (that column is invisible anyway because the window's opacity is 0).
 *   - Cocoa re-constrains the frame into the work area when the window is *shown*, so this
 *     must run AFTER showInactive(); parking first silently snaps the window back on-screen.
 *  Never resize — specs depend on the 1360x900 viewport. */
function parkOffScreen(win: BrowserWindow): void {
  const { bounds, workArea } = screen.getPrimaryDisplay()
  win.setPosition(bounds.x + bounds.width - 1, workArea.y, false)
}

/** T-098 — hand a quit attempt to the renderer, which owns the confirmation dialogs (E-001
 *  doctrine: no native dialogs). Returns true when a renderer was actually asked — only then
 *  may the caller preventDefault. Returns false when nobody can answer (no window, page not
 *  loaded yet, renderer crashed), in which case the quit MUST proceed: an unanswerable
 *  confirmation would leave the app impossible to quit. Main keeps no dialog state — a second
 *  Cmd+Q while the dialog is open just re-sends, and the renderer ignores the repeat. */
function requestQuitConfirm(): boolean {
  // In test mode the window is deliberately never activated (T-078), so getFocusedWindow()
  // is null there — the first live window is the fallback.
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win || win.isDestroyed()) return false
  const wc = win.webContents
  if (!rendererLoaded || wc.isDestroyed() || wc.isCrashed()) return false
  // A dialog inside a minimized/hidden window is invisible — the app would just look like it
  // refuses to quit. Surface the window first. Never in unobtrusive test mode: T-078 forbids
  // show()/focus() there (they steal the machine's focus), and no spec minimizes.
  if (!unobtrusive) {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  }
  const liveTermIds = ptyManager
    .list()
    .filter((t) => t.alive)
    .map((t) => t.termId)
  wc.send(EV.confirmQuit, { liveTerms: liveTermIds.length, liveTermIds })
  return true
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#FAFBFC',
    titleBarStyle: 'hiddenInset',
    show: false,
    // Windows/Linux counterpart of app.dock.hide(): keep test instances out of the taskbar.
    ...(unobtrusive ? { skipTaskbar: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // T-081 — never throttle rAF/timers while occluded or asleep: xterm.js renders via
      // rAF, and a throttled renderer waking up left stale rows on screen (VS Code ships
      // the same setting for its terminal). The test-mode command-line switches above
      // cover only the e2e case; this covers real use (overnight sleep, covered window).
      backgroundThrottling: false
    }
  })

  // T-083 — ship the spell context of every right-click to the renderer. Chromium computes
  // misspelledWord/dictionarySuggestions only here (main), while the context MENU is renderer-
  // built (E-001 doctrine) — so main broadcasts and the open menu merges suggestions in. The
  // event fires a beat after the renderer's own `contextmenu`, hence push (not pull).
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send(EV.spellContext, {
      misspelledWord: params.misspelledWord,
      suggestions: params.dictionarySuggestions.slice(0, 5)
    })
  })

  // Chords main takes before the page (window-shortcuts.ts): one handler whatever has focus, an
  // app frame included. A held chord's repeats are swallowed without toggling again.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isToggleSidePanel(input, process.platform)) return
    event.preventDefault()
    const win = mainWindow
    if (!input.isAutoRepeat && win && !win.isDestroyed()) win.webContents.send(EV.toggleFileTree)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    rendererLoaded = true
  })

  // T-098 — the red traffic light (and "Close Window" / Cmd+Shift+W, which is the same window
  // `close` event) runs the SAME confirmation as Cmd+Q, and on confirmation quits the WHOLE
  // app. Pomade is a single-window hub: a windowless process still holding live PTYs is a
  // zombie the user can neither see nor reach, and "red button = I lost my hub" is exactly the
  // accident this task exists to prevent. The renderer's confirm path calls app.quit(), so this
  // listener only ever has to BLOCK the first, unconfirmed close.
  mainWindow.on('close', (event) => {
    if (quitConfirmed || !quitConfirmEnabled) return
    if (requestQuitConfirm()) event.preventDefault()
  })

  mainWindow.on('ready-to-show', () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (unobtrusive) {
      // Transparent before the first paint (no flash), inactive, then off-screen.
      win.setOpacity(0)
      win.showInactive()
      parkOffScreen(win)
    } else {
      win.show()
    }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file in prod.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// T-036 — application menu. Replaces Electron's default so Cmd+W closes the ACTIVE TAB
// (renderer-side close flow: dirty-doc guard, PTY reaper) instead of the window, and
// Cmd+T opens a new terminal tab. Window close moves to Cmd+Shift+W (macOS convention).
// Menu accelerators are handled before the web contents sees the keystroke, so they fire
// regardless of focus (xterm included) and never leak into a pty. Standard role submenus
// (app/Edit/View/Window) are kept so copy/paste, quit, minimize etc. keep working.
function sendToWindow(win: unknown, channel: string): void {
  // Accelerator presses pass the focused window; a programmatic MenuItem.click() (e2e)
  // may not — fall back to the focused/first window. No window at all → no-op (so Cmd+W
  // with the window closed does nothing).
  const target =
    win instanceof BrowserWindow
      ? win
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])
  if (target && !target.isDestroyed()) target.webContents.send(channel)
}

function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        {
          id: 'menu-settings',
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: (_item, win) => sendToWindow(win, EV.openSettings)
        },
        {
          id: 'menu-change-workspace',
          label: 'Change Workspace…',
          click: (_item, win) => sendToWindow(win, EV.changeWorkspace)
        },
        { type: 'separator' },
        {
          id: 'menu-new-terminal-tab',
          label: 'New Terminal Tab',
          accelerator: 'CmdOrCtrl+T',
          click: (_item, win) => sendToWindow(win, EV.tabsNewTerminal)
        },
        { type: 'separator' },
        {
          id: 'menu-close-tab',
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, win) => sendToWindow(win, EV.tabsCloseActive)
        },
        {
          // T-149 — Cmd+Shift+T reopens the active project's most-recently closed tab. Menu-level
          // (like Cmd+W) so it fires regardless of focus and never reaches a focused terminal.
          id: 'menu-reopen-closed-tab',
          label: 'Reopen Closed Tab',
          accelerator: 'Shift+CmdOrCtrl+T',
          click: (_item, win) => sendToWindow(win, EV.tabsReopenClosed)
        },
        { type: 'separator' },
        {
          // E-001 (T-012) — Cmd+F opens in-document find in the FOCUSED editor pane. Handled
          // at the menu level (like Cmd+W) so it never reaches xterm/terminal panes; the
          // renderer no-ops when the active tab isn't a doc.
          id: 'menu-editor-find',
          label: 'Find in Document…',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, win) => sendToWindow(win, EV.editorFind)
        },
        {
          id: 'menu-close-window',
          label: 'Close Window',
          accelerator: 'Shift+CmdOrCtrl+W',
          role: 'close'
        }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          // E-007 (T-030) — Cmd+B toggles the Projects panel. Handled at the menu level (like
          // Cmd+W) so it fires regardless of focus and never reaches a focused terminal.
          id: 'menu-toggle-projects-panel',
          label: 'Toggle Projects Panel',
          accelerator: 'CmdOrCtrl+B',
          click: (_item, win) => sendToWindow(win, EV.toggleProjectsPanel)
        },
        {
          // T-049 — Toggle Side Panel. The accelerator is shown here; the keystroke itself is
          // taken in `before-input-event` (window-shortcuts.ts) on the physical key, before the
          // page and the menu's own key matching see it.
          id: 'menu-toggle-filetree',
          label: 'Toggle Side Panel',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (_item, win) => sendToWindow(win, EV.toggleFileTree)
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerServices(): void {
  registerConfigStore(ipcMain)
  registerFsService(ipcMain)
  // WAVE2A: register fs watcher (fs.watch → EV.fsChanged)
  // WAVE2B: register pty + agents (pty.*, agents.*)
  registerPtyManager(ipcMain)
  registerAgentService(ipcMain)
  // WAVE3: register git (git.*).
  registerGitService(ipcMain)
  registerGitRuns(ipcMain)
  // E-027: Host API handlers (apps.*).
  registerHostApi(ipcMain)
  // E-031 — the event bus (events.*).
  registerEventBus(ipcMain)
  registerThemeTestHook()
  // E-032 — the closed-Pomade notice queue (notices.*).
  registerNoticeQueue(ipcMain)
  // E-028: the Host API socket (backends, commands) and its window half.
  registerHostSocket(ipcMain)
  registerAppBackends()
  registerAttachedTerminals(ipcMain)
  registerAppCommands(ipcMain)
  registerAppLaunchd()
  // E-047 (T-291) — app scope folders: a removed app's go.
  registerAppScopeFolders()
  // E-035 — unsaved-doc recovery copies + discarded drafts (user data only).
  registerRecoveryStore(ipcMain)
  // E-044 — local history snapshots of project files (user data only).
  registerLocalHistory(ipcMain)

  // T-098 — the renderer's final "Quit" click. Flip the gate, then re-enter the normal quit:
  // before-quit now passes straight through into flushRenderers → will-quit → exit.
  defineHandler(ipcMain, CH.app.confirmQuit, () => {
    quitConfirmed = true
    app.quit()
  })

  // E-006 (T-027) — on a workspace switch, tear down per-workspace resources: kill all
  // PTYs (they're per-workspace) and close all fs watchers so the renderer re-establishes
  // them against the new root.
  onWorkspaceTeardown(() => ptyManager.disposeAll())
  onWorkspaceTeardown(() => stopAllWatchers())
  onWorkspaceTeardown(() => stopDocWatch())
  // T-091 — the terminal name index is per-workspace and eagerly warmed: drop it (and its own
  // recursive watcher) with the old root, then rebuild it for the new one the moment the switch
  // is committed, so the first Cmd+hover in the new workspace never waits on a walk.
  onWorkspaceTeardown(() => resetNameIndex())
  onWorkspaceReady(() => warmNameIndex())
  // T-116 (E-022) — collect orphaned scrollback snapshots for the workspace we just switched
  // INTO (the boot-time GC is in `whenReady` below; this covers a switch back to a workspace
  // whose tabs changed elsewhere). Fire-and-forget: nothing waits on a housekeeping pass.
  onWorkspaceReady(() => {
    void ptyManager.gcSnapshots()
  })
}

void app.whenReady().then(async () => {
  // Resolve the workspace root up front (POMADE_WORKSPACE wins) so the renderer
  // can skip the picker when a root is already known.
  await configStore.resolveRoot()

  buildAppMenu()
  registerServices()
  // E-027 — serve pomade-app://, scan installed + dev-linked apps, and watch for changes. Awaited
  // so the first `apps.list` the renderer makes already sees every app.
  // E-028 — the Host API socket in user data, for app backends and commands. Listening before the
  // registry's first scan, which starts the with-Pomade backends (after stopping any a crashed
  // Pomade left running).
  await startHostSocket(app.getPath('userData'))
  await reapLeftoverBackends()
  // E-027 — a packaged Pomade installs the apps its release carries before the registry's first
  // scan, so they come up like any install (commands, backend, launch panel).
  await installBundledApps()
  await startAppRegistry()
  // E-047 (T-291) — folders of apps removed while Pomade was closed.
  void sweepRemovedApps()
  // E-028 — the command folder, workspace pointer and host record in this Pomade's home.
  await refreshCommands()
  // Before the first window exists, so the icon never appears and never bounces.
  // `app.dock` is macOS-only.
  if (unobtrusive && process.platform === 'darwin') app.dock?.hide()
  createWindow()

  // T-091 — build the terminal name index NOW (async, nothing waits on it) instead of on the
  // first Cmd+hover of the first terminal, which used to stall ~2 s on a real workspace. Placed
  // after createWindow so the window's own startup I/O gets the head start.
  warmNameIndex()

  // T-116 (E-022) — BOOT GC for terminal scrollback snapshots: delete every
  // `.pomade/state/scrollback/<key>` whose key owns no tab in any `state/<projectId>.json`
  // (a crash between "tab closed" and "file deleted", a hand-edited state file). Deliberately
  // reads the state DIRECTORY here in main: the renderer hydrates per project, lazily, so its
  // in-memory tabs are not a complete owner list — and doing it before the renderer creates any
  // tab means a live tab can never be mistaken for an orphan. Fire-and-forget.
  void ptyManager.gcSnapshots()

  // E-035 — discarded drafts are kept 7 days; prune the expired ones once per launch.
  void pruneDrafts()
  // E-044 — snapshot project files as they change on disk, kept 7 days.
  startLocalHistory()

  // Dock-icon click after the window was closed (Cmd+Shift+W / red button) reopens it.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // T-081 — after a sleep/wake cycle the renderer's picture of a terminal can be stale
  // (rAF gaps, display reconfiguration on lid-open). Tell every renderer to repaint its
  // visible terminal from the authoritative xterm buffer. Harmless when nothing is stale.
  const notifyWake = (): void => {
    safeBroadcast(EV.appWake)
  }
  powerMonitor.on('resume', notifyWake)
  powerMonitor.on('unlock-screen', notifyWake)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** Ask every live renderer to flush its debounced state, and wait for their acks (bounded
 *  by a 1s timeout so a wedged renderer can't block the quit). Windows are still alive
 *  during `before-quit`, so this is where the renderer→main flush IPC can round-trip. */
function flushRenderers(): Promise<void> {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (wins.length === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let remaining = wins.length
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      ipcMain.removeListener(CH.app.flushed, onAck)
      resolve()
    }
    const onAck = (): void => {
      remaining -= 1
      if (remaining <= 0) finish()
    }
    ipcMain.on(CH.app.flushed, onAck)
    for (const w of wins) w.webContents.send(EV.appFlush)
    setTimeout(finish, 1000)
  })
}

let flushingForQuit = false
app.on('before-quit', (event) => {
  // T-098 — the gate comes FIRST: an unconfirmed quit is bounced back to the renderer's
  // dialogs and never reaches the flush/reap pipeline below. Once confirmed (or bypassed in
  // test mode), this handler behaves exactly as it did before T-098.
  if (!quitConfirmed && quitConfirmEnabled && requestQuitConfirm()) {
    event.preventDefault()
    return
  }
  if (flushingForQuit) return
  flushingForQuit = true
  // Let renderers push their last-moment state into main's write queue, then let the quit
  // proceed normally (will-quit drains flushPendingWrites and reaps PTYs / the scheduler).
  event.preventDefault()
  void flushRenderers().finally(() => app.quit())
})

let quitting = false
app.on('will-quit', (event) => {
  if (quitting) return
  quitting = true
  // Flush any debounced config/state writes (incl. what renderers just flushed) AND drain the
  // PTY children before exit. T-037 — killAll(true) suppresses further pty broadcasts and waits
  // for each node-pty child to actually exit, so app.exit() never force-terminates the process
  // while a child is still dying (whose late exit event, racing the window teardown, was the
  // source of the intermittent "error was not a part of any test" flake).
  event.preventDefault()
  // T-116 (E-022) — scrollback snapshots are flushed HERE, synchronously, BEFORE killAll: a
  // requested kill reaps the term entry (and with it the ring buffer we are persisting), so an
  // async write would race its own subject away. It runs before `flushPendingWrites()` too,
  // which is harmless — the two touch different files (state/<project>.json vs
  // state/scrollback/<tab>) and neither waits on the other. The T-037/T-098 ordering below is
  // untouched: this adds a synchronous step, it does not reorder the awaited pipeline.
  ptyManager.flushSnapshots()
  // E-028 — no new socket clients from here on; the socket file goes with the process.
  stopHostSocket()
  void Promise.all([flushPendingWrites(), ptyManager.killAll(true), stopAllBackends()]).finally(() => {
    app.exit(0)
  })
})
