// Pomade — TerminalPane (renderer). Wave 2b.
// An @xterm/xterm view wired to a main-process PTY over IPC. Registered for kinds
// 'terminal' and 'agent'. Panes are NEVER unmounted on project switch (PaneHost keeps
// them mounted, display:none) — so this component tolerates being hidden and re-fits on
// re-show. A dead PTY renders a last-state note plus Relaunch (and Resume for agents with a known
// session id). T-114 (E-022): a tab RESTORED as live is no longer one of those — its PTY is gone,
// but it waits (runtime-only, showing an empty live pane) to be REVIVED when its project opens, so
// the dead branch below is reached only by a genuine exit, a tab persisted dead, or an agent revive
// could not resume.
//
// E-020 adds the terminal's copy-out / navigation UX:
//   T-084 — renderer-built right-click menu (Copy/Paste/Select all/Clear) + auto-copy-on-select.
//   T-085 — Option+click moves the shell's cursor (xterm's altClickMovesCursor).
//   T-086 — Cmd+click opens file paths and URLs found in the output (an xterm link provider).
//   T-092 — that provider ALWAYS runs; Cmd only toggles the link decorations, and a row's
//           candidates resolve in parallel (see the provider and `syncMeta`).

import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

import type { TerminalTab } from '@shared/types'
import type { PaneProps } from '../../panes/registry'
import { buildAllProjects, useWorkspaceStore } from '../../stores/workspace-store'
import { useTabsStore } from '../../stores/tabs-store'
import { useTerminalsStore } from '../../stores/terminals-store'
import { useCloseGuard } from '../../hooks/useCloseGuard'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { fontStackFor, areBundledFontsReady, bundledFontsReady } from '../../font-catalog'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { DialogShell } from '../../components/DialogShell'
import dialogStyles from '../../components/dialog.module.css'
import { scanCandidates } from './term-links'
import { activatePickedMatch, activateResolved, resolveCandidate, type LinkContext } from './term-link-open'
import { computeRowLinks } from './term-link-rows'
import { useXtermSession, type PickerState } from './useXtermSession'
import styles from './TerminalPane.module.css'

// T-084 — how long the "Copied N chars" confirmation stays up before fading out.
const COPY_HINT_MS = 1500

/** T-084 — the terminal's own context menu. `selection` is captured at right-click time so
 *  Copy acts on what was highlighted even if the click itself collapsed the live selection. */
interface TermMenuState {
  x: number
  y: number
  selection: string
}

