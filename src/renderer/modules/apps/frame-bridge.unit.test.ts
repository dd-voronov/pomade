import type { KeyMessage } from 'pomade-kit/protocol'
import { describe, expect, it } from 'vitest'

import { isForwardedKey, isOverlayEscape } from './frame-bridge'

describe('isForwardedKey', () => {
  const key: KeyMessage = {
    channel: 'pomade',
    type: 'key',
    key: 'y',
    code: 'KeyY',
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true
  }
  it('accepts a Cmd or Ctrl chord', () => {
    expect(isForwardedKey(key)).toBe(true)
    expect(isForwardedKey({ ...key, metaKey: false, ctrlKey: true })).toBe(true)
  })
  it('refuses a key without Cmd or Ctrl', () => {
    expect(isForwardedKey({ ...key, metaKey: false })).toBe(false)
  })
  it('refuses a modifier key pressed alone', () => {
    expect(isForwardedKey({ ...key, key: 'Meta', code: 'MetaLeft' })).toBe(false)
  })
  it('refuses a chord main runs natively (a menu accelerator, Cmd+Shift+B), on the physical key', () => {
    expect(isForwardedKey({ ...key, key: 'b', code: 'KeyB' })).toBe(false)
    expect(isForwardedKey({ ...key, key: 'И', code: 'KeyB' })).toBe(false)
    expect(isForwardedKey({ ...key, key: 'w', code: 'KeyW', shiftKey: false })).toBe(false)
    expect(isForwardedKey({ ...key, key: 'b', code: 'KeyB', shiftKey: false })).toBe(false)
  })
  it('relays a renderer chord (quick peek, document history)', () => {
    expect(isForwardedKey({ ...key, key: 'g', code: 'KeyG' })).toBe(true)
    expect(isForwardedKey({ ...key, key: 'h', code: 'KeyH' })).toBe(true)
  })
})

describe('isOverlayEscape', () => {
  const esc = { channel: 'pomade', type: 'key', key: 'Escape', code: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as const
  it('is a plain Escape only', () => {
    expect(isOverlayEscape(esc)).toBe(true)
    expect(isOverlayEscape({ ...esc, shiftKey: true })).toBe(false)
    expect(isOverlayEscape({ ...esc, metaKey: true })).toBe(false)
    expect(isOverlayEscape({ ...esc, altKey: true })).toBe(false)
    expect(isOverlayEscape({ ...esc, key: 'Enter', code: 'Enter' })).toBe(false)
  })
})
