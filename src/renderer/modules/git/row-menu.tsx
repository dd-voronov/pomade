// Pomade — T-228: the right-click menu of a row that opens a tab (a Changes, In progress or History
// row in the Git panel; a file or commit row in a commit or branch tab). A single click opens the
// row through the preview slot; the menu's "Open in a new tab" opens a tab that stays.
//
// The menu renders in a portal on <body> (no row layout or clipping applies to it), inside a
// wrapper that stops React's events: a portal still bubbles through the React tree, so an item
// click would otherwise reach the row's onClick and open the preview as well.

import { useState } from 'react'
import { createPortal } from 'react-dom'

import { ContextMenu, type MenuItem } from '../../components/ContextMenu'

/** Test id of every row menu, and of its "Open in a new tab" item. */
export const ROW_MENU_TEST_ID = 'git-row-menu'
export const OPEN_IN_NEW_TAB_TEST_ID = 'row-menu-open-new-tab'

/** The item that opens the row in a tab that is not the preview. `label` names what opens when it
 *  is not the row's usual comparison. */
export function openInNewTabItem(onSelect: () => void, label = 'Open in a new tab'): MenuItem {
  return { label, testId: OPEN_IN_NEW_TAB_TEST_ID, onSelect }
}

/** A file a commit deleted opens its removed content against nothing. */
export const OPEN_DELETION_LABEL = 'Open the deletion in a new tab'

/** An uncommitted deleted file opens its last committed version in the deleted-file view (an
 *  overlay with Restore file), which is not a tab. */
export const VIEW_LAST_VERSION_LABEL = 'View last committed version'

/** An untracked folder's row reveals the folder in the file tree; nothing opens in a tab. */
export const SHOW_IN_FILE_TREE_LABEL = 'Show in file tree'

const stop = (e: React.SyntheticEvent): void => e.stopPropagation()

/** A row's right-click menu: spread `onContextMenu` onto the row and render `menu` anywhere in it.
 *  `items` is read when the menu opens. */
export function useRowMenu(items: () => MenuItem[]): {
  onContextMenu: (e: React.MouseEvent) => void
  menu: React.ReactNode
} {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setAt({ x: e.clientX, y: e.clientY })
  }
  const menu = at
    ? createPortal(
        <div style={{ display: 'contents' }} onClick={stop} onMouseDown={stop} onDoubleClick={stop} onContextMenu={stop} onKeyDown={stop}>
          <ContextMenu x={at.x} y={at.y} items={items()} onClose={() => setAt(null)} testId={ROW_MENU_TEST_ID} />
        </div>,
        document.body
      )
    : null
  return { onContextMenu, menu }
}
