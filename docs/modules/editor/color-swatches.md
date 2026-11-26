---
doc: docs/modules/editor/color-swatches.md
audience: engineers, product
holds: inline color swatches and the click-to-edit picker in the Raw view — recognized formats, picker behavior, format-preserving rewrite
kind: reference
---

# Color swatches & picker — inline previews for color codes, click to edit

**Module:** `editor` · **UI:** small checkerboard-backed squares before color codes in the Raw view ·
**Code:** `src/renderer/modules/editor/cm-color-swatch.ts` (detection/widget), `color-codes.ts`
(formats), `ColorPickerPopover.tsx` (picker), `RawEditor.tsx` (mount) · **e2e:**
`editor-color-swatch.spec.ts`

## What it does

In the **Raw view**, every recognized color code gets a small swatch square before it — VS
Code-style, live as you type, in every text file format. Clicking a swatch opens a
hand-rolled color picker; **Apply** rewrites the code in place **preserving its original
notation**, as a single undo step. Escape, Cancel, or clicking outside changes nothing.

## Recognized formats

- **Hex:** `#rgb`, `#rrggbb`, `#rrggbbaa` (word-bounded; 4-digit `#rgba` is not supported).
- **`rgb()` / `rgba()`:** legacy comma and modern space syntax; channels 0–255 or
  percentages (not mixed); alpha as 0–1 or a percentage.
- **`hsl()` / `hsla()`:** legacy and modern; `deg` optional on the hue; saturation/lightness
  must be percentages.
- Function names match case-insensitively and are echoed back as written. Out-of-range or
  malformed codes get no swatch. **Named CSS colors are not detected** (they would need syntax-tree gating
  to avoid prose false positives).

The swatch renders the actual color over a checkerboard so alpha reads honestly, and is
sized not to change the line height.

## The picker

A compact popover (`Pick a color`) anchored under the swatch (flips above near the bottom
edge): a **saturation/value area**, a **hue slider**, and an **alpha slider that appears only
when the notation carries alpha** (hex8 or a function with an alpha component). The header
shows the original code; a live preview shows the prospective new code as it will be written.

- **Apply** (or Enter) commits — exactly one CodeMirror transaction, so one Cmd+Z reverts it;
  the doc goes dirty exactly like typing.
- **Cancel**, Escape, or a click outside discards the draft — the document is untouched
  while dragging.
- **Format preservation:** hex stays hex with its letter case; 3-digit stays 3-digit when
  still expressible; alpha presence/style, function name, separator style (`, ` vs ` `),
  percent-vs-number channels, and the `deg` unit all survive the edit.

## Boundaries worth knowing

- Raw view only: Live, Rendered and the CSV table cells have no swatches. A `.csv` shown in Raw does show
  swatches.
- No hex text input, eyedropper, palette, or recent colors in the picker — sliders only.
- If the document changed under the popover (the code moved or was edited), Apply safely
  no-ops instead of rewriting the wrong range.
- There is no setting: swatches are always on in the Raw view.

Tickets: E-019, T-067, T-068. Backlog: T-069 (named colors), T-070 (Rendered), T-071 (CSV table).
