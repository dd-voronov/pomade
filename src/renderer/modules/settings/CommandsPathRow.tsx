// Pomade E-028 — Settings ▸ General ▸ Commands: the PATH line in the user's ~/.zprofile that puts
// this Pomade's command folder on PATH in terminals Pomade did not start. Pomade never writes it on
// its own; this row (or `pomade path install` / `remove`) is the only way it is added or removed.
// Hidden when commands are off (a test run without the hooks).

import { useEffect, useState } from 'react'

import type { PathLineStatus } from '@shared/types'
import styles from './SettingsModal.module.css'

/** `/Users/u/.zprofile` → `~/.zprofile`. */
function tilde(path: string): string {
  const home = window.pomade.env.home
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

function statusText(s: PathLineStatus): string {
  if (s.lineTarget === s.binDir) return `On — ${tilde(s.rcFile)} puts ${tilde(s.binDir)} on PATH.`
  if (s.lineTarget === null) return `Off — ${tilde(s.rcFile)} has no Pomade line.`
  if (s.lineTarget === '') return `${tilde(s.rcFile)} has a Pomade line that was edited; adding repairs it.`
  return `${tilde(s.rcFile)} puts another Pomade’s commands on PATH (${tilde(s.lineTarget)}).`
}

export function CommandsPathRow(): React.JSX.Element | null {
  const [status, setStatus] = useState<PathLineStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.pomade.commands
      .pathLine()
      .then((s) => {
        if (live) setStatus(s)
      })
      .catch((err: unknown) => console.error('[settings] PATH line status failed', err))
    return () => {
      live = false
    }
  }, [])

  if (!status) return null
  const on = status.lineTarget === status.binDir

  const toggle = (): void => {
    setBusy(true)
    setError(null)
    window.pomade.commands
      .setPathLine(!on)
      .then(setStatus)
      .catch((err: unknown) => setError(`Could not change ${tilde(status.rcFile)}: ${(err as Error).message}`))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <p className={`${styles.sectionTitle} ${styles.group}`}>Commands</p>
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Commands in other terminals</span>
          <span className={styles.hint}>
            Pomade’s terminals always have the commands of your apps. To use them in other
            terminals too, Pomade adds one marked line to {tilde(status.rcFile)}; removing it takes
            the line out and leaves the rest of the file as it was.
          </span>
          <span className={`${styles.hint} ${styles.pathStatus}`} data-testid="setting-path-line-status">
            {statusText(status)}
          </span>
          {error && (
            <span className={`${styles.hint} ${styles.pathStatus}`} role="alert">
              {error}
            </span>
          )}
        </span>
        <button
          type="button"
          className={`${styles.btn} ${styles.rowAction}`}
          data-testid="setting-path-line-toggle"
          disabled={busy}
          onClick={toggle}
        >
          {on ? 'Remove line' : 'Add line'}
        </button>
      </div>
    </>
  )
}
