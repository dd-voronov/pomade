// Pomade — E-037: the small branch mark before a branch name.

export function BranchMark(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <circle cx="2.6" cy="2" r="1.1" />
        <circle cx="2.6" cy="8" r="1.1" />
        <circle cx="7.4" cy="3.4" r="1.1" />
        <path d="M2.6 3.1v3.8M7.4 4.5c0 1.6-1.4 2.1-3.6 2.8" />
      </g>
    </svg>
  )
}
