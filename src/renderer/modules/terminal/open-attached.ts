// Pomade — E-034: opening an attached terminal tab (docs/modules/terminal/attached-terminals.md).
// One tab per session per project: the same reference focuses the open tab. The title is the one
// the caller gave, else the session's own (the pane takes it from the keeper once attached).

import { nanoid } from 'nanoid'
import type { SessionRef } from 'pomade-kit/protocol'

import type { AttachedTab, Id } from '@shared/types'
import { useTabsStore } from '../../stores/tabs-store'

export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return a.app === b.app && a.session === b.session
}

/** Open (or focus) the attached tab for `session` in `projectId`, right of the active tab. */
export function openAttachedTab(projectId: Id, session: SessionRef, title?: string): void {
  const tabs = useTabsStore.getState()
  const existing = tabs
    .tabsFor(projectId)
    .find((t): t is AttachedTab => t.kind === 'attached' && sameSession(t.session, session))
  if (existing) {
    if (title !== undefined && title !== existing.title) tabs.updateTab(projectId, existing.id, { title, renamed: true })
    tabs.setActive(projectId, existing.id)
    return
  }
  const tab: AttachedTab = {
    id: nanoid(),
    projectId,
    kind: 'attached',
    session: { app: session.app, session: session.session },
    title: title ?? session.session,
    ...(title !== undefined ? { renamed: true } : {})
  }
  tabs.openTab(tab)
}
