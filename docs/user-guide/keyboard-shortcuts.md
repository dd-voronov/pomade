---
doc: docs/user-guide/keyboard-shortcuts.md
audience: users
holds: every keyboard shortcut in Pomade, grouped by where it works
kind: reference
---

# Keyboard shortcuts

On macOS. Where a key says Cmd, Ctrl works on other platforms. Esc closes any open menu, popover or
dialog.

## Anywhere

| Keys | What it does |
|---|---|
| Cmd+, | Open Settings |
| Cmd+T | New terminal tab, right of the active tab |
| Cmd+W | Close the active tab (asks first if it holds unsaved work or a running process) |
| Cmd+Shift+T | Reopen the project's most recently closed tab |
| Cmd+B | Show or hide the Projects panel |
| Cmd+Shift+B | Show or hide the side panel (Files, Git, Notices, app panels) |
| Cmd+Shift+H | Show or hide the active document's Document history |
| Cmd+Shift+G | Quick peek: the active document's changes in an overlay |
| Cmd+Shift+W | Close the window (asks before quitting) |
| Cmd+Q | Quit (asks when sessions are running or documents are unsaved) |
| Cmd+R · Opt+Cmd+I | Reload the window · developer tools |
| Cmd+0 · Cmd+= · Cmd+- | Reset zoom · zoom in · zoom out |
| Ctrl+Cmd+F · Cmd+M · Cmd+H | Full screen · minimize · hide |
| ← / → on a focused column divider | Resize the column by 16 px |

There are no shortcuts for switching between tabs.

## Editor

| Keys | What it does |
|---|---|
| Cmd+S | Save |
| Cmd+F | Find in document — Enter / Shift+Enter next / previous, Esc closes |
| F3 · Shift+F3 | Next · previous match (Raw, Live) |
| Cmd+Alt+G | Go to line (Raw, Live) |
| Cmd+D · Cmd+Shift+L | Select the next occurrence · all occurrences (Raw, Live) |
| Cmd+B · Cmd+I | Bold · italic (Live, Rendered) |
| Cmd+E | Inline code (Rendered) |
| Cmd+Alt+0 … 6 | Paragraph, heading 1–6 (Rendered) |
| Cmd+Alt+7 · Cmd+Alt+8 | Numbered · bulleted list (Rendered) |
| Cmd+Alt+C · Cmd+Alt+X | Code block · strikethrough (Rendered) |
| Tab · Shift+Tab | Indent · outdent (a list item in Rendered; the line in Raw) |
| Shift+Enter | Line break inside a paragraph (Rendered) |
| Cmd+Z · Cmd+Shift+Z | Undo · redo |
| Cmd+click | Open a link, path or `[[wikilink]]` |
| Enter · Tab · Shift+Tab · Esc | In a CSV cell: commit · next cell · previous cell · cancel |
| Cmd+Enter | Save a value in the Properties panel's complex-value editor |

In Raw view, Cmd+B shows or hides the Projects panel. Cmd+Shift+B always toggles the side panel, never a
blockquote.

## Terminals and agents

| Keys | What it does |
|---|---|
| Cmd+C | Copy the selection; with nothing selected the key goes to the shell |
| Ctrl+C | With a selection: copy. Without one: interrupt the running command |
| Cmd+V | Paste |
| Option+click | Move the shell's cursor to the clicked spot |
| Cmd+hover · Cmd+click | Underline · open a file or URL in the output (a picker when several files match) |

## Git

| Keys | What it does |
|---|---|
| Cmd+Enter | In the commit box: commit (staged files if any are staged, else all) |
| Esc | Close the commit box, the quick peek, the Document history panel or the deleted-file view |
| Enter | On a Git panel, branch-tab or commit-tab row: open it in a tab that stays |
| → · ← | On a merge commit in History: show · hide its commits |
| Enter · Space · Cmd+click | On a Document history row: open the comparison · tick it · tick it |
| Cmd+S | In a comparison tab with a live right side: save the document |

## Files and projects

| Keys | What it does |
|---|---|
| Cmd+click · Shift+click · Cmd+Shift+click | Toggle a row · select a range · add a range |
| Double-click | Rename the item |
| Esc | Clear the selection |
| Enter · Esc | In the go-to box: go · dismiss suggestions, then clear |
| Enter · Space | On the Workspace row: open the Workspace |

Projects and groups have no shortcuts; reorder them with the row's ⋯ ▸ Move up / Move down.

## Notices

| Keys | What it does |
|---|---|
| Cmd+click · Shift+click | Select notices |
| Delete · Backspace | Delete the selected notices |
| Esc | Clear the selection |

## Apps

An app can declare its own shortcut (Cmd with optional Ctrl, Alt or Shift and one letter or digit) that
opens its tab or overlay from anywhere. Pomade's own shortcuts always win over an app's. Esc closes an
app's overlay.
