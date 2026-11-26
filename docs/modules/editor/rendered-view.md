---
doc: docs/modules/editor/rendered-view.md
audience: engineers, product
holds: the Rendered view — the Milkdown WYSIWYG markdown editor: its plugins, how edits reach the buffer, what it does not do
kind: reference
---

# Rendered view — Milkdown WYSIWYG over the markdown body

**Module:** `editor` · **UI:** `DocTab.mode === 'rendered'`, the mode button reading `Rendered` (markdown
only) · **Code:** `src/renderer/modules/editor/RenderedMarkdown.tsx` (component, controller, task-item
node view), `md-config.ts` (shared pipeline + plugins), `md-roundtrip.ts` (headless parse check),
`pm-search.ts` (find), `pm-editor-links.ts` (Cmd+click links), `pm-focus-sync.ts` (caret after focus) ·
**e2e:** `editor.spec.ts`, `editor-render-default.spec.ts`, `editor-roundtrip.spec.ts`,
`editor-checkboxes.spec.ts`, `editor-linebreak.spec.ts`, `editor-nested-lists.spec.ts`,
`editor-list-spacing.spec.ts`, `editor-rendered-startup-typing.spec.ts`

## What it does

A formatted, editable view of the markdown **body**: headings, emphasis, lists, task lists, tables, code,
quotes and links render as such and are edited in place. It is the **Adjust formatting** engine: every
edit serializes the document back to markdown, so an edited doc is rewritten in Pomade's canonical style
on save (the contract, and the parse-health gate that decides whether a file may enter this view, are in
[editing-modes.md](./editing-modes.md)). The frontmatter never reaches this editor: the pane splits it off,
shows it in the Properties panel ([frontmatter-properties.md](./frontmatter-properties.md)), and
re-attaches it byte-verbatim to every change (`handleRenderedChange` in `EditorPane.tsx`).

## Pipeline

Milkdown with the **commonmark** preset (minus `remark-preserve-empty-line`, see
[editing-modes.md](./editing-modes.md)) and **gfm**, plus history and the listener. The serializer
(`configureRemarkStringify` in `md-config.ts`) writes `-` bullets and rules, one-space list indent, and
drops escapes that a re-parse proves unnecessary (`[[wikilink]]` and `snake_case` stay literal). Tight
bullet lists stay tight (`bulletListSpreadFix`, `listJoin`): a list item is written loose only when its source had a
blank line between its blocks, an item created by typing is tight, and two paragraphs in one item keep their blank
line. A line break inside a paragraph is one
`\n` on disk, drawn as a real `<br>` (`softBreakFix`). The headless gate editor and this editor `.use()` the same parts, so they cannot drift.

## How edits reach the buffer

- The listener reports `markdownUpdated` after a 200 ms debounce; the pane sets the buffer and the dirty
  flag from it. `flushPendingEdits()` emits an edit the debounce has not reported yet (and only a real
  one, never a re-serialization of an untouched doc); a save and every buffer read (comparison tab,
  quick peek) call it first, so Cmd+S right after typing saves every keystroke.
- The editor reads its content **once** at mount. A disk reload, a Use-disk-version resolution or an edit
  made in another view remounts it (`key={reloadNonce}`, `remountRich`).
- A Document history restore replaces the document as one undo step, closed on both sides (`replaceDocument`).

## Plugins and behaviors

- **Task items** render a real checkbox (node view, testid `task-checkbox`); a click flips the item and
  changes exactly one character on disk. `[` at the start of an empty list item becomes an unchecked task
  item (input rule).
- **Line breaks:** Enter = new paragraph, Shift+Enter = soft break (`\n`), see
  [markdown-editing.md](./markdown-editing.md).
- **`--` + space / Tab / Enter → em-dash** in prose (`emDashProsePlugin`).
- **`[[wikilinks]]`** are literal text drawn link-styled (decoration only); **Cmd+click** opens links, see
  [editor-links.md](./editor-links.md).
- **Find:** the custom find panel, see [find-in-document.md](./find-in-document.md).
- **Caret after focus:** a key pressed right after the editor takes focus keeps its caret move
  (`pm-focus-sync.ts`). ProseMirror re-asserts its own selection 20 ms after focus; on a busy renderer a
  native caret move (Cmd+ArrowDown, Home, arrows) is read into its state only after that timer, so the
  re-assert would put the caret back and the next characters would land at the stale spot. The plugin
  replaces that timer: if a key was pressed since the focus, the DOM selection is read into the state
  (text selections only, never while composing); otherwise ProseMirror's state is written onto the DOM.
  It steps aside when ProseMirror's internals are not the expected shape.
- **Spellcheck:** the OS squiggles are on ([spellcheck.md](./spellcheck.md)).
- **Keyboard:** Milkdown's commonmark/gfm keymaps apply (Cmd+I italic, Cmd+B bold, Cmd+E inline code,
  Cmd+Alt+0 to 6 paragraph/headings, Cmd+Alt+7/8 lists, Cmd+Alt+C code block, Cmd+Alt+X strikethrough,
  Tab / Shift+Tab to indent or outdent a list item).

## Boundaries worth knowing

- No auto-closing pairs (raw only; `[[` is reserved for a future wikilink suggester).
- Find runs per text node, so a query spanning a formatting boundary does not match.
- A doc whose body Milkdown cannot parse never enters this view by default; an explicit toggle forces it.

Tickets: E-002, E-023, T-016, T-038, T-041, T-053, T-054, T-124, T-152, T-184, T-206.
