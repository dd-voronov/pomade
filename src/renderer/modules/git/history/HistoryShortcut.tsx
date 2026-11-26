// Pomade — E-038: Cmd+Shift+H (Ctrl+Shift+H elsewhere) opens or closes the active doc's History
// panel. On a comparison tab it opens the left version chip's list (T-224); on a version tab, the
// document's History. Matched on the physical
// key (`KeyH`) so it holds under any keyboard layout, in the capture phase so a focused terminal
// or editor never sees it first.

import { useEffect } from 'react'

import { useToast } from '../../../hooks/useToast'
import { useTabsStore } from '../../../stores/tabs-store'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { useVersionChipStore } from '../compare/version-chip-store'
import { openDocHistory, useDocHistoryStore } from './doc-history-store'

export function HistoryShortcut(): null {
  const toast = useToast()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey
      if (!mod || !e.shiftKey || e.altKey || e.code !== 'KeyH') return
      e.preventDefault()
      e.stopPropagation()
      const pid = useWorkspaceStore.getState().activeProjectId
      const tabs = useTabsStore.getState()
      const tab = (tabs.tabsByProject[pid] ?? []).find((t) => t.id === tabs.activeTabByProject[pid])
      // A version tab (T-226) opens its document's History.
      if (tab?.kind === 'doc' && tab.path && tab.version) openDocHistory(pid, tab.path)
      else if (tab?.kind === 'doc' && tab.path) useDocHistoryStore.getState().toggle(tab.id)
      else if (tab?.kind === 'compare') useVersionChipStore.getState().show(tab.id, 'left')
      else toast('Open a saved document to see its history (Cmd+Shift+H).', 'info')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [toast])
  return null
}
