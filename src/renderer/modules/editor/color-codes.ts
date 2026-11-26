// Pomade E-019 (T-067 / T-068) — color-code detection, parsing and FORMAT-PRESERVING
// re-serialization. Pure functions only (no DOM, no CodeMirror) so both the raw-editor
// decoration and the picker popup share one source of truth.
//
// Detection is regex-based on purpose: raw mode must work in EVERY text format, and
// `.txt`/unknown extensions load NO language extension (doc-kind.ts), so a syntax-tree
// based detector would silently skip exactly the files the Owner asked about.
//
// Supported notations (T-067 scope — named CSS colors are T-069, deliberately out):
//   • hex        #rgb · #rrggbb · #rrggbbaa   (word-bounded; 4-digit #rgba is NOT in scope)
//   • rgb()/rgba()  legacy `r, g, b[, a]` and modern `r g b[ / a]`; channels 0–255 or 0–100%
//   • hsl()/hsla()  legacy `h, s%, l%[, a]` and modern `h s% l%[ / a]`; hue optionally `deg`
// Anything malformed or out of range gets NO swatch — an invalid code must not look valid.

export interface RGBA {
  /** 0–255 */
  r: number
  /** 0–255 */
  g: number
  /** 0–255 */
  b: number
  /** 0–1 */
  a: number
}

/** How the code was WRITTEN — everything needed to rewrite it in the very same shape. */
export type ColorNotation =
  | { kind: 'hex'; digits: 3 | 6 | 8; upper: boolean }
  | {
      kind: 'rgb' | 'hsl'
      /** function name exactly as written (`rgb` / `rgba` / `RGBA` …) */
      name: string
      sep: 'comma' | 'space'
      alpha: 'none' | 'number' | 'percent'
      /** rgb only — channels were written as percentages */
      channelPct: boolean
      /** hsl only — hue unit as written (`''` or `deg`, case preserved) */
      hueUnit: string
    }

export interface ParsedColor {
  rgba: RGBA
  notation: ColorNotation
}

// ── Detection ────────────────────────────────────────────────────────────────────
// Word-bounded hex: longest-first so `#rrggbbaa` wins over `#rrggbb` over `#rgb`, and a
// trailing `(?!\w)` kills partial matches inside longer identifiers (`#abcdefg`, `#abcd`).
// The leading guard also rejects HTML numeric entities (`&#123456;`) and `##`.
const HEX_SRC = '(?<![\\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?!\\w)'
// Functional notation is matched permissively (balanced-paren-free body) and then fully
// validated by `parseColorCode` — keeps the regex trivial and the rules unit-testable.
const FN_SRC = '\\b(?:rgba?|hsla?)\\(\\s*[^()\\n]{0,120}?\\)'

/** Global regexp matching color-code CANDIDATES. Always validate a hit with `parseColorCode`. */
export const COLOR_CODE_RE = new RegExp(`${HEX_SRC}|${FN_SRC}`, 'gi')

/** A fresh, independent copy of the candidate regexp (own `lastIndex`). */
export function colorCodeRegexp(): RegExp {
  return new RegExp(COLOR_CODE_RE.source, COLOR_CODE_RE.flags)
}

// ── Parsing ──────────────────────────────────────────────────────────────────────

const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/
const PCT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)%$/

function num(s: string): number | null {
  return NUM_RE.test(s) ? Number(s) : null
}

function inRange(v: number | null, lo: number, hi: number): number | null {
  return v === null || !Number.isFinite(v) || v < lo || v > hi ? null : v
}

/** Parse a channel written either as 0–255 or as 0–100%. Returns 0–255, or null. */
function channel(s: string): { value: number; pct: boolean } | null {
  if (PCT_RE.test(s)) {
    const p = inRange(Number(s.slice(0, -1)), 0, 100)
    return p === null ? null : { value: (p * 255) / 100, pct: true }
  }
  const v = inRange(num(s), 0, 255)
  return v === null ? null : { value: v, pct: false }
}

/** Parse an alpha written as 0–1 or 0–100%. */
function alphaOf(s: string): { value: number; style: 'number' | 'percent' } | null {
  if (PCT_RE.test(s)) {
    const p = inRange(Number(s.slice(0, -1)), 0, 100)
    return p === null ? null : { value: p / 100, style: 'percent' }
  }
  const v = inRange(num(s), 0, 1)
  return v === null ? null : { value: v, style: 'number' }
}

