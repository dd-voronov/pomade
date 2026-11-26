// Pomade — E-017 shared renderer for a predefined LIBRARY icon (the third icon kind next to
// emoji glyphs and uploaded images). Given a `lib:…` id it draws the monochrome SVG, sized to
// `1em` so it inherits the font-size of whatever icon container hosts it — exactly like an
// emoji glyph does — which makes it crisp at every tier (48/40/32/16 incl. the collapsed rail)
// with ZERO changes to the row/rail CSS. Tinted with `currentColor`, matching the app's other
// vector glyphs. Returns null for an unknown id so callers can fall through to the default.

import { getLibraryIcon } from './icon-library'
import styles from './IconGlyph.module.css'

export function LibraryGlyph({
  id,
  className
}: {
  id: string
  className?: string
}): React.JSX.Element | null {
  const icon = getLibraryIcon(id)
  if (!icon) return null
  return (
    <svg
      className={`${styles.svg} ${className ?? ''}`}
      viewBox="0 0 24 24"
      role="img"
      aria-label={icon.label}
      data-lib-icon={id}
    >
      {icon.render()}
    </svg>
  )
}
