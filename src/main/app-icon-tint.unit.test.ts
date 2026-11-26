import { describe, expect, it } from 'vitest'

import { isTintableIcon } from './app-icon-tint'

const svg = (body: string, attrs = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" ${attrs}>${body}</svg>`

describe('isTintableIcon', () => {
  it('a currentColor SVG is tintable', () => {
    expect(isTintableIcon('i.svg', svg('<path d="M1 1h4" stroke="currentColor"/>', 'fill="none"'))).toBe(true)
  })

  it('an SVG in one fixed colour is tintable, however it spells it', () => {
    const planner = svg(
      '<g stroke="#5a6b7a" stroke-width="1.3"><rect x="2" y="2" width="3" height="3"/></g><path d="M1 1" fill="#5A6B7A"/>',
      'fill="none"'
    )
    expect(isTintableIcon('planner.svg', planner)).toBe(true)
    expect(isTintableIcon('a.svg', svg('<path d="M1 1" style="fill: #abc"/><path d="M2 2" fill="#AABBCC"/>'))).toBe(true)
    expect(isTintableIcon('a.svg', svg('<path d="M1 1"/>'))).toBe(true)
  })

  it('two colours, a gradient, a pattern or an embedded image are not', () => {
    expect(isTintableIcon('a.svg', svg('<rect fill="#E8833A"/><path stroke="#fff"/>'))).toBe(false)
    expect(isTintableIcon('a.svg', svg('<rect style="fill:red;stroke:blue"/>'))).toBe(false)
    expect(isTintableIcon('a.svg', svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/>'))).toBe(false)
    expect(isTintableIcon('a.svg', svg('<rect fill="url(#p)"/>'))).toBe(false)
    expect(isTintableIcon('a.svg', svg('<image href="x.png"/>'))).toBe(false)
  })

  it('a raster, or a file that is not an SVG, is not', () => {
    expect(isTintableIcon('icon.png', '\u0089PNG')).toBe(false)
    expect(isTintableIcon('icon.svg', 'not an svg')).toBe(false)
  })
})
