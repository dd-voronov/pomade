import { describe, expect, it } from 'vitest'

import type { HostedApp } from '@shared/types'
import { findAppShortcut } from './app-shortcuts'

const app = (id: string, keys: string[], unavailable: string | null = null): HostedApp =>
  ({
    id,
    unavailable,
    shortcuts: keys.map((key, i) => ({ id: `s${i}`, title: `S${i}`, key, action: 'tab', route: `r${i}` }))
  }) as unknown as HostedApp

const key = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  code,
  metaKey: mods.meta ?? true,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false
})

describe('findAppShortcut', () => {
  const apps = [app('a', ['Cmd+Shift+Y']), app('b', ['Cmd+Alt+P', 'Cmd+1']), app('gone', ['Cmd+Ctrl+J'], 'removed')]

  it('finds the app and shortcut a chord belongs to', () => {
    expect(findAppShortcut(apps, key('KeyY', { shift: true }))).toMatchObject({ app: { id: 'a' }, shortcut: { route: 'r0' } })
    expect(findAppShortcut(apps, key('Digit1'))).toMatchObject({ app: { id: 'b' }, shortcut: { route: 'r1' } })
  })

  it('nothing for other chords, plain keys, extra modifiers or unavailable apps', () => {
    expect(findAppShortcut(apps, key('KeyY'))).toBeNull()
    expect(findAppShortcut(apps, key('KeyY', { meta: false, shift: true }))).toBeNull()
    expect(findAppShortcut(apps, key('KeyY', { shift: true, ctrl: true }))).toBeNull()
    expect(findAppShortcut(apps, key('KeyJ', { ctrl: true }))).toBeNull()
    expect(findAppShortcut([], key('KeyY', { shift: true }))).toBeNull()
  })
})
