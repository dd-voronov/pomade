// Pomade — T-226: reading a fixed version of a document (a commit's, a local-history snapshot, a
// discarded draft) as raw text. Throws a plain sentence when the version cannot be had: Document
// History's Restore and the version tab both show it as is.

import type { VersionSource } from '@shared/doc-version'

export async function readVersion(source: VersionSource): Promise<string> {
  switch (source.kind) {
    case 'draft': {
      const draft = (await window.pomade.recovery.drafts(source.path)).find((d) => d.id === source.id)
      if (!draft) throw new Error('This version is no longer kept — discarded versions are kept for 7 days.')
      return draft.content
    }
    case 'snapshot': {
      const text = await window.pomade.localHistory.read(source.path, source.id)
      if (text === null) throw new Error('This version is no longer kept — local history keeps 7 days.')
      return text
    }
    case 'rev': {
      const f = await window.pomade.git.fileAt(source.repo, source.rev, source.path)
      if (f.kind === 'text') return f.content
      if (f.kind === 'absent') throw new Error('The file does not exist in that version.')
      if (f.kind === 'binary') throw new Error('That version is a binary file.')
      if (f.kind === 'too-big') throw new Error('That version is larger than 2 MB.')
      throw new Error('That version is no longer in this repository.')
    }
  }
}
