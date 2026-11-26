---
doc: docs/modules/core/app-shell.md
audience: engineers, product
holds: the window and app shell — layout columns, application menu and shortcuts, quit protection, theme tokens, context-menu clamping, shell-level reliability; how it is built
kind: reference
---

# Window & app shell — layout, menu, quit, theming

**Module:** `core` · **Code:** `src/main/index.ts` (window, app menu, quit gate, boot order),
`src/main/window-shortcuts.ts`, `src/main/windows.ts`, `src/main/theme.ts`, `src/renderer/App.tsx`
(layout), `src/renderer/layout/` (`ColumnDivider`, `QuitConfirm`, `WorkspacePicker`),
`src/renderer/tokens.css`, `src/renderer/hooks/use-clamped-position.ts` · **e2e:** `smoke.spec.ts`,
`layout.spec.ts`, `layout-scrollbar-gutter.spec.ts`, `tab-hotkeys.spec.ts`, `quit-confirm.spec.ts`,
`quit-dirty-docs.spec.ts`, `window-recreate.spec.ts`, `density.spec.ts`, `menu-clamp.spec.ts`,
`app-version-spellcheck.spec.ts`

## What it does

Pomade is a single window (1360×900, minimum 900×600, hidden-inset title bar) whose look comes from
**one token file**, whose keyboard shortcuts are **application-menu items or main-process chords**
(so a terminal never receives them), whose every quit path is **confirmed** before anything dies, and
whose context menus all clamp to the viewport through **one shared hook**. The Projects panel footer shows
the running app version.

## Layout

Without a workspace root the window shows the first-run picker ([workspaces and
persistence](./workspaces-and-persistence.md)); with one it shows four regions side by side:

| Region | Width | Notes |
|---|---|---|
| Projects panel | 160–480 px, default 240; collapsed = a 52 px rail | `Cmd+B`; collapse and width persist |
| Icon strip and side panel | 44 px icon strip + side panel 160–560 px, default 240; collapsed = the strip only | `Cmd+Shift+B`; see [side panels](./side-panels.md) |
| Main | the rest, never below 320 px | tab strip above, pane host below |

A 30 px title bar above the body (a window drag region) carries only the word "Pomade". The two
`ColumnDivider`s (`role="separator"`) resize by pointer drag (live, committed on pointer-up) or by
`←`/`→` in 16 px steps while focused. Each divider clamps against its own limits **and** against the
other columns so the main area keeps its 320 px (`clampProjectsPanel` / `clampFileTree` in `App.tsx`).
Widths change through CSS variables only, so a resize never remounts a pane. Widths and both
collapse flags live in `.pomade/state/view.json` (`layout`) ([settings](./settings.md)).

The app-level overlays — settings modal, startup prompt, git overlays, quit dialogs, toast host —
are mounted once beside the layout. The quit dialog and toast host are also mounted in the picker
branch: main blocks a quit as soon as the page has loaded, so a window with no answering dialog
would be unquittable.

## Application menu & shortcuts

Pomade replaces Electron's default menu, so accelerators are handled **at the menu level**: they fire
whatever has focus and never leak into a terminal pty. Each custom item sends one `EV.*` event to the
focused (else first) window; the renderer acts on it.

- **File:** `Settings…` Cmd+, · `Change Workspace…` · `New Terminal Tab` Cmd+T (inserted right of the
  active tab, focused) · `Close Tab` Cmd+W (the renderer's close flow: dirty-doc guard, PTY reaper; no
  active tab = no-op, the window stays) · `Reopen Closed Tab` Cmd+Shift+T (the active project's
  most recently closed tab; no-op when its reopen stack is empty) · `Find in Document…` Cmd+F (the
  focused editor pane; a no-op when the active tab is not a doc) · `Close Window` Cmd+Shift+W.
- **View:** `Toggle Projects Panel` Cmd+B · `Toggle Side Panel` Cmd+Shift+B, plus the standard reload,
  developer-tools, zoom and full-screen roles.
- The macOS app menu, Edit and Window submenus are Electron's role menus (Quit Cmd+Q, Copy/Paste,
  Minimize …).

