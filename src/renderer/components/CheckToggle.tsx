// Pomade — shared checkbox-style switch: a small box whose tick shows the state, then a label. The
// History panel's "Show all commits", the comparison tab's "Changes only" and the Git panel History
// head's "Every commit" are this. The label shrinks with an ellipsis when its row runs out of room.

import { Tooltip } from './Tooltip'

import styles from './CheckToggle.module.css'

interface CheckToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  /** The tooltip's lines. */
  tooltip: string[]
  /** The accessible name, when it should say more than the label. */
  ariaLabel?: string
  /** Extra class on the label, for a host that hides it in a narrow container. */
  labelClassName?: string
  testId?: string
}

export function CheckToggle({
  checked,
  onChange,
  label,
  tooltip,
  ariaLabel,
  labelClassName,
  testId,
}: CheckToggleProps): React.JSX.Element {
  return (
    <Tooltip lines={tooltip}>
      <button
        type="button"
        className={styles.toggle}
        data-testid={testId}
        aria-pressed={checked}
        aria-label={ariaLabel}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.box} data-on={checked || undefined} aria-hidden="true">
          {checked && (
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1.3 4.2l1.8 1.8 3.6-3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className={labelClassName ? `${styles.label} ${labelClassName}` : styles.label}>{label}</span>
      </button>
    </Tooltip>
  )
}
