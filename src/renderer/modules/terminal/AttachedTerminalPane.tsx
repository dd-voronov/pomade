// Pomade — E-034: the attached terminal pane (docs/modules/terminal/attached-terminals.md).
// A terminal tab on a session an app's keeper holds: the same xterm, links, copy/paste and
// attention as a PTY tab, under a header that says whose session it is ("Coda web · Runner"), how
// it stands, and the actions the owner contributes (Restart) plus Stop. Closing the tab only
// detaches; the session keeps running, with Pomade open or closed.

import { useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SessionExit, SessionInfo } from 'pomade-kit/protocol'

import type { AttachedState, AttachedTab } from '@shared/types'
import type { PaneProps } from '../../panes/registry'
import { buildAllProjects, useWorkspaceStore } from '../../stores/workspace-store'
import { useTabsStore } from '../../stores/tabs-store'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { fontStackFor, areBundledFontsReady, bundledFontsReady } from '../../font-catalog'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { Tooltip } from '../../components/Tooltip'
import { activatePickedMatch, type LinkContext } from './term-link-open'
import type { PickerState } from './useXtermSession'
import { useAttachedXterm } from './useAttachedXterm'
import { attachedStatus } from './attached-status'
import { useOwnerName } from './owner-name'
import styles from './AttachedTerminalPane.module.css'
import termStyles from './TerminalPane.module.css'

const COPY_HINT_MS = 1500

interface TermMenuState {
  x: number
  y: number
  selection: string
}

