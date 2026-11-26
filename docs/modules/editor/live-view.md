---
doc: docs/modules/editor/live-view.md
audience: engineers, product
holds: the Live view — byte-true rendered markdown editing over CodeMirror: the contract, construct coverage, wiring, boundaries
kind: reference
---

# Live view — byte-true rendered editing over CodeMirror

**Module:** `editor` · **UI:** `DocTab.mode === 'live'`, the mode button reading `Live` ·
**Code:** `src/renderer/modules/editor/cm-live.ts` (engine), `LiveEditor.tsx` (component +
link popover), `cm-live-theme.ts` (token theme), `cm-editor-links.ts` (Cmd+click), `open-mode.ts`
(open-mode rule) · **e2e:** `editor-live-inline.spec.ts`, `editor-live-blocks.spec.ts`,
`editor-live-links.spec.ts`, `editor-live-wiring.spec.ts`, `editor-live-editing.spec.ts`

## What it does

A third markdown view that reads like Rendered but **is** the raw source: CodeMirror 6 over
the body with a decoration layer driven by the markdown syntax tree. There is **no
serializer anywhere on this path**, so byte fidelity holds by construction — in Live mode
only the user's typed bytes ever change the file. Every file is "supported": unknown syntax
renders as plain text, never an error. This is the **Keep formatting** engine; Milkdown
Rendered ([rendered-view.md](./rendered-view.md)) is the **Adjust formatting** engine with its
canonicalizing contract.

## The contract

- **Zero-reveal.** Hidden markup never reveals itself, whatever the caret does — no
  Obsidian-style marker flash, no layout shift.
- **Atomic markers.** The caret can never land inside a hidden marker pair: hidden runs are
  atomic ranges for cursor motion, and a transaction filter snaps click-placed carets to the
  nearest edge. Formatting is edited via commands (Cmd+B/I, checkbox click, the link
  popover), never by touching markers.
- **Typing raw syntax works.** `**x**` folds the moment the pair closes in the parse;
  unclosed markers are ordinary visible text.
- **Backspace deletes letters, not markers.** Deleting "through" a hidden marker deletes
  the letter beyond it; deleting the **last** character between a pair removes the
  now-empty pair with it, recursively for nested constructs — the buffer never holds an
  orphaned `**`/`****`/`[](url)`. Plain deletes fall through to the defaults
  (`deleteMarkupBackward` un-quotes/un-lists level-by-level).
- **Delete-as-a-unit applies only to atomic objects:** the horizontal-rule widget, the
  image chip, the checkbox widget, and a link's URL half.
