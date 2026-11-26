// Pomade E-002 (T-015) — app settings store.
// Hydrates from window.pomade.app.getSettings() at start and again when the workspace changes
// (settings live in the workspace: `.pomade/settings.json` + `.pomade/state/view.json`); every
// mutation persists via window.pomade.app.setSettings() and reflects the merged result.
//
// E-007 (T-029/T-030) — also owns the layout (column widths + Projects panel
// collapse). Width setters update state LIVE (no IPC) so dragging stays smooth; the caller
// persists once at drag end via persistLayout(). Collapse toggles persist immediately.

import { create } from 'zustand'

import { withGroupFolded } from '@shared/doc-history'
import {
  DEFAULT_APP_SETTINGS,
  LAYOUT_LIMITS,
  type AppSettings,
  type LayoutSettings,
  type MarkdownDefaultMode,
  type MarkdownFormatting
} from '@shared/types'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface AppSettingsState extends AppSettings {
  hydrated: boolean
  hydrate: () => Promise<void>
  setMarkdownDefaultMode: (mode: MarkdownDefaultMode) => Promise<void>
  // E-024 — Keep formatting (Live) / Adjust formatting (Rendered) as the markdown rich view.
  setMarkdownFormatting: (value: MarkdownFormatting) => Promise<void>
  // E-006 (T-027) — launch behavior toggle.
  setConfirmWorkspaceOnStartup: (value: boolean) => Promise<void>
  // T-063 — file-tree preview-tab mode toggle.
  setPreviewTabMode: (value: boolean) => Promise<void>
  // T-084 — terminal auto-copy-on-select toggle.
  setTerminalAutoCopy: (value: boolean) => Promise<void>
  // T-090 — editor-header name field: name ⇄ informative path (one global, clicked in the header).
  setEditorHeaderShowPath: (value: boolean) => Promise<void>
  // T-152 — em-dash auto-replacement toggle (Settings ▸ Editor).
  setEmDashReplace: (value: boolean) => Promise<void>
  // E-036 — the file tree's "Show git status" toggle.
  setShowGitStatus: (value: boolean) => Promise<void>
  // E-032 — mute / unmute one notice source.
  setNoticeSourceMuted: (source: string, muted: boolean) => Promise<void>
  // T-223 — fold / unfold one Document history group (every document's).
  setDocHistoryGroupFolded: (group: string, folded: boolean) => Promise<void>
  // T-267 — the comparison tab's Changes only switch (every comparison tab's).
  setCompareChangesOnly: (value: boolean) => Promise<void>
  // T-274 — local history's two extension lists (Settings ▸ General ▸ Local history).
  setLocalHistoryAlways: (value: string[]) => Promise<void>
  setLocalHistoryNever: (value: string[]) => Promise<void>
  setProjectSwitchToast: (value: boolean) => Promise<void>
  setLocalHistoryCapMb: (value: number) => Promise<void>
  // T-153 — per-surface font selections (font ids; see font-catalog.ts).
  setTerminalFont: (value: string) => Promise<void>
  setEditorRawFont: (value: string) => Promise<void>
  // E-007 (T-029) — live width setters (state only; persist via persistLayout at drag end).
  setProjectsPanelWidth: (width: number) => void
  setFileTreeWidth: (width: number) => void
  persistLayout: () => Promise<void>
  // E-007 (T-030) — collapse toggles persist immediately.
  toggleProjectsPanelCollapsed: () => Promise<void>
  setProjectsPanelCollapsed: (value: boolean) => Promise<void>
  // T-049 — file-tree collapse toggles persist immediately (same as the Projects panel).
  toggleFileTreeCollapsed: () => Promise<void>
  setFileTreeCollapsed: (value: boolean) => Promise<void>
}

