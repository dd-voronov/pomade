// Pomade E-019 · T-068 — the color picker popup behind a raw-mode color swatch.
//
// Hand-rolled on purpose: `<input type="color">` carries no alpha and looks like nothing else in
// the app. This is a compact HSV picker (saturation/value area + hue slider, plus an alpha slider
// ONLY when the code's notation carries alpha), built on the house popover pattern
// (SymlinkPopover): fixed positioning off a DOMRect anchor, viewport-clamped, scrim + Escape to
// dismiss. No new dependency.
//
// The document is NOT touched while dragging — the picker holds a draft and commits on Apply, so
// the rewrite is exactly ONE CodeMirror transaction (one Cmd+Z step). Escape / outside click /
// Cancel change nothing.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  formatColorCode,
  hsvToRgb,
  rgbToHsv,
  toCssColor,
  toHexKey,
  type ColorNotation,
  type HSV,
  type RGBA
} from './color-codes'
import { Popover } from '../../components/Popover'
import styles from './ColorPickerPopover.module.css'

const POP_W = 236

type Track = 'sv' | 'hue' | 'alpha'

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function notationHasAlpha(notation: ColorNotation): boolean {
  return notation.kind === 'hex' ? notation.digits === 8 : notation.alpha !== 'none'
}

export function ColorPickerPopover({
  anchorRect,
  code,
  initial,
  notation,
  onApply,
  onCancel
}: {
  anchorRect: DOMRect
  /** The code exactly as written in the document — shown for comparison. */
  code: string
  initial: RGBA
  notation: ColorNotation
  onApply: (next: RGBA) => void
  onCancel: () => void
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<Track | null>(null)
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(initial))
  const [alpha, setAlpha] = useState(initial.a)

  const hasAlpha = notationHasAlpha(notation)
  const rgba: RGBA = { ...hsvToRgb(hsv.h, hsv.s, hsv.v), a: hasAlpha ? alpha : 1 }
  const nextCode = formatColorCode(notation, rgba)

  const [pos, setPos] = useState(() => ({
    left: Math.max(8, Math.min(anchorRect.left - 4, window.innerWidth - POP_W - 8)),
    top: anchorRect.bottom + 6
  }))

  // Flip above the swatch when the panel would run off the bottom (measured, not guessed).
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const h = el.offsetHeight
    if (anchorRect.bottom + 6 + h > window.innerHeight - 8) {
      setPos((p) => ({ ...p, top: Math.max(8, anchorRect.top - h - 6) }))
    }
    el.focus()
    // Anchor is fixed for the lifetime of the popup.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measures and focuses once on open; the anchor is fixed for the popup's lifetime
  }, [])

  const applyRef = useRef<() => void>(() => {})
  applyRef.current = () => onApply(rgba)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        applyRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const update = (track: Track, e: React.PointerEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const fx = clamp01((e.clientX - r.left) / r.width)
    const fy = clamp01((e.clientY - r.top) / r.height)
    if (track === 'sv') setHsv((h) => ({ h: h.h, s: fx, v: 1 - fy }))
    else if (track === 'hue') setHsv((h) => ({ ...h, h: fx * 360 }))
    else setAlpha(Math.round(fx * 1000) / 1000)
  }

  const track = (
    kind: Track
  ): {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
    onLostPointerCapture: () => void
  } => ({
    onPointerDown: (e) => {
      e.preventDefault()
      dragRef.current = kind
      e.currentTarget.setPointerCapture(e.pointerId)
      update(kind, e)
    },
    onPointerMove: (e) => {
      if (dragRef.current === kind) update(kind, e)
    },
    onPointerUp: (e) => {
      dragRef.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    },
    onLostPointerCapture: () => {
      dragRef.current = null
    }
  })

  const opaque = toCssColor({ ...rgba, a: 1 })

  return (
    <Popover
      onDismiss={onCancel}
      style={{ left: pos.left, top: pos.top, width: POP_W }}
      ariaLabel="Pick a color"
      testId="color-picker"
      panelClassName={styles.pop}
      panelRef={panelRef}
      tabIndex={-1}
    >
        <div className={styles.head}>
          <span>Color</span>
          <span className={styles.original} data-testid="color-picker-original">
            {code}
          </span>
        </div>

        <div className={styles.body}>
          <div
            className={styles.sv}
            style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
            data-testid="color-picker-sv"
            {...track('sv')}
          >
            <span
              className={styles.thumb}
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: opaque }}
            />
          </div>

          <div className={styles.hue} data-testid="color-picker-hue" {...track('hue')}>
            <span
              className={styles.thumb}
              style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%', backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
            />
          </div>

          {hasAlpha && (
            <div className={styles.alpha} data-testid="color-picker-alpha" {...track('alpha')}>
              <span
                className={styles.alphaFill}
                style={{ backgroundImage: `linear-gradient(to right, ${toCssColor({ ...rgba, a: 0 })}, ${opaque})` }}
              />
              <span
                className={styles.thumb}
                style={{ left: `${alpha * 100}%`, top: '50%', backgroundColor: opaque }}
              />
            </div>
          )}

          <div className={styles.preview}>
            <span className={styles.chip} aria-hidden="true">
              <span className={styles.chipFill} style={{ backgroundColor: toCssColor(rgba) }} />
            </span>
            <span className={styles.value} data-testid="color-picker-value" data-color={toHexKey(rgba)}>
              {nextCode}
            </span>
          </div>
        </div>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <button type="button" className={styles.btn} data-testid="color-picker-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            data-testid="color-picker-apply"
            onClick={() => onApply(rgba)}
          >
            Apply
          </button>
        </div>
    </Popover>
  )
}
