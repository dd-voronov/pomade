// T-176 — pure-logic seed suite for editor/color-codes.ts (detect / parse / format-preserving
// re-serialize). Table-driven; see color-codes.ts's header comment for the notation contract.

import { describe, expect, it } from 'vitest'
import {
  colorCodeRegexp,
  formatColorCode,
  parseColorCode,
  rgbToHsl,
  hslToRgb,
  toCssColor,
  toHexKey,
  type RGBA
} from './color-codes'

describe('parseColorCode — hex', () => {
  const cases: [name: string, src: string, rgba: RGBA][] = [
    ['3-digit hex expands each nibble', '#abc', { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 }],
    ['6-digit hex', '#112233', { r: 0x11, g: 0x22, b: 0x33, a: 1 }],
    ['8-digit hex carries alpha', '#11223380', { r: 0x11, g: 0x22, b: 0x33, a: 0x80 / 255 }]
  ]
  it.each(cases)('%s', (_name, src, rgba) => {
    expect(parseColorCode(src)?.rgba).toEqual(rgba)
  })

  it('rejects malformed hex (5 digits)', () => {
    expect(parseColorCode('#abcde')).toBeNull()
  })
})

describe('parseColorCode — functional rgb()/hsl()', () => {
  it('legacy comma rgb with percent alpha', () => {
    const p = parseColorCode('rgba(10, 20, 30, 50%)')
    expect(p?.rgba).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(p?.notation).toMatchObject({ kind: 'rgb', sep: 'comma', alpha: 'percent' })
  })

  it('modern space rgb with slash alpha', () => {
    const p = parseColorCode('rgb(10 20 30 / 0.5)')
    expect(p?.rgba).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(p?.notation).toMatchObject({ kind: 'rgb', sep: 'space', alpha: 'number' })
  })

  it('rejects mixed number/percentage channels', () => {
    expect(parseColorCode('rgb(50%, 100, 200)')).toBeNull()
  })

  it('rejects mixed legacy comma + modern slash alpha', () => {
    expect(parseColorCode('rgb(10, 20, 30 / 0.5)')).toBeNull()
  })

  it('hsl legacy with deg-less hue and comma alpha', () => {
    const p = parseColorCode('hsl(0, 100%, 50%)')
    expect(p?.rgba.r).toBeCloseTo(255)
    expect(p?.rgba.g).toBeCloseTo(0)
    expect(p?.rgba.b).toBeCloseTo(0)
  })

  it('hsl hue with explicit deg unit is preserved in the notation', () => {
    const p = parseColorCode('hsl(120deg, 100%, 50%)')
    expect(p?.notation).toMatchObject({ kind: 'hsl', hueUnit: 'deg' })
  })

  // Edge case not previously exercised: a negative / out-of-[0,360) hue must still parse (CSS
  // hue is not range-clamped, only wrapped) — pins the `((hue % 360) + 360) % 360` normalization.
  it('negative hue wraps into [0,360) rather than being rejected', () => {
    const p = parseColorCode('hsl(-30, 100%, 50%)')
    expect(p).not.toBeNull()
    // -30 deg == 330 deg
    const expected = hslToRgb(330, 100, 50)
    expect(p!.rgba.r).toBeCloseTo(expected.r, 5)
    expect(p!.rgba.g).toBeCloseTo(expected.g, 5)
    expect(p!.rgba.b).toBeCloseTo(expected.b, 5)
  })

  it('rejects a saturation/lightness written without a percent sign', () => {
    expect(parseColorCode('hsl(120, 100, 50)')).toBeNull()
  })

  it('rejects an empty functional body', () => {
    expect(parseColorCode('rgb()')).toBeNull()
  })
})

