// Pomade — file tree icon set (T-018). Inline SVG, monochrome (currentColor) so every
// icon inherits its color from the row/CSS class — no fixed hex baked in here, so the set
// follows tokens.css (light now, dark later) automatically. Crisp at 1x/2x since it's
// vector, not a bitmap/font glyph.

// E-020 — the image-extension set now lives in doc-kind (where the editor's "can I open this?"
// predicate needs it too); this module used to keep a duplicate copy of the same list.
import { IMAGE_EXTS, MARKDOWN_EXTS } from '../editor/doc-kind'

type FileKind = 'markdown' | 'code' | 'data' | 'image' | 'generic'

const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'css',
  'scss',
  'html',
  'yml',
  'yaml',
  'py',
  'sh',
  'zsh',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'toml',
  'rb',
  'php'
])
const DATA_EXT = new Set(['csv', 'tsv'])

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

function kindOf(name: string): FileKind {
  const ext = extOf(name)
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (DATA_EXT.has(ext)) return 'data'
  if (CODE_EXT.has(ext)) return 'code'
  return 'generic'
}

// Shared dog-eared page outline every file icon is built on.
function Page({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.25 1.75H9.5L12.25 4.5V13.25C12.25 13.8 11.8 14.25 11.25 14.25H4.25C3.7 14.25 3.25 13.8 3.25 13.25V2.75C3.25 2.2 3.7 1.75 4.25 1.75Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 1.75V4.5H12.25"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {children}
    </svg>
  )
}

function MarkdownGlyph(): React.JSX.Element {
  return (
    <>
      <path d="M5.4 10.6V6.9L6.9 8.9L8.4 6.9V10.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.6 6.9V10.6L10.7 9.3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
    </>
  )
}

function CodeGlyph(): React.JSX.Element {
  return (
    <path
      d="M6.6 6.6L4.9 8.5L6.6 10.4M9.4 6.6L11.1 8.5L9.4 10.4"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  )
}

function DataGlyph(): React.JSX.Element {
  return (
    <g stroke="currentColor" strokeWidth="0.9">
      <rect x="5" y="6.6" width="6" height="4.2" rx="0.5" fill="none" />
      <line x1="5" y1="8.7" x2="11" y2="8.7" />
      <line x1="8" y1="6.6" x2="8" y2="10.8" />
    </g>
  )
}

function ImageGlyph(): React.JSX.Element {
  return (
    <g fill="currentColor">
      <circle cx="6" cy="7.5" r="0.9" />
      <path d="M4.6 10.6L6.7 8.3L8.3 10L10 7.8L11.3 10.6H4.6Z" />
    </g>
  )
}

/** File-type icon by extension (T-018): markdown / code / tabular-data / image / generic. */
export function FileIcon({ name }: { name: string }): React.JSX.Element {
  const kind = kindOf(name)
  const glyph =
    kind === 'markdown' ? (
      <MarkdownGlyph />
    ) : kind === 'code' ? (
      <CodeGlyph />
    ) : kind === 'data' ? (
      <DataGlyph />
    ) : kind === 'image' ? (
      <ImageGlyph />
    ) : null
  return <Page>{glyph}</Page>
}

/** Folder icon, open (expanded) vs closed — visibly different silhouettes, not just a
 *  tint change: closed is a clean solid folder; open shows an outlined back panel with
 *  a slanted front flap, the common "folder open" convention. Accent-tinted to echo the
 *  workspace-root diamond marker — folders read as structural, files stay neutral. */
export function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="3.25" width="5.2" height="2.1" rx="0.7" fill="currentColor" opacity={open ? 0.55 : 0.65} />
      {open ? (
        <>
          <rect
            x="1.35"
            y="5.35"
            width="13.3"
            height="8.4"
            rx="1.1"
            stroke="currentColor"
            strokeWidth="1.1"
            opacity="0.55"
          />
          <path
            d="M0.9 7.4H14.75L13.2 13A1 1 0 0 1 12.25 13.75H3.35A1 1 0 0 1 2.4 13L0.9 7.4Z"
            fill="currentColor"
          />
        </>
      ) : (
        <rect x="1.35" y="5.35" width="13.3" height="8.4" rx="1.1" fill="currentColor" />
      )}
    </svg>
  )
}

/** E-004 (T-022) — plain-terminal tab icon: a window with a shell prompt chevron + caret.
 *  Monochrome (currentColor) so it follows the tab's text color like the file icons. */
export function TerminalIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1.4" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M4.4 6.2L6.6 8L4.4 9.8"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="7.6" y1="10" x2="10.6" y2="10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** E-004 (T-022) — agent-terminal tab icon: a small "spark"/asterisk mark, visibly distinct
 *  from the plain-terminal window. Agent-SPECIFIC identity (per-agent glyphs) comes later. */
export function AgentIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <line x1="8" y1="2.4" x2="8" y2="13.6" />
        <line x1="2.9" y1="4.9" x2="13.1" y2="11.1" />
        <line x1="13.1" y1="4.9" x2="2.9" y2="11.1" />
      </g>
    </svg>
  )
}

/** E-012 (round-3) — symlink indicator: two interlocking rounded chain links. Monochrome
 *  (currentColor, driven to the accent by the wrapping chip/glyph span) and sized to 100% so
 *  its container controls the box — a chip in the tree row / editor header, a bare glyph in the
 *  tab strip. Shared across all three placements so the mark reads identically everywhere. */
export function SymlinkGlyph(): React.JSX.Element {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.4 12.6a3.5 3.5 0 0 0 5.3.4l2.4-2.4a3.5 3.5 0 0 0-5-5l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.6 11.4a3.5 3.5 0 0 0-5.3-.4l-2.4 2.4a3.5 3.5 0 0 0 5 5l1.4-1.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Chevron twisty: points right collapsed, rotated 90deg (via CSS) when expanded. */
export function ChevronIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M4.5 2.5L8 6L4.5 9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// T-144 — the folder-with-plus glyph, reassigned from the old Mount button to New folder.
export function NewFolderIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 5.2c0-.66.54-1.2 1.2-1.2h2.3l1.2 1.4h5.1c.66 0 1.2.54 1.2 1.2v4.4c0 .66-.54 1.2-1.2 1.2H3.2c-.66 0-1.2-.54-1.2-1.2V5.2Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M8 7.4v3.2M6.4 9h3.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

// T-144 — the ⋯ kebab glyph (three horizontal dots), shared by the section and per-root kebabs.
export function KebabIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.35" />
      <circle cx="8" cy="8" r="1.35" />
      <circle cx="12.5" cy="8" r="1.35" />
    </svg>
  )
}

export function ClipboardIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="4" y="3" width="8" height="11" rx="1.4" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M6 3.2V2.6A1 1 0 0 1 7 1.6h2a1 1 0 0 1 1 1v.6"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  )
}
