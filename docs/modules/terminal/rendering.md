---
doc: docs/modules/terminal/rendering.md
audience: engineers, product
holds: how terminals are drawn — xterm configuration, Unicode 11 widths, the terminal font, sleep/wake and re-show repaint, repainting a restored recording; how it is built
kind: reference
---

# Terminal rendering — xterm setup, unicode widths, font, sleep/wake repaint

**Module:** `terminal` · **UI:** the *Terminal font* setting (Settings ▸ General ▸ Terminal);
otherwise none (correctness — agent TUIs render like VS Code's terminal) · **Code:**
`src/renderer/modules/terminal/useXtermSession.ts` (`createTerminal`, fit/resize, the attach paint),
`TerminalPane.tsx` (visibility and wake refit, font restyle), `src/renderer/font-catalog.ts`,
`src/main/index.ts` (window options, wake events) · **e2e:** `terminal-render.spec.ts`,
`font-settings.spec.ts`, `terminal-scrollback.spec.ts` (the replay-paint rules)

## What it does

Two classes of visible corruption are prevented at the source: agent-TUI garbling caused by emoji
width mismatches, and stale or garbled terminals after overnight sleep. Claude Code's status line
(📁 🌿 ⏱️) renders identically to VS Code, and terminals look right immediately on wake.

## The xterm instance

`createTerminal` builds one xterm for PTY tabs and attached tabs alike: font size 12.5, line height
1.2, blinking cursor, **10 000 lines** of scrollback, the fit addon and the Unicode 11 addon.
`altClickMovesCursor` is `true` and `rightClickSelectsWord` is `false`, both set explicitly
([copy-paste-and-selection](./copy-paste-and-selection.md)). The theme is read from the app's CSS tokens when the terminal is
created: background and cursor-accent `--panel-raised`, text `--text`, cursor `--accent`, selection
`--selection`. Pomade has one (light) theme; a live xterm keeps the colors it was created with.

## Unicode 11 widths

xterm's built-in width tables are Unicode 6, where most emoji measure **1 cell**; agent CLIs assume
**2**. Every cursor-addressed partial rewrite after an emoji then lands shifted — garbled status
bars, mis-cleared repaint frames leaking multiplied banners and orphan `───` rules into scrollback.
Pomade loads the unicode11 addon (`unicode.activeVersion = '11'`), the same default VS Code ships.

## Terminal font

The xterm font for terminals and agent panes follows the **Terminal font** setting (a font id;
default `sf-mono`, the app's `--font-mono` stack). The list is monospace only, since an xterm grid
needs a fixed advance width: `SF Mono (default)`, `PT Mono`, `Monaco`, `JetBrains Mono (bundled)`,
`IBM Plex Mono (bundled)`. The two bundled fonts render without being installed on the Mac. An
unknown persisted id falls back to the standard mono stack. See [`../editor/fonts.md`](../editor/fonts.md) for the
catalog and bundling.

- **Measured before the grid.** xterm creation waits for the bundled fonts to load
  (`bundledFontsReady`), so the grid never measures against a not-yet-loaded face. The fonts load at
  boot, so this only delays a terminal created in the first milliseconds of launch.
- **Live restyle, no rebuild.** Changing the setting sets `xterm.options.fontFamily` on the live
  terminal, then refits (reflow to the new cell metrics), resizes the PTY and repaints — scrollback
  and any full-screen TUI survive. The pane is never rebuilt.

## Sleep/wake and hidden panes

- **No background throttling:** the window runs with `backgroundThrottling: false`; a renderer
  throttled overnight (occluded window, closed lid) would otherwise wake with stale rows.
- **Wake repaint:** on macOS resume and screen unlock (`powerMonitor` `resume` / `unlock-screen`),
  the visible terminal re-fits its grid and repaints every row from the buffer; a display
  reconfiguration that resized the window while rendering was paused is absorbed.
- **Re-show repaint:** a pane hidden behind another tab or project re-fits, fully repaints and takes
  focus when it becomes visible again.
- Resize chatter is deduped: the PTY is told about a resize only when the grid actually changed,
  sparing SIGWINCH/IPC storms during live window drags.

## Repainting a restored recording

A restore paint is a **recording**. A recording of an agent session contains the questions its TUI
asked the terminal (cursor position, device attributes) and the modes it switched on (focus and
mouse reporting). A terminal answers questions whether they are live or replayed, so two rules apply
to the paint, both view-only:

- **While a pane is painting restored scrollback, nothing it emits is sent to the shell.** Answers to
  a recording are not input. The window is one IPC round trip plus the parse, and it closes on the
  parser's own completion callback, not when `write()` returns, because the replies are emitted
  *during* parsing. A keystroke that lands inside it is dropped (sub-100 ms, before the pane is
  legible). Live output arriving during the window is queued and written after the paint, with the
  part the paint already covered trimmed off.
- **After the paint, mouse and focus reporting are switched off and the cursor shown — in the view
  only.** A mode is state: left on, it keeps sending `^[[I`/`^[[O` and mouse reports into a plain zsh
  forever. The reset is `?1003l ?1000l ?1006l ?1004l ?25h`; the alternate screen is exited only if
  the paint actually ended there (a trimmed recording can strand it), never unconditionally — that
  would move the cursor.

## Boundaries worth knowing

- Scrollback corruption that *already happened* is real buffer content — the fixes prevent new
  corruption; an old tab keeps its garbage until relaunched or cleared.
- A terminal's colors follow the CSS tokens at creation; there is no per-terminal theme.

Tickets: T-081, T-128, T-153.