export function TerminalPane({ tab }: PaneProps): React.JSX.Element {
  // Registry only maps this pane to terminal/agent kinds, so the cast is safe.
  const term = tab as TerminalTab

  const mountId = useRef(nanoid()).current
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [rosterCmd, setRosterCmd] = useState<string | null>(null)

  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const activeTabId = useTabsStore((s) => s.activeTabByProject[tab.projectId])
  const visible = activeProjectId === term.projectId && activeTabId === term.id

  // T-044 — close-confirmation state. `busyRef` mirrors the pty's live foreground-busy flag
  // (a running command); the guard confirms before killing a live agent or a busy terminal.
  const closeTab = useTabsStore((s) => s.closeTab)
  const busyRef = useRef(false)
  // The shared close guard: prompt before killing a LIVE agent (its context is valuable even at an
  // idle prompt) or a BUSY plain terminal (a foreground command is running); idle terminals and
  // dead tabs close silently.
  const {
    prompt: closePrompt,
    setPrompt: setClosePrompt,
    resolveClose
  } = useCloseGuard(
    term.projectId,
    term.id,
    () => term.status === 'live' && (term.kind === 'agent' || busyRef.current)
  )

  // ── E-020 state ──────────────────────────────────────────────────────────────
  // T-084 — the right-click menu, the "Copied N chars" flash, and the auto-copy setting.
  const [menu, setMenu] = useState<TermMenuState | null>(null)
  const [hint, setHint] = useState<{ chars: number; nonce: number } | null>(null)
  const hintSeqRef = useRef(0)
  const autoCopy = useAppSettingsStore((s) => s.terminalAutoCopy)
  const autoCopyRef = useRef(autoCopy)
  autoCopyRef.current = autoCopy

  // T-153 — the terminal font selection (font id → CSS stack). Held in a ref so the xterm effect
  // reads the current value at CREATION without depending on it (a font change must restyle the
  // live xterm, never rebuild it and lose scrollback); a separate effect restyles on change.
  const terminalFont = useAppSettingsStore((s) => s.terminalFont)
  const terminalFontRef = useRef(terminalFont)
  terminalFontRef.current = terminalFont

  // T-153 — gate xterm creation on the bundled fonts being loaded, so xterm never measures its
  // grid before a bundled family is available (a wrong-metrics grid until the next refit). The
  // faces load at boot (font-catalog import in main.tsx), so this is already true by the time the
  // first project — and thus the first terminal — is opened; the gate only ever waits on a
  // terminal created within the first few ms of launch. Seeded synchronously to avoid re-gating.
  const [fontsReady, setFontsReady] = useState(areBundledFontsReady)
  useEffect(() => {
    if (fontsReady) return
    let mounted = true
    void bundledFontsReady.then(() => {
      if (mounted) setFontsReady(true)
    })
    return () => {
      mounted = false
    }
  }, [fontsReady])
  // The last text we copied, so a re-render / a selection that didn't change never re-copies
  // (xterm's onSelectionChange fires per drag tick — the commit point here is MOUSEUP).
  const lastCopiedRef = useRef('')

  // T-086 — link state. `cwdRef` is the shell's live working directory (first resolution base).
  // T-092 — `metaRef` no longer GATES the link affordance: links are always provided, and Cmd
  // only decides whether they are DECORATED (underline + pointer cursor). See the provider.
  const metaRef = useRef(false)
  const cwdRef = useRef('')
  const [picker, setPicker] = useState<PickerState | null>(null)

  // On first mount of a supposedly-live tab, verify its PTY actually still exists (after an app
  // restart it won't). T-114 (E-022): a restored-live tab whose PTY is gone is now a REVIVE
  // CANDIDATE, not an immediate dead pane — the store keeps the mark runtime-only and resolves it
  // when the tab's project is opened. That is also why this pane keeps rendering its (empty) live
  // branch in the meantime: no dead-pane flash before a revive, and the xterm effect re-attaches
  // by itself when revive swaps `termId`.
  useEffect(() => {
    if (term.status === 'live') void useTerminalsStore.getState().reconcile(term.projectId, term)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a restore check, once per mounted tab; a later termId or status change is this run's own (revive, relaunch) and needs no check
  }, [])

  // ── E-020 helpers ────────────────────────────────────────────────────────────
  const showHint = (chars: number): void => {
    hintSeqRef.current += 1
    setHint({ chars, nonce: hintSeqRef.current })
  }
  const showHintRef = useRef(showHint)
  showHintRef.current = showHint

  /** T-084 — copy `text` and flash the confirmation. Used by auto-copy, Cmd+C and menu Copy. */
  const copyText = (text: string): void => {
    if (!text) return
    lastCopiedRef.current = text
    void window.pomade.app.clipboardWrite(text)
    showHintRef.current(text.length)
  }
  const copyTextRef = useRef(copyText)
  copyTextRef.current = copyText

  /** T-084 — paste the clipboard into the PTY (the shell echoes it, as with a real paste). */
  const pasteIntoPty = (): void => {
    void (async () => {
      const text = await window.pomade.app.clipboardRead()
      if (text) await window.pomade.pty.write(term.termId, text)
    })()
    // T-123 — this menu action writes to the pty directly (it never reaches xterm), so
    // `coreService.onUserInput` won't fire for it; clear the attention dot here explicitly. It is
    // an unambiguous user action. Guarded in the store, so a no-op when the tab is already clean.
    useTabsStore.getState().clearTabAttention(projectIdRef.current, term.id)
  }

  // T-086 — resolution bases, read FRESH from the stores at hover/click time so neither a
  // project switch nor a `cd` needs the xterm effect to re-subscribe. `TerminalTab.cwd` (the
  // persisted, workspace-relative launch directory) covers the window before the shell's first
  // prompt marker has reported a live $PWD.
  const buildLinkContext = (): LinkContext => {
    const ws = useWorkspaceStore.getState()
    const wsRootAbs = ws.root ?? ''
    const active = buildAllProjects(ws.projects).find((p) => p.id === ws.activeProjectId)
    const rootPath = active?.rootPath ?? ''
    const staticCwd = term.cwd
      ? term.cwd.startsWith('/')
        ? term.cwd
        : `${wsRootAbs}/${term.cwd}`
      : wsRootAbs
    return {
      cwdAbs: cwdRef.current || staticCwd,
      projectRootAbs: rootPath ? `${wsRootAbs}/${rootPath}` : wsRootAbs,
      wsRootAbs
    }
  }
  const buildLinkContextRef = useRef(buildLinkContext)
  buildLinkContextRef.current = buildLinkContext

  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // T-097 — this tab's CURRENT project, read fresh inside useXtermSession's long-lived
  // subscriptions. "Move to another project" changes `term.projectId` on a live terminal; if
  // that value were a DEPENDENCY of the mount effect, the move would dispose the xterm and
  // rebuild it from the pty ring buffer (scrollback beyond it, and any full-screen TUI's
  // state, lost) even though the PTY itself is untouched. Via the ref the effect survives the
  // move untouched and still reports exits against the project the tab now lives in.
  const projectIdRef = useRef(term.projectId)
  projectIdRef.current = term.projectId

  // T-171 — the xterm MOUNT lifecycle: build the terminal and everything that lives and dies with
  // it (link provider, copy-on-select, pty-write forward + T-128 replay guard, genuine-input
  // signals, the T-116 attach paint, fit/resize), each concern a setup function returning its own
  // dispose. Keyed by termId/status/id/fontsReady exactly as before; `projectIdRef` (not
  // `term.projectId`) keeps a cross-project move from rebuilding xterm (T-097).
  useXtermSession({
    termId: term.termId,
    status: term.status,
    tabId: term.id,
    fontsReady,
    containerRef,
    termRef,
    fitRef,
    projectIdRef,
    terminalFontRef,
    metaRef,
    buildLinkContextRef,
    setPicker,
    autoCopyRef,
    copyTextRef,
    lastCopiedRef
  })

  // T-153 — restyle the LIVE xterm when the terminal font setting changes (terminals AND agent
  // panes, since agents render in an xterm too). Setting `options.fontFamily` re-measures the
  // char cell; a refit then reflows the grid to the new metrics and a resize keeps the pty's
  // rows/cols in sync — no rebuild, so scrollback and any full-screen TUI survive. `fontsReady`
  // is in the deps so a font selected before the fonts finished loading is applied once measured.
  useEffect(() => {
    const xterm = termRef.current
    const fit = fitRef.current
    if (!xterm || !fit) return
    const family = fontStackFor(terminalFont) || 'monospace'
    if (xterm.options.fontFamily === family) return
    let cancelled = false
    // Every bundled family is already loaded by the time any xterm exists (the creation gate),
    // so this resolves synchronously; awaiting `document.fonts.ready` is belt-and-braces for a
    // face that somehow isn't registered yet, so the refit never measures a not-yet-loaded font.
    void document.fonts.ready.then(() => {
      if (cancelled) return
      xterm.options.fontFamily = family
      try {
        fit.fit()
        void window.pomade.pty.resize(term.termId, xterm.cols, xterm.rows)
        xterm.refresh(0, xterm.rows - 1)
      } catch {
        /* container hidden / no dimensions — the re-show effect refits on next display */
      }
    })
    return () => {
      cancelled = true
    }
  }, [terminalFont, term.termId, fontsReady])

  // T-168 — the STATE-TRANSITION pty subscriptions (agent start/exit, session-id/unbound, exec,
  // cwd PERSISTENCE, attention) no longer live in this pane. They are owned by terminals-store,
  // keyed by termId and diffed off tabsByProject (subscribe-term-events, beside the PTY reaper),
  // so a transition lands regardless of whether this pane is mounted — the fix for the
  // hidden-not-unmounted data-loss class. This pane keeps ONLY xterm-facing wiring: onData / onExit
  // / fit / replay (in the xterm effect above), the link-base `cwdRef` (below), and the
  // close-guard `busyRef` (further below).

  // T-114 (E-022) — the link-resolution base. `cwdRef` mirrors this pty's live working directory so
  // neither a project switch nor a `cd` needs the xterm effect to re-subscribe; it is refreshed on
  // every prompt-marker report (first prompt, then every `cd`) as well as on the busy→idle edge
  // below. The PERSISTENCE of this cwd onto the tab is the store's job (handleCwd), not the pane's.
  useEffect(() => {
    if (term.status !== 'live') return
    return window.pomade.pty.onCwd(term.termId, (cwd) => {
      cwdRef.current = cwd
    })
  }, [term.status, term.termId])

  // T-056/T-061 — the per-tab attention dot is now cleared on the ACTIVATION EDGE by
  // tabs-store.setActive (activating a DIFFERENT tab wipes its dot). This edge-triggered clear
  // (instead of the old "visible && attention" effect that lived here) is what lets a manual
  // "Mark unread" on the ACTIVE tab keep its dot until the user leaves AND returns — and it
  // covers doc tabs too, which have no TerminalPane. See P-018 design note.

  // T-044 — mirror the pty's foreground-busy flag into a ref the close-guard reads. Seed
  // from pty.list() (covers a busy state entered before this subscription attached), then
  // track live changes. Non-live tabs are never busy.
  useEffect(() => {
    if (term.status !== 'live') {
      busyRef.current = false
      return
    }
    let cancelled = false
    // E-020 (T-086) — the shell's cwd rides along on the same signal. A prompt marker is what
    // flips busy→idle AND what reports `$PWD`, so refreshing the cwd on every idle edge tracks
    // every `cd` exactly, with no polling and no extra event channel.
    const readCwd = (): void => {
      void window.pomade.pty.cwd(term.termId).then((c) => {
        if (!cancelled && c) cwdRef.current = c
      })
    }
    void window.pomade.pty.list().then((list) => {
      if (cancelled) return
      const entry = list.find((t) => t.termId === term.termId)
      if (entry) {
        busyRef.current = entry.busy
        if (entry.cwd) cwdRef.current = entry.cwd
      }
    })
    const off = window.pomade.pty.onBusy(term.termId, (b) => {
      busyRef.current = b
      if (!b) readCwd()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [term.termId, term.status])

  // T-084 — the "Copied N chars" flash fades itself out. Keyed on the nonce so a second copy
  // during the fade restarts the timer instead of inheriting the first one's deadline.
  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(null), COPY_HINT_MS)
    return () => clearTimeout(timer)
  }, [hint])

  // Escape closes the menu / the link picker (mirrors their scrims, and the tree + editor menus).
  // Registered in the CAPTURE phase, unlike those menus: the focused element here is xterm's
  // textarea, and xterm's own key handling ends in `cancel()` — which calls stopPropagation, so a
  // bubble-phase listener would never see the keystroke. Consuming it also keeps the ESC byte
  // from reaching the shell: while an overlay is open the key belongs to the overlay.
  useEffect(() => {
    if (!menu && !picker) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setMenu(null)
      setPicker(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menu, picker])

  // e2e hook (same precedent as `__pomadeStores` in App.tsx): activate a terminal link by its
  // TOKEN, skipping the real Cmd+click on a canvas cell. Cell-precise mouse clicks on xterm are
  // genuinely fiddly to synthesize, so the routing matrix is asserted through this while a
  // separate spec keeps one real-mouse Cmd+click as the smoke test that the wiring is live.
  useEffect(() => {
    if (term.status !== 'live') return
    const registry = window as unknown as {
      __pomadeTermLinks?: Record<string, (token: string) => Promise<void>>
      __pomadeTermLinkResolve?: Record<string, (token: string) => Promise<boolean>>
      __pomadeTermProvideLinks?: Record<
        string,
        (rowText: string) => Promise<{ target: string; startY: number; endY: number }[]>
      >
    }
    const map = (registry.__pomadeTermLinks ??= {})
    map[term.termId] = async (token: string) => {
      const [cand] = scanCandidates(token)
      if (!cand) return
      const resolved = await resolveCandidate(cand, buildLinkContextRef.current())
      if (!resolved) return
      if (resolved.kind === 'ambiguous') {
        const rect = containerRef.current?.getBoundingClientRect()
        setPicker({
          x: (rect?.left ?? 0) + 24,
          y: (rect?.top ?? 0) + 24,
          name: resolved.name,
          matches: resolved.matches,
          ...(resolved.line !== undefined ? { line: resolved.line } : {})
        })
        return
      }
      activateResolved(resolved)
    }
    // Diagnostic sibling: does TOKEN resolve to a link AT ALL (the same scan+resolve the provider
    // runs, minus routing)? Returns false for a token that would never underline. Used by the
    // folder-links spec to assert detection without synthesizing a cell-precise Cmd+click.
    const resolveMap = (registry.__pomadeTermLinkResolve ??= {})
    resolveMap[term.termId] = async (token: string) => {
      const [cand] = scanCandidates(token)
      if (!cand) return false
      return (await resolveCandidate(cand, buildLinkContextRef.current())) !== null
    }
    // Fix B hook: run the REAL provider pipeline (computeRowLinks — Fix B's join included) against
    // the live buffer for the PHYSICAL row whose rendered text contains `rowText`, and return each
    // resolved link's target plus the ABSOLUTE 0-based buffer rows it spans. Used to assert that a
    // hard-wrapped path produces ONE multi-row link when hovering EACH fragment's own row — the join
    // reads neighbouring logical lines, so a token-string hook cannot exercise it.
    const provideMap = (registry.__pomadeTermProvideLinks ??= {})
    provideMap[term.termId] = async (rowText: string) => {
      const xterm = termRef.current
      if (!xterm) return []
      const cell = xterm.buffer.active.getNullCell()
      const buf = xterm.buffer.active
      // Find the absolute row whose OWN physical text contains `rowText` (each wrapped fragment is
      // its own physical row, so this addresses one fragment's row precisely).
      let absY = -1
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y)
        if (line && line.translateToString(true).includes(rowText)) {
          absY = y
          break
        }
      }
      if (absY < 0) return []
      const rowLinks = await computeRowLinks(xterm, absY, cell, buildLinkContextRef.current())
      return rowLinks.map((l) => ({ target: l.target, startY: l.from.y, endY: l.to.y }))
    }
    return () => {
      delete map[term.termId]
      delete resolveMap[term.termId]
      delete provideMap[term.termId]
    }
  }, [term.termId, term.status])

  // NOTE (E-005 user-test round 1): this pane must NEVER kill its PTY on unmount. React
  // StrictMode (dev builds) mounts, simulates an unmount running effect cleanups, and
  // mounts again — a kill-on-unmount cleanup here killed every freshly created PTY in
  // `npm run dev`, so all new terminals/agents opened dead. Panes are views; PTY reaping
  // is owned by terminals-store's tab-lifecycle reaper (a tab dropping its termId).

  // Re-fit when the pane becomes visible again (fit can't measure while display:none).
  // T-081 — also repaint every row from the buffer: output written while the pane was
  // hidden (or while the renderer was rAF-throttled) can leave stale rows on screen.
  useEffect(() => {
    if (!visible || term.status !== 'live') return
    const fit = fitRef.current
    const xterm = termRef.current
    if (!fit || !xterm) return
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
        void window.pomade.pty.resize(term.termId, xterm.cols, xterm.rows)
        xterm.refresh(0, xterm.rows - 1)
        xterm.focus()
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, term.status, term.termId])

  // T-081 — sleep-resume / screen-unlock: a renderer that spent hours throttled (occluded
  // window, closed lid) can wake with a stale picture, and lid-open display reconfiguration
  // may have resized the window while rendering was paused. Re-fit and repaint the VISIBLE
  // terminal from xterm's buffer; hidden panes are covered by the re-show effect above.
  useEffect(() => {
    if (term.status !== 'live') return
    return window.pomade.app.onWake(() => {
      if (!visible) return
      const fit = fitRef.current
      const xterm = termRef.current
      if (!fit || !xterm) return
      requestAnimationFrame(() => {
        try {
          fit.fit()
          void window.pomade.pty.resize(term.termId, xterm.cols, xterm.rows)
          xterm.refresh(0, xterm.rows - 1)
        } catch {
          /* ignore */
        }
      })
    })
  }, [visible, term.status, term.termId])

  if (term.status === 'dead') {
    const isAgent = term.kind === 'agent'
    const handleRelaunch = (): void => {
      void useTerminalsStore.getState().relaunch(term.projectId, term.id)
    }
    const handleResume = async (): Promise<void> => {
      const roster = await window.pomade.agents.roster()
      const agent = roster.find((a) => a.id === term.agentId)
      const project = useWorkspaceStore.getState().projectById(term.projectId)
      if (!agent || !project || !term.resumeSessionId) {
        handleRelaunch()
        return
      }
      const cmd =
        agent.kind === 'codex'
          ? `${agent.command} resume ${term.resumeSessionId}`
          : `${agent.command} --resume ${term.resumeSessionId}`
      useTabsStore.getState().updateTab(term.projectId, term.id, { lastCommand: cmd })
      void useTerminalsStore.getState().relaunch(term.projectId, term.id)
      setRosterCmd(cmd)
    }

    return (
      <div
        className={styles.dead}
        data-testid={`terminal-dead-${term.id}`}
        data-mount-id={mountId}
        data-term-id={term.termId}
        data-status="dead"
      >
        <div className={styles.deadDiamond} aria-hidden="true" />
        <p className={styles.deadTitle}>{isAgent ? 'Agent session ended' : 'Terminal closed'}</p>
        <p className={styles.deadMeta}>
          {term.lastCommand ? <code>{rosterCmd ?? term.lastCommand}</code> : <code>zsh -il</code>}
        </p>
        <div className={styles.deadActions}>
          <button
            type="button"
            className={styles.primaryBtn}
            data-testid={`relaunch-${term.id}`}
            onClick={handleRelaunch}
          >
            Relaunch
          </button>
          {isAgent && term.resumeSessionId && (
            <button
              type="button"
              className={styles.ghostBtn}
              data-testid={`resume-${term.id}`}
              onClick={() => void handleResume()}
            >
              Resume session
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={styles.root}
      data-testid={`terminal-${term.id}`}
      data-mount-id={mountId}
      data-term-id={term.termId}
      data-status="live"
      onClick={(e) => {
        // T-063 — interacting with a terminal commits any outstanding preview tab.
        useTabsStore.getState().commitPreview(term.projectId)
        // T-086 — a Cmd+click is a LINK gesture: xterm's link activation has already run by the
        // time this bubbles up, and focusing the terminal here would immediately steal focus
        // back from the editor the link just opened.
        if (e.metaKey) return
        termRef.current?.focus()
      }}
      onContextMenu={(e) => {
        // T-084 — renderer-built menu (doctrine E-001: no native menus). Safe to preventDefault
        // here: unlike the editor, a terminal has nothing to ask the OS spellchecker about.
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY, selection: termRef.current?.getSelection() ?? '' })
      }}
    >
      <div ref={containerRef} className={styles.xterm} />

      {/* T-084 — copy confirmation, bottom-right of the pane, fading out on its own. */}
      {hint && (
        <div className={styles.copyHint} data-testid={`terminal-copy-hint-${term.id}`} aria-live="polite">
          {`Copied ${hint.chars} ${hint.chars === 1 ? 'char' : 'chars'}`}
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          testId="terminal-menu"
          items={[
            {
              label: 'Copy',
              testId: 'terminal-menu-copy',
              disabled: !menu.selection,
              onSelect: () => copyText(menu.selection)
            },
            {
              // T-121 — "to input" makes the one-click copy-paste flow legible: select output
              // (auto-copies), right-click, and this lands it at the shell/agent input line. A
              // bare "Paste" read as inert to the Owner because the click target is output.
              label: 'Paste to input',
              testId: 'terminal-menu-paste',
              onSelect: () => {
                pasteIntoPty()
                termRef.current?.focus()
              }
            },
            { separator: true },
            {
              label: 'Select all',
              testId: 'terminal-menu-select-all',
              onSelect: () => termRef.current?.selectAll()
            },
            {
              label: 'Clear',
              testId: 'terminal-menu-clear',
              onSelect: () => {
                termRef.current?.clear()
                termRef.current?.focus()
              }
            }
          ]}
        />
      )}

      {/* T-086 — a bare filename that exists in several places: the user picks which one. */}
      {picker && (
        <ContextMenu
          x={picker.x}
          y={picker.y}
          onClose={() => setPicker(null)}
          testId="terminal-link-picker"
          items={[
            {
              header: `${picker.matches.length} files named “${picker.name}”`
            },
            ...picker.matches.map<MenuItem>((match, i) => ({
              testId: `terminal-link-candidate-${i}`,
              data: { 'data-path': match },
              label: (
                <span className={styles.candidate}>
                  <span className={styles.candidateName}>{match.slice(match.lastIndexOf('/') + 1)}</span>
                  <span className={styles.candidateDir}>{match.slice(0, match.lastIndexOf('/')) || '.'}</span>
                </span>
              ),
              onSelect: () => {
                const line = picker.line
                void activatePickedMatch(match, line)
              }
            }))
          ]}
        />
      )}
      {closePrompt && (
        <DialogShell
          testId="terminal-close-guard"
          ariaLabel={term.kind === 'agent' ? 'Close running agent' : 'Close running terminal'}
          title={term.kind === 'agent' ? 'Close agent tab?' : 'Close running terminal?'}
          onScrimClick={(e) => e.stopPropagation()}
          footer={
            <>
              <button
                type="button"
                className={dialogStyles.btnGhost}
                data-testid="terminal-close-cancel"
                onClick={() => {
                  setClosePrompt(false)
                  resolveClose('cancel') // keep this tab AND abort the rest of a batch (T-044)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={dialogStyles.btnPrimary}
                data-testid="terminal-close-confirm"
                onClick={() => {
                  setClosePrompt(false)
                  closeTab(term.projectId, term.id)
                  resolveClose('proceed')
                }}
              >
                Close
              </button>
            </>
          }
        >
          <p className={dialogStyles.modalText}>
            {term.kind === 'agent'
              ? `“${term.title}” still has a running agent session. Closing it ends the session and loses its context.`
              : `A command is still running in “${term.title}”. Closing it will stop the process.`}
          </p>
        </DialogShell>
      )}
    </div>
  )
}
