---
doc: docs/modules/editor/csv-editing.md
audience: engineers, product
holds: the CSV table view — lossless model, cell editing, row and column edits, undo, find, fallbacks, limits
kind: reference
---

# CSV editing — a lossless, editable table view with structural edits

**Module:** `editor` · **UI:** the `Table`/`Raw` mode button on `.csv` docs · **Code:**
`src/renderer/modules/editor/CsvTable.tsx` (grid), `csv-model.ts` (lossless model), `useEditorMode.ts`
(malformed fallback) · **e2e:** `editor-csv.spec.ts`, `editor-csv-structural.spec.ts`,
`editor-context-find.spec.ts`

## What it does

`.csv` files get an editable table view: click a cell to edit, right-click row numbers or
column headers for Excel-like insert/delete, Cmd+Z to undo. The model is **lossless** —
untouched fields keep their exact source bytes (quoting, spacing, blank lines, CRLF, trailing
newline); only the cells you actually edit are re-encoded. A `.csv` opens **raw** by default;
the header mode button (`Raw` ↔ `Table`) switches, and the tab remembers its mode.

## How it works

**Parsing.** The delimiter is detected from the first line — `,` `;` tab `|`, highest count
outside quotes wins (comma on ties) — so tab-separated data named `.csv` still parses. Quoted
fields, escaped `""`, and multi-line cells are supported. The first non-blank record is the
header row and fixes the column count; longer rows fold their overflow into the last column,
shorter rows show empty cells. Blank source lines are skipped in the grid but kept
in the file.

**Cell editing.** Single click on a body cell → input. **Enter** commits, **Tab / Shift+Tab**
commit and move to the next/previous cell (wrapping across rows), **Escape** discards, blur
commits. The **header row is not editable in the table** — change headers in raw mode.

**Structural edits.** Right-click a column header: **Insert column left / Insert
column right / Delete column**. Right-click a row number: **Insert row above / Insert row
below / Delete row**. A 1×1 minimum is enforced (the delete items disable at the last
row/column). Inserted cells are empty; everything else stays byte-identical.

**Undo.** Cmd+Z / Cmd+Shift+Z on the table undo/redo cell **and** structural edits
(text-snapshot stack). While a cell input is focused, the input's own text undo applies
instead. The stack is table-local — a disk reload resets it.

**Dirty & save** work exactly like any doc: edits mark the tab dirty, **Cmd+S** writes (see
[save-and-file-lifecycle.md](./save-and-file-lifecycle.md)). Untouched quoting is preserved byte-for-byte on disk.

**Find.** Cmd+F opens the shared find panel; matches are cells, header cells included (highlighted, stepped
through with Enter/Shift+Enter). Replace is raw-only, and the panel says so
([find-in-document.md](./find-in-document.md)). Serving the table, the panel carries `data-mode="table"`.

**Clipboard and context menu.** While a cell is being edited, right-click offers Cut, Copy, Paste and
Find & replace on the selection inside the cell input ([editor-context-menu.md](./editor-context-menu.md)).
Right-clicking a row number or column header opens the structural menu instead and stops the event.

## Fallbacks & notices

- **Unparseable** (unterminated quote, empty file, no data rows) → raw text with the notice
  "This CSV could not be parsed as a table — showing the raw text instead." (testid
  `csv-malformed`).
- **Any table that parses is editable.** The model captures every field's exact source slice and
  each record's line terminator, so `serialize(parse(text)) === text` holds byte-for-byte for any
  input that scans: the table can always save losslessly and has no read-only state in practice. The
  model's `editable` flag (`serialize(model) === text`) is a guard that is always true for a model that
  scans.

## Boundaries worth knowing

- **Editing a field re-encodes it minimally**: quotes are emitted only when the value needs
  them (contains the delimiter, `"`, or a newline) — an unnecessarily-quoted field you edit
  comes back unquoted. Untouched fields never change.
- `.tsv` has no table view — only `.csv` (its tab-delimited content parses fine when named
  `.csv`).
- No column resize, no drag-reorder, no fill handle, no arrow-key cell navigation — clicks
  and Tab are the navigation model.
- Raw mode for CSV deliberately has no auto-close pairs and no spellcheck — it types
  literally.
- A table has no linear caret, so a Raw ⇄ Table toggle carries no caret or reading position
  ([editing-modes.md](./editing-modes.md)).

Tickets: E-009, T-002, T-034, T-051, T-096.
