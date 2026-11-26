// Pomade Wave 2c — per-file capabilities: which CodeMirror language to load, and
// whether the doc has a "rich" (non-raw) rendered mode (markdown → Milkdown, csv → table).

import type { Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { yaml } from '@codemirror/lang-yaml'

import { basename } from '../../lib/path-display'

/** The "rich" rendered mode a file supports, if any. Maps onto DocTab.mode==='rendered'. */
export type RichKind = 'markdown' | 'table' | null

export function extOf(path: string): string {
  // Deliberately NOT `basename(path)`: unlike basename's display fallback (whole path back when
  // the slice is empty), a trailing-slash path here must extract from an empty base (no ext) —
  // this is pure extension arithmetic, not a display split.
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

// T-179 — re-exported (not reimplemented): this was the one canonical `basename` in the renderer,
// now backed by `lib/path-display.ts` alongside every other former copy.
export { basename }

/**
 * The single source of truth for the markdown extensions (E-023). `isMarkdownPath` /
 * `richKindFor` / `languageLabel` / `languageExtension` and the raw-mode prose gate all read it,
 * and the file-tree icon set (`filetree/icons.tsx`) imports it instead of keeping a partial copy
 * (T-096) — so `.markdown`/`.mkd`/`.mdown`/`.mdx` are first-class everywhere `.md` is.
 */
export const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])
const HTML_EXTS = new Set(['html', 'htm'])

/**
 * T-077 — files whose LANGUAGE owns angle brackets: lang-html's `autoCloseTags` completes
 * `<p>` → `<p></p>` (and `</` → the matching close tag), which is more valuable in HTML than the
 * generic `<>` pair, and the two cannot share the `>` keystroke. So `<>` auto-close is dropped
 * from the bracket set for exactly these extensions (see cm-pairs.ts); every other text format
 * keeps it.
 */
export function hasTagCompletion(path: string): boolean {
  return HTML_EXTS.has(extOf(path))
}

export function richKindFor(path: string): RichKind {
  if (isMarkdownPath(path)) return 'markdown'
  if (extOf(path) === 'csv') return 'table'
  return null
}

/**
 * E-023 — the single source of truth for "this path is a markdown file". `MARKDOWN_EXTS` covers
 * `.md`/`.markdown`/`.mdown`/`.mkd`/`.mdx`; every opener (file tree, symlink popover, terminal
 * links, go-to-path) uses THIS to decide the initial doc mode, so all markdown extensions open
 * rendered-by-default (governed by the "New markdown opens as" setting) instead of only literal
 * `.md`. Openers previously hardcoded `endsWith('.md')`, which left the other extensions raw.
 *
 * T-192 — an unsaved **Untitled** doc has no path yet (`path === ''`). BY POLICY, not detection,
 * it counts as markdown: ~95% of new docs are saved as `.md`, and nothing is lost by giving an
 * extensionless unsaved buffer the full markdown treatment (rich view switch, prose spellcheck,
 * the header's rich-view control) from creation. The first save assigns a real extension — saving
 * as `.md` keeps everything, a non-md extension reclassifies the tab (the one legitimate moment
 * those features disappear). An empty path is the precise "untitled/unsaved" signal: a saved doc
 * always carries its workspace-relative path.
 */
export function isMarkdownPath(path: string): boolean {
  return path === '' || MARKDOWN_EXTS.has(extOf(path))
}

/**
 * E-020 (T-086) — extensions the DOCUMENT EDITOR has no business opening: images and common
 * binary containers. Loading one into CodeMirror as UTF-8 produces a screenful of replacement
 * characters and, for anything large, a stalled pane — so a Cmd+clicked terminal link pointing
 * at one of these is REVEALED IN FINDER instead (see the E-020 routing matrix).
 *
 * `IMAGE_EXTS` is the single source of truth for "this is an image" across the app: the file
 * tree's icon set imports it (it used to keep a private copy of the same list).
 */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

const BINARY_EXTS = new Set([
  // archives / disk images / packages
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'pkg', 'iso', 'jar', 'asar',
  // documents that are containers, not text
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages', 'epub',
  // databases
  'db', 'sqlite', 'sqlite3', 'realm',
  // fonts / icons
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'icns', 'ico',
  // media
  'mp3', 'wav', 'aiff', 'flac', 'm4a', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  // compiled artifacts
  'so', 'dylib', 'o', 'a', 'node', 'wasm', 'class', 'pyc', 'exe', 'bin'
])

/** True when `path` should NOT be opened in the editor (image or binary by extension). */
export function opensInEditor(path: string): boolean {
  const ext = extOf(path)
  return !IMAGE_EXTS.has(ext) && !BINARY_EXTS.has(ext)
}

/** A human label for the raw-mode syntax, shown in the pane header. */
export function languageLabel(path: string): string {
  const ext = extOf(path)
  // T-192 — an Untitled (empty-path) buffer reads as Markdown, matching its policy doc kind.
  if (isMarkdownPath(path)) return 'Markdown'
  if (ext === 'csv') return 'CSV'
  if (ext === 'json') return 'JSON'
  if (ext === 'js' || ext === 'cjs' || ext === 'mjs') return 'JavaScript'
  if (ext === 'jsx') return 'JSX'
  if (ext === 'ts') return 'TypeScript'
  if (ext === 'tsx') return 'TSX'
  if (ext === 'css') return 'CSS'
  if (HTML_EXTS.has(ext)) return 'HTML'
  if (ext === 'yaml' || ext === 'yml') return 'YAML'
  return ext ? ext.toUpperCase() : 'Plain text'
}

/** Build the CodeMirror language extension for a path (empty array = plain text). */
export function languageExtension(path: string): Extension {
  const ext = extOf(path)
  // T-153 — GFM base (tables, task lists, strikethrough, autolinks) instead of CommonMark, so
  // the raw editor's syntax tree carries `Table` nodes: T-153's mono-pin (cm-mono-pin.ts) styles
  // whole tables monospace, which requires those nodes to exist. Same base the Live view uses
  // (cm-live.ts). A mild highlighting improvement for the other GFM constructs comes free.
  if (isMarkdownPath(path)) return markdown({ base: markdownLanguage })
  if (ext === 'json') return json()
  if (ext === 'js' || ext === 'cjs' || ext === 'mjs') return javascript()
  if (ext === 'jsx') return javascript({ jsx: true })
  if (ext === 'ts') return javascript({ typescript: true })
  if (ext === 'tsx') return javascript({ jsx: true, typescript: true })
  if (ext === 'css') return css()
  // Tag auto-closing stays ON: it is the better behavior in HTML, so T-077 keeps `<>` out of the
  // bracket set here instead (see `hasTagCompletion`).
  if (HTML_EXTS.has(ext)) return html()
  if (ext === 'yaml' || ext === 'yml') return yaml()
  return []
}
