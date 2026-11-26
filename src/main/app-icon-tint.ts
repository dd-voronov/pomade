// Pomade — T-244: may Pomade tint an app's icon? A strip / tab icon is drawn in Pomade's own
// colour (a CSS mask: the image's shape, filled with the button's current colour) when it is an
// SVG painted in one colour — `currentColor` (the HOST-API §1 rule), or any single fixed colour.
// Anything else (a raster, a multi-colour or gradient SVG) is shown as the image itself, untinted:
// a mask would flatten its colours into one silhouette. Pure — no Electron, unit-tested.

/** Paint values that add no colour of their own. */
const NEUTRAL = new Set(['none', 'transparent', 'currentcolor', 'inherit', 'context-fill', 'context-stroke'])

/** Colour-carrying attributes and style properties. */
const PAINT_ATTR = /\b(fill|stroke|stop-color|flood-color|lighting-color|color)\s*=\s*("([^"]*)"|'([^']*)')/gi
const PAINT_PROP = /\b(fill|stroke|stop-color|flood-color|lighting-color|color)\s*:\s*([^;"'}]+)/gi

function normalise(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s*!important$/, '')
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return v.replace(/\s+/g, '')
}

/** True when `path` names an SVG whose `text` paints with at most one colour and no gradient,
 *  pattern or embedded image — so masking it loses nothing. */
export function isTintableIcon(path: string, text: string): boolean {
  if (!/\.svg$/i.test(path) || !/<svg[\s>]/i.test(text)) return false
  if (/<(linearGradient|radialGradient|pattern|image|foreignObject)[\s>/]/i.test(text)) return false
  const colours = new Set<string>()
  for (const m of text.matchAll(PAINT_ATTR)) colours.add(normalise(m[3] ?? m[4] ?? ''))
  for (const m of text.matchAll(PAINT_PROP)) colours.add(normalise(m[2] ?? ''))
  for (const c of NEUTRAL) colours.delete(c)
  colours.delete('')
  if ([...colours].some((c) => c.startsWith('url('))) return false
  return colours.size <= 1
}
