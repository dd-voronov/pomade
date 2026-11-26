// Pomade — E-010 (T-035; round-4) FULL emoji set for the in-app icon picker.
// Sourced from `emojibase-data` (the one approved data dependency, the Owner 2026-07-23):
// ~1,900 emoji with official CLDR labels + search tags, grouped into the standard Unicode
// categories at module load. Skin-tone variants stay collapsed (top-level entries only) and
// the "component" group (bare modifiers) is excluded — they make no sense as project icons.

import rawEmojiData from 'emojibase-data/en/data.json'

export interface EmojiEntry {
  glyph: string
  /** Lowercase search terms (official label + CLDR tags). */
  keywords: string[]
}

export interface EmojiCategory {
  id: string
  label: string
  emojis: EmojiEntry[]
}

// Unicode/emojibase group ids → picker categories (group 2 "component" deliberately absent).
const GROUPS: { group: number; id: string; label: string }[] = [
  { group: 0, id: 'smileys', label: 'Smileys' },
  { group: 1, id: 'people', label: 'People' },
  { group: 3, id: 'nature', label: 'Animals & nature' },
  { group: 4, id: 'food', label: 'Food & drink' },
  { group: 5, id: 'travel', label: 'Travel & places' },
  { group: 6, id: 'activities', label: 'Activities' },
  { group: 7, id: 'objects', label: 'Objects' },
  { group: 8, id: 'symbols', label: 'Symbols' },
  { group: 9, id: 'flags', label: 'Flags' }
]

interface RawEmoji {
  label: string
  emoji: string
  group?: number
  order?: number
  tags?: string[]
}

export const EMOJI_CATEGORIES: EmojiCategory[] = GROUPS.map(({ group, id, label }) => ({
  id,
  label,
  emojis: (rawEmojiData as RawEmoji[])
    .filter((e) => e.group === group)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((e) => ({
      glyph: e.emoji,
      keywords: [e.label.toLowerCase(), ...(e.tags ?? []).map((t) => t.toLowerCase())]
    }))
}))

export function searchEmojis(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const seen = new Set<string>()
  const out: EmojiEntry[] = []
  for (const cat of EMOJI_CATEGORIES) {
    for (const e of cat.emojis) {
      if (seen.has(e.glyph)) continue
      if (e.glyph === q || e.keywords.some((k) => k.includes(q))) {
        out.push(e)
        seen.add(e.glyph)
      }
    }
  }
  return out
}
