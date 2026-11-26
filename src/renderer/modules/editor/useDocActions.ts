// Pomade — the editor pane's document/context-menu action handlers: open-a-target (image chip /
// link popover), duplicate, copy-to, copy path, reveal in Finder, the clipboard cut/copy/paste that
// act on the right-click selection snapshot, find-&-replace, and start-an-agent-chat. Plus the agent
// roster (for the context menu) and the Copy-to picker's open state.

import { useEffect, useMemo, useState, type MutableRefObject } from 'react'

import type { AgentInfo, Project } from '@shared/types'
import { useTabsStore } from '../../stores/tabs-store'
import { useTerminalsStore } from '../../stores/terminals-store'
import { basename } from './doc-kind'
import { duplicatePath, isOutsidePath } from './doc-io'
import { normalizeHref } from './editor-links'
import { cleanIpcError } from '../../lib/ipc-errors'
import type { EditorController } from './editor-controller'
import type { MenuState } from './useEditorContextMenu'

export interface DocActions {
  visibleAgents: AgentInfo[]
  copyToOpen: boolean
  setCopyToOpen: (v: boolean) => void
  openDocTab: (rel: string) => void
  handleOpenTarget: (target: string) => void
  handleDuplicate: () => void
  handleCopyTo: () => void
  confirmCopyTo: (destDir: string) => void
  handleCopyPath: () => void
  handleCopyFullPath: () => void
  revealInFinder: () => void
  handleCopy: () => void
  handleCut: () => void
  handlePaste: () => void
  handleFindReplace: () => void
  handleNewAgentChat: (agent: AgentInfo) => void
}

