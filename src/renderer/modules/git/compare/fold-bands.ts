// Pomade — T-278: under Changes only, each folded run reads as ONE band across the comparison. The
// library draws a fold bar per side, inside each side's content; the rest of the row — the left
// side's gutters, and between the bars the take-old column and the right side's gutters — belongs
// to other elements. This layer paints those parts: per fold, a piece over the left gutters and a
// piece from the left side's edge to the right side's content, placed from the bars' measured
// positions. The pieces live in the editors' row, which scrolls with the content, so scrolling moves
// them for free; they are re-placed after every editor update that can move a bar (viewport,
// height, geometry, document) and on resize. Clicking a piece clicks that fold's bar, which unfolds
// the run on both sides; hovering any part of a band lights all of it.

import type { MergeView } from '@codemirror/merge'

const FOLD_BAR = '.cm-collapsedLines'

export interface FoldBandClasses {
  layer: string
  piece: string
}

export interface FoldBands {
  /** Re-place the pieces on the next frame. */
  schedule(): void
  destroy(): void
}

/** One fold: its bar on each side (either may be outside its side's rendered viewport). */
interface Fold {
  a: HTMLElement | null
  b: HTMLElement | null
  top: number
  height: number
}

export function mountFoldBands(view: MergeView, classes: FoldBandClasses): FoldBands {
  const row = view.dom.querySelector<HTMLElement>(':scope > .cm-mergeViewEditors')
  if (!row) return { schedule: () => {}, destroy: () => {} }
  const layer = document.createElement('div')
  layer.className = classes.layer
  row.appendChild(layer)

  let folds: Fold[] = []
  let hovered = -1
  let frame = 0

  const barsOf = (side: 'a' | 'b'): HTMLElement[] => [...view[side].contentDOM.querySelectorAll<HTMLElement>(FOLD_BAR)]

  const markHover = (i: number, on: boolean): void => {
    const f = folds[i]
    if (!f) return
    const els = [f.a, f.b, ...layer.querySelectorAll<HTMLElement>(`[data-fold="${i}"]`)]
    for (const el of els) el?.toggleAttribute('data-fold-hover', on)
  }
  const setHover = (i: number): void => {
    if (i === hovered) return
    markHover(hovered, false)
    hovered = i
    markHover(hovered, true)
  }

  const place = (): void => {
    frame = 0
    const box = row.getBoundingClientRect()
    const rel = (r: DOMRect): { top: number; height: number } => ({ top: r.top - box.top, height: r.height })
    // Pair the two sides' bars by height in the row: the library aligns the sides, so a run's two
    // bars share a top.
    const next: Fold[] = []
    for (const side of ['a', 'b'] as const) {
      for (const bar of barsOf(side)) {
        const at = rel(bar.getBoundingClientRect())
        const same = next.find((f) => Math.abs(f.top - at.top) <= 1)
        if (same) same[side] = bar
        else next.push({ a: side === 'a' ? bar : null, b: side === 'b' ? bar : null, ...at })
      }
    }
    next.sort((x, y) => x.top - y.top)
    markHover(hovered, false)
    folds = next
    // A layout change (a resize under a still pointer) can leave the band without a mouseleave.
    if (!row.matches(':hover')) hovered = -1

    const aEditor = view.a.dom.parentElement?.getBoundingClientRect()
    const aContent = view.a.contentDOM.getBoundingClientRect()
    const bContent = view.b.contentDOM.getBoundingClientRect()
    const spans = aEditor
      ? [
          { left: aEditor.left - box.left, width: aContent.left - aEditor.left },
          { left: aEditor.right - box.left, width: bContent.left - aEditor.right }
        ]
      : []
    const want = folds.length * spans.length
    while (layer.children.length > want) layer.lastElementChild?.remove()
    while (layer.children.length < want) {
      const piece = document.createElement('div')
      piece.className = classes.piece
      layer.appendChild(piece)
    }
    folds.forEach((f, i) => {
      spans.forEach((s, j) => {
        const piece = layer.children[i * spans.length + j] as HTMLElement
        piece.dataset.fold = String(i)
        piece.dataset.testid = j === 0 ? 'compare-fold-band-gutter' : 'compare-fold-band'
        piece.style.top = `${f.top}px`
        piece.style.height = `${f.height}px`
        piece.style.left = `${s.left}px`
        piece.style.width = `${Math.max(0, s.width)}px`
      })
    })
    markHover(hovered, true)
  }

  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(place)
  }

  const indexOf = (target: EventTarget | null): number => {
    if (!(target instanceof Element)) return -1
    const piece = target.closest<HTMLElement>('[data-fold]')
    if (piece && layer.contains(piece)) return Number(piece.dataset.fold)
    const bar = target.closest<HTMLElement>(FOLD_BAR)
    return bar ? folds.findIndex((f) => f.a === bar || f.b === bar) : -1
  }
  const onClick = (e: MouseEvent): void => {
    const f = folds[indexOf(e.target)]
    if (!f) return
    e.preventDefault()
    // The bar's own handler unfolds the run on its side and the sibling.
    ;(f.a ?? f.b)?.click()
  }
  const onOver = (e: MouseEvent): void => setHover(indexOf(e.target))
  const onLeave = (): void => setHover(-1)
  layer.addEventListener('click', onClick)
  row.addEventListener('mouseover', onOver)
  row.addEventListener('mouseleave', onLeave)
  const resize = new ResizeObserver(schedule)
  resize.observe(row)
  schedule()

  return {
    schedule,
    destroy: () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      row.removeEventListener('mouseover', onOver)
      row.removeEventListener('mouseleave', onLeave)
      layer.remove()
    }
  }
}
