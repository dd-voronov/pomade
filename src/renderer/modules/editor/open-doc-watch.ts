// Pomade — E-035 (rule 8): keeps main's open-doc watcher (`fs.watchDocs`) in step with every
// doc tab in every project, and fans its `fs:doc-changed` events out to the editor panes through
// ONE IPC listener (a listener per pane would grow with the number of open docs).

import { useTabsStore } from '../../stores/tabs-store'
import type { Tab } from '@shared/types'

type Listener = (path: string) => void

const listeners = new Set<Listener>()
let ipcOff: (() => void) | null = null

/** Subscribe to writes on open docs (any writer). The callback receives the doc path; a pane
 *  compares it with its own. Returns an unsubscribe fn. */
export function onOpenDocChanged(cb: Listener): () => void {
  if (!ipcOff) {
    ipcOff = window.pomade.fs.onDocChanged((path) => {
      for (const l of listeners) l(path)
    })
  }
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function openDocPaths(tabsByProject: Record<string, Tab[]>): string[] {
  const paths = new Set<string>()
  for (const tabs of Object.values(tabsByProject)) {
    for (const t of tabs) {
      if (t.kind === 'doc' && t.path) paths.add(t.path)
      // E-037 — a comparison's disk and live sides follow the file too.
      if (t.kind === 'compare') {
        for (const s of [t.left, t.right]) if ((s.kind === 'file' || s.kind === 'disk') && s.path) paths.add(s.path)
      }
    }
  }
  return [...paths].sort()
}

/** Declare the open-doc set to main now and on every tab change. Returns a stop fn. */
export function startOpenDocWatch(): () => void {
  let last: string | null = null
  const sync = (tabsByProject: Record<string, Tab[]>): void => {
    const paths = openDocPaths(tabsByProject)
    const key = paths.join('\n')
    if (key === last) return
    last = key
    window.pomade.fs.watchDocs(paths).catch(() => {
      last = null // retry on the next tab change
    })
  }
  sync(useTabsStore.getState().tabsByProject)
  return useTabsStore.subscribe((s, prev) => {
    if (s.tabsByProject !== prev.tabsByProject) sync(s.tabsByProject)
  })
}
