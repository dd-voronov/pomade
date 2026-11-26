import { describe, expect, it } from 'vitest'

import {
  OVERLAY_MARGIN,
  cardSize,
  clampPosition,
  frameHeight,
  openPosition
} from './overlay-geometry'

// The window below a 30px title bar, and the pane area inside it right of a 360px left column.
const BOUNDS = { x: 0, y: 30, w: 1280, h: 700 }
const PANE = { x: 360, y: 66, w: 920, h: 664 }

describe('frameHeight', () => {
  it('defaults to 220 and rounds to whole pixels', () => {
    expect(frameHeight(undefined, BOUNDS)).toBe(220)
    expect(frameHeight(260.6, BOUNDS)).toBe(261)
  })
  it('clamps to the minimum and to 60% of the bounds’ height', () => {
    expect(frameHeight(10, BOUNDS)).toBe(120)
    expect(frameHeight(5000, BOUNDS)).toBe(420)
    expect(frameHeight(420, BOUNDS)).toBe(420)
  })
  it('never leaves the card without its margins in a short window', () => {
    // 60% of 300 is 180; the room is 300 − 32 − 16 = 252: the share wins.
    expect(frameHeight(5000, { w: 900, h: 300 })).toBe(180)
    // 60% of 240 is 144; the room is 192: the share wins, and a request below it is kept.
    expect(frameHeight(130, { w: 900, h: 240 })).toBe(130)
    // A window too short for the minimum still gives the minimum.
    expect(frameHeight(5000, { w: 900, h: 100 })).toBe(120)
  })
})

describe('cardSize', () => {
  it('is a 420-wide frame and the requested height inside a border and under the 14px handle', () => {
    expect(cardSize(undefined, BOUNDS)).toEqual({ w: 422, h: 236 })
    expect(cardSize(300, BOUNDS)).toEqual({ w: 422, h: 316 })
  })
  it('narrows with a narrow window, keeping the margins', () => {
    expect(cardSize(undefined, { w: 300, h: 700 }).w).toBe(300 - 2 * OVERLAY_MARGIN)
  })
})

describe('clampPosition', () => {
  const card = cardSize(undefined, BOUNDS)
  it('keeps a position that is inside, and returns the same object', () => {
    const pos = { left: 100, top: 100 }
    expect(clampPosition(pos, card, BOUNDS)).toBe(pos)
  })
  it('lets the card sit anywhere in the window, over the left column too', () => {
    const overColumn = { left: OVERLAY_MARGIN, top: BOUNDS.y + OVERLAY_MARGIN }
    expect(clampPosition(overColumn, card, BOUNDS)).toBe(overColumn)
  })
  it('moves a position the least that keeps the card whole inside the window, margins on every side', () => {
    expect(clampPosition({ left: -50, top: -50 }, card, BOUNDS)).toEqual({ left: 16, top: BOUNDS.y + 16 })
    expect(clampPosition({ left: 5000, top: 5000 }, card, BOUNDS)).toEqual({
      left: BOUNDS.w - card.w - 16,
      top: BOUNDS.y + BOUNDS.h - card.h - 16
    })
  })
  it('clamps a remembered place into a smaller window', () => {
    const small = { x: 0, y: 30, w: 800, h: 500 }
    expect(clampPosition({ left: 1000, top: 600 }, card, small)).toEqual({ left: 800 - card.w - 16, top: 30 + 500 - card.h - 16 })
  })
})

describe('openPosition', () => {
  const card = cardSize(undefined, BOUNDS)
  const centre = { left: Math.round(PANE.x + (PANE.w - card.w) / 2), top: Math.round(PANE.y + (PANE.h - card.h) / 2) }
  const corner = { left: PANE.x + 16, top: PANE.y + 16 }

  it('centres over the pane area when nothing is remembered', () => {
    expect(openPosition(card, BOUNDS, PANE, 'center', undefined, true)).toEqual(centre)
  })
  it('sits in the pane area’s near corner for "panel" while the panel column is open, centred while it is collapsed', () => {
    expect(openPosition(card, BOUNDS, PANE, 'panel', undefined, true)).toEqual(corner)
    expect(openPosition(card, BOUNDS, PANE, 'panel', undefined, false)).toEqual(centre)
  })
  it('an explicit "panel" anchor wins over the remembered place', () => {
    const remembered = { left: 800, top: 400 }
    expect(openPosition(card, BOUNDS, PANE, 'panel', remembered, true)).toEqual(corner)
    expect(openPosition(card, BOUNDS, PANE, 'panel', remembered, false)).toEqual(centre)
  })
  it('an open naming no place opens where the user left it — over the left column too — kept inside the window', () => {
    expect(openPosition(card, BOUNDS, PANE, 'center', { left: 40, top: 200 }, true)).toEqual({ left: 40, top: 200 })
    expect(openPosition(card, BOUNDS, PANE, 'center', { left: 4000, top: 4000 }, true)).toEqual({
      left: BOUNDS.w - card.w - 16,
      top: BOUNDS.y + BOUNDS.h - card.h - 16
    })
  })
})
