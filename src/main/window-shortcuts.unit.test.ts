import { describe, expect, it } from 'vitest'

import { isToggleSidePanel, type ShortcutInput } from './window-shortcuts'

const cmdShiftB: ShortcutInput = { type: 'keyDown', code: 'KeyB', meta: true, control: false, alt: false, shift: true }

describe('isToggleSidePanel', () => {
  it('is Cmd+Shift+B on macOS, by physical key', () => {
    expect(isToggleSidePanel(cmdShiftB, 'darwin')).toBe(true)
  })
  it('is Ctrl+Shift+B elsewhere', () => {
    expect(isToggleSidePanel({ ...cmdShiftB, meta: false, control: true }, 'linux')).toBe(true)
    expect(isToggleSidePanel(cmdShiftB, 'linux')).toBe(false)
  })
  it('is only that chord, on key down', () => {
    expect(isToggleSidePanel({ ...cmdShiftB, type: 'keyUp' }, 'darwin')).toBe(false)
    expect(isToggleSidePanel({ ...cmdShiftB, shift: false }, 'darwin')).toBe(false)
    expect(isToggleSidePanel({ ...cmdShiftB, alt: true }, 'darwin')).toBe(false)
    expect(isToggleSidePanel({ ...cmdShiftB, control: true }, 'darwin')).toBe(false)
    expect(isToggleSidePanel({ ...cmdShiftB, code: 'KeyN' }, 'darwin')).toBe(false)
  })
})
