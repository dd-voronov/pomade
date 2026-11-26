---
doc: docs/contracts/test-hooks.md
audience: engineers
holds: every environment variable and global the app honours for tests and diagnostics — storage redirects, dialog stubs, tuned intervals, test-mode behaviour, main and renderer globals, menu triggering
kind: reference
---

# Test hooks

None of these is product surface: product code never reads a renderer test global, and every
main-process hook below is inert in a normal run.
Every global below is typed for specs
in `e2e/fixtures/globals.ts` — a hook added here is declared there too.

## Environment variables read by main

| Variable | Effect |
|---|---|
| `NODE_ENV=test` | Test mode: the clipboard is a per-process in-memory string; `app.openPath`, `app.showItemInFolder`, `app.openExternal` record instead of acting (globals below); the window is **unobtrusive** — `app.dock.hide()` / `skipTaskbar`, opacity 0, shown with `showInactive()` and parked 1 px on-screen in the display's far corner, no backgrounding — so test mode never calls `show()` / `focus()` / `moveTop()`; the quit confirmation is bypassed; commands, the Pomade home, the rc file and always-on backends are off unless their own hooks are set. A hook that names the Owner's real place — `~/.pomade`, `~/.pomade-dev`, `~/Library/Application Support/Pomade*`, `~/Library/LaunchAgents`, a shell rc file in the home folder or `$ZDOTDIR/.zprofile` (`src/main/owner-paths.ts#isOwnersPath`) — is refused: logged on stderr and treated as unset, so a run started from a Pomade terminal (which carries `POMADE_HOME=~/.pomade`) never writes there. |
| `POMADE_TEST_ACTIVATE=1` | Normal activating window behaviour in a test run (debugging; no spec uses it). |
| `POMADE_TEST_QUIT_CONFIRM=1` | Opt a test run **into** the quit confirmation. A spec that leaves the app alive under it must quit-then-close (`app.close()` would re-raise the dialog). |
| `POMADE_WORKSPACE=<abs>` | Use this workspace root; skip the picker. Also the CLI's first choice. |
| `POMADE_TEST_BUILD_FLAVOR=stable\|dev` | With `NODE_ENV=test`: Pomade runs as the stable or the dev build — the local-history folder (documents §"Local history"); otherwise packaged = stable, unpackaged = dev. |
| `POMADE_USER_DATA=<abs>` | Redirect user data (`app.json`, recovery, local history, notices queue, app state, keys, the socket) — tests never touch real user data. Also the target of `bin/pomade apps …`. Without it an unpackaged run uses `<appData>/pomade-dev` and the packaged app Electron's default. Under test it is required: without it, or set to the Owner's real folder, Pomade quits at start (exit 1) and `bin/pomade` refuses. |
| `POMADE_PICK_ROOT=<abs>` | Stands in for `workspace.pickRoot`'s dialog (read on every call). |
| `POMADE_PICK_PATH=<abs>` | Stands in for `fs.pickImage`'s dialog (read on every call). |
| `POMADE_HOME=<abs>` | This Pomade's home (`bin/`, `workspace`, `host.json`) instead of `~/.pomade` / `~/.pomade-dev`. Under test the only home (none without it); `bin/pomade` under test refuses to run a command that needs one without it. |
| `POMADE_SHELL_RC=<abs>` | The rc file the PATH line goes in. Without it under test there is none: the Settings row is hidden and `pomade path` refuses. |
| `POMADE_LAUNCH_AGENTS=<abs>` + `POMADE_LAUNCHD_PREFIX=io.github.dd-voronov.pomade.test.<random>.` | Where always-on backends' plists go and their label prefix. Under test both are required and the prefix must start with `io.github.dd-voronov.pomade.test.`, else always-on backends are off. A spec boots its label out in teardown. A launchd job cannot read `~/Documents`, so the always-on spec runs Pomade from a temp copy. |
| `POMADE_DEV_APPS=<path-or-url>[;…]` | Dev-link apps for one run without touching `app-links.json`: a build folder (absolute, or relative to the launch cwd) or `http://localhost:PORT`; the id comes from the manifest. Highest precedence. Conformance fixture: `e2e/fixtures/apps/hello/`. |
| `POMADE_BUNDLED_APPS=<abs>` | The bundled-apps folder (a packaged Pomade uses `<resourcesPath>/bundled-apps`). |
| `POMADE_WORKTREES_DIR=<abs>` | Where `worktree-add` makes folders. Under test without it (and without a home): `<userData>/worktrees`. |
| `POMADE_TEST_EVENT_LOG=<file>` | With `NODE_ENV=test`: every platform event appended as one JSON line, synchronously (the only witness of events published while Pomade quits). |
| `POMADE_TEST_WATCH_LOSS_MS=<n>` | Simulated native watcher loss: every in-workspace watch descriptor hears nothing for its first N ms and drops an event for a path it heard less than N ms before. Per launch only, never suite-wide. |

