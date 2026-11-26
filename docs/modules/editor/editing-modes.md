---
doc: docs/modules/editor/editing-modes.md
audience: engineers, product
holds: the Raw / Live / Rendered / Table views of a doc — the mode button, the open-mode rule, the Rendered parse-health gate, caret and reading-position preservation across toggles
kind: reference
---

# Raw, live & rendered editing modes — the toggle, the open-mode rule, the parse-health gate, caret preservation

**Module:** `editor` · **UI:** the mode button in the editor header (testid `mode-toggle`) ·
**Code:** `src/renderer/modules/editor/EditorPane.tsx` (orchestration), `useEditorMode.ts`
(toggle, gate, labels), `open-mode.ts` (open-mode rule), `md-roundtrip.ts` (parse-health gate),
`md-config.ts` (shared Milkdown pipeline), `doc-kind.ts` (`isMarkdownPath`, `richKindFor`),
`caret-anchor.ts` (caret bridge + reading-position anchors), `initial-view.ts` (first-paint
position), `useEditorController.ts` (controller registration, restore after a toggle),
`stores/viewport-capture.ts` (capture registry), `RawEditor.tsx` / `LiveEditor.tsx` /
`RenderedMarkdown.tsx` · **e2e:** `editor-mode-control.spec.ts`, `editor-roundtrip.spec.ts`,
`editor-toggle-guard.spec.ts`, `editor-render-default.spec.ts`, `editor-toggle-caret.spec.ts`,
`editor-toggle-viewport.spec.ts`, `editor-live-wiring.spec.ts`, `editor-untitled-markdown.spec.ts`,
`editor-viewport-position.spec.ts`

## What it does

Markdown edits in three views: **Live** (byte-true CodeMirror decoration layer, see
[live-view.md](./live-view.md)), **Rendered** (Milkdown WYSIWYG, canonicalizing, see
[rendered-view.md](./rendered-view.md)) or **Raw** (CodeMirror source, see [raw-view.md](./raw-view.md)).
CSV edits in **Table** or Raw ([csv-editing.md](./csv-editing.md)). One header button switches Raw ⇄
the doc's RICH view; its label shows the **current** view (`Live`, `Rendered`, `Table` or `Raw`), not the
click target. Files without a rich view (code, plain text) get no button.

**Which rich view a markdown doc gets.** The app setting **"Editing markdown"** (Settings ▸ General ▸
Editor) — *Keep formatting* (default) → Live, *Adjust formatting* → Rendered — picks the rich view for
fresh opens and for toggles the doc has no override for. The ⋯ menu's **"Rich view: Live"** /
**"Rich view: Rendered"** line (label = the current rich view) overrides it per doc and is persisted as
`DocTab.richView`; in a rich view it switches engines in place, in Raw it only changes the toggle's
target. Leaving a rich view records it, so the toggle's return leg — and a relaunch — comes back to the
SAME view. Changing the setting never re-renders open docs.

Three properties hold across everything: every parseable markdown opens in its rich view by default
(the **"New markdown opens as"** setting is the only switch that changes that); the two rich engines
keep opposite, explicit fidelity contracts — **Live changes only the bytes you type**, **Rendered
canonicalizes the whole body of an edited doc on save**; and **your caret and reading position survive
every toggle**.

## Open-mode rule

