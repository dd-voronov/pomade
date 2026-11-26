---
doc: docs/modules/editor/fonts.md
audience: engineers, product
holds: the per-surface font settings — raw editor prose font vs pinned code font, terminal font, the font catalog and the bundled monos
kind: reference
---

# Per-surface fonts — raw editor prose vs. pinned code, bundled monos

**Module:** `editor` (+ `terminal`, `core`) · **UI:** Settings ▸ General ▸ Editor ▸ *Editor font (raw)* and
Settings ▸ General ▸ Terminal ▸ *Terminal font* · **Code:** `src/renderer/font-catalog.ts`,
`src/renderer/modules/editor/cm-mono-pin.ts`, `cm-theme.ts`, `doc-kind.ts`, `RawEditor.tsx`,
`src/renderer/modules/terminal/TerminalPane.tsx`, `src/renderer/assets/fonts/` · **e2e:**
`font-settings.spec.ts`, `editor-spellcheck-stability.spec.ts`

## The model

Every monospace surface draws hyphen `-`, en-dash `–` and em-dash `—` near-identically in SF Mono.
The model is: **pick your font per surface; code-shaped regions always stay mono.** Two app settings, each a font **id** (see `AppSettings.terminalFont` /
`editorRawFont`, default `'sf-mono'` — an untouched install looks exactly as before):

- **Terminal font** — the xterm font for terminals and agent panes. Monospace options only (an
  xterm grid requires a fixed advance width).
- **Editor font (raw)** — the raw editor's PROSE font. Monos plus curated proportional faces.

Options (`font-catalog.ts`): SF Mono (default), PT Mono, Monaco, JetBrains Mono (bundled), IBM Plex Mono
(bundled) for both; the editor list adds System UI (sans-serif), Serif (Georgia) and Sans (Helvetica Neue).
A persisted id that is no longer offered falls back to the standard mono stack.

The Live and Rendered views are unaffected (they already read the proportional `--font-ui`).

## The font catalog (`font-catalog.ts`)

The single source of truth for the id → CSS-stack mapping and the curated option lists.
`TERMINAL_FONTS` (monos only) and `EDITOR_FONTS` (monos + proportional) drive the Settings
dropdowns; `fontStackFor(id)` resolves a stack (unknown id → the standard mono stack);
`isProportionalFont(id)` gates the raw mono-pin. `MONO_STACK` is kept byte-identical to
tokens.css `--font-mono`, so `'sf-mono'` reproduces today's look and code-region pinning (which
uses `var(--font-mono)`) always matches the default.

## Bundled fonts (no system install)

Two open-license monos ship INSIDE the app bundle, chosen for visibly distinct hyphen / en-dash /
em-dash glyphs, no ligature dependency (their `liga`/`calt` are opt-in OpenType features xterm and
CodeMirror never enable), and full Latin + Cyrillic + Greek coverage:

- **JetBrains Mono** — OFL 1.1 (`assets/fonts/JetBrainsMono-OFL.txt`)
- **IBM Plex Mono** — OFL 1.1 (`assets/fonts/IBMPlexMono-OFL.txt`)

WOFF2 (regular + bold) live under `src/renderer/assets/fonts/`; Vite emits them to
`out/renderer/assets/` and electron-builder packs them via `files: out/**` (they load from the
asar, never from a system font dir). `font-catalog.ts` registers them as `FontFace`s on
`document.fonts` and awaits their load at boot (imported in `main.tsx`). `bundledFontsReady` /
`areBundledFontsReady()` expose that readiness so a bundled family is **measured-ready before any
xterm grid measurement** — `TerminalPane` gates xterm creation on it (only ever a boot-window
wait; true by the time the first project, and thus the first terminal, is opened).

## Raw editor: prose font + mono pinning

`RawEditor` holds the theme + mono-pin in a CodeMirror **Compartment**, so changing the setting
**reconfigures live** (no rebuild — cursor, scroll, selection and undo survive):

- `.cm-scroller` uses the selected font for PROSE files (markdown/txt). Code files (js/json/…)
  always keep the standard mono stack — the setting governs prose, not code.
- The **mono-pin** layer (`cm-mono-pin.ts`) runs only for MARKDOWN whose selection is
  PROPORTIONAL (a mono selection needs no pinning). It sets `font-family: var(--font-mono)` on:
  fenced + indented code blocks and tables (`FencedCode`/`CodeBlock`/`Table` → line decorations
  across the whole node so rows align), inline code (`InlineCode` → mark), and YAML frontmatter
  (no parser node — derived from `bodyStartOffset`).
- **GFM parser.** Raw markdown parses with the GFM base (`markdown({ base: markdownLanguage })` in
  `doc-kind.ts`), so `Table` nodes exist for the pin; it is the same base the Live view uses.
- **Stability.** The pin rebuilds decorations only when the document or the parse changed
  (doc-change-keyed, tree-identity-keyed) — never on caret movement — so unchanged lines keep their
  text-node identity and Chromium's spell markers survive (`editor-spellcheck-stability.spec.ts`).

## Live view: tables mono

The Live view is proportional and already pins code AND tables to mono (`.cm-live-table` →
`fontMono`) — a table renders monospace and aligned while surrounding prose stays
proportional. `font-settings.spec.ts` locks this alongside the raw behavior.

## Boundaries worth knowing

- **Family only** — no font-size setting, no dash decoration.
- **Accepted quirk (Live/raw tables):** a table being typed renders in the body font until its
  delimiter row makes the parser recognize the `Table` node, then snaps to mono. Momentary.
- A glyph a bundled face lacks falls back through the stack to the system mono (every bundled
  stack ends in `MONO_STACK`), never to a proportional face.

Tickets: T-153, T-191.
