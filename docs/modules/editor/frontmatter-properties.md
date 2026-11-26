---
doc: docs/modules/editor/frontmatter-properties.md
audience: engineers, product
holds: the Properties panel — YAML frontmatter as typed rows in the rich markdown views: row types, editing, add/remove/reorder, autocomplete, complex and broken values
kind: reference
---

# Frontmatter & the Properties panel — edit YAML frontmatter as typed rows

**Module:** `editor` · **UI:** the "Properties" header above the Rendered/Live markdown body
(testid `properties-panel`) · **Code:** `src/renderer/modules/editor/PropertiesPanel.tsx`
(rows/UX), `pomade-kit/frontmatter` (`block.ts`, the surgical writeback core), `src/main/fm-index.ts`
(autocomplete index) · **e2e:** `editor-properties.spec.ts`, `editor-frontmatter.spec.ts`

## What it does

In the **Rendered and Live** markdown views (an identical panel in both), a doc's YAML frontmatter appears as a typed row panel above the
body: text, numbers, dates (with a calendar picker), checkboxes, and list chips — each
editable in place, plus add / remove / drag-reorder. Every edit rewrites **only the touched
key's own lines**; the rest of the block — key order, comments, blank lines, quoting style of
other keys — stays byte-identical. Edits go through the normal dirty/save pipeline: the panel
never touches disk by itself; **Cmd+S saves**, the close guard covers unsaved panel edits.

The panel exists only in the rich markdown views. Raw mode shows the YAML as text (that *is* the panel's
escape hatch); CSV and non-markdown files never get it. A file whose body Milkdown cannot parse shows Raw
([editing-modes.md](./editing-modes.md)), so no panel there either. A doc with no frontmatter shows no panel
until **Add properties** is used.

## How it works

**Header & collapse.** Clicking the `▾ Properties · N` header collapses/expands the panel
(`N` = row count). The state is **per project** (persisted as
`ProjectState.propertiesPanelExpanded`, default expanded) and applies live to every open pane
of that project; other projects keep their own state.

**Row types are inferred, not chosen.** The block core's `parseFrontmatter` types each top-level key from
its YAML value: `2026-06-15`-shaped scalars → date, booleans → checkbox, arrays of scalars →
list (the `tags` key gets accent-tinted chips), numbers/strings → text. There is no type
picker — changing a field's type means typing a differently-shaped value (P-019, backlog,
tracks proper field types). YAML niceties apply: `yes`/`no` are text, not checkboxes;
toggling a `True` checkbox rewrites it lowercase.

**Editing.** Click a value → input; **Enter or blur commits, Esc cancels**; an unchanged
commit writes nothing. Dates get an embedded calendar icon (`Pick a date`) opening the native
date picker — picking commits immediately; typing stays free-form with an advisory
`Use YYYY-MM-DD` hint that never blocks. List chips edit on click, delete via a hover `×` or
by committing an empty chip; the add input also deletes the last chip on Backspace-when-empty.

**Add / remove / reorder.** The ghost `+ Add property` row appends a key at the end of the
block; on a file with *no* frontmatter, the editor ⋯ menu gains **"Add properties"** (Rendered or Live only),
which opens the add row (placeholders "property name" and "value", an **Add** button), and the block is
created on the first commit. Each row has a hover `×`
(`Remove <key>`, no confirmation); **removing the last property drops the entire frontmatter
block**. Rows are draggable — drop above/below another row relocates just that key's lines.
There is no key-rename affordance; rename = remove + re-add (which moves the key to the end).

**Autocomplete.** The add-row key input suggests keys used across the workspace's
`.md` files, ranked by frequency (max 8, keys already on the doc excluded); list-value inputs
suggest existing values for that key. Backed by `fs.frontmatterIndex()` — a main-process scan
of every workspace `.md` leading `---` block, cached **per app run** (new keys elsewhere show
up after a relaunch or workspace switch). ↑/↓ navigate, Enter picks, Esc closes.

**Complex values.** A nested map, list of objects, or multi-line block scalar renders as a
read-only monospace YAML snippet with an **`edit in Raw`** button that expands an inline
textarea seeded with the key's exact source lines. **Save** (or Cmd+Enter) validates the YAML
first — invalid input shows an inline error and writes nothing; Esc collapses unchanged.
Valid text is spliced in bytes-as-typed. Complex rows have no `×`, so a complex property can
only be deleted in raw mode.

**Broken frontmatter.** Unparseable YAML (duplicate keys, tab indentation, syntax errors) —
or a top level that isn't a map — degrades the panel to a non-interactive `raw frontmatter`
badge: no rows, no toggle, bytes untouched. Fix it in raw mode. (Better fallback UX is P-016,
backlog.)

## Boundaries worth knowing

- **The byte-identity guarantee has honest exceptions on the edited key itself:** a quoted
  scalar re-emits plain when safe (quotes disappear); any chip edit regenerates all of that
  list's item lines (comments between items are lost); clearing a block list collapses it to
  `key: []`; removing the last property also removes any standalone comments in the block.
- **The calendar picker carries only `YYYY-MM-DD`** — picking a date on a datetime value
  drops the time component. Typing preserves it.
- A key whose name contains a colon (`"a:b": v`) parses as valid YAML but never appears as a
  row (or in the count) — edit it in raw mode.
- No auto-save and no panel shortcut: everything is click-driven, Cmd+S owns the write.
- Frontmatter never forces Raw: the parse-health gate checks the **body** only, and body edits in either
  rich view leave the frontmatter block byte-identical.

Tickets: E-013, E-014, T-013, T-065, E-024.
