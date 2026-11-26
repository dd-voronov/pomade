// Pomade — E-029: the side panels Pomade itself ships, in strip order. Each fills the side panel
// and always heads the strip, before app icons: Files (the default), Git (E-037), Notices (E-032) —
// the strip, selection, persistence and badges need nothing else.

import type { ComponentType } from 'react'

import { FileTree } from '../filetree/FileTree'
import { GitPanel, GIT_PANEL } from '../git/panel/GitPanel'
import { GitGlyph } from '../git/icons'
import { NoticesGlyph, NoticesPanel, NOTICES_PANEL } from '../notices/NoticesPanel'
import { FILES_PANEL } from './strip-model'

export interface BuiltinPanel {
  key: string
  title: string
  Glyph: () => React.JSX.Element
  /** Mounted once for the life of the column; renders nothing while the column is collapsed
   *  and is hidden (never unmounted) while another panel is shown. */
  Panel: ComponentType
}

/** Files — two stacked sheets, same 18px stroke language as the strip's other glyphs. */
function FilesGlyph(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
        <path d="M6.5 2.5h5l3 3v8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
        <path d="M11.5 2.5v3h3" />
        <path d="M3.5 5.5v9a1 1 0 0 0 1 1h7" />
      </g>
    </svg>
  )
}

export const BUILTIN_PANELS: readonly BuiltinPanel[] = [
  { key: FILES_PANEL, title: 'Files', Glyph: FilesGlyph, Panel: FileTree },
  { key: GIT_PANEL, title: 'Git', Glyph: GitGlyph, Panel: GitPanel },
  { key: NOTICES_PANEL, title: 'Notices', Glyph: NoticesGlyph, Panel: NoticesPanel }
]
