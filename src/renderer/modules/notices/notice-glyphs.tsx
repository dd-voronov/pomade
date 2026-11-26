// Pomade — E-032: the notices' icon-button glyphs, at the chrome icon size (`--control-icon`, 16px)
// inside a standard icon button (`--icon-btn`).

/** Dismiss / delete: a cross. */
export function CloseGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Mute a source: a bell, struck through. */
export function MuteGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11.1V7.55a4 4 0 0 1 8 0v3.55l1.15 1.35H2.85z" />
        <path d="M6.4 13.8a1.7 1.7 0 0 0 3.2 0" />
        <path d="M2.6 2.6l10.8 10.8" />
      </g>
    </svg>
  )
}