function hexPair(s: string): number {
  return parseInt(s, 16)
}

function parseHex(src: string): ParsedColor | null {
  const body = src.slice(1)
  const upper = /[A-F]/.test(body) && !/[a-f]/.test(body)
  if (body.length === 3) {
    const [r, g, b] = [...body].map((c) => hexPair(c + c))
    return { rgba: { r, g, b, a: 1 }, notation: { kind: 'hex', digits: 3, upper } }
  }
  if (body.length === 6) {
    return {
      rgba: { r: hexPair(body.slice(0, 2)), g: hexPair(body.slice(2, 4)), b: hexPair(body.slice(4, 6)), a: 1 },
      notation: { kind: 'hex', digits: 6, upper }
    }
  }
  if (body.length === 8) {
    return {
      rgba: {
        r: hexPair(body.slice(0, 2)),
        g: hexPair(body.slice(2, 4)),
        b: hexPair(body.slice(4, 6)),
        a: hexPair(body.slice(6, 8)) / 255
      },
      notation: { kind: 'hex', digits: 8, upper }
    }
  }
  return null
}

/** Split a functional body into channel parts + optional alpha, or null when malformed. */
function splitArgs(body: string): { parts: string[]; alpha: string | null; sep: 'comma' | 'space' } | null {
  const trimmed = body.trim()
  if (trimmed === '') return null
  if (trimmed.includes(',')) {
    if (trimmed.includes('/')) return null // can't mix legacy commas with a modern slash-alpha
    const raw = trimmed.split(',').map((p) => p.trim())
    if (raw.some((p) => p === '')) return null
    if (raw.length === 3) return { parts: raw, alpha: null, sep: 'comma' }
    if (raw.length === 4) return { parts: raw.slice(0, 3), alpha: raw[3], sep: 'comma' }
    return null
  }
  const slash = trimmed.split('/')
  if (slash.length > 2) return null
  const head = slash[0].trim()
  const alpha = slash.length === 2 ? slash[1].trim() : null
  if (alpha === '') return null
  const raw = head.split(/\s+/)
  if (raw.length !== 3) return null
  return { parts: raw, alpha, sep: 'space' }
}

const HUE_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg)?$/i

function parseFn(name: string, body: string): ParsedColor | null {
  const lower = name.toLowerCase()
  const family: 'rgb' | 'hsl' = lower.startsWith('rgb') ? 'rgb' : 'hsl'
  const split = splitArgs(body)
  if (!split) return null

  let alphaValue = 1
  let alphaStyle: 'none' | 'number' | 'percent' = 'none'
  if (split.alpha !== null) {
    const a = alphaOf(split.alpha)
    if (!a) return null
    alphaValue = a.value
    alphaStyle = a.style
  }

  if (family === 'rgb') {
    const chans = split.parts.map(channel)
    if (chans.some((c) => c === null)) return null
    const pcts = (chans as { value: number; pct: boolean }[]).map((c) => c.pct)
    // CSS forbids mixing number and percentage channels — treat it as malformed.
    if (pcts.some((p) => p !== pcts[0])) return null
    const [r, g, b] = (chans as { value: number; pct: boolean }[]).map((c) => c.value)
    return {
      rgba: { r, g, b, a: alphaValue },
      notation: {
        kind: 'rgb',
        name,
        sep: split.sep,
        alpha: alphaStyle,
        channelPct: pcts[0],
        hueUnit: ''
      }
    }
  }

  const hueMatch = HUE_RE.exec(split.parts[0])
  if (!hueMatch) return null
  const hue = Number(hueMatch[1])
  if (!Number.isFinite(hue)) return null
  // Saturation and lightness must be percentages (both legacy and modern hsl() write them so).
  if (!PCT_RE.test(split.parts[1]) || !PCT_RE.test(split.parts[2])) return null
  const s = inRange(Number(split.parts[1].slice(0, -1)), 0, 100)
  const l = inRange(Number(split.parts[2].slice(0, -1)), 0, 100)
  if (s === null || l === null) return null
  const rgb = hslToRgb(((hue % 360) + 360) % 360, s, l)
  return {
    rgba: { ...rgb, a: alphaValue },
    notation: {
      kind: 'hsl',
      name,
      sep: split.sep,
      alpha: alphaStyle,
      channelPct: false,
      hueUnit: hueMatch[2] ?? ''
    }
  }
}

