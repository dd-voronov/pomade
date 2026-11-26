---
doc: docs/modules/editor/spellcheck.md
audience: engineers, product
holds: OS-native spellcheck in the editor — where it is on, the right-click suggestions, how the data reaches the menu, known Chromium limits
kind: reference
---

# Spellcheck — OS-native squiggles and suggestions in the editor

**Module:** `editor` · **UI:** red squiggles + a spelling section at the top of the editor context menu ·
**Code:** `src/renderer/modules/editor/cm-spellcheck.ts` (content attributes, nudge), `RawEditor.tsx` and
`LiveEditor.tsx` (attribute gate), `EditorContextMenu.tsx` (menu section), `useEditorContextMenu.ts` (open
flow), `src/main/index.ts` (context push) · **e2e:** `app-version-spellcheck.spec.ts`,
`editor-spellcheck-attrs.spec.ts`, `editor-spellcheck-stability.spec.ts`

## What it does

Misspelled words get the platform's native squiggle, and right-clicking one puts a spelling section at the
top of the editor context menu: up to 5 suggestions (click one to replace the word), then **Add “word” to
dictionary**. Replacement is done by Chromium itself with its own undo entry; add-to-dictionary lands in the
macOS personal dictionary. There is no Pomade setting for any of this: it rides the OS spellchecker with zero
configuration. Autocorrect and autocapitalize are explicitly off everywhere.

## Where it's on

- **Raw view:** prose files only: every markdown extension (`.md` `.markdown` `.mkd` `.mdown` `.mdx`), `.txt`,
  and an **Untitled (unsaved) buffer** (markdown by policy). Code files stay squiggle-free (identifiers would
  light up the whole doc).
- **Live view:** always (it is a prose view).
- **Rendered view:** always (the browser's contenteditable default).
- **Off:** Raw code files and Raw CSV (no attributes set), and the fields that set `spellCheck={false}`: the
  Live link popover's URL input, the Properties panel's raw-YAML textarea, and the go-to-path box. Pomade sets
  nothing on other single-line inputs (CSV cells, Properties values), which follow Chromium's default.

## How it works

Main broadcasts Chromium's context-menu spell data (`misspelledWord` + up to 5 `dictionarySuggestions`) to the
renderer on every right-click (`EV.spellContext`); the renderer-built context menu merges the section in when a
word is present. When the word has no suggestions the section shows "No spelling suggestions" plus the
add-to-dictionary item.

**Menu timing.** A right-click inside the editable does not mount the menu synchronously: the menu state is
parked and mounts when the spell data for that click arrives (a 200 ms fallback opens it without a spelling
section). The user-visible effect is a sub-200 ms beat before the menu paints, and the spelling section is
fixed at open time. This is load-bearing: mounting earlier would occlude Chromium's hit test and kill spell data
for every editor right-click ([editor-context-menu.md](./editor-context-menu.md); [contracts/renderer](../../contracts/renderer.md) "Editor invariants").

**CodeMirror surfaces.** Raw (prose files) and Live set `spellcheck="true"` on the content element
(`proseSpellcheckAttrs`), overriding CodeMirror's default of off.

## Boundaries worth knowing

- **Russian works.** Russian squiggles and suggestions ride the same OS chain as English under macOS
  "Automatic by Language".
- The spelling section reflects the word under the **last right-click**; right-clicking elsewhere (or on a clean
  word) shows a plain menu.
- Right-clicking the editor header's name field opens the same menu but never shows a spelling section (there is
  no text under that click; the handler cancels the native request).
- **Loaded text in CodeMirror is checked late.** Chromium does not natively spell-check text that was inserted
  programmatically until the user edits it, and CodeMirror builds its content DOM programmatically, so a freshly
  opened Raw or Live doc may show no squiggles until it is edited (ProseMirror in Rendered is checked on load).
  `nudgeSpellcheck` toggles the `spellcheck` attribute across a frame after mount and on focus as a best-effort
  mitigation; text the user types is checked normally.
- **Squiggles can blink on caret moves.** Moving the caret can make a squiggle on the line just left vanish and
  reappear seconds later. That is Chromium's own idle spell re-check, not the app: probes showed no DOM churn on
  unchanged lines, and `editor-spellcheck-stability.spec.ts` keeps it that way (the mono-pin and the nudge never
  touch line text nodes).
