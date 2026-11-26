// Pomade — read a workspace file as a data: URL (empty rel → null). For inline image previews
// (Projects panel identity icons, group and project images, the fields ImagePicker). Moved out of
// modules/projects-panel/fields.tsx (T-169) so it's reachable without a cross-module reach-in.

import { useEffect, useState } from 'react'

export function useDataUrl(rel: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!rel) {
      setUrl(null)
      return
    }
    void window.pomade.fs
      .readDataUrl(rel)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [rel])
  return url
}
