// Pomade — E-035: open the Cmd+Shift+G quick peek for a doc tab. Every doc gets Saved ↔ Unsaved
// (disk vs buffer) — git or not, Untitled included; a doc inside a repo also gets Working vs HEAD
// and HEAD vs Previous. A dirty doc opens on Saved ↔ Unsaved, a clean one in a repo on
// Working vs HEAD.

import type { DocTab } from '@shared/types'
import { useGitUiStore, type PeekMode } from './git-ui-store'

export async function openQuickPeek(tab: DocTab): Promise<void> {
  const inWorkspace = tab.path !== '' && !tab.path.startsWith('/')
  const repo = inWorkspace ? await window.pomade.git.isRepo(tab.path) : false
  const mode: PeekMode = repo && !tab.dirty ? 'working-vs-head' : 'saved-vs-unsaved'
  useGitUiStore.getState().openDiff({ path: tab.path, tabId: tab.id, title: tab.title, repo, mode })
}
