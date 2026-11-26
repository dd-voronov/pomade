// Pomade — E-017 predefined icon LIBRARY: a third icon source next to emoji + image upload.
// Two sections: hand-made USE-CASE glyphs and BRAND marks. Brand marks come from the
// `simple-icons` package (MIT) via PER-ICON named imports (so only these ~13 icons are
// bundled, never the whole set); the handful simple-icons has dropped under brand-policy
// pressure (LinkedIn, Slack, Microsoft, Amazon, Minecraft) get a hand-made minimal glyph in
// the same monochrome style. Everything renders monochrome, tinted with `currentColor` so it
// follows the app's token colors exactly like the file-tree / tab glyphs (brand color is a
// deliberate non-goal for v1 — the door stays open via the per-icon data).
//
// A chosen library icon persists as a STABLE id string in the same `icon` field the emoji
// picker already writes (Group.icon / Project.icon / WorkspaceIdentity.icon), distinguished
// by the `lib:` prefix — e.g. `lib:si-youtube`, `lib:usecase-music`. This keeps persistence
// purely additive (see docs/contracts/types.md "Workspace config"). Ids are source-neutral: the `si-` namespace
// means "brand mark", not "came from simple-icons", so a brand can switch sourcing later
// without breaking already-saved configs.

import {
  siYoutube,
  siInstagram,
  siTelegram,
  siSpotify,
  siObsidian,
  siNotion,
  siApple,
  siAndroid,
  siGoogletranslate,
  siX,
  siPinterest,
  siAirbnb,
  siMcdonalds
} from 'simple-icons'

export interface LibraryIcon {
  /** Stable persisted id, always `lib:`-prefixed. */
  id: string
  /** Human label shown as tooltip / aria-label. */
  label: string
  /** Lowercase search terms (label words + brand aliases). */
  keywords: string[]
  /** Inner SVG markup for a 0 0 24 24 viewBox; each element sets its own fill/stroke to
   *  `currentColor` (some glyphs are solid silhouettes, some are stroked line art). */
  render: () => React.ReactNode
}

export const LIBRARY_ID_PREFIX = 'lib:'

/** True when a stored icon value is a library id (vs an emoji glyph or empty). */
export function isLibraryIcon(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.startsWith(LIBRARY_ID_PREFIX)
}

// ─── simple-icons brand marks (solid silhouettes) ────────────────────────────────
// simple-icons paths are authored for a 24×24 viewBox with `fill`; we tint via currentColor.
const siPath = (d: string) => (): React.ReactNode => <path d={d} fill="currentColor" />

// ─── hand-made line-art helpers (use-case glyphs) ────────────────────────────────
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

