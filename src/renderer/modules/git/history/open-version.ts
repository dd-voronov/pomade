// Pomade — T-226: open a fixed version of a document in its own editable tab (a version tab,
// shared/doc-version.ts). One tab per version: opening it again focuses the open tab. The tab is
// titled with the name the document had in that version (`T-2.md @ Nov 17 12:49` for a local
// version from before a rename to T-3.md). It opens in the document's own view (Raw / Live /
// Rendered) when the document is open, else in the default for its kind. A version that cannot
// be read (gone, binary, over 2 MB) throws its plain sentence and opens nothing.

import { nanoid } from 'nanoid'

import { isDocTabOf, sameVersion, versionLabel, versionPath, versionTabTitle, type VersionSource } from '@shared/doc-version'
import type { DocTab, Id } from '@shared/types'
import { useTabsStore } from '../../../stores/tabs-store'
import { initialDocMode } from '../../editor/open-mode'
import { readVersion } from './version-text'

export async function openVersionTab(projectId: Id, docPath: string, source: VersionSource): Promise<void> {
  await readVersion(source)
  const tabs = useTabsStore.getState()
  const open = tabs.tabsFor(projectId)
  const existing = open.find(
    (t): t is DocTab => t.kind === 'doc' && t.path === docPath && !!t.version && sameVersion(t.version.source, source)
  )
  if (existing) {
    tabs.setActive(projectId, existing.id)
    return
  }
  const docTab = open.find((t): t is DocTab => t.kind === 'doc' && isDocTabOf(t, docPath))
  const label = versionLabel(source, Date.now())
  const tab: DocTab = {
    id: nanoid(),
    projectId,
    kind: 'doc',
    title: versionTabTitle(versionPath(source, docPath), label),
    path: docPath,
    mode: docTab?.mode ?? initialDocMode(docPath),
    ...(docTab?.richView ? { richView: docTab.richView } : {}),
    dirty: false,
    version: { source, label }
  }
  tabs.openTab(tab)
}
