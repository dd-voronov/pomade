// Pomade — in-document find (T-012) state + wiring for the editor pane. Raw / live modes use
// CodeMirror's own themed search panel; rendered markdown and the CSV table use the custom
// EditorFindPanel, whose state lives here. Owns the Cmd+F accelerator routing and the
// close-on-leave cleanup.

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

import { useTabsStore } from '../../stores/tabs-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import type { EditorController, FindMatchInfo } from './editor-controller'

const NO_MATCHES: FindMatchInfo = { count: 0, current: 0 }

export interface EditorFind {
  findOpen: boolean
  findQuery: string
  findCase: boolean
  findInfo: FindMatchInfo
  /** Open find in the mounted editor; `prefill` seeds the query (e.g. from the selection, T-011). */
  openFind: (prefill?: string) => void
  onFindQueryChange: (q: string) => void
  onFindCaseChange: (v: boolean) => void
  onFindNext: () => void
  onFindPrev: () => void
  closeFind: () => void
}

export function useEditorFind(
  controllerRef: MutableRefObject<EditorController | null>,
  renderedShown: boolean,
  projectId: string,
  tabId: string
): EditorFind {
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findCase, setFindCase] = useState(false)
  const [findInfo, setFindInfo] = useState<FindMatchInfo>(NO_MATCHES)

  // Open in-document find in the mounted editor. Raw → CodeMirror's themed panel; rendered →
  // the custom panel. `prefill` seeds the query (e.g. from the selection, T-011).
  const openFind = (prefill?: string): void => {
    const ctrl = controllerRef.current
    if (!ctrl) return
    if (ctrl.kind === 'raw' || ctrl.kind === 'live') {
      ctrl.openFind?.(prefill)
      return
    }
    const q = prefill ?? ''
    setFindOpen(true)
    setFindQuery(q)
    setFindInfo(q && ctrl.find ? ctrl.find.setQuery(q, { caseSensitive: findCase }) : NO_MATCHES)
  }
  const openFindRef = useRef(openFind)
  openFindRef.current = openFind

  // Cmd+F (app-menu accelerator, T-012). Respond ONLY when this pane is the active doc pane —
  // so the shortcut never fires into terminal panes and no-ops when no editor is active
  // (mirrors the T-036 Cmd+W routing, which also targets the active tab).
  useEffect(() => {
    return window.pomade.app.onEditorFind(() => {
      const activePid = useWorkspaceStore.getState().activeProjectId
      const activeTid = useTabsStore.getState().activeTabByProject[projectId]
      if (activePid !== projectId || activeTid !== tabId) return
      const sel = controllerRef.current?.getSelection()
      openFindRef.current(sel && !sel.empty ? sel.text.split('\n')[0] : undefined)
    })
  }, [projectId, tabId, controllerRef])

  // Close the custom find panel when the pane leaves a find-panel view (rendered md or CSV
  // table) — e.g. a mode toggle back to raw, which has its own CodeMirror search panel.
  useEffect(() => {
    if (!renderedShown && findOpen) {
      controllerRef.current?.find?.clear()
      setFindOpen(false)
    }
  }, [renderedShown, findOpen, controllerRef])

  const applyFindQuery = (q: string, caseSensitive: boolean): void => {
    const find = controllerRef.current?.find
    if (!find) return
    if (q) setFindInfo(find.setQuery(q, { caseSensitive }))
    else {
      find.clear()
      setFindInfo(NO_MATCHES)
    }
  }
  const onFindQueryChange = (q: string): void => {
    setFindQuery(q)
    applyFindQuery(q, findCase)
  }
  const onFindCaseChange = (v: boolean): void => {
    setFindCase(v)
    applyFindQuery(findQuery, v)
  }
  const onFindNext = (): void => {
    const find = controllerRef.current?.find
    if (find) setFindInfo(find.next())
  }
  const onFindPrev = (): void => {
    const find = controllerRef.current?.find
    if (find) setFindInfo(find.prev())
  }
  const closeFind = (): void => {
    controllerRef.current?.find?.clear()
    setFindOpen(false)
    setFindQuery('')
    setFindInfo(NO_MATCHES)
    controllerRef.current?.focus()
  }

  return {
    findOpen,
    findQuery,
    findCase,
    findInfo,
    openFind,
    onFindQueryChange,
    onFindCaseChange,
    onFindNext,
    onFindPrev,
    closeFind
  }
}