// ════════════════════════════════════════════════════════════════════════════════
// USE-CASE ICONS (hand-made, stroked line art in the app's file-tree taste)
// ════════════════════════════════════════════════════════════════════════════════
export const USE_CASE_ICONS: LibraryIcon[] = [
  {
    id: 'lib:usecase-music',
    label: 'Music',
    keywords: ['music', 'song', 'audio', 'note', 'sound'],
    render: () => (
      <>
        <path d="M9 18V6l11-2v12" {...STROKE} />
        <circle cx="6" cy="18" r="3" {...STROKE} />
        <circle cx="17" cy="16" r="3" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-film',
    label: 'Film-making',
    keywords: ['film', 'movie', 'video', 'cinema', 'clapperboard', 'production'],
    render: () => (
      <>
        <rect x="3" y="3.5" width="18" height="17" rx="2" {...STROKE} />
        <path d="M7.5 3.5v17M16.5 3.5v17M3 12h18M3 7.75h4.5M3 16.25h4.5M16.5 7.75H21M16.5 16.25H21" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-software',
    label: 'Software engineering',
    keywords: ['software', 'engineering', 'code', 'coding', 'developer', 'programming'],
    render: () => (
      <>
        <path d="M8 7l-5 5 5 5" {...STROKE} />
        <path d="M16 7l5 5-5 5" {...STROKE} />
        <path d="M13.5 5l-3 14" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-money',
    label: 'Money management',
    keywords: ['money', 'finance', 'budget', 'cash', 'coin', 'dollar', 'banking'],
    render: () => (
      <>
        <circle cx="12" cy="12" r="9" {...STROKE} />
        <path d="M12 6.5v11" {...STROKE} />
        <path d="M14.75 9c0-1.24-1.23-2.05-2.75-2.05S9.25 7.76 9.25 9s1.23 1.9 2.75 2.2 2.75 1 2.75 2.25-1.23 2.05-2.75 2.05S9.25 16.24 9.25 15" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-games',
    label: 'Games',
    keywords: ['games', 'gaming', 'gamepad', 'controller', 'play', 'console'],
    render: () => (
      <>
        <rect x="2.5" y="7.5" width="19" height="9" rx="4.5" {...STROKE} />
        <path d="M6.5 11v3M5 12.5h3" {...STROKE} />
        <circle cx="16" cy="11.5" r="1.1" fill="currentColor" />
        <circle cx="18.5" cy="13.5" r="1.1" fill="currentColor" />
      </>
    )
  },
  {
    id: 'lib:usecase-knowledge',
    label: 'Knowledge management',
    keywords: ['knowledge', 'book', 'notes', 'wiki', 'learning', 'library', 'reading'],
    render: () => (
      <>
        <path d="M12 6.5C10.4 5 8 4.5 3 4.5v13c5 0 7.4.5 9 2 1.6-1.5 4-2 9-2v-13c-5 0-7.4.5-9 2z" {...STROKE} />
        <path d="M12 6.5v13" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-writing',
    label: 'Writing',
    keywords: ['writing', 'write', 'pen', 'pencil', 'edit', 'author', 'blog'],
    render: () => (
      <>
        <path d="M4 20h4L19 9a2.12 2.12 0 0 0-3-3L5 17v3z" {...STROKE} />
        <path d="M14.5 7.5l3 3" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-translation',
    label: 'Translation',
    keywords: ['translation', 'translate', 'language', 'languages', 'localization'],
    render: () => (
      <>
        <path d="M3.5 5H11" {...STROKE} />
        <path d="M7.25 4.25c0 4.6-1.9 8.4-4.75 10.5" {...STROKE} />
        <path d="M4.5 8.5c0 2.6 2.9 4.9 6 6" {...STROKE} />
        <path d="M11 20l4-9 4 9" {...STROKE} />
        <path d="M12.4 17h5.2" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-health',
    label: 'Gym / health',
    keywords: ['gym', 'health', 'fitness', 'workout', 'dumbbell', 'exercise', 'training'],
    render: () => (
      <>
        <path d="M8 12h8" {...STROKE} />
        <rect x="4.5" y="8.5" width="3.5" height="7" rx="1" {...STROKE} />
        <rect x="16" y="8.5" width="3.5" height="7" rx="1" {...STROKE} />
        <path d="M3 10.5v3M21 10.5v3" {...STROKE} />
      </>
    )
  },
  {
    id: 'lib:usecase-personal',
    label: 'Personal life management',
    keywords: ['personal', 'life', 'home', 'house', 'family', 'household'],
    render: () => (
      <>
        <path d="M3.5 11L12 4l8.5 7" {...STROKE} />
        <path d="M5.5 9.5V19.5h13V9.5" {...STROKE} />
        <path d="M10 19.5v-5h4v5" {...STROKE} />
      </>
    )
  }
]

// ════════════════════════════════════════════════════════════════════════════════
// BRAND ICONS — simple-icons where available, hand-made minimal glyphs where dropped.
// ════════════════════════════════════════════════════════════════════════════════
export const BRAND_ICONS: LibraryIcon[] = [
  // ── from simple-icons ──
  { id: 'lib:si-youtube', label: 'YouTube', keywords: ['youtube', 'video'], render: siPath(siYoutube.path) },
  { id: 'lib:si-instagram', label: 'Instagram', keywords: ['instagram', 'insta', 'social'], render: siPath(siInstagram.path) },
  { id: 'lib:si-telegram', label: 'Telegram', keywords: ['telegram', 'messaging', 'chat'], render: siPath(siTelegram.path) },
  { id: 'lib:si-spotify', label: 'Spotify', keywords: ['spotify', 'music', 'audio'], render: siPath(siSpotify.path) },
  { id: 'lib:si-obsidian', label: 'Obsidian', keywords: ['obsidian', 'notes', 'knowledge'], render: siPath(siObsidian.path) },
  { id: 'lib:si-notion', label: 'Notion', keywords: ['notion', 'notes', 'docs'], render: siPath(siNotion.path) },
  { id: 'lib:si-apple', label: 'Apple', keywords: ['apple', 'mac', 'ios'], render: siPath(siApple.path) },
  { id: 'lib:si-android', label: 'Android', keywords: ['android', 'google', 'mobile'], render: siPath(siAndroid.path) },
  { id: 'lib:si-googletranslate', label: 'Google Translate', keywords: ['google translate', 'translate', 'language'], render: siPath(siGoogletranslate.path) },
  { id: 'lib:si-x', label: 'X (Twitter)', keywords: ['x', 'twitter', 'social', 'tweet'], render: siPath(siX.path) },
  { id: 'lib:si-pinterest', label: 'Pinterest', keywords: ['pinterest', 'pin', 'social'], render: siPath(siPinterest.path) },
  { id: 'lib:si-airbnb', label: 'Airbnb', keywords: ['airbnb', 'travel', 'stay'], render: siPath(siAirbnb.path) },
  { id: 'lib:si-mcdonalds', label: "McDonald's", keywords: ['mcdonalds', 'food', 'burger'], render: siPath(siMcdonalds.path) },

  // ── hand-made (removed from simple-icons under brand policy) ──
  {
    id: 'lib:si-linkedin',
    label: 'LinkedIn',
    keywords: ['linkedin', 'social', 'work', 'professional'],
    render: () => (
      <>
        <circle cx="5" cy="5.2" r="2.2" fill="currentColor" />
        <rect x="2.9" y="9" width="4.2" height="12" rx="0.4" fill="currentColor" />
        <path
          d="M10 9h4v1.7c.66-1.1 1.9-1.95 3.7-1.95 2.9 0 4.3 1.85 4.3 5.1V21h-4.2v-6.3c0-1.5-.55-2.5-1.9-2.5-1.05 0-1.65.7-1.9 1.4-.1.25-.1.6-.1.95V21H10z"
          fill="currentColor"
        />
      </>
    )
  },
  {
    id: 'lib:si-slack',
    label: 'Slack',
    keywords: ['slack', 'chat', 'messaging', 'work'],
    render: () => (
      <>
        <rect x="9" y="2" width="3.5" height="9.5" rx="1.75" fill="currentColor" />
        <rect x="11.5" y="12.5" width="3.5" height="9.5" rx="1.75" fill="currentColor" />
        <rect x="2" y="11.5" width="9.5" height="3.5" rx="1.75" fill="currentColor" />
        <rect x="12.5" y="9" width="9.5" height="3.5" rx="1.75" fill="currentColor" />
      </>
    )
  },
  {
    id: 'lib:si-microsoft',
    label: 'Microsoft',
    keywords: ['microsoft', 'windows', 'ms'],
    render: () => (
      <>
        <rect x="3" y="3" width="8" height="8" fill="currentColor" />
        <rect x="13" y="3" width="8" height="8" fill="currentColor" />
        <rect x="3" y="13" width="8" height="8" fill="currentColor" />
        <rect x="13" y="13" width="8" height="8" fill="currentColor" />
      </>
    )
  },
  {
    id: 'lib:si-msoffice',
    label: 'MS Office',
    keywords: ['ms office', 'office', 'microsoft', 'word', 'excel', 'powerpoint'],
    render: () => (
      <>
        <path d="M14 2.5L3.5 6v12L14 21.5l6.5-2V4.5L14 2.5z" {...STROKE} />
        <path d="M14 6.5v11l-6.5 1.2V8.5L14 6.5z" fill="currentColor" />
      </>
    )
  },
  {
    id: 'lib:si-amazon',
    label: 'Amazon',
    keywords: ['amazon', 'shopping', 'store', 'aws'],
    render: () => (
      <>
        <path
          d="M3.3 15.4c3 2.2 6.6 3.4 10.2 3.4 2.5 0 5.2-.6 7.6-1.9.5-.25.9.3.4.7-2.2 2-5.4 3.1-8.3 3.1-4 0-7.7-1.5-10.4-4-.35-.3 0-.75.5-.5"
          fill="currentColor"
        />
        <path
          d="M20.3 13.3c-.5-.6-3-.35-4-.2-.3.05-.35-.25-.05-.45 1.9-1.35 5-1 5.4-.5.4.5-.1 3.6-1.9 5.1-.28.23-.55.1-.42-.2.42-1 1.35-3.2.97-3.75z"
          fill="currentColor"
        />
      </>
    )
  },
  {
    id: 'lib:si-minecraft',
    label: 'Minecraft',
    keywords: ['minecraft', 'game', 'block', 'creeper'],
    render: () => (
      <>
        <rect x="3.5" y="3.5" width="17" height="17" rx="1" {...STROKE} strokeWidth={1.6} />
        <rect x="6.5" y="7.5" width="3.5" height="3.5" fill="currentColor" />
        <rect x="14" y="7.5" width="3.5" height="3.5" fill="currentColor" />
        <rect x="10.25" y="11.5" width="3.5" height="3.5" fill="currentColor" />
        <rect x="7" y="15" width="3.25" height="3.5" fill="currentColor" />
        <rect x="13.75" y="15" width="3.25" height="3.5" fill="currentColor" />
      </>
    )
  }
]

export const ALL_LIBRARY_ICONS: LibraryIcon[] = [...USE_CASE_ICONS, ...BRAND_ICONS]

const LIBRARY_BY_ID = new Map<string, LibraryIcon>(ALL_LIBRARY_ICONS.map((i) => [i.id, i]))

/** Look up a library icon by its stored id (`lib:…`). */
export function getLibraryIcon(id: string | undefined | null): LibraryIcon | undefined {
  return id ? LIBRARY_BY_ID.get(id) : undefined
}

export interface LibrarySearchResult {
  useCases: LibraryIcon[]
  brands: LibraryIcon[]
}

/** Filter BOTH sections by a query (matched against label + keywords). Empty query = all. */
export function searchLibrary(query: string): LibrarySearchResult {
  const q = query.trim().toLowerCase()
  if (!q) return { useCases: USE_CASE_ICONS, brands: BRAND_ICONS }
  const match = (i: LibraryIcon): boolean =>
    i.label.toLowerCase().includes(q) || i.keywords.some((k) => k.includes(q))
  return { useCases: USE_CASE_ICONS.filter(match), brands: BRAND_ICONS.filter(match) }
}