`initialDocMode(path)` in `open-mode.ts` is the single rule every opener calls (file tree, terminal
links, symlink popover, go-to-path, New doc, Document history's version tab), through `openDocByPath` in
`stores/tabs-store.ts`:

- a non-markdown path opens **raw** (a CSV's Table view is a per-tab choice, never an open default);
- a markdown path (`.md` `.markdown` `.mdown` `.mkd` `.mdx`, per `MARKDOWN_EXTS`) opens in the rich view
  the "Editing markdown" setting selects (Live under Keep), or **raw** when "New markdown opens as" is Raw.

The settings are read at open time only; restored tabs keep their persisted mode.

- **"New markdown opens as"** (Settings ▸ General ▸ Editor, testid `setting-md-default-mode`; mirrored in
  the editor ⋯ menu as the checkable item **"New md opens: Rich/Raw"**): `Rich` (default; stored as
  `markdownDefaultMode: 'rendered'`) or `Raw`. Under `Raw`, a markdown pane whose tab is in a rich mode is coerced to raw **once, when the
  pane mounts** (`useEditorMode.ts`, after load and settings hydration), restored tabs included. The
  setting never upgrades a raw tab to rich.
- **"Editing markdown"** (testid `setting-md-formatting`): `Keep formatting` / `Adjust formatting`.
- **An Untitled (unsaved) doc is markdown by policy.** A new doc has no filename (`path === ''`);
  `isMarkdownPath('')` returns `true`, so it has the rich view switch, the ⋯ "Rich view" line, prose
  spellcheck in Raw, markdown syntax and the em-dash / mono-pin features from creation, and
  `initialDocMode('')` applies the same two settings as any markdown path. The first Save resolves the
  real extension: a markdown extension keeps everything; any other reclassifies the tab to that kind
  (see [save-and-file-lifecycle.md](./save-and-file-lifecycle.md)).
- A tab's `mode` (`raw` / `live` / `rendered`), its `richView` and its `viewport` persist in the project
  state and survive relaunch.

## The parse-health gate (Rendered only)

The gate applies only when the rich view is **Rendered**. Live needs none: a text editor cannot fail to
display text, so `mode: 'live'` mounts directly and unknown syntax shows as plain text.

Before Milkdown owns a file, Pomade runs the **body** (frontmatter split off and kept verbatim) through a
headless copy of the exact live pipeline (`md-roundtrip.ts` `parsesCleanly`, built from `md-config.ts`) and
checks only that it **parses** (`parse(body) != null`). The text checked is the one the pane is about to
render: the buffer, a recovered unsaved draft ([unsaved-recovery.md](./unsaved-recovery.md)) included, never
the disk copy. The gate runs when a tab opens in Rendered; an explicit toggle skips it (below). Parseable → Rendered. Unparseable, or the parser
throws → the file shows **Raw, silently**; the mode button reading `Raw` is the only signal. No serialize,
no byte compare. Frontmatter alone never forces Raw. A file that canonicalizes on save (cosmetic) still
opens Rendered.

**Canonicalization on save.** Editing a doc in Rendered re-serializes the **whole body** on save: tables
are re-padded, blank lines normalized, `_em_` → `*em*`, a paragraph immediately followed by a list gains a
blank line (including an Obsidian callout wrapping a list), 4-space nested lists become 2-space
(`listItemIndent: 'one'`), trailing line-end whitespace is dropped, bullets and rules use `-`.
**Frontmatter is always re-attached byte-verbatim**; only the body canonicalizes. A doc opened and toggled
without edits stays byte-identical and never dirties.

**Inline `<br>` and empty docs.** The shared pipeline (`commonmarkNoEmptyLine` in `md-config.ts`, used by
the live Milkdown editor and the headless gate alike) removes milkdown's `remarkPreserveEmptyLinePlugin`:
`<br>` round-trips byte-exact through `htmlSchema`, and an empty paragraph serializes to nothing, so an
emptied doc saves as empty.

**An explicit toggle always wins.** Clicking `Raw` → Rendered enters Rendered immediately, bypassing the
gate (`forceRendered`, per-pane state, not persisted; after a relaunch a gate-failed tab shows Raw again
and one click restores Rendered). The ⋯ "Rich view" switch into Rendered bypasses it the same way.

## Caret preservation across toggles

At toggle time the pane snapshots, synchronously off the **outgoing** engine, a `CaretAnchor` for the
caret and a second anchor for the **viewport top**. The successor engine restores the caret as the
**selection only** (no scroll to it) and scrolls the kept viewport to the top: the reading position stays
put, and a caret left far from the visible area stays where it was.

A `CaretAnchor` is the caret's **block as plain text** (whitespace-stripped, lowercased), the caret's
**offset** inside that plain text, and a proportional **fraction** of the body as last resort. The
successor matches the block tiered — exact key → containment → shared prefix/suffix (≥ 8 chars) → the
fraction fallback snapped to a block start — so an unmatched caret lands nearby, never at the top. All
three engines speak the same anchor language (computed on the body, so the frontmatter offset never
matters), so every leg of Raw ⇄ Live ⇄ Rendered, including the ⋯ menu's engine switch, carries both.

The offset survives inline markup (`**bold**`, `[[wikilinks]]`, `` `code` ``) because the raw side maps
through the markdown AST's text runs; soft breaks count as one character on both sides. A caret inside
frontmatter (invisible to the rich views) uses the fraction fallback. CSV toggles carry neither (a table
has no linear position).

Diagnostics: a bounded ring of toggle events lives at `window.__pomadeCaretTrace` (devtools console).

## Reading position — a doc reopens where you left it

Separate from the caret, a doc persists its **first visible line** (the viewport top) so it reopens where
you were reading, not where the cursor sits. It is a **tab** property (`DocTab.viewport`, a
`CaretAnchor`-shaped block anchor, one value valid across Raw ⇄ Live ⇄ Rendered). While the pane is
visible it is written by:

- **save points**: a capturer registered in `viewport-capture` runs on tab switch away, tab close and app
  quit (`captureAllViewports`);
- **a scroll debounce**: 500 ms after scrolling settles (a capture-phase scroll listener on the pane root),
  so a restart restores the scrolled-to spot even with no tab switch in between.

The position is applied at **first paint** on reopen, app restart and a re-shown pane: the doc appears
already scrolled. A doc opened fresh from the tree has no saved position and starts at the top, or at the
`:line` when opened through a link.

Which position wins when several are known before the editor exists (`getInitialView` in
`EditorPane.tsx`, `initial-view.ts`; `DocTab.viewport`: [contracts/types](../../contracts/types.md) "Tabs"): a pending `:line` on a fresh open >
the mode-toggle restore (viewport kept, caret as selection) > the saved viewport. The `:line` is one-shot:
once taken, later toggles keep the reading position. A `:line` link to an already-open tab jumps there and
that becomes the new position. `EditorController` exposes `getViewportAnchor()` (capture) and
`scrollToViewportAnchor()` (re-show restore); the first-paint baking lives in each engine's mount (raw: CM
`scrollTo`; live: outer-container scroll; rendered: synchronous in `mounted`, best-effort).

## Boundaries worth knowing

- **One-shot restores survive a double mount.** A development build runs React StrictMode, which mounts every
  editor twice and discards the first controller. The post-toggle caret restore applies only to the controller
  still current when its deferred apply runs, and a `:line` jump that landed in a discarded controller is
  re-posted once for the survivor (`useEditorController.ts`); every engine's controller no-ops on a destroyed
  view. Production builds mount once. E2E runs a production bundle, so `strictmode-caret-swallow.spec.ts` builds
  with `electron.vite.dev-react.config.ts` to reproduce the double mount.
- The gate checks that the body **parses**, not that it round-trips; cosmetic canonicalization is applied
  on the next save of an edited file.
- The mode button has no tooltip; its label is the whole affordance.
- A non-markdown tab whose persisted mode says `live` shows Raw.

Tickets: T-004, T-014, T-015, T-041, T-042, T-075, T-185, T-192, T-194, T-293, E-023, E-024.
