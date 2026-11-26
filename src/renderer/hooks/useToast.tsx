// Pomade — toasts. `useToast()` returns a pusher; <ToastHost/> renders them.
// IPC errors (rejected promises) surface here (docs/contracts/ipc-app.md "The typed boundary"). E-032 — notices (apps', the queue's)
// are drawn in the same host, below the plain toasts (`modules/notices/NoticeToasts.tsx`).

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { nanoid } from 'nanoid'

import { NoticeToasts } from '../modules/notices/NoticeToasts'
import styles from './useToast.module.css'

type ToastKind = 'info' | 'error'

/** A button at the toast's end; clicking it runs `run` and dismisses the toast. */
export interface ToastAction {
  label: string
  run: () => void
  testId?: string
}

export interface ToastOptions {
  action?: ToastAction
  /** A new toast with the same tag replaces the shown one instead of stacking under it. */
  tag?: string
  testId?: string
}

interface Toast extends ToastOptions {
  id: string
  kind: ToastKind
  message: string
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, kind?: ToastKind, options?: ToastOptions) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind = 'info', options = {}) =>
    set((s) => ({
      toasts: [
        ...s.toasts.filter((t) => !options.tag || t.tag !== options.tag),
        { id: nanoid(), kind, message, ...options }
      ]
    })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export function useToast(): (message: string, kind?: ToastKind) => void {
  return useToastStore((s) => s.push)
}

export function ToastHost(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  // One timer per toast, from when it shows: a newer toast never restarts an older one's.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const live = new Set(toasts.map((t) => t.id))
    for (const t of toasts) {
      if (!timers.current.has(t.id)) timers.current.set(t.id, setTimeout(() => dismiss(t.id), 4000))
    }
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer)
        timers.current.delete(id)
      }
    }
  }, [toasts, dismiss])
  useEffect(() => {
    const map = timers.current
    return () => {
      for (const timer of map.values()) clearTimeout(timer)
      map.clear()
    }
  }, [])

  return (
    <div className={styles.host} role="status" aria-live="polite">
      {toasts.map((t) =>
        t.action ? (
          <ActionToast key={t.id} toast={t} action={t.action} onDismiss={() => dismiss(t.id)} />
        ) : (
        <button
          key={t.id}
          type="button"
          data-testid="toast"
          data-kind={t.kind}
          className={`${styles.toast} ${t.kind === 'error' ? styles.error : ''}`}
          onClick={() => dismiss(t.id)}
        >
          {t.message}
        </button>
        )
      )}
      <NoticeToasts />
    </div>
  )
}

/** A toast with an action: the message dismisses it like a plain toast, the action runs and
 *  dismisses. Two sibling buttons in one card (a button can't hold a button). */
function ActionToast({
  toast,
  action,
  onDismiss
}: {
  toast: Toast
  action: ToastAction
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid={toast.testId ?? 'toast'}
      data-kind={toast.kind}
      className={`${styles.toast} ${styles.withAction} ${toast.kind === 'error' ? styles.error : ''}`}
    >
      <button type="button" className={styles.toastMessage} onClick={onDismiss}>
        {toast.message}
      </button>
      <button
        type="button"
        className={styles.toastAction}
        data-testid={action.testId}
        onClick={() => {
          onDismiss()
          action.run()
        }}
      >
        {action.label}
      </button>
    </div>
  )
}
