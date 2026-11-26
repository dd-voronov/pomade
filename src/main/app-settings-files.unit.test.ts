import { describe, expect, it } from 'vitest'

import { DEFAULT_APP_SETTINGS, DEFAULT_LAYOUT_SETTINGS, type AppSettings } from '@shared/types'
import {
  filesTouchedBy,
  mergeAppSettings,
  buildFlavor,
  preferencesOf,
  readAppSettings,
  viewStateOf
} from './app-settings-files'

const OLD: Partial<AppSettings> & Record<string, unknown> = {
  markdownDefaultMode: 'raw',
  terminalAutoCopy: false,
  mutedNoticeSources: ['pomade-git'],
  editorHeaderShowPath: true,
  docHistoryFolded: ['local'],
  compareChangesOnly: true,
  layout: { projectsPanelWidth: 300, fileTreeWidth: 280, projectsPanelCollapsed: true, fileTreeCollapsed: false }
}

describe('preferences and view state', () => {
  it('split every key into exactly one file', () => {
    const s = mergeAppSettings(OLD)
    const prefs = preferencesOf(s) as Record<string, unknown>
    const view = viewStateOf(s) as Record<string, unknown>
    expect(Object.keys(view).sort()).toEqual(['compareChangesOnly', 'docHistoryFolded', 'editorHeaderShowPath', 'layout'])
    for (const k of Object.keys(view)) expect(prefs).not.toHaveProperty(k)
    expect({ ...prefs, ...view }).toEqual(s)
  })

  it('read back: each file contributes only its own keys; unknown keys dropped; gaps defaulted', () => {
    const s = readAppSettings(
      { markdownDefaultMode: 'raw', layout: { fileTreeWidth: 999 }, compareChangesOnly: true, bogus: 1 },
      { layout: { projectsPanelWidth: 300 }, terminalAutoCopy: false, docHistoryFolded: ['local'] }
    )
    expect(s.markdownDefaultMode).toBe('raw')
    expect(s.terminalAutoCopy).toBe(true)
    expect(s.compareChangesOnly).toBe(false)
    expect(s.docHistoryFolded).toEqual(['local'])
    expect(s.layout).toEqual({ ...DEFAULT_LAYOUT_SETTINGS, projectsPanelWidth: 300 })
    expect(s).not.toHaveProperty('bogus')
  })

  it('missing or unreadable files read as the defaults', () => {
    expect(readAppSettings(null, null)).toEqual(DEFAULT_APP_SETTINGS)
    expect(readAppSettings('garbage', [1, 2])).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('a patch touches only the file its keys live in', () => {
    expect(filesTouchedBy({ layout: DEFAULT_LAYOUT_SETTINGS })).toEqual({ preferences: false, viewState: true })
    expect(filesTouchedBy({ terminalAutoCopy: false })).toEqual({ preferences: true, viewState: false })
    expect(filesTouchedBy({ terminalAutoCopy: false, compareChangesOnly: true })).toEqual({ preferences: true, viewState: true })
    expect(filesTouchedBy({})).toEqual({ preferences: false, viewState: false })
  })

  it('a partial layout patch keeps sibling fields', () => {
    const s = mergeAppSettings(OLD, { layout: { fileTreeCollapsed: true } as AppSettings['layout'] })
    expect(s.layout).toEqual({ ...OLD.layout, fileTreeCollapsed: true })
  })
})

describe('buildFlavor', () => {
  it('packaged is stable, unpackaged dev; the test override applies only under test', () => {
    expect(buildFlavor({}, true)).toBe('stable')
    expect(buildFlavor({}, false)).toBe('dev')
    expect(buildFlavor({ NODE_ENV: 'test', POMADE_TEST_BUILD_FLAVOR: 'stable' }, false)).toBe('stable')
    expect(buildFlavor({ NODE_ENV: 'test', POMADE_TEST_BUILD_FLAVOR: 'dev' }, true)).toBe('dev')
    expect(buildFlavor({ NODE_ENV: 'test', POMADE_TEST_BUILD_FLAVOR: 'other' }, false)).toBe('dev')
    expect(buildFlavor({ POMADE_TEST_BUILD_FLAVOR: 'stable' }, false)).toBe('dev')
  })
})
