// Pomade — T-184 link navigation for the editor pane: the doc's link-resolution bases (its own
// directory → project root → workspace root, the same LinkContext the terminal uses), the Cmd+click
// ambiguity picker's state, and the deterministic `__pomadeEditorLinkResolve` e2e probe. Handed to
// whichever editor engine is mounted; refs keep the bases live under a long-lived pane.

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

import {
  scanLineRegions,
  resolveRegion,
  type EditorLinkNav,
  type EditorLinkPickerState,
  type LinkContext
} from './editor-links'

export function useEditorLinkNav(
  pathRef: MutableRefObject<string>,
  wsRoot: string | null,
  rootPath: string,
  tabId: string
): {
  linkNav: EditorLinkNav
  linkPicker: EditorLinkPickerState | null
  setLinkPicker: (s: EditorLinkPickerState | null) => void
} {
  // The Cmd+click link ambiguity picker (a wikilink basename / bare name with several matches).
  // The CM extension / PM plugin ask for it via the nav callback.
  const [linkPicker, setLinkPicker] = useState<EditorLinkPickerState | null>(null)

  const wsRootRef = useRef(wsRoot)
  wsRootRef.current = wsRoot
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath
  const linkNav = useRef<EditorLinkNav>({
    getContext: (): LinkContext => {
      const p = pathRef.current
      const wsRootAbs = wsRootRef.current ?? ''
      const rp = rootPathRef.current
      const projectRootAbs = rp ? `${wsRootAbs}/${rp}` : wsRootAbs
      let cwdAbs: string
      if (!p) {
        cwdAbs = projectRootAbs // unsaved doc — resolve relative to the project root
      } else if (p.startsWith('/')) {
        const i = p.lastIndexOf('/') // outside-workspace absolute path — its own directory
        cwdAbs = i > 0 ? p.slice(0, i) : '/'
      } else {
        const i = p.lastIndexOf('/') // ws-relative path — <wsRoot>/<its directory>
        const relDir = i >= 0 ? p.slice(0, i) : ''
        cwdAbs = relDir ? `${wsRootAbs}/${relDir}` : wsRootAbs
      }
      return { cwdAbs, projectRootAbs, wsRootAbs }
    },
    onAmbiguous: (picker) => setLinkPicker(picker)
  }).current

  // T-184 e2e hook (precedent: `__pomadeTermLinkResolve`): does a line of text hold a link that
  // RESOLVES on disk (i.e. would underline) in THIS doc's context? Lets specs assert the "no dead
  // links" invariant deterministically, using the pane's real resolution bases. Not app surface —
  // only the real Cmd+hover DOM decoration drives navigation. Keyed by tab id.
  useEffect(() => {
    const registry = window as unknown as {
      __pomadeEditorLinkResolve?: Record<string, (text: string) => Promise<boolean>>
    }
    const map = (registry.__pomadeEditorLinkResolve ??= {})
    map[tabId] = async (text: string) => {
      const ctx = linkNav.getContext()
      const results = await Promise.all(
        scanLineRegions(text).map((r) => resolveRegion(r, ctx))
      )
      return results.some((r) => r !== null)
    }
    return () => {
      delete map[tabId]
    }
  }, [tabId, linkNav])

  return { linkNav, linkPicker, setLinkPicker }
}
