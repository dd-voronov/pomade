---
doc: docs/modules/editor/editor-context-menu.md
audience: engineers, product
holds: the editor's right-click menu — its two variants, the spelling section, the actions (duplicate, copy to, copy path, agent chat, clipboard, find), and the park-and-mount flow
kind: reference
---

# Editor context menu — right-click in a doc

**Module:** `editor` · **UI:** right-click in the doc body, or on the header's name field · **Code:**
`src/renderer/modules/editor/EditorContextMenu.tsx` (menu), `useEditorContextMenu.ts` (open flow, selection
snapshot), `useDocActions.ts` (action handlers, agent roster), `CopyToModal.tsx` (folder picker),
`EditorPane.tsx` (wiring), `src/main/index.ts` (spell-context push) · **e2e:** `editor-context-find.spec.ts`,
`app-version-spellcheck.spec.ts`

## What it does

Right-clicking in a doc opens a menu built on the shared `ContextMenu` primitive (clamped to the viewport,
Esc closes). Which variant depends on whether text is selected at the click.

**With a selection** (any view; in the CSV table, a selection inside the cell being edited):

- **Cut**, **Copy**, **Paste**: act on the selection captured at the click (see below); Paste replaces it with
  the clipboard text.
- **Find & replace**: opens find prefilled with the selection's first line ([find-in-document.md](./find-in-document.md)).
- **New agent chat ▸**: a submenu of the agents the project shows (all, or the project's visible set); an agent
  whose command is not found carries a `!` badge ("Command not found — will report in the terminal"); an empty
  roster reads "No agents available". Picking one starts that agent with the instruction `Read <path>` submitted
  and the selection typed in unsubmitted. Toast: "Starting <agent>…".

**Without a selection** (and the header's name field):

- **Duplicate file**: copies the file next to itself as `<name> copy.<ext>` (`copy 2` on a collision) and opens
  the copy in a new tab. Toast "Duplicated to <name>".
- **Copy file to…**: a folder picker titled `Copy “<name>” to…` (lazy tree of workspace folders, starting at
  `<workspace root>`); **Copy here** copies, keeping the name unless it collides, and opens the copy. Toast
  "Copied to <path>".
- **New agent chat with this file in context ▸**: the same submenu, the file only.
- **Copy path**: the doc's path as the tab holds it (workspace-relative; absolute for an outside-workspace
  doc). **Copy full path**: the workspace root joined with that path. Toasts "Copied path" / "Copied full path".

An Untitled doc has no file: Duplicate, Copy to, Copy path, Copy full path and the agent chat answer with the
toast "Save the document first."

**Spelling section.** When the click is on a misspelled word, the menu starts with up to 5 suggestions (a click
replaces the word) and **Add “word” to dictionary**, then a separator; with no suggestions it shows "No
spelling suggestions" above the add item ([spellcheck.md](./spellcheck.md)).

The CSV table's row-number and column-header right-clicks open their own menus
([csv-editing.md](./csv-editing.md)) and stop the event before it reaches this one.

## How it works

**Park and mount.** The body handler does not mount the menu synchronously and does not call
`preventDefault`: Chromium raises its context-menu request (the only carrier of spellcheck data) only if the
DOM event is not cancelled, and a menu scrim already in the DOM would sit under Chromium's hit test and kill
the spelling data. So `onContextMenu` parks the menu state and the menu mounts when main's per-right-click
`EV.spellContext` push arrives (misspelled word plus up to 5 suggestions), with a 200 ms timer as the only
fallback. Every mounted pane hears every right-click; only the pane that parked a menu (or has one open)
reacts. Do not change this order (see [contracts/renderer](../../contracts/renderer.md) "Editor invariants").

**Selection snapshot.** A mousedown collapses the editor selection before `contextmenu` fires (on macOS also a
primary-button Ctrl+click). The capture-phase mousedown on the body wrapper snapshots the selection on every
mousedown; the menu uses the live selection when it is non-empty, else the snapshot. Cut and Paste act on the
captured range through `EditorController.replaceRange`. The same handler commits a preview tab
([preview-tabs.md](../tabs/preview-tabs.md)): a click into the body counts as using the tab.

**Header variant.** Right-clicking the header's name field opens the no-selection variant at once, with
`preventDefault`: nothing there has spelling data to lose, so no spelling section can appear
([editor-header.md](./editor-header.md)).

Tickets: E-001, T-010, T-011, T-043, T-083, T-090.
