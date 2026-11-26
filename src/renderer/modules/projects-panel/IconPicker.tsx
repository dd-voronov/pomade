// Pomade — icon picker for the group/project/workspace change-icon window.
// E-017 redesign: the window now offers THREE icon sources, chosen with a mode switcher —
//   • Icons — a searchable predefined LIBRARY (use-case glyphs + brand marks; see icon-library).
//   • Emoji — the curated in-app emoji grid (E-010/T-035; native glyphs, NO external picker).
//   • Image — the existing ImagePicker (T-033 external copy-in via fs.pickImage).
// The three sources are mutually exclusive: exactly one icon is stored at a time. A library
// icon and an emoji share the single `icon` string field (a library value is `lib:`-prefixed);
// picking either clears any uploaded image, and picking an image clears the `icon` field.
// A large live preview shows the current icon (or the default glyph when unset). The mode
// opens on whatever the CURRENT icon is (req: labels/state reflect the stored value).

import { useMemo, useState } from 'react'

import { ImagePicker } from '../../components/fields'
import { useDataUrl } from '../../hooks/useDataUrl'
import { EMOJI_CATEGORIES, searchEmojis } from './emoji-data'
import { isLibraryIcon, searchLibrary, type LibraryIcon } from './icon-library'
import { LibraryGlyph } from './IconGlyph'
import styles from './IconPicker.module.css'

type Mode = 'icons' | 'emoji' | 'image'

interface IconPickerProps {
  /** Current icon value — an emoji glyph OR a `lib:` library id (empty = none). */
  icon: string
  /** Current image path, workspace-relative (empty = none). */
  image: string
  onIconChange: (value: string) => void
  onImageChange: (rel: string) => void
  /** Fallback glyph shown in the preview when nothing is set. */
  defaultGlyph: string
  testIdPrefix: string
}

function initialMode(icon: string, image: string): Mode {
  if (isLibraryIcon(icon)) return 'icons'
  if (icon) return 'emoji'
  if (image) return 'image'
  return 'icons'
}

