---
doc: docs/modules/terminal/copy-paste-and-selection.md
audience: engineers, product
holds: copy on select, the terminal right-click menu, Cmd+C / Cmd+V behavior, Option+click cursor positioning; how it is built
kind: reference
---

# Copy, paste & selection — getting text out of (and into) the terminal

**Module:** `terminal` · **UI:** the terminal right-click menu (`terminal-menu`), the "Copied N chars"
flash, Settings ▸ General ▸ Terminal ▸ **Copy on select** · **Code:**
`src/renderer/modules/terminal/useXtermSession.ts` (`attachCopyOnSelect`, `createTerminal` options),
`TerminalPane.tsx` (menu, hint, paste action), `AttachedTerminalPane.tsx` (the same menu on an
attached tab) · **e2e:** `terminal-copy.spec.ts`

## What it does

Selecting text in a terminal with the mouse **copies it automatically** and flashes `Copied N chars`
(`Copied 1 char`) in the pane's bottom-right corner for 1.5 s. Right-click opens a menu with **Copy /
Paste to input / Select all / Clear**. **Option+click** moves the shell's cursor to the clicked
column. Cmd+C and Cmd+V behave as you would expect, with the terminal-specific nuances below.

## Auto-copy on select

- The copy commits when the mouse selection *ends* (mouseup, listened on the window because a drag
  routinely ends outside the pane) — one selection, one copy, one hint. Re-committing the same text,
  or a click that clears the selection, never re-copies.
- Toggle: **Settings ▸ General ▸ Terminal ▸ "Copy on select"**, default **on**. Off, a selection is
  just a selection — Cmd+C and the menu's Copy still work.

## The right-click menu

- **Copy** — acts on the selection as it was at right-click time (the click cannot destroy what you
  were about to copy). Disabled with no selection.
- **Paste to input** — reads the clipboard and writes it straight to the PTY's input line (no
  bracketed-paste wrapping), and clears the tab's unread dot. With auto-copy on, select output →
  right-click → Paste to input is a one-click copy-paste into the prompt. On an attached tab it is
  disabled unless the session is running, and the text goes as `paste` ([attached-terminals](./attached-terminals.md)).
- **Select all**, **Clear** (clears the visible buffer).
- The menu clamps to the viewport and closes on Escape or a click outside; while it is open, Escape
  belongs to the menu — it never reaches the shell.
- A right-click never *changes* the selection: xterm's macOS default of selecting the word under the
  cursor on right-click is off (`rightClickSelectsWord: false`), otherwise the menu's Copy would copy
  something you never chose.

## Keyboard nuances

- **Cmd+C (or Ctrl+C) with a selection** copies it and does not reach the shell (the terminal paints
  to a canvas, so there is no DOM selection for the OS Copy command — Pomade handles the key
  itself). **With no selection the key passes through**, so Ctrl+C sends SIGINT to the foreground
  process.
- **Cmd+V is not intercepted.** The Edit menu's native paste reaches xterm's input and is written to
  the shell (xterm wraps it in bracketed paste when the program asked for it). Intercepting it too
  would double-paste.
- Typing or pasting clears the tab's unread dot; a bare click or scroll does not ([panes-and-lifecycle](./panes-and-lifecycle.md)
  "Attention").

## Option+click cursor positioning

Option+click on the shell's command line moves the cursor to the clicked cell (xterm synthesizes the
arrow-key presses — the same mechanism as VS Code and iTerm). It applies only at a prompt in the
normal buffer with mouse reporting off, so a full-screen TUI (vim, an agent CLI) still receives the
click itself. `altClickMovesCursor: true` is set explicitly so an xterm default change cannot alter
the behavior.

## Boundaries worth knowing

- Inside a TUI that owns the mouse (Claude Code's own selection and copy handling, vim with mouse
  mode), xterm selection does not happen — the app's own affordances apply; Pomade's cover plain zsh,
  codex and scrollback.
- Option+click is reliable on the zsh prompt line; TUIs with their own input boxes may interpret the
  synthesized arrows approximately or ignore them.
- A plain click focuses the terminal (and commits a pending preview tab); a **Cmd+click is a link
  gesture** and does not steal focus — see [file-and-url-links](./file-and-url-links.md).

Tickets: T-084, T-085, T-121.