**Tuned intervals** (`src/main/test-tuning.ts#tunedMs`): a positive number of milliseconds replaces
the production value; unset, empty or invalid ⇒ production, byte-identical behaviour.
`playwright.config.ts` exports the suite's values (`e2e/fixtures/timing.ts`) into every launch; a spec
opts one app back to production by setting the variable to `''`.

| Variable | Production | Interval |
|---|---|---|
| `POMADE_TEST_POLL_MS` | 1000 | session-watcher poll |
| `POMADE_TEST_SNAPSHOT_IDLE_MS` | 2000 | scrollback snapshot idle debounce |
| `POMADE_TEST_CONFIG_DEBOUNCE_MS` | 500 | config-store write debounce |
| `POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS` | 1500 | local-history quiet window |
| `POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS` | 20000 | local-history max wait |
| `POMADE_TEST_LOCAL_HISTORY_PRUNE_DELAY_MS` | 30000 | first local-history prune |
| `POMADE_TEST_LOCAL_HISTORY_CAP_BYTES` | the setting `localHistoryCapMb` | snapshot store size cap (bytes, not ms); set, it overrides the setting |

`SUBMIT_TIE_MS` has no hook — the tie window is product semantics.

**Screenshots.** `POMADE_<ticket>_SHOTS=<dir>` (`POMADE_E037_SHOTS`, `POMADE_T226_SHOTS`, …) is read
by individual e2e specs, never by the app: the spec saves its review screenshots there.

## Main-process globals (read with `electronApp.evaluate`)

| Global | Holds |
|---|---|
| `__pomadeOpenedUrls`, `__pomadeOpenedPaths`, `__pomadeRevealedPaths` | what `app.openExternal`, `app.openPath`, `app.showItemInFolder` were asked under `NODE_ENV=test` |
| `__pomadePick` | `{ answers: (string \| null)[], requests: { defaultPath, message, extensions? }[] }` — under test the Host API folder and file pickers take the next queued answer (absolute path, or `null` = cancel; none queued = cancel) and log each request |
| `__pomadeTheme` | `{ set(theme: 'light' \| 'dark'), get() }` — sets the theme apps are told about (`theme.changed`), under test |
| `__pomadeNameIndex`, `__pomadeNameIndexRewalk()` | name-index stats (`builds`, `patches`, `watching`, `lastBuildMs`, `files`, `dirs`); force a re-walk |
| `__pomadeDocWatch` | `{ dirs }` — descriptors the open-doc watcher holds |
| `__pomadeOutsideWatch` | `{ size }` — outside-mount watch descriptors |
| `__pomadeTreeReads` | under `NODE_ENV=test`, every folder `fs.tree` / `fs.treeOutside` read, in order (assign `[]` to reset) |

## Renderer globals (read with `page.evaluate`)

| Global | Holds |
|---|---|
| `__pomadeStores` | `{ useTabsStore, useWorkspaceStore, useWorkspaceUiStore, useTerminalsStore, useAppSettingsStore, useMountsStore, useAppsStore, useAgentLiveStore }` — for setup the UI does not cover |
| `__pomadeEditorSelectionFrom()` | the visible editor pane's selection start (`-1` = none); used by `waitCaretRegistered` before a spec's first keystroke |
| `__pomadeEditorLinkResolve[tabId](text)` | whether a doc line's text holds a resolvable link |
| `__pomadeTermLinks[termId]`, `__pomadeTermLinkResolve[termId](token)` | terminal link scan; whether a token resolves to a link (no routing) |
| `__pomadeTermProvideLinks[termId](rowText)` | runs the real link provider on the buffer row holding `rowText`: each link's `{ target, startY, endY }` |
| `__pomadeAttachedBuffer[tabId]()` | an attached tab's whole buffer as text |
| `__pomadeCaretTrace` | ring of caret-restore trace entries (diagnostics) |
| `__pomadeRenderCounts` | per-component render counts (dev diagnostics) |

## Menu accelerators

Synthesized key events do not reach native menu accelerators, so e2e clicks the real menu item:
`electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('<id>').click())`
(ids in [ipc-app](./ipc-app.md) §"events"). That covers menu item → IPC event → renderer; only the
OS keystroke dispatch is untested. Quit paths are driven from main:
`app.evaluate(({ app }) => app.quit())` and `BrowserWindow.getAllWindows()[0].close()`.

Tickets: T-036, T-078, T-098, T-177, T-243, T-245, T-246, T-273, E-020, E-027, E-028.