- **Style-matched insertion.** Cmd+B/I write the document's detected marker flavor
  (`_`-flavored doc → `__…__`/`_…_`; Pomade's `**`/`*` only with no signal), wrapping the
  selection or the word at the caret; inside an existing construct they toggle it OFF.
  Enter continues a list by copying the current marker — style-matched by construction.

## Construct coverage

Rendered with hidden, atomic markers: headings by level (`#` runs hidden, Setext underlines
dimmed), bold / italic / strikethrough / `==highlight==` (custom lezer inline extension) /
inline code, bullet lists (• widget over the marker char; hanging indent), ordered lists
(real, tinted marker text), task checkboxes (one clickable widget over `- [ ]`; a click
writes the one-char diff and refocuses the editor), blockquotes and callouts (`> ` hidden,
styled border; `[!note]` stays visible text), fenced code (nested-language highlighting via
a local `LanguageDescription` list; fence lines dimmed), horizontal rules (widget), images
(atomic `🖼 filename` chip; click opens http(s) externally or the local file's own tab),
regular links (text shown link-styled and edited letter-by-letter; `[` + `](url)` hidden;
a plain click opens the URL popover with edit + Open — never inline-revealed; Cmd+click
opens the destination directly, a file path resolved against the doc's folder),
`[[wikilinks]]` (link-styled literal text; Cmd+click opens, as in the other views; see
[editor-links.md](./editor-links.md)).

**Styled source, not widgets:** tables (monospace lines, editable as text, never
re-padded), footnotes, math, inline/block HTML. Frontmatter is split off before the editor
sees it, edited via the shared PropertiesPanel, and re-attached byte-verbatim on save.

Soft/hard breaks are inherent (source lines render 1:1), which also gives tight/loose list
parity for free.

## Wiring

- The rich view a fresh markdown open gets = the **"Editing markdown"** setting (Settings ▸
  General ▸ Editor): *Keep formatting* → Live (default), *Adjust formatting* → Milkdown Rendered.
  `open-mode.ts` is the one place composing it with "New markdown opens as"; every opener
  calls it. Setting changes never re-render open docs ([editing-modes.md](./editing-modes.md)).
- The mode button stays two-state and names the CURRENT view; leaving a rich view persists
  it as `DocTab.richView`, so the return leg — and a relaunch — comes back to the same view.
- The ⋯ menu's **"Rich view: Live/Rendered"** switches this one doc between engines in
  place (caret and viewport carried over the anchor bridge).
- The editor stack is CodeMirror's history, draw-selection, line wrapping, the themed search
  panel at the top (find and replace, [find-in-document.md](./find-in-document.md)), the
  checkbox completion (`- [` → `- [ ] `, cancellable), the em-dash replacement, the shared
  Cmd+click link layer, the markdown keymap (Enter continues a list or quote, Backspace
  un-lists level by level), Cmd+B / Cmd+I and Cmd+S. There are no line numbers, no fold gutter,
  no auto-close pairs and no color swatches; those are Raw features.
- `:line` jumps land via the caret-anchor bridge (like Rendered); the OS spellchecker is on
  ([spellcheck.md](./spellcheck.md)); the whole body scrolls in the pane's outer container,
  shared with the Properties panel above it.
- **Link popover.** A plain click on a link's text opens a small dialog ("Link URL") at the click: one
  input (placeholder `https://…`) and an **Open** button. Enter applies the edited URL as one isolated
  undo step, **Open** applies and opens the target (http(s) in the default browser, a local path as
  its own doc tab, resolved against the doc's folder), Escape or a click outside cancels. The URL is
  never edited inline in the buffer.
- **Checkbox widget.** A task's `- [ ]` is one checkbox (aria-label "Mark task complete" / "Mark task
  incomplete", testid `live-task-checkbox`); a click writes the one state character and refocuses the
  editor so Cmd+S keeps working.

## Exception to "only your typed bytes change the file"

The core contract is that the file is the document: no serializer runs, so only the user's typed
bytes change the buffer. There is **one deliberate exception**, the em-dash auto-replacement. When
the setting **"Replace -- with — while typing"** (Settings ▸ General ▸ Editor,
`AppSettings.emDashReplace`, default on) is on, typing `--` then a boundary (space / Tab / Enter) writes
an em-dash `—` the user did not literally type. It is admissible because it is a byte-for-byte
predictable transform of the user's OWN keystrokes (never a rewrite of untouched text), it is gated
behind an explicit setting, and it is reversible (Backspace as the very next key restores the literal
`-- `). Prose only, never inside a code fence or inline code. Code lives in `cm-emdash.ts`
([markdown-editing.md](./markdown-editing.md)); the setting is `emDashReplace` in [contracts/types](../../contracts/types.md) "App settings".

## Boundaries worth knowing

- No marker reveal of any kind, no table/callout/HTML widgets, no image embeds, no "Format
  document" command; per-object widgets (tables first) are the planned next step.
- Toggling views without editing never dirties the doc; an unedited save writes
  byte-identical content.
- Obsidian-style `![[embeds]]` are not `Image` nodes: they render as wikilink-styled text.
- The hanging list indent is `ch`-approximate (proportional font); wrapped lines align
  under the text, not pixel-exactly under the first character.

Tickets: E-024, T-126, T-152, T-184, T-198. Design: P-024 (§4 contract, §5 coverage, §6 widget ladder).
