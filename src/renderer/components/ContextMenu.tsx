// Pomade T-158 — the ONE renderer-built context-menu primitive. Every menu in the app (tab /
// strip / Projects panel row + workspace / file tree / editor / CSV header / terminal / tab-strip bulk +
// add) renders through here: scrim + viewport clamp (useClampedPosition) + Escape + role="menu"/
// menuitem + the shared shell CSS live in this file, so a new menu is an items array, never a
// re-forked scrim + clamp + markup.
//
// Positioning: pass the pointer (a right-click's clientX/clientY) or an anchor point (a trigger
// button's bottom-left). `x`/`y` are `null` while the menu is closed; the owner mounts <ContextMenu>
// only while open. Deferred mount (T-083 r2, the editor spell menu) is unaffected — the owner still
// decides WHEN to render this component; the clamp is driven by whichever mount happens.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { Tooltip } from './Tooltip'
import { useClampedPosition, useClampedSubmenu } from '../hooks/use-clamped-position'
import styles from './ContextMenu.module.css'

/** Extra `data-*` attributes for a menu container or an item. */
type DataAttrs = Record<`data-${string}`, string | number | boolean | undefined>

export interface MenuItem {
  /** A divider row. When set, every other field is ignored. */
  separator?: boolean
  /** A non-interactive label row (e.g. "3 items selected"). When set, this is a header row. */
  header?: React.ReactNode
  headerTestId?: string
  /** A quiet empty-state line (e.g. "No spelling suggestions"). When set, this is a static row. */
  emptyText?: React.ReactNode
  emptyTestId?: string

  // ── action / submenu row ──
  label?: React.ReactNode
  /** Leading glyph (kebab arrows, color swatch, …); rendered in the fixed 16px glyph slot. */
  glyph?: React.ReactNode
  /** Trailing content flush-right (a status badge). A submenu row's chevron overrides it. */
  trailing?: React.ReactNode
  onSelect?: () => void
  testId?: string
  /** Native `disabled` (inert). Coexists with `title`; use `tooltip` for a hoverable one. */
  disabled?: boolean
  danger?: boolean
  /** Native `title=` tooltip. */
  title?: string
  /** Shared design-system `<Tooltip lines>`. A disabled item with this stays HOVERABLE
   *  (rendered aria-disabled, not native disabled) so the tip still fires. */
  tooltip?: string[]
  tooltipTestId?: string
  /** aria-pressed toggle state (Show/Hide ignored items). */
  pressed?: boolean
  /** aria-checked (color picker radio, or a menuitemcheckbox toggle). */
  checked?: boolean
  /** Force role="menuitemradio" even when not checked. */
  radio?: boolean
  /** Override the item's ARIA role (default: menuitem, or menuitemradio when `checked`/`radio`). */
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'
  /** Extra class on the item button (content-level owner styling). */
  itemClassName?: string
  /** Extra data-* attributes on the item button (e.g. data-path). */
  data?: DataAttrs
  /** Keep the menu open after selecting (default: close). */
  keepOpen?: boolean

  // ── submenu ──
  submenu?: MenuItem[]
  submenuTestId?: string
  submenuEmpty?: React.ReactNode
  submenuEmptyTestId?: string
  /** onMouseDown preventDefault on the submenu container (editor: keep the selection). */
  preserveFocus?: boolean
}

export interface ContextMenuProps {
  x: number | null | undefined
  y: number | null | undefined
  items: MenuItem[]
  onClose: () => void
  /** data-testid on the menu container. */
  testId: string
  /** data-testid on the scrim (default: `${testId}-scrim`). */
  scrimTestId?: string
  /** Extra data-* on the menu container (data-kind, data-variant, data-axis, data-bulk, …). */
  data?: DataAttrs
  ariaLabel?: string
  /** onMouseDown preventDefault on the menu container (editor: keep the selection live). */
  preserveFocus?: boolean
  /** Re-run the position clamp when this changes without the anchor moving (the editor spell
   *  section pops in a beat after open and grows the menu). */
  remeasureKey?: unknown
  /** Register the Escape listener in the CAPTURE phase (terminal: xterm owns focus). */
  escapeCapture?: boolean
}

function itemKey(it: MenuItem, i: number): string {
  if (it.separator) return `sep-${i}`
  if (it.header !== undefined) return `hdr-${it.headerTestId ?? i}`
  if (it.emptyText !== undefined) return `empty-${it.emptyTestId ?? i}`
  return it.testId ?? `item-${i}`
}

export function ContextMenu(props: ContextMenuProps): React.JSX.Element {
  const { x, y, items, onClose, testId, preserveFocus } = props
  const { ref: menuRef, left, top } = useClampedPosition<HTMLDivElement>(x, y, props.remeasureKey)
  // One open submenu at a time, keyed by the submenu row's testId (or its index).
  const [openSub, setOpenSub] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, props.escapeCapture ?? false)
    return () => window.removeEventListener('keydown', onKey, props.escapeCapture ?? false)
  }, [onClose, props.escapeCapture])

  const select = (it: MenuItem): void => {
    if (it.disabled) return
    it.onSelect?.()
    if (!it.keepOpen) onClose()
  }

  return (
    <>
      <div
        className={styles.scrim}
        data-testid={props.scrimTestId ?? `${testId}-scrim`}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className={styles.menu}
        style={{ left, top }}
        role="menu"
        aria-label={props.ariaLabel}
        data-testid={testId}
        {...props.data}
        onMouseDown={preserveFocus ? (e) => e.preventDefault() : undefined}
      >
        {items.map((it, i) => (
          <Row
            key={itemKey(it, i)}
            item={it}
            index={i}
            openSub={openSub}
            setOpenSub={setOpenSub}
            onSelect={select}
          />
        ))}
      </div>
    </>
  )
}

