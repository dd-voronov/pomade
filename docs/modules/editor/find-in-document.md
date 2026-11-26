---
doc: docs/modules/editor/find-in-document.md
audience: engineers, product
holds: in-document find (Cmd+F) in Raw, Live, Rendered and the CSV table — two panels, routing, what each can do
kind: reference
---

# Find in document — Cmd+F in every view

**Module:** `editor` · **UI:** the search panel at the top of the doc body · **Code:**
`src/renderer/modules/editor/useEditorFind.ts` (state, Cmd+F routing), `EditorFindPanel.tsx` (custom panel),
`pm-search.ts` (Rendered engine), `CsvTable.tsx` (table engine), `cm-search-keys.ts` (CodeMirror keymap),
`RawEditor.tsx` / `LiveEditor.tsx` (`openFind`), `src/main/index.ts` (menu accelerator) · **e2e:**
`editor-context-find.spec.ts`, `editor-find-keys.spec.ts`

## What it does

**Cmd+F** (app menu **Find in Document…**) opens find in the active doc pane. It is a no-op when the active
tab is not a doc (a terminal never receives it) and when the pane is not the active tab of the active
project. The first line of the current selection prefills the query; the editor context menu's
**Find & replace** item (selection variant) does the same. Two panels serve the four views.

## Raw and Live: CodeMirror's search panel

The standard CodeMirror panel, themed to the app, opens at the top of the editor (`search({ top: true })`):
find field, next / previous, all, match case, regexp, by word, **replace** and replace all, close. **Replace
works here.** Enter / Shift+Enter in the field step through matches, Esc closes. The keymap
(`editorSearchKeymap`) is CodeMirror's search keymap **without** its `Mod-g` binding: Cmd+G is unbound and
Cmd+Shift+G is only the quick peek ([diff-view](../git/diff-view.md)); F3 / Shift+F3 still step, Cmd+Alt+G
is go-to-line, Cmd+D selects the next occurrence, Cmd+Shift+L selects all matches.

## Rendered and CSV table: the custom panel

`EditorFindPanel` (testid `find-panel`, `data-mode` = `rendered` or `table`): a query input (placeholder
"Find in document"), a count (`N of M`, "No results" on a miss, empty with an empty query), an **Aa**
toggle (tooltip "Match case"), ↑ / ↓ buttons (disabled with no matches), ✕ (tooltip "Close (Esc)") and
the note **"Replace is available in raw mode."** Enter = next, Shift+Enter = previous, both wrapping
around; Esc closes, clears the highlights and returns focus to the editor. The input is focused and its
text selected on open. All matches are highlighted, the current one distinctly.

- **Rendered** (`pm-search.ts`): a ProseMirror plugin keeps the query and match ranges and paints inline
  decorations. A new query starts at the first match at or after the caret; stepping moves the selection
  to the match and scrolls it into view without taking focus from the input. Search runs per text node, so
  a query spanning a formatting boundary (a bolded letter mid-word) does not match. Edits made while find is
  open recompute the matches.
- **CSV table** (`CsvTable.tsx`): matches are cells, header cells included; the first match is current,
  stepping scrolls the cell into view.
- The panel closes by itself when the pane leaves a view that uses it (a toggle back to Raw, which has its
  own panel).

Tickets: E-001, T-011, T-012, T-043, T-096.
