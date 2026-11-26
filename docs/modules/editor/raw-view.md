---
doc: docs/modules/editor/raw-view.md
audience: engineers, product
holds: the Raw view — the CodeMirror source editor every text doc has: what it provides, languages, which features run on which files
kind: reference
---

# Raw view — the CodeMirror source editor

**Module:** `editor` · **UI:** `DocTab.mode === 'raw'`, the mode button reading `Raw`, or no mode button
at all for code and plain text · **Code:** `src/renderer/modules/editor/RawEditor.tsx` (component +
controller), `cm-theme.ts` (theme, wikilink highlighter), `doc-kind.ts` (language by extension),
`cm-search-keys.ts` · **e2e:** `editor.spec.ts`, `editor-roundtrip.spec.ts`,
`editor-paired-elements.spec.ts`, `editor-color-swatch.spec.ts`, `editor-links.spec.ts`,
`editor-context-find.spec.ts`

## What it does

The Raw view edits the file's text exactly as stored. It is the only view of every non-markdown,
non-CSV file, the escape hatch for markdown and CSV (YAML frontmatter is plain text here), and the view a
doc falls back to when its rich view cannot show it. The editor is controlled by the doc buffer: edits
flow up through `onChange`, and an external change to the buffer (a reload, a comparison-tab edit, a
Document history restore) is reconciled as a minimal text change so the caret and undo stack survive.

## What the editor provides

Line numbers, a fold gutter, active-line highlight, bracket matching, special-character highlighting,
soft line wrapping, rectangular selection, `indentOnInput`, undo/redo history, and the CodeMirror default,
history and fold keymaps plus `Tab` / `Shift+Tab` indent (`indentWithTab`). The theme (`cm-theme.ts`) is
built from the app's design tokens; the search panel is restyled to match. `[[wikilink]]` runs read as
links in every file. Cmd+S saves ([save-and-file-lifecycle.md](./save-and-file-lifecycle.md)).

**Language by extension** (`languageExtension` in `doc-kind.ts`, label in the header badge): markdown
(GFM base) for the markdown extensions and for an Untitled doc, JSON, JavaScript (`js` `cjs` `mjs`), JSX,
TypeScript, TSX, CSS, HTML (`html` `htm`, with tag auto-closing), YAML (`yaml` `yml`). Every other
extension is plain text with no highlighting; its badge is the uppercased extension (`Plain text` when
there is none).

## Which features run on which files

| Feature | Runs on | Doc |
|---|---|---|
| Auto-close pairs and selection wrapping | every text file except `.csv` (`<>` not in `.html`/`.htm`) | [markdown-editing.md](./markdown-editing.md) |
| `- [` → task checkbox (cancellable) | every file | [markdown-editing.md](./markdown-editing.md) |
| `--` → em-dash | markdown (frontmatter excluded) | [markdown-editing.md](./markdown-editing.md) |
| Color swatches + picker | every file | [color-swatches.md](./color-swatches.md) |
| Cmd+click links | every file | [editor-links.md](./editor-links.md) |
| OS spellcheck | markdown, `.txt`, Untitled | [spellcheck.md](./spellcheck.md) |
| Prose font + mono pinning | `.txt` takes the prose font; markdown also pins code | [fonts.md](./fonts.md) |
| Find with replace | every file | [find-in-document.md](./find-in-document.md) |
| Right-click menu | every file | [editor-context-menu.md](./editor-context-menu.md) |

CSV in Raw types literally: no pairs, no spellcheck (the table view is the CSV tool). The Live and
Rendered views have no line numbers or fold gutter.

## Controller

`RawEditor` registers an `EditorController` (`editor-controller.ts`, `kind: 'raw'`) with the pane:
selection read, `replaceRange` (context-menu Cut/Paste), `replaceDocument` (Document history restore as one undo
step), `gotoLine` (terminal `path:line` links; clamped, centered, re-issued after layout), caret and
viewport anchors for the toggle bridge, `openFind` / `closeFind`, `focus`. Position at open follows
[editing-modes.md](./editing-modes.md) (reading position).

Tickets: E-001, T-012, T-077, T-086, T-153, T-184.
