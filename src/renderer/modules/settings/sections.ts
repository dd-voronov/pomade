// Pomade E-006 (T-026) — the extensible section registry.
// Adding a future Settings section is exactly one entry here plus its component — the
// SettingsModal shell renders one nav button per entry and mounts the active section's
// component, with no shell changes. Keep `id`s stable: entry points deep-link by id
// (e.g. the file-tree gear opens 'filetree'), and the first entry is the default section.

import type { ComponentType } from 'react'

import { GeneralSection } from './GeneralSection'
import { FileTreeSection } from './FileTreeSection'

export type SettingsSectionId = 'general' | 'filetree'

export interface SettingsSection {
  id: SettingsSectionId
  label: string
  Component: ComponentType
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'general', label: 'General', Component: GeneralSection },
  { id: 'filetree', label: 'File tree', Component: FileTreeSection }
]