describe('formatColorCode — round-trips preserve original notation shape', () => {
  it('hex 3-digit stays short when still representable, uppercase preserved', () => {
    const src = '#ABC'
    const parsed = parseColorCode(src)!
    expect(formatColorCode(parsed.notation, parsed.rgba)).toBe('#ABC')
  })

  it('hex 3-digit expands to 6 when a channel is no longer representable short', () => {
    const parsed = parseColorCode('#abc')!
    // Nudge one channel (r: 0xaa=170) off the "short-representable" nibble-doubled pattern.
    const mutated = { ...parsed.rgba, r: parsed.rgba.r + 1 } // 171 = 0xab, not nibble-doubled
    expect(formatColorCode(parsed.notation, mutated)).toBe('#abbbcc')
  })

  it('legacy comma rgba stays comma-separated with numeric alpha', () => {
    const src = 'rgba(10, 20, 30, 0.5)'
    const parsed = parseColorCode(src)!
    expect(formatColorCode(parsed.notation, parsed.rgba)).toBe(src)
  })

  it('modern space rgb stays space-separated with slash alpha', () => {
    const src = 'rgb(10 20 30 / 0.5)'
    const parsed = parseColorCode(src)!
    expect(formatColorCode(parsed.notation, parsed.rgba)).toBe(src)
  })

  it('percentage-channel rgb stays percentage on rewrite (values chosen to round-trip exactly)', () => {
    const src = 'rgb(100%, 20%, 0%)'
    const parsed = parseColorCode(src)!
    expect(formatColorCode(parsed.notation, parsed.rgba)).toBe(src)
  })

  it('hsl with deg unit preserved on rewrite', () => {
    const src = 'hsl(120deg, 100%, 50%)'
    const parsed = parseColorCode(src)!
    expect(formatColorCode(parsed.notation, parsed.rgba)).toBe(src)
  })

  it('function name casing preserved (RGBA)', () => {
    const src = 'RGBA(1, 2, 3, 1)'
    const parsed = parseColorCode(src)!
    // alpha=1 with a 'number' style alpha originally present still emits (alpha style is 'none'
    // only when the source had no alpha token at all — here it did, so it's carried forward).
    expect(formatColorCode(parsed.notation, parsed.rgba)).toBe('RGBA(1, 2, 3, 1)')
  })
})

describe('COLOR_CODE_RE / colorCodeRegexp detection', () => {
  it('matches longest hex form first (8 over 6 over 3)', () => {
    const re = colorCodeRegexp()
    expect([...'#11223344'.matchAll(re)].map((m) => m[0])).toEqual(['#11223344'])
  })

  it('does not match a partial hex inside a longer identifier', () => {
    const re = colorCodeRegexp()
    expect([...'#abcdefg'.matchAll(re)]).toEqual([])
  })

  it('does not match an HTML numeric entity', () => {
    const re = colorCodeRegexp()
    expect([...'&#123456;'.matchAll(re)]).toEqual([])
  })

  it('each call returns an independent regexp (own lastIndex)', () => {
    const a = colorCodeRegexp()
    const b = colorCodeRegexp()
    a.exec('#fff')
    expect(a.lastIndex).not.toBe(0)
    expect(b.lastIndex).toBe(0)
  })
})

describe('color space round-trips', () => {
  it('rgbToHsl → hslToRgb round-trips within rounding tolerance', () => {
    const rgb = { r: 200, g: 50, b: 120 }
    const hsl = rgbToHsl(rgb)
    const back = hslToRgb(hsl.h, hsl.s, hsl.l)
    expect(back.r).toBeCloseTo(rgb.r, 0)
    expect(back.g).toBeCloseTo(rgb.g, 0)
    expect(back.b).toBeCloseTo(rgb.b, 0)
  })

  it('achromatic (gray) has hue 0 and saturation 0', () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, l: (128 / 255) * 100 })
  })
})

describe('toCssColor / toHexKey', () => {
  it('toCssColor always emits rgba() with trimmed alpha', () => {
    expect(toCssColor({ r: 1, g: 2, b: 3, a: 1 })).toBe('rgba(1, 2, 3, 1)')
  })

  it('toHexKey omits the alpha channel when fully opaque', () => {
    expect(toHexKey({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000')
  })

  it('toHexKey includes the alpha channel when translucent', () => {
    expect(toHexKey({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#ff000080')
  })
})