/** Parse one candidate string into a color + its notation. `null` = not a valid color code. */
export function parseColorCode(src: string): ParsedColor | null {
  if (src.startsWith('#')) return parseHex(src)
  const m = /^([A-Za-z]+)\(([\s\S]*)\)$/.exec(src)
  if (!m) return null
  return parseFn(m[1], m[2])
}

// ── Re-serialization (format preserving) ─────────────────────────────────────────

function trimNum(n: number, decimals: number): string {
  const s = n.toFixed(decimals)
  return s.replace(/\.?0+$/, '') || '0'
}

function pctStr(n: number): string {
  return `${trimNum(n, 1)}%`
}

function hex2(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0')
}

/**
 * Rewrite `rgba` using the SAME notation the original code was written in:
 * hex stays hex (short form kept when still expressible, otherwise expanded; letter case
 * preserved), `rgb()` stays `rgb()`, `hsl()` stays `hsl()`, separator style and percentage
 * style preserved, and alpha emitted iff the original notation carried one.
 */
export function formatColorCode(notation: ColorNotation, rgba: RGBA): string {
  const r = Math.round(rgba.r)
  const g = Math.round(rgba.g)
  const b = Math.round(rgba.b)
  const a = Math.min(1, Math.max(0, rgba.a))

  if (notation.kind === 'hex') {
    const carriesAlpha = notation.digits === 8 || a < 1
    let out: string
    if (carriesAlpha) {
      out = `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`
    } else if (notation.digits === 3 && [r, g, b].every((c) => (c >> 4) === (c & 0xf))) {
      // Short form still representable — keep it short.
      out = `#${(r >> 4).toString(16)}${(g >> 4).toString(16)}${(b >> 4).toString(16)}`
    } else {
      out = `#${hex2(r)}${hex2(g)}${hex2(b)}`
    }
    return notation.upper ? out.toUpperCase() : out
  }

  const join = notation.sep === 'comma' ? ', ' : ' '
  const channels =
    notation.kind === 'rgb'
      ? notation.channelPct
        ? [pctStr((r / 255) * 100), pctStr((g / 255) * 100), pctStr((b / 255) * 100)]
        : [String(r), String(g), String(b)]
      : (() => {
          const hsl = rgbToHsl({ r, g, b })
          return [`${Math.round(hsl.h)}${notation.hueUnit}`, `${Math.round(hsl.s)}%`, `${Math.round(hsl.l)}%`]
        })()

  let tail = ''
  if (notation.alpha !== 'none') {
    const aStr = notation.alpha === 'percent' ? pctStr(a * 100) : trimNum(a, 3)
    tail = notation.sep === 'comma' ? `, ${aStr}` : ` / ${aStr}`
  }
  return `${notation.name}(${channels.join(join)}${tail})`
}

/** A CSS color string always safe to hand to `style.backgroundColor`. */
export function toCssColor(c: RGBA): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${trimNum(c.a, 3)})`
}

/** Canonical lowercase hex identity (8 digits only when translucent) — used for tests + widget eq. */
export function toHexKey(c: RGBA): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
  return c.a >= 1 ? base : `${base}${hex2(c.a * 255)}`
}

// ── Color space conversions ──────────────────────────────────────────────────────

export interface HSV {
  /** 0–360 */
  h: number
  /** 0–1 */
  s: number
  /** 0–1 */
  v: number
}

export function rgbToHsv({ r, g, b }: { r: number; g: number; b: number }): HSV {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hh = (((h % 360) + 360) % 360) / 60
  const c = v * s
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  const seg = Math.floor(hh) % 6
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ]
  const [r, g, b] = table[seg]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

/** h 0–360, s/l 0–100. */
export function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = (((gn - bn) / d) % 6) * 60
  else if (max === gn) h = ((bn - rn) / d + 2) * 60
  else h = ((rn - gn) / d + 4) * 60
  if (h < 0) h += 360
  return { h, s: s * 100, l: l * 100 }
}

/** h 0–360, s/l 0–100 → r/g/b 0–255. */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sn = s / 100
  const ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = ln - c / 2
  const seg = Math.floor(hh) % 6
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ]
  const [r, g, b] = table[seg]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}
