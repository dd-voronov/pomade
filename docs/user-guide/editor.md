---
doc: docs/user-guide/editor.md
audience: users
holds: how to edit documents in Pomade — opening, the Live, Rendered, Raw and Table views, markdown, CSV tables, the Properties panel, links, find, spellcheck, colors, saving, files that change on disk, recovery of unsaved edits, shortcuts
kind: reference
---

# The editor

A document tab edits one file. Markdown opens in a formatted view that still keeps your text exactly as you
typed it; every other text file opens as plain, highlighted source; CSV can show as a table. Pomade never
saves for you: you press **Cmd+S** (below), and until then your edits are held safely, even through a crash.

## Open a document

- **File tree**: click a file. With *Single click opens a preview tab* on (Settings ▸ General ▸ Tabs) a
  single click opens an italic preview tab that the next click replaces; it stays once you click into it or
  edit it.
- **New document**: the **+** in the tab strip ▸ **New doc**. It starts empty as **Untitled**, behaves as
  markdown, and asks for a name when you save.
- **From a terminal**: Cmd+click a file path in terminal output. A trailing `:12` opens the file at that line.
- **Go to path…**: the box in the file tree accepts a path, including one outside your workspace.
- **From a link in a document**: Cmd+click (see [Links](#links)).

A file over 2 MB, or one that contains binary data, does not open for editing. The tab explains why and offers
**Reveal in Finder**; **Save** stays disabled (its tooltip reads "File is not supported: editing is not
available"), so a refused file is never overwritten.

Each document tab remembers where you were reading. Reopen it, restart Pomade or come back to the tab and it
appears already scrolled to the same place.

## The views

The header button on the right shows the view you are in: **Live**, **Rendered**, **Table** or **Raw**.
Click it to switch between **Raw** and the document's formatted view. Code and plain-text files have only Raw
and no button.

| View | What you get | Best for |
|---|---|---|
| **Live** (markdown default) | headings, bold, lists, quotes and links look formatted; the file changes only where you type | everyday writing and notes you want left untouched |
| **Rendered** (markdown) | a fully formatted editor; saving an edited document rewrites its text in Pomade's standard style (tables re-padded, `_em_` becomes `*em*`, blank lines normalized) | people who prefer a word-processor feel and do not mind reformatting |
| **Raw** (every file) | the plain text with line numbers and syntax colors | code, YAML, anything you want to see character by character |
| **Table** (`.csv`) | an editable grid | spreadsheets of text |

Switching views never edits the file and never marks it unsaved. Your caret stays on the same paragraph and
the part of the page you were reading stays in view.

**Choose the default view.** Settings ▸ General ▸ Editor:

- **Editing markdown**: *Keep formatting* (the default) makes the formatted view **Live**; *Adjust formatting*
  makes it **Rendered**.
- **New markdown opens as**: *Rich* (the formatted view that "Editing markdown" picks — Live or Rendered) or *Raw*.

These apply when a document opens; documents already open keep their view. To change one document, use its
**⋯** menu: **Rich view: Live** / **Rich view: Rendered** switches this document's formatted view, and
**New md opens: Rich/Raw** mirrors the second setting.

If a markdown file cannot be shown as Rendered, it shows as Raw, silently: the button reads **Raw**. Clicking
it still switches to Rendered. The check looks at the text the tab is about to show, so unsaved edits recovered
after a crash count, not only the saved file.

## Write markdown

In **Live** and **Rendered**, markers disappear: you see a heading, not `##`. In Live the hidden markers cannot
be placed inside, so Backspace removes letters, not asterisks; delete the last letter of a bold word and the
bold goes with it.

- **Bold and italic** (Live, Rendered): Cmd+B, Cmd+I. With the caret inside bold or italic text the command
  removes it. In Live, bold and italic use the markers your document already uses (`__x__` if the file uses
  underscores, `**x**` otherwise).
- **Task lists**: type `- ` then `[` to get `- [ ] `. Press Backspace or Escape right away to keep just `- [`.
  Click a checkbox in Live or Rendered to tick it; exactly one character changes in the file.
- **Line breaks** (Rendered): Enter starts a new paragraph, Shift+Enter a soft line break.
- **Em-dash**: typing `--` and then a space, Tab or Enter turns the two hyphens into `—`. Backspace straight
  after restores them. It never happens inside code. Turn it off in Settings ▸ General ▸ Editor:
  **Replace -- with — while typing**.
- **Auto-closing pairs** (Raw): typing `(`, `[`, `{`, `<`, `"`, `'` or a backtick adds the closing half; typing
  the closing half steps over it. With text selected, typing an opener wraps the selection; `*` and `_` wrap
  too (press again to stack `**`). Not in `.csv`.
- **Images** in Live appear as a small chip with the file name; click it to open the image. Obsidian
  `![[embeds]]` show as link-styled text.

Pomade also shows `[[wikilinks]]` as links in every view.

## Properties (YAML frontmatter)

A markdown file that starts with a `---` block shows it as **Properties** above the text (in Live and
Rendered; in Raw you see the YAML). Each key is a row:

- Click a value to edit it; **Enter** or clicking away saves it into the document, **Esc** cancels. Nothing
  reaches the disk until you press Cmd+S.
- Types are recognized by the value: text, numbers, dates (a calendar icon opens a date picker; typing is free,
  with a gentle `Use YYYY-MM-DD` hint), checkboxes for true/false, and chips for lists (`tags` are tinted).
  Click a chip to edit it, hover and click **×** to remove it.
- **+ Add property** adds a row. The key box suggests keys you already use in your other markdown files, and
  list values suggest values you used before. Use ↑ ↓, Enter, Esc.
- **×** on a row removes it; removing the last row removes the whole block. Drag a row to reorder it.
- A nested value shows as YAML with **edit in Raw**: it opens a small editor; **Save** (or Cmd+Enter) checks the
  YAML first and refuses invalid text.
- A file without frontmatter shows no panel; choose **⋯ ▸ Add properties** to create one.
- Click the **▾ Properties · N** header to collapse the panel; the choice is remembered per project.
- If the YAML is broken, the panel shows **raw frontmatter** and leaves it untouched; fix it in Raw.

Only the key you touch is rewritten. Comments, order and spacing elsewhere in the block stay as they were.

## CSV tables

A `.csv` file opens as Raw. Click **Raw** to switch to **Table**.

- Click a cell to edit it. **Enter** saves, **Tab** / **Shift+Tab** saves and moves to the next or previous
  cell, **Esc** cancels. The header row is edited in Raw.
- Right-click a column header: **Insert column left**, **Insert column right**, **Delete column**. Right-click a
  row number: **Insert row above**, **Insert row below**, **Delete row**.
- **Cmd+Z** and **Cmd+Shift+Z** undo and redo cell and row/column edits. **Cmd+F** finds cells.
- Only the cells you edit change in the file; quoting, spacing and line endings elsewhere are kept.
- If the file cannot be read as a table (an open quote, no data rows) it stays in Raw with a note.

## Links

Hold **Cmd** and links under the pointer get an underline; **Cmd+click** opens one. Only links that lead
somewhere are underlined. A plain click just moves the caret.

- File paths (`src/app.ts`, `./notes.md`, `~/Documents/x.md`, with an optional `:20` line), `[[wikilinks]]`
  and markdown links `[text](path)` open the file in a tab. A markdown link's path is read relative to the
  document's folder.
- `http` and `https` links open in your browser.
- If a `[[wikilink]]` name matches several files, a menu lists them ("3 files named “notes”"); pick one.
- In **Live**, a plain click on a link's text opens a **Link URL** box where you can edit the address and press
  **Enter**, or press **Open**. **Esc** closes it.
- A file outside the current project opens with an orange triangle on its tab and header; a file outside your
  workspace with a red one. Hover it for the reason. Folders added to the project scope (**Add to project
  scope**, see the file tree) count as part of the project: no triangle for their files.

## Find

**Cmd+F** (or the right-click item **Find & replace** on selected text) opens find at the top of the document,
prefilled with the first line of your selection.

- **Raw and Live**: the standard search bar with a replace field. **Enter** goes to the next match,
  **Shift+Enter** the previous, **Esc** closes. **F3** also steps.
- **Rendered and Table**: a find bar with **Aa** (match case), **↑** / **↓**, and a count such as `2 of 5`.
  It notes "Replace is available in raw mode." Switch to Raw or Live to replace.

## Spelling

Misspelled words get a red squiggle in Raw (markdown and `.txt` files), Live and Rendered. Right-click the word
for up to five suggestions, then **Add "word" to dictionary**. Spelling comes from macOS, so your system
dictionaries and languages apply. Code files are not checked. A document that has only just opened may
show its squiggles after the first edit.

## Colors

In **Raw**, a small swatch appears before every color code (`#1a2b3c`, `#fff`, `#1a2b3c80`, `rgb(…)`, `hsl(…)`).
Click it to open the picker: drag in the color area, move the hue slider, and the alpha slider when the code has
one. **Apply** (or Enter) rewrites the code in its own style (hex stays hex, case and spacing kept) as one undo
step; **Cancel**, **Esc** or a click outside changes nothing.

## Fonts

Settings ▸ General ▸ Editor ▸ **Editor font (raw)** sets the font of the Raw view's prose, including proportional
choices. Code blocks, inline code, tables and frontmatter stay monospace. **Terminal font** (Terminal group)
sets terminals and agent panes.

## Right-click menu

Right-click in the document. With text selected: **Cut**, **Copy**, **Paste**, **Find & replace**, **New agent
chat**. With nothing selected: **Duplicate file**, **Copy file to…**, **New agent chat with this file in
context**, **Copy path**, **Copy full path**. The agent submenu starts the agent you pick with the file
(and your selection typed in, not sent). Right-click the file name in the header for the second menu.
Misspelled words add suggestions at the top.

## The header

The file name sits on the left; **click it** to show the file's path instead (all headers change together): from the project folder, or
`<folder>/…` for a file in a folder added to the project scope; the full `~` path for a file outside the project.
Next to it: a dot while there are unsaved changes, a triangle when the file lives outside this project or the
workspace, a badge with the file type (`Markdown`, `CSV`, `TypeScript`, …) and a chain link for a symbolic link.
On the right: the view button, **History**, **Save**, **⋯**, **×**.

**⋯ Document actions**: **Close saved docs** (closes only tabs without unsaved changes), **Close all docs**,
**New md opens: …**, **Rich view: …**, **Add properties**.

## Save

- **Cmd+S** or the **Save** button writes the file. The button reads **Saved** and is disabled when nothing
  needs saving.
- A new **Untitled** document opens **Save new document**: type a name such as `notes.md` (relative to the
  project), press Enter. If the name exists Pomade asks **File already exists** with **Overwrite** or
  **Cancel**. The extension decides the document's kind: `.md` stays markdown, `.csv` gains the table, `.txt` is
  plain text.
- Line endings and a final newline are kept as they were.
- Save a file outside your workspace for the first time in a tab and Pomade asks **Save outside your
  workspace?** (**Save anyway** or **Cancel**).
- A failed save shows `Could not save <name>: …` and the document stays unsaved.

**Closing** a document with unsaved changes asks **Unsaved changes**: **Save**, **Discard** or **Cancel**
(Cancel also stops a close-all). Quitting with unsaved documents asks **Unsaved documents**: **Save all docs**,
**Discard all changes** or **Cancel**; a document that needs an answer (a new Untitled one, a file changed on
disk) is named and the quit stops.

## When the file changes on disk

Another program, an agent or git may change a file you have open. Pomade never overwrites either version
silently and never reloads on its own.

- **No unsaved edits**: a note **This file changed on disk outside Pomade.** with **Reload** and **Dismiss**.
- **With unsaved edits**: an amber banner **File changed since your edits.** with **Compare**. Compare opens a
  tab with the disk version on the left and your version, still editable, on the right. Copy over what you
  want, then:
  - **Keep mine**: your text stays; the next Save writes it over the disk version.
  - **Use disk version**: your text is replaced by the file; your edits are kept as a discarded draft.
- **File deleted or moved**: **This file no longer exists on disk (moved or deleted). Saving will recreate it.**
- **Saving over a changed file** asks **File changed on disk** with **Cancel**, **Reload instead** (drops your
  edits, no write) or **Overwrite**.

Edits made inside Pomade (saving, renaming, moving a file) never trigger these.

## Recovery of unsaved edits

Unsaved edits are copied aside about two seconds after you stop typing, outside your project and git. If
Pomade crashes, is force-quit or restarts, the tab reopens with your edits in place, unsaved, under
**Recovered unsaved edits from 14:32.**:

- **Compare**: see the saved file next to your edits.
- **Discard**: go back to the saved file; your edits are kept as a discarded draft.
- **Dismiss**: hide the note and keep working.

An Untitled document comes back too. If the file changed on disk meanwhile, you get the amber banner instead.

**Discarded drafts** (from a close, a quit, a Discard, **Use disk version**, or discarding changes in the Git panel)
are kept for 7 days. Find them in the document's **Document history** panel, where you can compare and restore them.

## Document history

**History** in the header (**Cmd+Shift+H**) opens Document history. It lists earlier versions of the document: unsaved edits, discarded
drafts, versions Pomade kept, commits. Open one in its own tab, compare, restore. See
[Document history](./git.md#document-history). **Cmd+Shift+G** shows a quick peek of what changed since the
last save or commit.

## Shortcuts

| Keys | Does |
|---|---|
| Cmd+S | save the document |
| Cmd+F | find in the document |
| Cmd+Shift+H | open or close Document history |
| Cmd+Shift+G | quick peek of what changed |
| Cmd+click | open the link under the pointer |
| Cmd+B, Cmd+I | bold, italic (Live, Rendered) |
| Cmd+Z, Cmd+Shift+Z | undo, redo (a CSV table has its own stack) |
| Enter, Shift+Enter | new paragraph, soft line break (Rendered); next, previous match (find) |
| Tab, Shift+Tab | indent, outdent (Raw, lists); next, previous cell (CSV) |
| Esc | cancel a cell edit, a field, a popover or the find bar; close a menu |
| Cmd+W | close the tab (asks if it has unsaved changes) |
| Cmd+Shift+T | reopen the last closed tab |
| Cmd+Alt+1 … 6, 0 | heading levels, paragraph (Rendered) |
| Cmd+Alt+7, 8 | numbered list, bullet list (Rendered) |
| Cmd+E | inline code (Rendered) |
| Cmd+Alt+C | code block (Rendered) |
| Cmd+Alt+X | strikethrough (Rendered) |

In Raw, Cmd+B is not an editor command: it collapses the Projects panel, as everywhere else.

## If something looks wrong

- *The button says Raw on a markdown file.* The text could not be shown as Rendered, or the default is Raw.
  Click the button to switch.
- *No squiggles in a freshly opened file.* They appear once you edit.
- *A swatch or picker is missing.* They exist only in Raw.
- *Cmd+click does nothing.* The pointer must be over a link that leads to an existing file or a URL; a missing
  file is never underlined.
- *Find in Rendered misses a word.* Rendered finds within formatting runs only; a match across bold and plain
  text is missed. Use Raw or Live.
