// Pomade — small form primitives shared by the group/project modals (Wave 2a).
// Plain CSS-module controls (no UI framework), styled to the diamond token set.

import { forwardRef, type ReactNode } from 'react'

import { useToast } from '../hooks/useToast'
import { useDataUrl } from '../hooks/useDataUrl'
import { cleanIpcError } from '../lib/ipc-errors'
import styles from './fields.module.css'

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  )
}

// The three controls below forward their ref to the DOM element so `Tooltip` (and any other
// anchor-by-ref caller) can wrap them.
export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input ref={ref} {...props} className={styles.input} />
  }
)

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea(props, ref) {
  return <textarea ref={ref} {...props} className={styles.textarea} rows={props.rows ?? 2} />
})

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'primary' | 'danger'
  }
>(function Button({ variant = 'default', ...props }, ref) {
  const cls =
    variant === 'primary' ? styles.btnPrimary : variant === 'danger' ? styles.btnDanger : styles.btn
  return <button ref={ref} type="button" {...props} className={`${cls} ${props.className ?? ''}`} />
})

/** Text input + Browse button that opens a native picker constrained to the workspace.
 *  When `onBrowse` is supplied it replaces the default (workspace-constrained) picker — the
 *  image field uses this to route Browse through fs.pickImage (T-033 external copy-in). */
export function PathPicker({
  value,
  onChange,
  placeholder,
  directory,
  image,
  onBrowse,
  testId
}: {
  value: string
  onChange: (rel: string) => void
  placeholder?: string
  directory?: boolean
  image?: boolean
  onBrowse?: () => Promise<string | null>
  testId?: string
}): React.JSX.Element {
  const toast = useToast()
  const browse = async (): Promise<void> => {
    try {
      const rel = onBrowse
        ? await onBrowse()
        : await window.pomade.fs.pickPath({ directory, image, defaultRel: value || undefined })
      if (rel !== null) onChange(rel)
    } catch (err) {
      toast(cleanIpcError(err), 'error')
    }
  }
  return (
    <div className={styles.pathRow}>
      <input
        className={styles.input}
        value={value}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button data-testid={testId ? `${testId}-browse` : undefined} onClick={() => void browse()}>
        Browse…
      </Button>
    </div>
  )
}

/** Free-text input backed by a datalist of suggestions (area combobox). */
export function Combobox({
  value,
  onChange,
  suggestions,
  placeholder,
  testId
}: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
  testId?: string
}): React.JSX.Element {
  const listId = `combobox-${testId ?? 'x'}`
  return (
    <>
      <input
        className={styles.input}
        value={value}
        placeholder={placeholder}
        list={listId}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  )
}

/** Image path picker with an inline preview rendered from a data: URL. */
export function ImagePicker({
  value,
  onChange,
  testId
}: {
  value: string
  onChange: (rel: string) => void
  testId?: string
}): React.JSX.Element {
  const preview = useDataUrl(value)
  return (
    <div className={styles.imageRow}>
      {preview ? (
        <img className={styles.imagePreview} src={preview} alt="" />
      ) : (
        <span className={styles.imagePlaceholder} aria-hidden="true" />
      )}
      <PathPicker
        value={value}
        onChange={onChange}
        image
        onBrowse={() => window.pomade.fs.pickImage()}
        placeholder="(optional)"
        testId={testId}
      />
      {value && (
        <Button aria-label="Clear image" onClick={() => onChange('')}>
          Clear
        </Button>
      )}
    </div>
  )
}