**Chords main takes before the page** (`window-shortcuts.ts`, wired to `before-input-event`): Cmd+Shift+B
(Ctrl+Shift+B off macOS), matched on the physical `KeyB`, so it holds under any keyboard layout —
macOS fails to match Shift+letter menu accelerators under non-US layouts. It has exactly one handler
whatever has focus, an app frame included; the page never sees the keystroke; a held chord's
auto-repeats are swallowed. The View-menu item keeps the accelerator for display and serves the click.

**App-declared shortcuts** (manifest `shortcuts`, [app hosting](./app-hosting.md)) are matched by one
capture-phase window listener (`useAppShortcuts`), before any pane sees the key.

OS keystroke → menu dispatch is untestable in e2e; specs click the real menu items programmatically
(`menu-close-tab`, `menu-settings`, `menu-toggle-projects-panel`, …), which exercises everything below the
keystroke.

## Quit protection

Every quit path — Cmd+Q, the app-menu Quit, the red traffic light, `Close Window` (Cmd+Shift+W, the
same window `close` event) — is intercepted in main and handed to the renderer, which owns the
dialogs. Nothing exits until the renderer's final confirmation calls `app.confirmQuit`, which flips
`quitConfirmed` and re-enters the normal quit. Closing the window therefore quits the whole app: a
windowless process holding live PTYs would be a zombie the user can neither see nor reach.

Main sends `EV.confirmQuit` with the live PTY count and ids. A minimized or hidden window is restored
and focused first (never in unobtrusive test mode). Main keeps no dialog state: a second quit attempt
while a dialog is open just re-sends, and the renderer ignores the repeat. If nobody can answer (no
window, page not yet loaded, renderer crashed) the quit proceeds, because an unanswerable
confirmation would make the app unquittable.

`QuitConfirm` runs up to three **sequential** stages (one scrim at a time):

1. **Quit Pomade?** — always; `Cancel` / `Quit`. "Cancel keeps every tab and session exactly as it is."
2. **Sessions still running** — only when live terminal or agent sessions exist: the real counts
   ("2 agents and 3 terminals are still running."; counted across all projects, a session counts only
   when its tab is `live` **and** main still has the pty). `Cancel` / `Quit anyway`.
3. **Unsaved documents** — only when a doc tab is dirty in any project (hidden panes included):
   `Cancel` / `Discard all changes` / `Save all docs`. Save-all runs each doc's normal save pipeline
   (on-disk conflict guard, refusal guard); a doc that cannot be saved unattended (untitled, refused,
   unconfirmed outside the workspace, conflict) aborts the quit with **Couldn't save some documents**
   naming them. Discard keeps each buffer as a 7-day discarded draft ([unsaved
   recovery](../editor/unsaved-recovery.md)).

Cancel, Esc, a scrim click or × at any stage aborts the whole quit; the next attempt starts again at
stage 1. In test mode the gate is bypassed unless a spec sets `POMADE_TEST_QUIT_CONFIRM=1`; there a
closed window leaves the process running (macOS) and a dock click (`activate`) recreates the window.

After confirmation the shutdown pipeline runs: `before-quit` asks each window to flush its in-flight
saves (acks, 1 s timeout), then `will-quit` writes the terminals' scrollback snapshots, stops the
host socket, and drains the config write queue while killing PTYs and stopping app backends, then
`app.exit(0)` ([workspaces and persistence](./workspaces-and-persistence.md) "Write discipline").

## Boot order