export function AttachedTerminalPane({ tab }: PaneProps): React.JSX.Element {
  const t = tab as AttachedTab
  const owner = useOwnerName(t.session.app)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const activeTabId = useTabsStore((s) => s.activeTabByProject[t.projectId])
  const visible = activeProjectId === t.projectId && activeTabId === t.id

  const [state, setState] = useState<AttachedState>({ kind: 'connecting' })
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const everAttached = info !== null
  const [stopping, setStopping] = useState(false)

  const [menu, setMenu] = useState<TermMenuState | null>(null)
  const [hint, setHint] = useState<{ chars: number; nonce: number } | null>(null)
  const hintSeqRef = useRef(0)
  const autoCopy = useAppSettingsStore((s) => s.terminalAutoCopy)
  const autoCopyRef = useRef(autoCopy)
  autoCopyRef.current = autoCopy
  const terminalFont = useAppSettingsStore((s) => s.terminalFont)
  const terminalFontRef = useRef(terminalFont)
  terminalFontRef.current = terminalFont
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
  const lastCopiedRef = useRef('')
  const metaRef = useRef(false)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const projectIdRef = useRef(t.projectId)
  projectIdRef.current = t.projectId

  const copyText = (text: string): void => {
    if (!text) return
    lastCopiedRef.current = text
    void window.pomade.app.clipboardWrite(text)
    hintSeqRef.current += 1
    setHint({ chars: text.length, nonce: hintSeqRef.current })
  }
  const copyTextRef = useRef(copyText)
  copyTextRef.current = copyText

  // Links resolve against the session's own folder first, then the project and the workspace.
  const cwdRef = useRef('')
  const buildLinkContext = (): LinkContext => {
    const ws = useWorkspaceStore.getState()
    const wsRootAbs = ws.root ?? ''
    const project = buildAllProjects(ws.projects).find((p) => p.id === projectIdRef.current)
    const rootPath = project?.rootPath ?? ''
    return {
      cwdAbs: cwdRef.current || wsRootAbs,
      projectRootAbs: rootPath ? `${wsRootAbs}/${rootPath}` : wsRootAbs,
      wsRootAbs
    }
  }
  const buildLinkContextRef = useRef(buildLinkContext)
  buildLinkContextRef.current = buildLinkContext

  const tabRef = useRef(t)
  tabRef.current = t
  const onInfo = (next: SessionInfo): void => {
    setInfo(next)
    cwdRef.current = next.cwd
    if (next.state === 'running') setStopping(false)
    const current = tabRef.current
    // The session's own title, unless the tab carries one of its own.
    if (!current.renamed && next.title !== current.title) {
      useTabsStore.getState().updateTab(current.projectId, current.id, { title: next.title })
    }
  }
  const onExit = (exit: SessionExit): void => {
    setStopping(false)
    setInfo((prev) => (prev ? { ...prev, state: 'exited', pid: null, exit } : prev))
  }

  useAttachedXterm({
    tabId: t.id,
    session: t.session,
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
    lastCopiedRef,
    onState: setState,
    onInfo,
    onExit
  })

  // Restyle on a font change without a rebuild (the screen and modes stay).
  useEffect(() => {
    const xterm = termRef.current
    const fit = fitRef.current
    if (!xterm || !fit) return
    const family = fontStackFor(terminalFont) || 'monospace'
    if (xterm.options.fontFamily === family) return
    xterm.options.fontFamily = family
    try {
      fit.fit()
      void window.pomade.attached.resize(t.id, xterm.cols, xterm.rows)
    } catch {
      /* hidden — refit on re-show */
    }
  }, [terminalFont, t.id, fontsReady])

  // Re-fit, repaint and resize the session when the pane is shown (last active client wins).
  useEffect(() => {
    if (!visible) return
    const raf = requestAnimationFrame(() => {
      const fit = fitRef.current
      const xterm = termRef.current
      if (!fit || !xterm) return
      try {
        fit.fit()
        void window.pomade.attached.resize(t.id, xterm.cols, xterm.rows)
        xterm.refresh(0, xterm.rows - 1)
        xterm.focus()
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, t.id])

  useEffect(() => {
    if (!hint) return
    const timer = setTimeout(() => setHint(null), COPY_HINT_MS)
    return () => clearTimeout(timer)
  }, [hint])

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

  const status = attachedStatus(state, info, owner, everAttached)
  const running = state.kind === 'attached' && info?.state === 'running'
  const actions = state.kind === 'attached' ? (info?.actions ?? []) : []
  const showNotice = !everAttached && (state.kind === 'unreachable' || state.kind === 'gone' || state.kind === 'rejected')

  const paste = (): void => {
    void (async () => {
      const text = await window.pomade.app.clipboardRead()
      if (text) await window.pomade.attached.paste(t.id, text)
    })()
    useTabsStore.getState().clearTabAttention(t.projectId, t.id)
  }

  return (
    <div className={styles.pane} data-testid={`attached-${t.id}`} data-state={state.kind} data-session-state={info?.state ?? ''}>
      <div className={styles.header}>
        <div className={styles.titleWrap}>
          <span className={styles.title} data-testid={`attached-title-${t.id}`}>
            {t.title}
          </span>
          <span className={styles.owner} data-testid={`attached-owner-${t.id}`}>
            · {owner}
          </span>
          <Tooltip lines={[status.detail]}>
            <span className={styles.status} data-tone={status.tone} data-testid={`attached-status-${t.id}`}>
              <span className={styles.statusDot} aria-hidden="true" />
              {status.label}
            </span>
          </Tooltip>
        </div>
        <div className={styles.actions}>
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className={styles.btn}
              data-testid={`attached-action-${a.id}`}
              onClick={() => void window.pomade.attached.action(t.session, a.id, t.projectId)}
            >
              {a.title}
            </button>
          ))}
          {running && (
            <Tooltip lines={['Stop the session (it ends as “stopped by you”)']}>
              <button
                type="button"
                className={styles.btn}
                data-testid="attached-stop"
                disabled={stopping}
                onClick={() => {
                  setStopping(true)
                  void window.pomade.attached.stop(t.id).catch(() => setStopping(false))
                }}
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      <div
        className={styles.body}
        onClick={(e) => {
          useTabsStore.getState().commitPreview(t.projectId)
          if (e.metaKey) return
          termRef.current?.focus()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY, selection: termRef.current?.getSelection() ?? '' })
        }}
      >
        <div ref={containerRef} className={termStyles.xterm} data-testid={`attached-xterm-${t.id}`} />
        {showNotice && (
          <div className={styles.notice} data-testid={`attached-notice-${t.id}`}>
            <p className={styles.noticeTitle}>{status.label}</p>
            <p className={styles.noticeText}>{status.detail}</p>
          </div>
        )}
        {hint && (
          <div className={termStyles.copyHint} data-testid={`terminal-copy-hint-${t.id}`} aria-live="polite">
            {`Copied ${hint.chars} ${hint.chars === 1 ? 'char' : 'chars'}`}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          testId="terminal-menu"
          items={[
            { label: 'Copy', testId: 'terminal-menu-copy', disabled: !menu.selection, onSelect: () => copyText(menu.selection) },
            {
              label: 'Paste to input',
              testId: 'terminal-menu-paste',
              disabled: !running,
              onSelect: () => {
                paste()
                termRef.current?.focus()
              }
            },
            { separator: true },
            { label: 'Select all', testId: 'terminal-menu-select-all', onSelect: () => termRef.current?.selectAll() },
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
      {picker && (
        <ContextMenu
          x={picker.x}
          y={picker.y}
          onClose={() => setPicker(null)}
          testId="terminal-link-picker"
          items={[
            { header: `${picker.matches.length} files named “${picker.name}”` },
            ...picker.matches.map<MenuItem>((match, i) => ({
              testId: `terminal-link-candidate-${i}`,
              data: { 'data-path': match },
              label: (
                <span className={termStyles.candidate}>
                  <span className={termStyles.candidateName}>{match.slice(match.lastIndexOf('/') + 1)}</span>
                  <span className={termStyles.candidateDir}>{match.slice(0, match.lastIndexOf('/')) || '.'}</span>
                </span>
              ),
              onSelect: () => void activatePickedMatch(match, picker.line)
            }))
          ]}
        />
      )}
    </div>
  )
}