export function IconPicker({
  icon,
  image,
  onIconChange,
  onImageChange,
  defaultGlyph,
  testIdPrefix
}: IconPickerProps): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(() => initialMode(icon, image))

  // Emoji-mode state (unchanged from the original picker).
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState(EMOJI_CATEGORIES[0].id)
  const emojiResults = useMemo(() => {
    if (query.trim()) return searchEmojis(query)
    return EMOJI_CATEGORIES.find((c) => c.id === categoryId)?.emojis ?? []
  }, [query, categoryId])

  // Icons-mode (library) state — one search field filters BOTH sections.
  const [libQuery, setLibQuery] = useState('')
  const lib = useMemo(() => searchLibrary(libQuery), [libQuery])

  const preview = useDataUrl(image)

  const pickLibrary = (id: string): void => {
    onImageChange('') // library/emoji/image are mutually exclusive
    onIconChange(id === icon ? '' : id)
  }
  const pickEmoji = (glyph: string): void => {
    onImageChange('')
    onIconChange(glyph === icon ? '' : glyph)
  }

  const modes: { id: Mode; label: string }[] = [
    { id: 'icons', label: 'Icons' },
    { id: 'emoji', label: 'Emoji' },
    { id: 'image', label: 'Image' }
  ]

  const libId = (id: string): string => id.replace(/^lib:/, '')

  const renderSection = (title: string, icons: LibraryIcon[], sectionId: string): React.JSX.Element => (
    <div className={styles.libSection} data-testid={`${testIdPrefix}-lib-section-${sectionId}`}>
      <span className={styles.libSectionLabel}>{title}</span>
      <div className={styles.libGrid}>
        {icons.length > 0 ? (
          icons.map((i) => (
            <button
              key={i.id}
              type="button"
              className={`${styles.libCell} ${i.id === icon ? styles.libCellActive : ''}`}
              title={i.label}
              aria-label={i.label}
              aria-pressed={i.id === icon}
              data-testid={`${testIdPrefix}-lib-${libId(i.id)}`}
              onClick={() => pickLibrary(i.id)}
            >
              <LibraryGlyph id={i.id} className={styles.libCellGlyph} />
            </button>
          ))
        ) : (
          <span className={styles.noResults}>None here match “{libQuery.trim()}”.</span>
        )}
      </div>
    </div>
  )

  return (
    <div className={styles.wrap} data-testid={`${testIdPrefix}-icon-picker`}>
      <div className={styles.top}>
        <span
          className={styles.preview}
          data-testid={`${testIdPrefix}-icon-preview`}
          data-kind={isLibraryIcon(icon) ? 'library' : icon ? 'emoji' : image ? 'image' : 'default'}
        >
          {isLibraryIcon(icon) ? (
            <LibraryGlyph id={icon} className={styles.previewLib} />
          ) : icon ? (
            <span className={styles.previewEmoji}>{icon}</span>
          ) : preview ? (
            <img className={styles.previewImg} src={preview} alt="" />
          ) : (
            <span className={styles.previewDefault}>{defaultGlyph}</span>
          )}
        </span>
        {(icon || image) && (
          <button
            type="button"
            className={styles.clear}
            data-testid={`${testIdPrefix}-icon-clear`}
            onClick={() => {
              onIconChange('')
              onImageChange('')
            }}
          >
            Clear icon
          </button>
        )}
      </div>

      {/* Mode switcher — pick a source first, then its UI shows below. */}
      <div className={styles.modes} role="tablist" aria-label="Icon source">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={m.id === mode}
            className={`${styles.modeBtn} ${m.id === mode ? styles.modeBtnActive : ''}`}
            data-testid={`${testIdPrefix}-mode-${m.id}`}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'icons' && (
        <div className={styles.pane} data-testid={`${testIdPrefix}-lib-pane`}>
          <input
            className={styles.search}
            value={libQuery}
            placeholder="Search icons…"
            data-testid={`${testIdPrefix}-lib-search`}
            onChange={(e) => setLibQuery(e.target.value)}
          />
          {renderSection('Use cases', lib.useCases, 'usecases')}
          {renderSection('Brands', lib.brands, 'brands')}
        </div>
      )}

      {mode === 'emoji' && (
        <div className={styles.pane} data-testid={`${testIdPrefix}-emoji-pane`}>
          <input
            className={styles.search}
            value={query}
            placeholder="Search emoji…"
            data-testid={`${testIdPrefix}-emoji-search`}
            onChange={(e) => setQuery(e.target.value)}
          />

          {!query.trim() && (
            <div className={styles.tabs} role="tablist">
              {EMOJI_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={c.id === categoryId}
                  className={`${styles.tab} ${c.id === categoryId ? styles.tabActive : ''}`}
                  onClick={() => setCategoryId(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          <div className={styles.grid} data-testid={`${testIdPrefix}-emoji-grid`}>
            {emojiResults.length > 0 ? (
              emojiResults.map((e) => (
                <button
                  key={e.glyph}
                  type="button"
                  className={`${styles.emoji} ${e.glyph === icon ? styles.emojiActive : ''}`}
                  title={e.keywords[0]}
                  aria-label={e.keywords[0]}
                  data-testid={`${testIdPrefix}-emoji-${e.glyph}`}
                  onClick={() => pickEmoji(e.glyph)}
                >
                  {e.glyph}
                </button>
              ))
            ) : (
              <span className={styles.noResults}>No emoji match “{query.trim()}”.</span>
            )}
          </div>
        </div>
      )}

      {mode === 'image' && (
        <div className={styles.pane} data-testid={`${testIdPrefix}-image-pane`}>
          <ImagePicker
            value={image}
            onChange={(rel) => {
              if (rel) onIconChange('') // choosing an image clears any emoji/library icon
              onImageChange(rel)
            }}
            testId={`${testIdPrefix}-image`}
          />
        </div>
      )}
    </div>
  )
}
