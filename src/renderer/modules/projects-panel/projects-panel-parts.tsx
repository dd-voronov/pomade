// Pomade — Projects panel presentational leaf parts, shared by the expanded rows/sections (ProjectRow,
// GroupSection, UngroupedSection) and the collapsed rail. Pure presentation + the row-kebab
// primitives; no store or DnD wiring lives here.

import { TAB_COLORS, type Group, type Project, type TabColor, type WorkspaceIdentity } from '@shared/types'
import { isLibraryIcon } from './icon-library'
import { LibraryGlyph } from './IconGlyph'
import { Tooltip } from '../../components/Tooltip'
import { useDataUrl } from '../../hooks/useDataUrl'
import styles from './ProjectsPanel.module.css'

export const DEFAULT_PROJECT_GLYPH = '📄'
export const DEFAULT_GROUP_GLYPH = '📁'
export const DEFAULT_WORKSPACE_GLYPH = '💠'

// E-015 — horizontal indent applied per nesting level (expanded Projects panel).
export const INDENT_STEP = 14

/** E-011 / T-151 — red numeric "wants attention" counter, social-media style. Numeric only (no
 *  text badge), capped at "9+", token-styled (--danger). Rendered only when count > 0. The count
 *  is a LIVE DERIVED tally of a project's unread (dotted) tabs — see the derivation below. */
export function AttentionCounter({
  count,
  testId
}: {
  count: number
  testId: string
}): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <span className={styles.counter} data-testid={testId} aria-label={`${count} awaiting attention`}>
      {count > 9 ? '9+' : count}
    </span>
  )
}

/** E-010 (T-035) — a project's ~16px icon: emoji glyph (precedence) → uploaded image →
 *  default glyph. Crisp at small size (emoji render as text; images object-fit cover). */
export function ProjectIcon({ project }: { project: Project }): React.JSX.Element {
  const url = useDataUrl(project.image ?? '')
  // T-074 — the same test id in the expanded row and on the collapsed rail (only one of the two
  // ever mounts), so e2e can assert glyph-size PARITY between the two surfaces.
  const testId = `project-icon-${project.id}`
  if (project.icon) {
    if (isLibraryIcon(project.icon)) {
      return (
        <span className={styles.projectIcon} data-icon="library" data-testid={testId}>
          <LibraryGlyph id={project.icon} />
        </span>
      )
    }
    return (
      <span className={styles.projectIcon} data-icon="emoji" data-testid={testId}>
        {project.icon}
      </span>
    )
  }
  if (url)
    return (
      <img className={styles.projectIconImg} data-icon="image" data-testid={testId} src={url} alt="" />
    )
  return (
    <span className={styles.projectIcon} data-icon="default" data-testid={testId} aria-hidden="true">
      {DEFAULT_PROJECT_GLYPH}
    </span>
  )
}

/** E-010 (T-035) — a group's icon. E-015: sized by nesting `depth` (tier 40/32/24/16px via the
 *  `data-depth` attribute) so the hierarchy reads at a glance. Emoji → image → default. */
export function GroupIcon({ group, depth }: { group: Group; depth: number }): React.JSX.Element {
  const url = useDataUrl(group.image ?? '')
  return (
    <span className={styles.groupIcon} data-depth={depth} data-testid={`group-icon-${group.id}`}>
      {group.icon ? (
        isLibraryIcon(group.icon) ? (
          <span className={styles.groupIconEmoji} data-icon="library">
            <LibraryGlyph id={group.icon} />
          </span>
        ) : (
          <span className={styles.groupIconEmoji} data-icon="emoji">{group.icon}</span>
        )
      ) : url ? (
        <img className={styles.groupIconImg} data-icon="image" src={url} alt="" />
      ) : (
        <span className={styles.groupIconEmoji} data-icon="default" aria-hidden="true">
          {DEFAULT_GROUP_GLYPH}
        </span>
      )}
    </span>
  )
}

/** E-010 (round-4) — collapsed-rail group section marker: the group's icon with the group name
 *  as tooltip. It's a HEADER, not a launcher — clicking it EXPANDS the Projects panel. T-074: it renders
 *  the SAME `GroupIcon` as the expanded header, so the glyph is byte-for-byte the same tier size
 *  (40/32/24/16 by depth) — no rail-specific scaling. The button is only a hit target (never
 *  smaller than --hit-target, growing with the glyph). */
export function RailGroupMarker({
  group,
  depth,
  onExpand
}: {
  group: Group
  depth: number
  onExpand: () => void
}): React.JSX.Element {
  return (
    <Tooltip lines={[group.name]}>
      <button
        type="button"
        className={styles.railGroupMarker}
        data-depth={depth}
        aria-label={group.name}
        data-testid={`rail-group-${group.id}`}
        // T-190 — a colored group marker gets the same full-bg chip as a rail project (soft;
        // medium when highlighted). Markers are never active, so fill only — no ring.
        data-color={group.color}
        style={rowColorVars(group.color, group.highlighted)}
        onClick={onExpand}
      >
        <GroupIcon group={group} depth={depth} />
      </button>
    </Tooltip>
  )
}

/** E-010 (round-3) — the workspace identity icon: emoji → image → default (💠). Sized by the
 *  caller's `chipClass`/`emojiClass` so the same component serves the 48px expanded apex chip
 *  and the 26px collapsed-rail launcher. */