`registerAppScheme` (before `ready`) → user-data path (`POMADE_USER_DATA`, else `pomade-dev` when
unpackaged; in a test run a value naming the Owner's real folders is refused, `owner-paths.ts`) → `resolveRoot` → application menu → service registration → host socket →
`reapLeftoverBackends` → `installBundledApps` → `startAppRegistry` → `refreshCommands` → `createWindow`
→ name-index warm-up, scrollback-snapshot GC, discarded-draft prune, local-history start. The window's
first Host-API `apps.list` therefore already sees every app. The window's `context-menu` event ships
the spell context (misspelled word, up to 5 suggestions) to the renderer, which merges it into its own
menu ([spellcheck](../editor/spellcheck.md)).

## Theme tokens

`src/renderer/tokens.css` is the single source for every color, size and motion value — semantic
variables (`--accent`, `--bg`, `--text-muted`, `--danger`, …) plus layout metrics. Styling:
CSS modules and token variables only, no inline hex, no UI framework. Pomade has one
**light theme** ("diamond" icy-blue accent); `color-scheme: light` keeps native controls and
scrollbars light whatever the Mac's appearance. Another theme would be a `:root[data-theme="<theme>"]`
rule re-mapping the semantic variables. Tab tints are tokens too (`--tab-tint-<color>` / `-active`).

`main/theme.ts` is the one source apps are told about: `pomadeTheme()` is `"light"`, every app
frame's welcome carries it, and `setPomadeTheme` would publish `theme.changed`
([HOST-API](../../HOST-API.md) §3 `welcome.theme`, §4 `theme.changed`). Apps receive the same tokens from
`pomade-kit/tokens.css`, generated by `scripts/kit-tokens.mjs`; a unit test fails while the pinned
kit copy differs. Under `NODE_ENV=test`, `globalThis.__pomadeTheme` sets the theme source.

## Density

Any interactive control is at least `--hit-target: 24px`; icon-only buttons are the `--icon-btn: 24px`
square with a `--control-icon: 16px` glyph and a tooltip on every one; tree rows are
`--tree-row-h: 24px`. Nothing in the chrome is a pinpoint target.

## Context-menu clamping

Every pointer-positioned overlay clamps to the viewport with an 8 px margin through
`use-clamped-position.ts`: the shared `ContextMenu` primitive (every renderer-built menu), the Live
editor's link popup, and — via `useClampedTooltip` — every tooltip. The hook measures the overlay
parked at the viewport origin (measuring at the pointer would report a wrapped min-width and
under-clamp) inside a layout effect, so the corrected position is the first paint. Vertical overflow
flips the menu **up** (bottom anchored at the click, native-menu behavior); a tooltip flips above its
anchor; a submenu flyout, positioned `fixed`, flips to the left of its parent at the right edge and
shifts up at the bottom. A new overlay must use the hook, never raw `style={{ left, top }}`.

## App version label

The Projects panel footer shows `v<version>` (`app-version`) next to the Settings button; the collapsed
rail stays gear-only. The version is `pomadeVersion()` in `config-store.ts`: it reads the app's own
`package.json` two levels above the main bundle (correct in dev, e2e and inside `app.asar`), because
`app.getVersion()` reports Electron's version in unpackaged runs. The same value is the Host API's
`pomadeVersion`.

## Shell-level reliability

- `backgroundThrottling: false` — the renderer is never rAF/timer-throttled while occluded or
  asleep; xterm renders via rAF and a throttled renderer woke with stale rows.
- On `powerMonitor` `resume` / `unlock-screen`, main broadcasts `EV.appWake` and every visible terminal
  re-fits and repaints from the authoritative buffer.
- `safeBroadcast` (`windows.ts`) is the one path to every renderer window; it is a no-op once the app
  is shutting down and tolerates a webContents torn down mid-send, so a late event (pty exit, fs tick,
  wake) can never throw during a quit. `showDialog` anchors native pickers on the focused (else first)
  window.
- **Unobtrusive test windows.** The e2e suite runs several app instances in parallel. Under
  `NODE_ENV=test` (unless `POMADE_TEST_ACTIVATE=1`) a window never activates: it is revealed with
  `showInactive()`, made transparent and parked 1 px inside the far screen corner (after the show —
  Cocoa re-constrains a frame at show time), the dock icon and taskbar entry are suppressed, and
  Chromium's background throttling switches are disabled. The window is still genuinely shown, because
  a never-shown window reports `visibilityState: hidden` and pauses rAF, which breaks xterm and
  CodeMirror measurement. Test-only env hooks (`POMADE_WORKSPACE`, `POMADE_USER_DATA`,
  `POMADE_PICK_ROOT`, `POMADE_TEST_*`; intervals resolve through `tunedMs` in `test-tuning.ts`) are
  listed in [contracts/test-hooks](../../contracts/test-hooks.md).

## Boundaries worth knowing

- One light theme; the token structure allows another, no setting selects it.
- Window close and quit are one action: there is no "keep running without a window" state in real use.

Tickets: T-312, T-313.
