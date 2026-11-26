import { describe, expect, it } from 'vitest'

import { upgradeLayout } from './layout-settings'

describe('upgradeLayout', () => {
  it('moves the old Projects panel keys to the new ones', () => {
    expect(upgradeLayout({ sidebarWidth: 300, sidebarCollapsed: true, fileTreeWidth: 250 })).toEqual({
      projectsPanelWidth: 300,
      projectsPanelCollapsed: true,
      fileTreeWidth: 250
    })
  })

  it('keeps a new key over an old one and drops the old one', () => {
    expect(upgradeLayout({ sidebarWidth: 300, projectsPanelWidth: 200, sidebarCollapsed: false })).toEqual({
      projectsPanelWidth: 200,
      projectsPanelCollapsed: false
    })
  })

  it('leaves a current layout and a missing one as they are', () => {
    expect(upgradeLayout({ projectsPanelWidth: 200, fileTreeCollapsed: true })).toEqual({
      projectsPanelWidth: 200,
      fileTreeCollapsed: true
    })
    expect(upgradeLayout(undefined)).toEqual({})
  })

  it('does not change the stored object', () => {
    const stored = { sidebarWidth: 300 }
    upgradeLayout(stored)
    expect(stored).toEqual({ sidebarWidth: 300 })
  })
})
