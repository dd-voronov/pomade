// Pomade T-153 — the curated font catalogs for the two per-surface font settings
// (terminal + editor-raw) and the loader for the two BUNDLED open-license monos.
//
// Model (locked, the Owner 2026-08-26): the user picks a font per surface; code-shaped regions
// always stay mono. Fonts ship INSIDE the app bundle via the FontFace JS API (never installed
// to the user's Mac). Two bundled monos were picked for VISIBLY DISTINCT hyphen / en-dash /
// em-dash glyphs, no ligature dependency (the WOFF2s carry `liga`/`calt` as OPT-IN OpenType
// features; xterm and CodeMirror never enable them, so no ligatures render), and full Latin +
// Cyrillic + Greek coverage (the Owner writes Russian in terminals):
//   • JetBrains Mono  — OFL 1.1 (assets/fonts/JetBrainsMono-OFL.txt)
//   • IBM Plex Mono   — OFL 1.1 (assets/fonts/IBMPlexMono-OFL.txt)
//
// The FontFaces are added to `document.fonts` and their loads awaited at MODULE IMPORT (main.tsx
// imports this file at boot) so a bundled family is registered and measured-ready before any
// xterm grid measurement or CodeMirror layout — see TerminalPane's font-ready gate.

import jetbrainsRegular from './assets/fonts/JetBrainsMono-Regular.woff2'
import jetbrainsBold from './assets/fonts/JetBrainsMono-Bold.woff2'
import plexRegular from './assets/fonts/IBMPlexMono-Regular.woff2'
import plexBold from './assets/fonts/IBMPlexMono-Bold.woff2'

/** A selectable font: its persisted `id`, the label shown in Settings, the CSS `font-family`
 *  stack it maps to, and whether it is monospace (terminals list monos only). */
export interface FontOption {
  id: string
  label: string
  stack: string
  mono: boolean
}

// The standard mono stack — kept BYTE-IDENTICAL to tokens.css `--font-mono` so the default
// selection (`sf-mono`) reproduces today's look exactly, and so code-region pinning (which uses
// `var(--font-mono)`) always matches this default. Change both together.
export const MONO_STACK = '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace'
// The app UI stack — kept identical to tokens.css `--font-ui`.
const UI_STACK = '-apple-system, "SF Pro Text", "SF Pro", system-ui, sans-serif'

// Bundled families always end in the standard mono stack so any glyph a bundled face lacks
// falls back to the system mono rather than a proportional face.
const JETBRAINS_STACK = `"JetBrains Mono", ${MONO_STACK}`
const PLEX_STACK = `"IBM Plex Mono", ${MONO_STACK}`

/** The curated monospace fonts — shared by the terminal list and the editor list. SF Mono is
 *  the default (index 0). PT Mono/Monaco are macOS system monos; the last two are bundled.
 *  T-191: Menlo was dropped — visually indistinguishable from SF Mono (its direct descendant);
 *  PT Mono replaces it (ships with macOS, distinct shapes, first-class Cyrillic). A persisted
 *  `menlo` id falls back to the standard mono stack via fontStackFor — same look as before. */
const MONO_FONTS: FontOption[] = [
  { id: 'sf-mono', label: 'SF Mono (default)', stack: MONO_STACK, mono: true },
  { id: 'pt-mono', label: 'PT Mono', stack: '"PT Mono", ui-monospace, monospace', mono: true },
  { id: 'monaco', label: 'Monaco', stack: 'Monaco, ui-monospace, monospace', mono: true },
  { id: 'jetbrains-mono', label: 'JetBrains Mono (bundled)', stack: JETBRAINS_STACK, mono: true },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono (bundled)', stack: PLEX_STACK, mono: true }
]

/** Curated proportional fonts for the EDITOR (raw prose) list — never offered for terminals
 *  (an xterm grid requires a monospace face). */
const PROPORTIONAL_FONTS: FontOption[] = [
  { id: 'ui-sans', label: 'System UI (sans-serif)', stack: UI_STACK, mono: false },
  { id: 'serif', label: 'Serif (Georgia)', stack: 'Georgia, "Times New Roman", serif', mono: false },
  { id: 'humanist-sans', label: 'Sans (Helvetica Neue)', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif', mono: false }
]

/** Terminal font options (monospace only). */
export const TERMINAL_FONTS: readonly FontOption[] = MONO_FONTS
/** Editor-raw font options (monos + proportional). */
export const EDITOR_FONTS: readonly FontOption[] = [...MONO_FONTS, ...PROPORTIONAL_FONTS]

/** The default id for both surfaces — `sf-mono`, so an untouched install looks identical to
 *  today (the SF Mono stacks). Exported for the settings defaults. */
export const DEFAULT_FONT_ID = 'sf-mono'

const ALL = new Map<string, FontOption>(EDITOR_FONTS.map((f) => [f.id, f]))

/** Resolve a persisted font id to its CSS `font-family` stack; an unknown id (removed option,
 *  corrupt settings) falls back to the standard mono stack. */
export function fontStackFor(id: string): string {
  return ALL.get(id)?.stack ?? MONO_STACK
}

/** True when the selected font is PROPORTIONAL — the case where raw must pin code-shaped
 *  regions back to mono. A mono selection needs no pinning (everything is already mono). */
export function isProportionalFont(id: string): boolean {
  return ALL.get(id)?.mono === false
}

// ─── Bundled-font loading (FontFace API, no system install) ─────────────────────
function makeFace(family: string, url: string, weight: string): FontFace {
  return new FontFace(family, `url(${url})`, { weight, style: 'normal', display: 'swap' })
}

const bundledFaces: FontFace[] =
  typeof FontFace !== 'undefined'
    ? [
        makeFace('JetBrains Mono', jetbrainsRegular, '400'),
        makeFace('JetBrains Mono', jetbrainsBold, '700'),
        makeFace('IBM Plex Mono', plexRegular, '400'),
        makeFace('IBM Plex Mono', plexBold, '700')
      ]
    : []

let bundledFontsDone = false

/** Resolves once every bundled FontFace has loaded (or failed — a missing glyph subset must
 *  never wedge the app) AND been registered on `document.fonts`. Awaited by the terminal's
 *  font-ready gate so xterm never measures its grid before a bundled family is available. */
export const bundledFontsReady: Promise<void> = (async () => {
  if (typeof document === 'undefined' || !document.fonts) return
  await Promise.all(
    bundledFaces.map(async (face) => {
      document.fonts.add(face)
      try {
        await face.load()
      } catch {
        /* leave the family registered; CSS falls back through the stack */
      }
    })
  )
})().then(() => {
  bundledFontsDone = true
})

/** Synchronous "are the bundled fonts already loaded?" — lets a component seed its initial
 *  render state without awaiting (true on every mount after the first, so no gating cost). */
export function areBundledFontsReady(): boolean {
  return bundledFontsDone
}
