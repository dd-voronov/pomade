// Pomade E-006 (T-026) — unified Settings surface: UI state only.
// A single open/section store drives ONE sectioned Settings modal. Every scattered entry
// point (Projects panel footer gear, Cmd+, , file-tree gear, git sync) routes through this store
// so there is exactly one surface for a given setting. `openSettings(sectionId?)` deep-links
// to a section; an unknown/omitted id falls back to the first registered section.

import { create } from 'zustand'

import { SETTINGS_SECTIONS, type SettingsSectionId } from './sections'

interface SettingsUiState {
  open: boolean
  sectionId: SettingsSectionId
  openSettings: (sectionId?: SettingsSectionId) => void
  closeSettings: () => void
  setSection: (sectionId: SettingsSectionId) => void
}

const DEFAULT_SECTION: SettingsSectionId = SETTINGS_SECTIONS[0].id

export const useSettingsStore = create<SettingsUiState>((set) => ({
  open: false,
  sectionId: DEFAULT_SECTION,
  openSettings: (sectionId) =>
    set({
      open: true,
      sectionId:
        sectionId && SETTINGS_SECTIONS.some((s) => s.id === sectionId) ? sectionId : DEFAULT_SECTION
    }),
  closeSettings: () => set({ open: false }),
  setSection: (sectionId) => set({ sectionId })
}))
