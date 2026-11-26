// Pomade T-234 — the limits rows of Settings ▸ General ▸ Local history: the store's size cap
// (lowering it previews what goes and asks first) and Delete versions now — one group, Local
// versions or Discarded, kept longer than a chosen age, previewed live and confirmed. The preview's
// own `before` goes to the purge, so exactly what it counted is deleted.

import { useCallback, useEffect, useState } from 'react'

import {
  LOCAL_HISTORY_CAP_CHOICES_MB,
  capLabel,
  formatBytes,
  removalLabel,
  type PurgeGroup,
  type PurgePreview,
  type RemovalSize
} from '@shared/local-history'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useToast } from '../../hooks/useToast'
import { cleanIpcError } from '../../lib/ipc-errors'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useGitOpsStore } from '../git/ops/git-ops-store'
import styles from './SettingsModal.module.css'

/** The ages Delete versions now offers, in days; 0 = any age. Versions live 7 days. */
const PURGE_AGES = [0, 1, 2, 3, 4, 5, 6]

/** Document history's names for the two groups (GLOSSARY). */
const GROUP_NAME: Record<PurgeGroup, string> = { local: 'Local versions', discarded: 'Discarded' }

function ageLabel(days: number): string {
  if (days === 0) return 'Any age'
  return days === 1 ? '1 day' : `${days} days`
}

/** `Local versions older than 2 days` / `all Local versions`. */
function scopeLabel(group: PurgeGroup, days: number): string {
  return days === 0 ? `all ${GROUP_NAME[group]}` : `${GROUP_NAME[group]} older than ${ageLabel(days)}`
}

type Pending =
  | { kind: 'cap'; capMb: number; size: RemovalSize }
  | { kind: 'purge'; preview: PurgePreview; days: number }

export function LocalHistoryLimits(): React.JSX.Element {
  const capMb = useAppSettingsStore((s) => s.localHistoryCapMb)
  const setCapMb = useAppSettingsStore((s) => s.setLocalHistoryCapMb)
  const draftsNonce = useGitOpsStore((s) => s.draftsNonce)
  const toast = useToast()
  const [group, setGroup] = useState<PurgeGroup>('local')
  const [days, setDays] = useState(0)
  const [usage, setUsage] = useState<RemovalSize | null>(null)
  const [preview, setPreview] = useState<PurgePreview | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [changes, setChanges] = useState(0)

  // A version kept or removed anywhere (or a discard) re-asks both numbers, at most every 300 ms.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.pomade.localHistory.onChanged(() => {
      timer ??= setTimeout(() => {
        timer = null
        setChanges((n) => n + 1)
      }, 300)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.pomade.localHistory.previewPurge('local', 0).then(
      (all) => {
        if (!cancelled) setUsage(all)
      },
      () => {
        if (!cancelled) setUsage(null)
      }
    )
    void window.pomade.localHistory.previewPurge(group, days).then(
      (p) => {
        if (!cancelled) setPreview(p)
      },
      () => {
        if (!cancelled) setPreview(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [group, days, changes, draftsNonce, capMb])

  const pickCap = useCallback(
    async (next: number): Promise<void> => {
      if (next >= capMb) return setCapMb(next)
      try {
        const size = await window.pomade.localHistory.previewCap(next)
        if (size.versions === 0) await setCapMb(next)
        else setPending({ kind: 'cap', capMb: next, size })
      } catch (err) {
        toast(`Could not change the space: ${cleanIpcError(err)}`, 'error')
      }
    },
    [capMb, setCapMb, toast]
  )

  const askPurge = async (): Promise<void> => {
    try {
      const fresh = await window.pomade.localHistory.previewPurge(group, days)
      setPreview(fresh)
      if (fresh.versions > 0) setPending({ kind: 'purge', preview: fresh, days })
    } catch (err) {
      toast(`Could not count the versions: ${cleanIpcError(err)}`, 'error')
    }
  }

  const runPurge = (p: PurgePreview): void => {
    window.pomade.localHistory.purge(p.group, p.before).then(
      (gone) => {
        toast(`Deleted ${removalLabel(gone)}.`)
        // Document history and the Git panel's Discarded section read the drafts again.
        if (p.group === 'discarded') useGitOpsStore.setState((s) => ({ draftsNonce: s.draftsNonce + 1 }))
        setChanges((n) => n + 1)
      },
      (err: unknown) => toast(`Could not delete the versions: ${cleanIpcError(err)}`, 'error')
    )
  }

  const choices = LOCAL_HISTORY_CAP_CHOICES_MB.includes(capMb)
    ? LOCAL_HISTORY_CAP_CHOICES_MB
    : [...LOCAL_HISTORY_CAP_CHOICES_MB, capMb].sort((a, b) => a - b)
  const nothing = !preview || preview.versions === 0

  return (
    <>
      <div className={`${styles.row} ${styles.rowAfterList}`}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Space for local versions</span>
          <span className={styles.hint} data-testid="lh-usage">
            When local versions take more, the oldest go first.
            {usage ? ` Now: ${formatBytes(usage.bytes)}.` : ''}
          </span>
        </span>
        <select
          className={styles.select}
          data-testid="setting-lh-cap"
          value={capMb}
          onChange={(e) => void pickCap(Number(e.target.value))}
        >
          {choices.map((mb) => (
            <option key={mb} value={mb}>
              {capLabel(mb)}
            </option>
          ))}
        </select>
      </div>

      <p className={`${styles.rowLabel} ${styles.listLabel}`}>Delete versions now</p>
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Group</span>
          <span className={styles.hint}>
            Local versions: files as they changed. Discarded: unsaved text you closed, changes
            discarded in the Git panel.
          </span>
        </span>
        <select
          className={styles.select}
          data-testid="lh-purge-group"
          value={group}
          onChange={(e) => setGroup(e.target.value === 'discarded' ? 'discarded' : 'local')}
        >
          <option value="local">{GROUP_NAME.local}</option>
          <option value="discarded">{GROUP_NAME.discarded}</option>
        </select>
      </div>
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Older than</span>
        </span>
        <select
          className={styles.select}
          data-testid="lh-purge-age"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {PURGE_AGES.map((d) => (
            <option key={d} value={d}>
              {ageLabel(d)}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel} data-testid="lh-purge-preview">
            {nothing ? 'Nothing to delete' : removalLabel(preview)}
          </span>
          <span className={styles.hint}>
            {scopeLabel(group, days).replace(/^./, (c) => c.toUpperCase())}, in this workspace.
          </span>
        </span>
        <button
          type="button"
          className={`${styles.btn} ${styles.rowAction}`}
          data-testid="lh-purge"
          disabled={nothing}
          onClick={() => void askPurge()}
        >
          Delete…
        </button>
      </div>

      {pending?.kind === 'cap' && (
        <ConfirmDialog
          title={`Lower the space to ${capLabel(pending.capMb)}?`}
          message={`${removalLabel(pending.size)} will be deleted now — the oldest local versions, until the rest fit in ${capLabel(pending.capMb)}. This can’t be undone.`}
          confirmLabel="Lower and delete"
          onConfirm={() => void setCapMb(pending.capMb)}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'purge' && (
        <ConfirmDialog
          title={`Delete ${pending.preview.group === 'local' ? 'local' : 'discarded'} versions?`}
          message={`${removalLabel(pending.preview)} will be deleted: ${scopeLabel(pending.preview.group, pending.days)}, in this workspace. This can’t be undone.`}
          onConfirm={() => runPurge(pending.preview)}
          onClose={() => setPending(null)}
        />
      )}
    </>
  )
}
