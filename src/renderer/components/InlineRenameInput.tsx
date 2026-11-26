// Pomade (T-179) — the shared inline-rename `<input>`: TabStrip's tab rename and the file tree's
// mount-header rename each hand-rolled the identical single-shot Enter/blur guard (committing the
// rename closes the input, which fires `onBlur` right after Enter/Escape already handled it — this
// makes the commit/cancel idempotent per rename session). Purely behavioral: callers own the
// className/data-testid/placeholder so every call site keeps its exact styling and observables.

import { useRef } from 'react'

export interface InlineRenameInputProps {
  value: string
  onChange: (value: string) => void
  /** Fires once per rename session, on Enter or blur. Return (or resolve to) `'retry'` to keep the
   *  session open and re-arm the guard — the one caller that needs this (TabStrip's on-disk doc
   *  rename) keeps the input mounted and focused after a failed rename so the user can correct it;
   *  every other caller just returns nothing and the parent clears its own rename state. */
  onCommit: () => void | 'retry' | Promise<void | 'retry'>
  /** Fires once per rename session, on Escape. */
  onCancel: () => void
  className: string
  testId: string
  placeholder?: string
}

export function InlineRenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
  className,
  testId,
  placeholder
}: InlineRenameInputProps): React.JSX.Element {
  // Fresh per rename session: this component mounts only while its caller's rename state is set,
  // so a new session always starts with a fresh (false) guard — no external reset needed.
  const handledRef = useRef(false)

  const finish = (commit: boolean): void => {
    if (handledRef.current) return
    handledRef.current = true
    if (!commit) {
      onCancel()
      return
    }
    const outcome = onCommit()
    if (outcome && typeof (outcome as Promise<unknown>).then === 'function') {
      void (outcome as Promise<void | 'retry'>).then((o) => {
        if (o === 'retry') handledRef.current = false
      })
    } else if (outcome === 'retry') {
      handledRef.current = false
    }
  }

  return (
    <input
      className={className}
      data-testid={testId}
      autoFocus
      value={value}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
    />
  )
}
