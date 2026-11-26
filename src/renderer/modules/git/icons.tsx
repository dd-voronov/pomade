// Pomade — E-037: the git glyphs — the strip icon (18px, the strip's stroke language), the
// commit-details and comparison tab icons (16px, the tab strip's), and the panel's small marks.

/** Strip icon: a branch — two commits on a line, a third forking off. */
export function GitGlyph(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <circle cx="5.5" cy="4" r="1.75" />
        <circle cx="5.5" cy="14" r="1.75" />
        <circle cx="12.5" cy="6.5" r="1.75" />
        <path d="M5.5 5.75v6.5" />
        <path d="M12.5 8.25c0 2.6-2.2 3.4-5.4 4.4" />
      </g>
    </svg>
  )
}

/** Commit-details tab: a commit dot on a line. */
export function CommitIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <circle cx="8" cy="8" r="2.6" />
        <path d="M1.8 8h3.6M10.6 8h3.6" />
      </g>
    </svg>
  )
}

/** Comparison tab: two side-by-side sheets. */
export function CompareIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
        <rect x="1.9" y="2.9" width="5.2" height="10.2" rx="1" />
        <rect x="8.9" y="2.9" width="5.2" height="10.2" rx="1" />
        <path d="M3.6 6h1.8M10.6 6h1.8M10.6 8.5h1.8" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** A chevron for expandable rows; rotated by CSS when open. */
export function Chevron(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The back arrow of a drilled-in repo view. */
export function BackArrow(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Copy (two stacked squares). */
export function CopyGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
        <rect x="3.8" y="3.8" width="6.4" height="6.4" rx="1.2" />
        <path d="M8 2.2V2a.8.8 0 0 0-.8-.8H2.6a.8.8 0 0 0-.8.8v4.6c0 .44.36.8.8.8h.2" />
      </g>
    </svg>
  )
}

/** Discard on a change row: an arrow turning back. */
export function DiscardGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 4.5h4.75a2.75 2.75 0 0 1 0 5.5H5" />
        <path d="M5 2.5L3 4.5l2 2" />
      </g>
    </svg>
  )
}

/** Discarded row: Forget — a cross. */
export function ForgetGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** Conflict tab: three sheets — theirs, the result, yours. */
export function ConflictIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
        <rect x="1.4" y="3.4" width="3.6" height="9.2" rx="0.8" />
        <rect x="6.2" y="2.4" width="3.6" height="11.2" rx="0.8" />
        <rect x="11" y="3.4" width="3.6" height="9.2" rx="0.8" />
      </g>
    </svg>
  )
}

/** Stage a change: a plus. */
export function StageGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Unstage a change: a minus. */
export function UnstageGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Fetch: an arrow coming down into a tray. */
export function FetchGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 2v6.5M4.4 6l2.6 2.6L9.6 6" />
        <path d="M2.5 9.5v1.6c0 .5.4.9.9.9h7.2c.5 0 .9-.4.9-.9V9.5" />
      </g>
    </svg>
  )
}

/** Branch tab: a branch leaving its line. */
export function BranchTabIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <circle cx="4.4" cy="3.2" r="1.5" />
        <circle cx="4.4" cy="12.8" r="1.5" />
        <circle cx="11.6" cy="5.2" r="1.5" />
        <path d="M4.4 4.7v6.6M11.6 6.7c0 2.6-2.3 3.4-6 4.6" />
      </g>
    </svg>
  )
}

/** A worktree row: a folder. */
export function WorktreeGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M1.5 3.2c0-.5.4-.9.9-.9h2.3l1 1.1h3.9c.5 0 .9.4.9.9v4.6c0 .5-.4.9-.9.9H2.4c-.5 0-.9-.4-.9-.9V3.2z"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A remote branch row: a small cloud. */
export function RemoteGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M3.4 9.2h5.4a2 2 0 0 0 .3-4 2.9 2.9 0 0 0-5.6-.6A2.3 2.3 0 0 0 3.4 9.2z"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** A local branch row: the branch mark at row size. */
export function BranchGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.05" strokeLinecap="round">
        <circle cx="3.2" cy="2.4" r="1.2" />
        <circle cx="3.2" cy="9.6" r="1.2" />
        <circle cx="8.8" cy="4" r="1.2" />
        <path d="M3.2 3.6v4.8M8.8 5.2c0 2-1.7 2.6-4.4 3.4" />
      </g>
    </svg>
  )
}
