// Pomade — pane renderer registry.
// PaneHost looks up a renderer by TabKind. Later waves plug in the real renderers:
//   Wave 2b: registerPane('terminal', TerminalPane); registerPane('agent', AgentPane)
//   Wave 2c: registerPane('doc', EditorPane)
// Wave 1 registers a single PlaceholderPane for all three kinds so the framework is testable.

import type { ComponentType } from 'react'

import type { Tab, TabKind } from '@shared/types'

export interface PaneProps {
  tab: Tab
}

export type PaneComponent = ComponentType<PaneProps>

const registry = new Map<TabKind, PaneComponent>()

export function registerPane(kind: TabKind, component: PaneComponent): void {
  registry.set(kind, component)
}

export function getPane(kind: TabKind): PaneComponent | undefined {
  return registry.get(kind)
}