export function WorkspaceIcon({
  identity,
  chipClass,
  emojiClass,
  testId
}: {
  identity: WorkspaceIdentity | undefined
  chipClass: string
  emojiClass: string
  testId?: string
}): React.JSX.Element {
  const url = useDataUrl(identity?.image ?? '')
  return (
    <span className={chipClass} data-testid={testId}>
      {identity?.icon ? (
        isLibraryIcon(identity.icon) ? (
          <span className={emojiClass} data-icon="library">
            <LibraryGlyph id={identity.icon} />
          </span>
        ) : (
          <span className={emojiClass} data-icon="emoji">
            {identity.icon}
          </span>
        )
      ) : url ? (
        <img className={styles.workspaceIconImg} data-icon="image" src={url} alt="" />
      ) : (
        <span className={emojiClass} data-icon="default" aria-hidden="true">
          {DEFAULT_WORKSPACE_GLYPH}
        </span>
      )}
    </span>
  )
}

export function IconBtn({
  label,
  glyph,
  onClick,
  testId,
  disabled
}: {
  label: string
  glyph: string
  onClick: (e: React.MouseEvent) => void
  testId?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Tooltip lines={[label]}>
      <button
        type="button"
        className={styles.iconBtn}
        aria-label={label}
        data-testid={testId}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          onClick(e)
        }}
      >
        {glyph}
      </button>
    </Tooltip>
  )
}

/** Monochrome trash glyph (inherits `color` → red inside a danger menu item). */
export function TrashGlyph(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11M6.5 4V2.6h3V4M4.2 4l.55 9a1 1 0 0 0 1 .95h4.5a1 1 0 0 0 1-.95L11.8 4M6.6 6.7v4.6M9.4 6.7v4.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// T-060 — one action item inside a row's kebab (⋮) menu. Move up/down are disabled at the
// list edges; Delete is flagged `danger` (red text + red icon). T-190 — a `submenu` (with
// `checked` radio rows) drives the "Change color" flyout through the shared ContextMenu primitive.
export type KebabItem = {
  label: string
  glyph?: React.ReactNode
  onClick?: () => void
  testId?: string
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  submenu?: KebabItem[]
  submenuTestId?: string
}

// ─── T-190 — Projects panel row colors ───────────────────────────────────────────────

/** Human labels for the 6 shared hues (mirrors TabContextMenu's COLOR_LABEL). */
const ROW_COLOR_LABEL: Record<TabColor, string> = {
  red: 'Red',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple'
}

/** Inline CSS custom properties for a colored row, shared by the expanded rows/sections and the
 *  collapsed rail. `--row-fill` is the resting fill (soft, or MEDIUM when highlighted — the T-183
 *  auto-flip); `--row-border-active` is the 2-tone-darker active border (medium for a soft row,
 *  strong for a medium/highlighted one). Returns undefined for an uncolored row (no vars set). */
export function rowColorVars(
  color: TabColor | undefined,
  highlighted: boolean | undefined
): React.CSSProperties | undefined {
  if (!color) return undefined
  const fill = highlighted ? 'medium' : 'soft'
  const border = highlighted ? 'strong' : 'medium'
  return {
    ['--row-fill' as string]: `var(--row-tint-${color}-${fill})`,
    ['--row-border-active' as string]: `var(--row-tint-${color}-${border})`
  } as React.CSSProperties
}

/** A 14px color swatch glyph for the "Change color" submenu rows (mirrors the tab menu's
 *  ctxSwatch). Uses the MEDIUM tone so the tiny circle reads clearly. `null` = the "None" swatch. */
function ColorSwatch({ color }: { color: TabColor | null }): React.JSX.Element {
  if (color === null) return <span className={styles.swatchNone} />
  return <span className={styles.swatch} style={{ background: `var(--row-tint-${color}-medium)` }} />
}

/** Build the "Change color" kebab item (a submenu of None + the 6 hues, radio-checked on the
 *  current color) shared by project rows and group/sub-group headers. `idPrefix` = `project-<id>`
 *  or `group-<id>` so the testids match the row family. */
export function colorMenuItem(
  current: TabColor | undefined,
  onPick: (color: TabColor | undefined) => void,
  idPrefix: string
): KebabItem {
  return {
    label: 'Change color',
    glyph: '🎨',
    testId: `${idPrefix}-color`,
    submenuTestId: `${idPrefix}-color-submenu`,
    submenu: [
      {
        label: 'None',
        testId: `${idPrefix}-color-none`,
        checked: !current,
        glyph: <ColorSwatch color={null} />,
        onClick: () => onPick(undefined)
      },
      ...TAB_COLORS.map<KebabItem>((c) => ({
        label: ROW_COLOR_LABEL[c],
        testId: `${idPrefix}-color-${c}`,
        checked: current === c,
        glyph: <ColorSwatch color={c} />,
        onClick: () => onPick(c)
      }))
    ]
  }
}

/** T-060 — the kebab (⋮) trigger. It only opens the shared row menu (positioned at the
 *  Projects panel level so it survives the row's hover-out); it carries no menu of its own. */
export function KebabButton({
  testId,
  onOpen
}: {
  testId: string
  onOpen: (e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <Tooltip lines={['More actions']}>
      <button
        type="button"
        className={styles.iconBtn}
        aria-label="More actions"
        aria-haspopup="menu"
        data-testid={testId}
        onClick={onOpen}
      >
        ⋮
      </button>
    </Tooltip>
  )
}
