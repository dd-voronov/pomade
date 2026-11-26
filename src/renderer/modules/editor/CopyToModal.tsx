// Pomade E-001 (T-010) — "Copy file to…" destination picker. A simple workspace-scoped
// folder tree: pick a folder, confirm, and EditorPane calls fs.copyTo. Directories are
// loaded lazily (one level per expand), matching the file tree.

import { useCallback, useEffect, useState } from 'react'

import type { FileNode } from '@shared/types'
import styles from './EditorPane.module.css'
import dialog from '../../components/dialog.module.css'

interface CopyToModalProps {
  fileName: string
  onCancel: () => void
  onConfirm: (destDirRel: string) => void
}

export function CopyToModal({ fileName, onCancel, onConfirm }: CopyToModalProps): React.JSX.Element {
  const [childrenByPath, setChildren] = useState<Record<string, FileNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string>('') // workspace root by default

  const loadDir = useCallback(async (path: string): Promise<void> => {
    try {
      const node = await window.pomade.fs.tree(path, 1)
      const dirs = (node.children ?? []).filter((c) => c.kind === 'dir')
      setChildren((prev) => ({ ...prev, [path]: dirs }))
    } catch {
      /* directory vanished — ignore */
    }
  }, [])

  useEffect(() => {
    void loadDir('')
  }, [loadDir])

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!childrenByPath[path]) void loadDir(path)
      }
      return next
    })
  }

  const renderNodes = (dir: string): React.JSX.Element[] => {
    const nodes = childrenByPath[dir] ?? []
    return nodes.map((node) => {
      const isOpen = expanded.has(node.path)
      return (
        <div key={node.path} className={styles.copytoBranch}>
          <div
            className={`${styles.copytoRow} ${selected === node.path ? styles.copytoRowSel : ''}`}
            data-testid={`copyto-node-${node.path}`}
            data-selected={selected === node.path ? 'true' : undefined}
            onClick={() => setSelected(node.path)}
          >
            <button
              type="button"
              className={`${styles.copytoTwisty} ${isOpen ? styles.copytoTwistyOpen : ''}`}
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation()
                toggle(node.path)
              }}
            >
              ▸
            </button>
            <span className={styles.copytoName}>{node.name}</span>
          </div>
          {isOpen && <div className={styles.copytoChildren}>{renderNodes(node.path)}</div>}
        </div>
      )
    })
  }

  return (
    <div className={dialog.modalScrim} data-testid="copyto-modal">
      <div className={dialog.modal} role="dialog" aria-label="Copy file to folder">
        <div className={dialog.modalTitle}>Copy “{fileName}” to…</div>
        <div className={styles.copytoTree}>
          <div
            className={`${styles.copytoRow} ${selected === '' ? styles.copytoRowSel : ''}`}
            data-testid="copyto-root"
            data-selected={selected === '' ? 'true' : undefined}
            onClick={() => setSelected('')}
          >
            <span className={styles.copytoTwistyFixed} aria-hidden="true" />
            <span className={styles.copytoName}>&lt;workspace root&gt;</span>
          </div>
          {renderNodes('')}
        </div>
        <div className={dialog.modalRow}>
          <button
            type="button"
            className={dialog.btnGhost}
            data-testid="copyto-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={dialog.btnPrimary}
            data-testid="copyto-confirm"
            onClick={() => onConfirm(selected)}
          >
            Copy here
          </button>
        </div>
      </div>
    </div>
  )
}
