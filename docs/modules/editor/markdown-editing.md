---
doc: docs/modules/editor/markdown-editing.md
audience: engineers, product
holds: markdown typing conveniences — paired elements, task checkboxes, line breaks, em-dash replacement, Cmd+B/I, caret right after focus
kind: reference
---

# Markdown editing niceties — paired elements, checkboxes, line breaks, em-dash

**Module:** `editor` · **Code:** `src/renderer/modules/editor/cm-pairs.ts`, `cm-checkbox.ts`,
`cm-emdash.ts`, `cm-live.ts` (Cmd+B/I), `md-config.ts` (Rendered counterparts), `pm-focus-sync.ts` ·
**e2e:** `editor-paired-elements.spec.ts`, `editor-checkboxes.spec.ts`,
`editor-checkbox-autocomplete.spec.ts`, `editor-linebreak.spec.ts`, `editor-emdash-replace.spec.ts`,
`editor-rendered-startup-typing.spec.ts`, `editor-live-editing.spec.ts`

## What it does

Small typing conveniences that make markdown feel native: brackets and quotes auto-close and
wrap selections (raw mode), `- [` completes to a task checkbox (both modes, cancellable),
checkboxes toggle with a click and change exactly one character on disk, Shift+Enter makes a soft
line break, and `--` + a boundary becomes an em-dash while typing. Find is in
[find-in-document.md](./find-in-document.md).

## Paired elements (raw mode only)

Auto-close pairs: `()` `[]` `{}` `<>` `""` `''` `` ` ``. Typing the opener inserts the closer;
typing the closer where one was auto-inserted types over it; Backspace between the halves
deletes both. Two guards keep prose sane: a closer is only inserted in front of whitespace,
end-of-line, or `)]}:;>` (so `(` directly before a word stays bare), and quotes never pair
right after a word character (`don't` stays `don't`).

**Selection wrapping:** a non-empty selection plus either half of any pair wraps it. `*` and
`_` are wrap-only — they never auto-close (emphasis stays typable) but wrap selections, and
because the selection stays on the inner text the marks stack: `*` `*` `_` → `**_text_**`.
Multi-line selections wrap as a whole. Every auto-close or wrap is one undo step.

Boundaries: rendered (Milkdown) mode has **no** pairing at all (deliberate — a future
wikilink-suggestion feature owns `[[` there). In `.html`/`.htm`
files `<>` is excluded because the built-in tag completion owns `>` (`<p>` → `<p></p>`); all
other pairs still work there. `.csv` files type literally — no pairs, table or raw fallback.

## Checkboxes

**Autocomplete (all modes).** On a line holding just a list marker (`- ` or `* `, any
indent), typing `[` completes to `- [ ] ` with the caret after it. In raw AND live mode the
completion is **cancellable**: Backspace or Escape as the very next keystroke reverts to the
literal `- [`; anything else commits it. Completion and revert are each one undo step. With a
selection active, `[` wraps instead (raw only — wrapping wins). Rendered mode has the
equivalent as an input rule: `[` at the start of an empty list item turns it into an
unchecked task item.

**Toggling (rendered AND live mode).** Task items render real checkboxes (`- [ ]` unchecked,
`- [x]` checked). Clicking one toggles it without moving your caret; the file diff is exactly
one character (`[ ]` ↔ `[x]`) — everything else stays byte-identical (in live mode by
construction: the widget dispatches the one-char change itself). Raw mode has no clickable
checkboxes; edit the brackets as text.

## Bold and italic (Live and Rendered)

**Cmd+B / Cmd+I** in the live view wrap the selection (or the word at the caret) with
markers matching the **document's detected convention** — a `_`-flavored doc gets
`__…__`/`_…_`, Pomade's `**`/`*` only when the doc carries no signal; with the caret inside
an existing bold/italic construct the command **toggles it off** (deletes the marker pair —
the sanctioned way to edit markers, which are hidden and atomic there). Backspace semantics
and the rest of the live editing contract: [live-view.md](./live-view.md). In Rendered, Milkdown's own
keymap toggles the marks (Cmd+B, Cmd+I; the serializer writes `**` / `*`). Raw binds neither: Cmd+B there is
the app-wide Toggle Projects Panel, and you type or wrap the marks yourself (`*` / `_` wrap a selection).

## Em-dash auto-replacement (Raw, Live, Rendered)

Typing `--` immediately followed by a **boundary** — space, Tab, or Enter — replaces the `--`
with an em-dash `—` (U+2014), the boundary kept (`-- ` → `— `). App-level toggle Settings ▸
General ▸ Editor **"Replace -- with — while typing"** (`AppSettings.emDashReplace`, default on,
`setting-em-dash-replace`),
read live so flipping it takes effect in open docs at once. Markdown docs only; **prose contexts
only** — never inside a fenced/indented code block, inline code, or (raw) YAML frontmatter, so
`--flag` in a code fence survives. `.csv` is excluded entirely.

- **Space and Tab are fully owned:** one isolated transaction replaces `--` and inserts the
  boundary, and Backspace as the very next keystroke restores the literal `-- `/`--\t` (the same
  pending-state revert as the cancellable checkbox). Cmd+Z reverts the whole conversion (em-dash
  and its boundary) in one step.
- **Enter is seed-then-native:** the handler seeds the `--`→`—` replacement as its own step, then
  the editor's real Enter (newline / list continuation) runs — so lists keep continuing and a
  Cmd+Z peels the newline first, then the conversion.
- **Where it lives:** `cm-emdash.ts` is the shared CodeMirror extension (raw + live); the
  ProseMirror `emDashProsePlugin` in `md-config.ts` is the rendered engine's mirror. In CM it
  slots into the input-handler ladder at `Prec.highest` but ORTHOGONALLY — its triggers
  (space/Tab/Enter) never collide with checkbox (`[`), wrap, or closeBrackets, and `Prec.highest`
  only ensures it beats `indentWithTab` (Tab) and the list-continuation Enter for the one
  keystroke that follows a `--`. Code/frontmatter detection uses the markdown `syntaxTree`
  (CM) / `parent.type.spec.code` + the inline `code` mark (PM). The live-view em-dash is a
  documented exception to Live's typed-bytes-only contract, see [live-view.md](./live-view.md).

## Caret right after the editor gains focus (Rendered)

A caret move made with the keyboard right after the rendered editor takes focus (Cmd+Down to the
document end, Home, the arrows) sticks, and what is typed next lands at the new caret.
ProseMirror re-asserts its own selection onto the page 20 ms after focus; on a busy window that
re-assert could run after the key press and before ProseMirror had read the new caret, putting the
caret back where it was. `pm-focus-sync.ts` takes over that one timer: when a key was pressed since
the focus, the page's caret is read into the editor instead of being overwritten (ProseMirror's own
behaviour is kept when no key was pressed). Specs that type into a rendered doc wait for the typed
text to show in the editor — the dirty dot follows the 200 ms save debounce and says nothing about
the keystrokes.

## Line breaks (Rendered)

- **Enter** = new paragraph (`\n\n` on disk) — also splits list items normally.
- **Shift+Enter** = soft break inside the paragraph, saved as exactly one `\n` (never
  two-space or backslash hard breaks). Existing single-`\n` breaks render as real line breaks.

Tickets: T-016, T-038, T-050, T-053, T-077, T-152, T-206, E-024. Design: P-022 (pairs), P-024 (Live contract).
