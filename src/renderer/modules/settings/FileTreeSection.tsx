// Pomade E-006 (T-026) — File tree settings section. Absorbs the former standalone
// IgnoreSettingsModal (T-019): the editable ignored items the tree leaves out. Below them, the
// unwatched folders: workspace folders Pomade's watcher and indexes skip by path.
// Persists via workspace-store.updateFileTree → WorkspaceConfig.fileTree (no separate
// storage). The `ignore-settings` testid is kept on the wrapper for e2e continuity.

import { useEffect, useState } from 'react'

import { normalizeUnwatchedFolder } from '@shared/skipped-paths'
import { DEFAULT_TREE_IGNORE } from '@shared/types'
import { useToast } from '../../hooks/useToast'
import { cleanIpcError } from '../../lib/ipc-errors'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { NameListEditor } from './NameListEditor'
import styles from './SettingsModal.module.css'

/** The listed folders that are not on disk now, re-checked whenever the list changes. */
function useMissingFolders(folders: readonly string[]): Set<string> {
  const [missing, setMissing] = useState<Set<string>>(new Set())
  useEffect(() => {
    let live = true
    void Promise.all(
      folders.map(async (f) => ((await window.pomade.fs.exists(f).catch(() => false)) ? null : f))
    ).then((gone) => {
      if (live) setMissing(new Set(gone.filter((f): f is string => f !== null)))
    })
    return () => {
      live = false
    }
  }, [folders])
  return missing
}

export function FileTreeSection(): React.JSX.Element {
  const fileTree = useWorkspaceStore((s) => s.fileTree)
  const updateFileTree = useWorkspaceStore((s) => s.updateFileTree)
  const toast = useToast()
  const missing = useMissingFolders(fileTree.unwatched)

  const pickFolder = async (): Promise<string | null> => {
    try {
      return await window.pomade.fs.pickPath({ directory: true })
    } catch (err) {
      toast(cleanIpcError(err), 'error')
      return null
    }
  }

  return (
    <div data-testid="ignore-settings">
      <p className={styles.sectionTitle}>Ignored items</p>
      <p className={styles.hint}>
        Names the file tree leaves out. To see them dimmed without removing them from this list, open
        the tree's ⋯ menu ▸ Show ignored items.
      </p>
      <NameListEditor
        testIdPrefix="ignore"
        items={fileTree.ignore}
        defaults={DEFAULT_TREE_IGNORE}
        onChange={(ignore) => updateFileTree({ ignore })}
        emptyText="Nothing is ignored — everything shows in the tree."
        placeholder="folder or file name"
        removeLabel={(name) => `Stop ignoring ${name}`}
      />

      <div data-testid="unwatched-settings">
        <p className={`${styles.sectionTitle} ${styles.group}`}>Unwatched folders</p>
        <p className={styles.hint}>
          Add a folder to ignore by the watcher — one full of files that keep changing, such as logs,
          exports or caches. Pomade doesn't follow changes inside it: the file tree still shows it
          and reads it again when you expand it.
        </p>
        <NameListEditor
          testIdPrefix="unwatched"
          items={fileTree.unwatched}
          onChange={(unwatched) => updateFileTree({ unwatched })}
          emptyText="No folders — Pomade watches the whole workspace."
          placeholder="folder path in the workspace, e.g. logs"
          removeLabel={(folder) => `Watch ${folder} again`}
          normalize={normalizeUnwatchedFolder}
          pick={{ label: 'Choose…', run: pickFolder }}
          dimmed={(folder) => missing.has(folder)}
          dimmedLabel="Not in the workspace any more"
        />
      </div>
    </div>
  )
}