export const useAppSettingsStore = create<AppSettingsState>((set, get) => {
  const persistLayout = async (): Promise<void> => {
    const { layout } = get()
    const merged = await window.pomade.app.setSettings({ layout })
    set({ ...merged })
  }

  const patchLayout = (patch: Partial<LayoutSettings>): void => {
    set((s) => ({ layout: { ...s.layout, ...patch } }))
  }

  // T-179 — every plain-value setting setter was this same optimistic-set-then-merge dance,
  // byte-identical but for the one key. NOTE (pre-existing, not fixed here): the merge overwrites
  // with whatever main returns from THIS patch, so a second `persistSetting` call that resolves
  // while an earlier one is still in flight can have its optimistic set silently reverted by the
  // earlier call's merge landing after it (last `setSettings` response wins, not last call).
  const persistSetting = async (patch: Partial<AppSettings>): Promise<void> => {
    set(patch) // optimistic
    const merged = await window.pomade.app.setSettings(patch)
    set({ ...merged })
  }

  return {
    ...DEFAULT_APP_SETTINGS,
    hydrated: false,

    hydrate: async () => {
      try {
        const settings = await window.pomade.app.getSettings()
        set({ ...settings, hydrated: true })
      } catch {
        set({ hydrated: true }) // fall back to defaults if the read fails
      }
    },

    setMarkdownDefaultMode: (mode) => persistSetting({ markdownDefaultMode: mode }),
    // E-024 — Keep formatting (Live) / Adjust formatting (Rendered) as the markdown rich view.
    setMarkdownFormatting: (value) => persistSetting({ markdownFormatting: value }),
    // E-006 (T-027) — launch behavior toggle.
    setConfirmWorkspaceOnStartup: (value) => persistSetting({ confirmWorkspaceOnStartup: value }),
    // T-063 — file-tree preview-tab mode toggle.
    setPreviewTabMode: (value) => persistSetting({ previewTabMode: value }),
    // T-084 — terminal auto-copy-on-select toggle.
    setTerminalAutoCopy: (value) => persistSetting({ terminalAutoCopy: value }),
    // T-090 — editor-header name field: name ⇄ informative path (one global, clicked in the header).
    setEditorHeaderShowPath: (value) => persistSetting({ editorHeaderShowPath: value }),
    // T-152 — em-dash auto-replacement toggle (Settings ▸ Editor).
    setEmDashReplace: (value) => persistSetting({ emDashReplace: value }),
    setShowGitStatus: (value) => persistSetting({ showGitStatus: value }),
    setNoticeSourceMuted: (source, muted) => {
      const rest = get().mutedNoticeSources.filter((s) => s !== source)
      return persistSetting({ mutedNoticeSources: muted ? [...rest, source] : rest })
    },
    setDocHistoryGroupFolded: (group, folded) =>
      persistSetting({ docHistoryFolded: withGroupFolded(get().docHistoryFolded, group, folded) }),
    // T-267 — the comparison tab's Changes only switch (every comparison tab's).
    setCompareChangesOnly: (value) => persistSetting({ compareChangesOnly: value }),
    setLocalHistoryAlways: (value) => persistSetting({ localHistoryAlways: value }),
    setLocalHistoryNever: (value) => persistSetting({ localHistoryNever: value }),
    // T-311 — the experimental project-switch toast.
    setProjectSwitchToast: (value) => persistSetting({ projectSwitchToast: value }),
    // T-234 — the local-history store's size cap (MB).
    setLocalHistoryCapMb: (value) => persistSetting({ localHistoryCapMb: value }),
    // T-153 — per-surface font selections (font ids; see font-catalog.ts).
    setTerminalFont: (value) => persistSetting({ terminalFont: value }),
    setEditorRawFont: (value) => persistSetting({ editorRawFont: value }),

    setProjectsPanelWidth: (width) => {
      patchLayout({ projectsPanelWidth: clamp(width, LAYOUT_LIMITS.projectsPanelMin, LAYOUT_LIMITS.projectsPanelMax) })
    },

    setFileTreeWidth: (width) => {
      patchLayout({
        fileTreeWidth: clamp(width, LAYOUT_LIMITS.fileTreeMin, LAYOUT_LIMITS.fileTreeMax)
      })
    },

    persistLayout,

    toggleProjectsPanelCollapsed: async () => {
      patchLayout({ projectsPanelCollapsed: !get().layout.projectsPanelCollapsed })
      await persistLayout()
    },

    setProjectsPanelCollapsed: async (value) => {
      patchLayout({ projectsPanelCollapsed: value })
      await persistLayout()
    },

    toggleFileTreeCollapsed: async () => {
      patchLayout({ fileTreeCollapsed: !get().layout.fileTreeCollapsed })
      await persistLayout()
    },

    setFileTreeCollapsed: async (value) => {
      patchLayout({ fileTreeCollapsed: value })
      await persistLayout()
    }
  }
})
