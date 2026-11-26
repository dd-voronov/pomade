// Pomade — the file-tree section header toolbar (title + selection count + collapse / new-file /
// new-folder / ⋯ options buttons), extracted from FileTree in T-159. Pure presentational: every
// data-testid preserved; all actions arrive via props.

import { Tooltip } from '../../components/Tooltip'
import { KebabIcon, NewFolderIcon } from './icons'
import styles from './FileTree.module.css'

export interface TreeToolbarProps {
  selectionCount: number
  onCollapse: () => void
  onNewFile: () => void
  onNewFolder: () => void
  onSectionMenu: (e: React.MouseEvent) => void
}

export function TreeToolbar({
  selectionCount,
  onCollapse,
  onNewFile,
  onNewFolder,
  onSectionMenu
}: TreeToolbarProps): React.JSX.Element {
  return (
    <div className={styles.header}>
      <span className={styles.headerTitle}>
        Files
        {/* E-018 — how many rows a bulk action would hit, shown only while multi-selecting. */}
        {selectionCount > 1 && (
          <span className={styles.selCount} data-testid="tree-selection-count">
            {selectionCount}
          </span>
        )}
      </span>
      <span className={styles.headerActions}>
        <Tooltip lines={['Collapse side panel (Cmd+Shift+B)']}>
          <button
            type="button"
            className={styles.headerBtn}
            aria-label="Collapse side panel"
            data-testid="filetree-collapse"
            onClick={onCollapse}
          >
            «
          </button>
        </Tooltip>
        <Tooltip lines={['New file']}>
          <button
            type="button"
            className={styles.headerBtn}
            aria-label="New file"
            data-testid="tree-new-file"
            onClick={onNewFile}
          >
            ＋
          </button>
        </Tooltip>
        {/* T-144 — New folder wears the folder-with-plus glyph (reassigned from the old Mount
            button, which moved into the ⋯ kebab). */}
        <Tooltip lines={['New folder']}>
          <button
            type="button"
            className={styles.headerBtn}
            aria-label="New folder"
            data-testid="tree-new-folder"
            onClick={onNewFolder}
          >
            <NewFolderIcon />
          </button>
        </Tooltip>
        {/* T-144 — the section ⋯ kebab: ignored items… · show/hide ignored items · mount a folder. */}
        <Tooltip lines={['File tree options']}>
          <button
            type="button"
            className={styles.headerBtn}
            aria-label="File tree options"
            data-testid="tree-section-kebab"
            onClick={onSectionMenu}
          >
            <KebabIcon />
          </button>
        </Tooltip>
      </span>
    </div>
  )
}