export function useDocActions(params: {
  projectId: string
  path: string
  wsRoot: string | null
  project: Project | undefined
  menu: MenuState | null
  controllerRef: MutableRefObject<EditorController | null>
  openFind: (prefill?: string) => void
  toast: (message: string, tone?: 'info' | 'error') => void
}): DocActions {
  const { projectId, path, wsRoot, project, menu, controllerRef, openFind, toast } = params

  const [copyToOpen, setCopyToOpen] = useState(false)
  const [roster, setRoster] = useState<AgentInfo[]>([])

  useEffect(() => {
    let cancelled = false
    void window.pomade.agents
      .roster()
      .then((r) => {
        if (!cancelled) setRoster(r)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const visibleAgents = useMemo(() => {
    if (!project) return []
    if (project.visibleAgents.includes('*')) return roster
    return roster.filter((a) => project.visibleAgents.includes(a.id))
  }, [project, roster])

  // T-170 — thin wrapper over the shared `openDocByPath` action (dedupe-or-activate, mode,
  // symlink stat, right-of-active positioning). Always a REAL tab (no `usePreviewMode`), matching
  // this pane's current behavior for its internal opens (image chip / link popover / duplicate /
  // copy-to) — none of them ever consulted the T-063 preview-tab setting.
  const openDocTab = (rel: string): void => {
    useTabsStore.getState().openDocByPath(projectId, rel)
  }

  // E-024 — a live-view image chip was clicked, or a link popover's Open pressed.
  // `target` is the markdown destination as written, normalized by the SAME `normalizeHref` the
  // Cmd+click layer uses (`<…>`, `file://`, `?query`/`#fragment`, percent-escapes): http(s) opens
  // in the default browser; a local path resolves against THIS doc's folder (or stands alone when
  // absolute — an absolute path inside the workspace becomes workspace-relative, so it is a normal
  // tab, not the outside-workspace class) and opens as its own tab — the app's standing behavior
  // for a non-editor path (an image tab shows the type refusal panel with Reveal in Finder).
  const handleOpenTarget = (target: string): void => {
    const href = normalizeHref(target)
    if (!href) return
    if (href.kind === 'url') {
      void window.pomade.app.openExternal(href.url)
      return
    }
    let resolved: string
    if (href.path.startsWith('/')) {
      resolved =
        wsRoot && href.path.startsWith(`${wsRoot}/`) ? href.path.slice(wsRoot.length + 1) : href.path
    } else {
      // Resolve `./`/`../` segments against the doc's directory (workspace-relative).
      const baseDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const segs = (baseDir ? baseDir.split('/') : []).concat(href.path.split('/'))
      const out: string[] = []
      for (const s of segs) {
        if (s === '' || s === '.') continue
        if (s === '..') out.pop()
        else out.push(s)
      }
      resolved = out.join('/')
    }
    openDocTab(resolved)
  }

  const requireSaved = (): boolean => {
    if (path) return true
    toast('Save the document first.', 'error')
    return false
  }

  const handleDuplicate = (): void => {
    if (!requireSaved()) return
    void (async () => {
      try {
        const rel = await duplicatePath(path)
        openDocTab(rel)
        toast(`Duplicated to ${basename(rel)}`)
      } catch (err) {
        toast(cleanIpcError(err), 'error')
      }
    })()
  }

  const handleCopyTo = (): void => {
    if (requireSaved()) setCopyToOpen(true)
  }

  const confirmCopyTo = (destDir: string): void => {
    setCopyToOpen(false)
    void (async () => {
      try {
        const rel = await window.pomade.fs.copyTo(path, destDir)
        openDocTab(rel)
        toast(`Copied to ${rel}`)
      } catch (err) {
        toast(cleanIpcError(err), 'error')
      }
    })()
  }

  const handleCopyPath = (): void => {
    if (!requireSaved()) return
    void window.pomade.app.clipboardWrite(path)
    toast('Copied path')
  }

  const handleCopyFullPath = (): void => {
    if (!requireSaved()) return
    const full = wsRoot ? `${wsRoot}/${path}` : path
    void window.pomade.app.clipboardWrite(full)
    toast('Copied full path')
  }

  // T-106 — the absolute path of this doc, for the refusal panel's Reveal-in-Finder button. An
  // outside-workspace doc already stores its absolute path (leading '/'); an in-workspace doc's
  // path is workspace-relative, so prepend the workspace root (same as handleCopyFullPath).
  const revealInFinder = (): void => {
    if (!path) return
    const abs = isOutsidePath(path) ? path : wsRoot ? `${wsRoot}/${path}` : path
    void window.pomade.app.showItemInFolder(abs)
  }

  const handleCopy = (): void => {
    const t = menu?.selectionText ?? ''
    if (t) void window.pomade.app.clipboardWrite(t)
  }
  const handleCut = (): void => {
    if (!menu) return
    if (menu.selectionText) void window.pomade.app.clipboardWrite(menu.selectionText)
    controllerRef.current?.replaceRange(menu.from, menu.to, '')
  }
  const handlePaste = (): void => {
    const m = menu
    if (!m) return
    void (async () => {
      const t = await window.pomade.app.clipboardRead()
      if (t) controllerRef.current?.replaceRange(m.from, m.to, t)
    })()
  }

  const handleFindReplace = (): void => {
    const t = menu?.selectionText ?? ''
    openFind(t ? t.split('\n')[0] : undefined)
  }

  const handleNewAgentChat = (agent: AgentInfo): void => {
    if (!requireSaved() || !project) return
    const instruction = `Read ${path}`
    const sel = menu?.hasSelection ? menu.selectionText : undefined
    void useTerminalsStore.getState().startAgentWithContext(project, agent, {
      instruction,
      ...(sel ? { typeText: sel } : {})
    })
    toast(`Starting ${agent.name}…`)
  }

  return {
    visibleAgents,
    copyToOpen,
    setCopyToOpen,
    openDocTab,
    handleOpenTarget,
    handleDuplicate,
    handleCopyTo,
    confirmCopyTo,
    handleCopyPath,
    handleCopyFullPath,
    revealInFinder,
    handleCopy,
    handleCut,
    handlePaste,
    handleFindReplace,
    handleNewAgentChat
  }
}
