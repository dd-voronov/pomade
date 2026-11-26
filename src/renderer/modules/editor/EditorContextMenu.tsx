// Pomade E-001 (T-010/T-011) — the editor context menu, built on the shared ContextMenu primitive
// (T-158). Two variants driven by whether there's a selection. Its mount is DEFERRED by EditorPane
// (T-083 r2: parked in onContextMenu, mounted on main's EV.spellContext push) — unchanged here, the
// primitive just clamps whenever it mounts. `preserveFocus` keeps the editor selection live while a
// Cut/Copy/Paste item is clicked; `remeasureKey={spell}` re-clamps when the spelling section pops in.

import type { AgentInfo } from '@shared/types'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import styles from './EditorPane.module.css'

export interface EditorContextMenuProps {
  x: number
  y: number
  hasSelection: boolean
  agents: AgentInfo[]
  onClose: () => void
  // no-selection (T-010)
  onDuplicate: () => void
  onCopyTo: () => void
  onCopyPath: () => void
  onCopyFullPath: () => void
  // with-selection (T-011)
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onFindReplace: () => void
  // both: launch an agent chat with the file (and, when there's a selection, the selection)
  onNewAgentChat: (agent: AgentInfo) => void
  // T-083 — the misspelled word under the right-click (null = spelled fine / not over text).
  // Suggestions arrive from main a beat after the menu opens, so this section pops in.
  spell: { word: string; suggestions: string[] } | null
  onReplaceMisspelling: (suggestion: string) => void
  onAddToDictionary: (word: string) => void
}

export function EditorContextMenu(props: EditorContextMenuProps): React.JSX.Element {
  const { x, y, hasSelection, agents, spell } = props

  // The agents flyout is anchored to its row; no room on the right → it opens to the LEFT.
  const agentItem: MenuItem = {
    label: hasSelection ? 'New agent chat' : 'New agent chat with this file in context',
    testId: 'menu-new-agent-chat',
    submenuTestId: 'menu-agent-submenu',
    preserveFocus: true,
    submenuEmpty: 'No agents available',
    submenuEmptyTestId: 'menu-agent-empty',
    submenu: agents.map<MenuItem>((agent) => ({
      label: agent.name,
      testId: `menu-agent-${agent.id}`,
      trailing: !agent.resolved ? (
        <span className={styles.ctxBadge} title="Command not found — will report in the terminal">
          !
        </span>
      ) : undefined,
      onSelect: () => props.onNewAgentChat(agent)
    }))
  }

  const spellSection: MenuItem[] = spell
    ? [
        ...(spell.suggestions.length > 0
          ? spell.suggestions.map<MenuItem>((s) => ({
              label: s,
              testId: `menu-spell-${s}`,
              itemClassName: styles.ctxSpellSuggestion,
              onSelect: () => props.onReplaceMisspelling(s)
            }))
          : [{ emptyText: 'No spelling suggestions', emptyTestId: 'menu-spell-empty' } as MenuItem]),
        {
          label: <>Add “{spell.word}” to dictionary</>,
          testId: 'menu-spell-add',
          onSelect: () => props.onAddToDictionary(spell.word)
        },
        { separator: true }
      ]
    : []

  const body: MenuItem[] = hasSelection
    ? [
        { label: 'Cut', testId: 'menu-cut', onSelect: props.onCut },
        { label: 'Copy', testId: 'menu-copy', onSelect: props.onCopy },
        { label: 'Paste', testId: 'menu-paste', onSelect: props.onPaste },
        { separator: true },
        { label: 'Find & replace', testId: 'menu-find-replace', onSelect: props.onFindReplace },
        { separator: true },
        agentItem
      ]
    : [
        { label: 'Duplicate file', testId: 'menu-duplicate-file', onSelect: props.onDuplicate },
        { label: 'Copy file to…', testId: 'menu-copy-file-to', onSelect: props.onCopyTo },
        { separator: true },
        agentItem,
        { separator: true },
        { label: 'Copy path', testId: 'menu-copy-path', onSelect: props.onCopyPath },
        { label: 'Copy full path', testId: 'menu-copy-full-path', onSelect: props.onCopyFullPath }
      ]

  return (
    <ContextMenu
      x={x}
      y={y}
      items={[...spellSection, ...body]}
      onClose={props.onClose}
      testId="editor-context-menu"
      scrimTestId="editor-menu-scrim"
      data={{ 'data-variant': hasSelection ? 'selection' : 'no-selection' }}
      preserveFocus
      remeasureKey={spell}
    />
  )
}