function Row({
  item,
  index,
  openSub,
  setOpenSub,
  onSelect
}: {
  item: MenuItem
  index: number
  openSub: string | null
  setOpenSub: (k: string | null) => void
  onSelect: (it: MenuItem) => void
}): React.JSX.Element | null {
  if (item.separator) return <div className={styles.sep} role="separator" />
  if (item.header !== undefined) {
    return (
      <div className={styles.header} data-testid={item.headerTestId}>
        {item.header}
      </div>
    )
  }
  if (item.emptyText !== undefined) {
    return (
      <span className={styles.empty} data-testid={item.emptyTestId}>
        {item.emptyText}
      </span>
    )
  }

  if (item.submenu) {
    const key = item.submenuTestId ?? item.testId ?? `sub-${index}`
    return (
      <Submenu
        item={item}
        open={openSub === key}
        onToggle={() => setOpenSub(openSub === key ? null : key)}
        onSelect={onSelect}
      />
    )
  }

  return <ActionRow item={item} onSelect={onSelect} />
}

const chevron = (
  <span className={`${styles.trailing} ${styles.chevron}`} aria-hidden="true">
    ›
  </span>
)

/** The button body shared by plain rows and submenu-trigger rows. */
function itemButton(
  item: MenuItem,
  extra: {
    trailing?: React.ReactNode
    onClick: (e: React.MouseEvent) => void
    ariaExpanded?: boolean
    ariaHaspopup?: boolean
  }
): ReactElement {
  const soft = item.disabled && !!item.tooltip // hoverable disabled (keeps the tooltip)
  const role =
    item.role ?? (item.radio || item.checked !== undefined ? 'menuitemradio' : 'menuitem')
  return (
    <button
      type="button"
      role={role}
      className={`${styles.menuItem}${item.danger ? ` ${styles.menuItemDanger}` : ''}${
        item.itemClassName ? ` ${item.itemClassName}` : ''
      }`}
      data-testid={item.testId}
      disabled={item.disabled && !soft}
      aria-disabled={item.disabled || undefined}
      data-disabled={soft ? 'true' : undefined}
      aria-pressed={item.pressed}
      aria-checked={item.checked}
      aria-haspopup={extra.ariaHaspopup ? 'menu' : undefined}
      aria-expanded={extra.ariaExpanded}
      title={item.title}
      {...item.data}
      onClick={extra.onClick}
    >
      {item.glyph !== undefined && (
        <span className={styles.glyph} aria-hidden="true">
          {item.glyph}
        </span>
      )}
      {item.label}
      {extra.trailing}
    </button>
  )
}

function ActionRow({
  item,
  onSelect
}: {
  item: MenuItem
  onSelect: (it: MenuItem) => void
}): React.JSX.Element {
  const soft = item.disabled && !!item.tooltip
  const button = itemButton(item, {
    trailing: item.trailing ? <span className={styles.trailing}>{item.trailing}</span> : undefined,
    onClick: (e) => {
      if (soft) {
        e.preventDefault()
        return
      }
      onSelect(item)
    }
  })
  if (item.tooltip) {
    return (
      <Tooltip lines={item.tooltip} testId={item.tooltipTestId}>
        {button}
      </Tooltip>
    )
  }
  return button
}

function Submenu({
  item,
  open,
  onToggle,
  onSelect
}: {
  item: MenuItem
  open: boolean
  onToggle: () => void
  onSelect: (it: MenuItem) => void
}): React.JSX.Element {
  const flyout = useClampedSubmenu<HTMLDivElement>(open)
  const rows = item.submenu ?? []
  return (
    <div className={styles.subWrap}>
      {itemButton(item, {
        trailing: chevron,
        onClick: onToggle,
        ariaExpanded: open,
        ariaHaspopup: true
      })}
      {open && (
        <div
          ref={flyout.ref}
          className={styles.submenu}
          style={flyout.style}
          role="menu"
          data-testid={item.submenuTestId}
          data-flipped={flyout.flipped ? 'true' : undefined}
          onMouseDown={item.preserveFocus ? (e) => e.preventDefault() : undefined}
        >
          {rows.length === 0 && item.submenuEmpty !== undefined ? (
            <span className={styles.empty} data-testid={item.submenuEmptyTestId}>
              {item.submenuEmpty}
            </span>
          ) : (
            rows.map((sub, i) => (
              <ActionRow key={sub.testId ?? `sub-item-${i}`} item={sub} onSelect={onSelect} />
            ))
          )}
        </div>
      )}
    </div>
  )
}
