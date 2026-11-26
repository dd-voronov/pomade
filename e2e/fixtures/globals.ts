// Pomade e2e — the test globals, typed once for every spec (docs/contracts/test-hooks.md).
//
// `window.pomade` (the preload bridge) is declared by src/shared/ipc-api.ts, which tsconfig.e2e.json
// includes; everything else the app installs for tests is declared here, so a spec reads
// `window.__pomadeStores…` / `globalThis.__pomadeRevealedPaths` without a cast and a renamed hook or
// field fails typecheck instead of passing on `undefined`.
//
// Renderer hooks a pane installs once it is live (the terminal and editor link maps) are declared
// present: a spec calls them only after the pane is up, and an absent map throws, failing the spec
// loudly. Hooks a spec reads before they may exist are optional.
//
// The test fixture apps' surfaces (`window.__hello`, `window.__agents`) and the probes a spec
// installs in a page or app frame (`__seen`, `__changes`, `__toggles`, …) are declared here too, so
// no spec casts `window`. A probe is declared present: the spec that installs it reads it only
// afterwards.

import type { PomadeStores } from './stores'

/** One resolved terminal link as `__pomadeTermProvideLinks` reports it (absolute 0-based rows). */
export interface ProvidedTermLink {
  target: string
  startY: number
  endY: number
}

/** A Host API picker request as `__pomadePick` logs it. */
export interface PickRequest {
  defaultPath: string
  message: string
  extensions?: string[]
}

/** The text-node probe editor-spellcheck-stability.spec.ts installs in the page (not an app hook):
 *  `idsFor` lists the expando ids of the text nodes in the blocks containing a line; `textChurn`
 *  logs every text-node characterData / add / remove under the observed editor. */
export interface SpellStableProbe {
  tag: () => void
  textChurn: string[]
  idsFor: (line: string) => string[]
}

/** A Host API call's outcome, as the fixture apps' `call` resolves it. */
export interface CallResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

/** What the hello fixture app was told on `welcome`. */
export interface HelloWelcome {
  surface: string
  icon?: string
  key?: string
  kind?: string
  route: string
}

/** A Host API event the hello fixture app received. */
export interface HelloEvent {
  name: string
  payload: unknown
}

/** One roadmap row the hello fixture app lists. */
export interface HelloRow {
  path: string
  id?: string
  title?: string
  status?: string
  error: string | null
}

/** `window.__hello` — the hello fixture app's live state plus a raw `call` (e2e/fixtures/apps/hello). */
export interface HelloState {
  mark: string
  status: string
  welcome: HelloWelcome | null
  route: string
  project: { id: string; kind: string; name: string; root: string } | null
  rows: HelloRow[]
  events: HelloEvent[]
  requests: unknown[]
  copyResult: string | null
  lastOverlayOpen?: unknown
  call: (method: string, params?: unknown) => Promise<CallResult>
}

/** `window.__agents` — the pomade-agents stand-in's state plus a raw `call` (e2e/fixtures/apps/agents). */
export interface AgentsState {
  status: string
  route: string
  roster: unknown[] | null
  sessions: unknown[] | null
  live: unknown[] | null
  silent: boolean
  events: HelloEvent[]
  requests: { from: string; method: string; params?: Record<string, unknown> }[]
  call: (method: string, params?: unknown) => Promise<CallResult>
}

/** One `files.changed` batch an app frame logs into `__seen` / `__settle.batches`. */
export interface SeenBatch {
  watchId: string
  changes: { kind: string; path: string }[]
}

declare global {
  interface Window {
    __pomadeStores: PomadeStores
    __pomadeEditorSelectionFrom?: () => number
    __pomadeEditorLinkResolve: Record<string, (text: string) => Promise<boolean>>
    __pomadeTermLinks: Record<string, (token: string) => Promise<void>>
    __pomadeTermLinkResolve: Record<string, (token: string) => Promise<boolean>>
    __pomadeTermProvideLinks: Record<string, (rowText: string) => Promise<ProvidedTermLink[]>>
    __pomadeAttachedBuffer?: Record<string, () => string>
    __pomadeCaretTrace?: { at: string; stage: string; [k: string]: unknown }[]
    __pomadeRenderCounts?: Record<string, number>
    __spellStable: SpellStableProbe
    __hello: HelloState
    __agents: AgentsState
    // Probes specs install in the page or an app frame.
    __seen: SeenBatch[]
    __settle: { batches: SeenBatch[]; reads: { path: string; content: string }[] }
    __changes: string[]
    __unsub?: () => void
    __toggles: number
    __keyB: number
    __releaseFocusTimer: () => void
  }

  // Main-process globals (read with `electronApp.evaluate`). `var` is what makes them properties
  // of `globalThis` in a type declaration.
  var __pomadeOpenedUrls: string[] | undefined
  var __pomadeOpenedPaths: string[] | undefined
  var __pomadeRevealedPaths: string[] | undefined
  var __pomadePick: { answers: (string | null)[]; requests: PickRequest[] } | undefined
  var __pomadeTheme: { set(theme: 'light' | 'dark'): void; get(): 'light' | 'dark' } | undefined
  var __pomadeNameIndex:
    | { builds: number; patches: number; watching: boolean; lastBuildMs: number; files: number; dirs: number }
    | undefined
  var __pomadeNameIndexRewalk: (() => Promise<void>) | undefined
  var __pomadeDocWatch: { dirs: number } | undefined
  var __pomadeOutsideWatch: { size: number } | undefined
  var __pomadeTreeReads: string[] | undefined
}
