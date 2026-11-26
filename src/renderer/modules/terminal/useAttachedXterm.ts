// Pomade — E-034: the attached terminal's xterm lifecycle (docs/modules/terminal/attached-terminals.md).
// The same view as a PTY tab — `createTerminal`, the Cmd+click link provider, copy-on-select —
// fed by the keeper instead of a PTY: main follows the session (`window.pomade.attached`), a
// snapshot paints an emptied terminal, live output follows.
//
// THE INPUT RULE. The keeper's own terminal answers the program's terminal queries (cursor
// position, device attributes, colours…). xterm here sees the same output and would answer them
// too — on `onData`, indistinguishable from typing. So this view forwards only what the user did:
// xterm's data events flagged as user input (keys, mouse reports, wheel-as-arrows, IME), its focus
// reports (the program asked for them; only the view knows focus), and pastes as `paste` (the
// keeper brackets them per the program's current mode). Its own answers go nowhere.

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SessionExit, SessionInfo, SessionRef } from 'pomade-kit/protocol'

import type { AttachedEvent, AttachedState } from '@shared/types'
import { useTabsStore } from '../../stores/tabs-store'
import { useTerminalsStore } from '../../stores/terminals-store'
import type { LinkContext } from './term-link-open'
import { attachCopyOnSelect, attachLinkProvider, createTerminal, type PickerState } from './useXtermSession'

/** xterm's core data path (private, pinned with the xterm version). */
interface CoreService {
  triggerDataEvent(data: string, wasUserInput?: boolean): void
}

const FOCUS_REPORTS = new Set(['\x1b[I', '\x1b[O'])

/** Forward what the user did to the session — never the view's answers to queries. Returns the
 *  undo. */
function forwardUserInput(xterm: Terminal, send: (data: string) => void): () => void {
  const core = (xterm as unknown as { _core?: { coreService?: CoreService } })._core?.coreService
  const binary = xterm.onBinary((data) => send(data))
  if (!core || typeof core.triggerDataEvent !== 'function') {
    // An xterm without the hook: keystrokes only (no mouse, no focus) — never the answers.
    const keys = xterm.onKey(({ key }) => send(key))
    return () => {
      keys.dispose()
      binary.dispose()
    }
  }
  const original = core.triggerDataEvent
  core.triggerDataEvent = function (data: string, wasUserInput = false): void {
    if (wasUserInput || FOCUS_REPORTS.has(data)) send(data)
    original.call(this, data, wasUserInput)
  }
  return () => {
    core.triggerDataEvent = original
    binary.dispose()
  }
}

export interface AttachedXtermOptions {
  tabId: string
  session: SessionRef
  fontsReady: boolean
  containerRef: MutableRefObject<HTMLDivElement | null>
  termRef: MutableRefObject<Terminal | null>
  fitRef: MutableRefObject<FitAddon | null>
  projectIdRef: MutableRefObject<string>
  terminalFontRef: MutableRefObject<string>
  metaRef: MutableRefObject<boolean>
  buildLinkContextRef: MutableRefObject<() => LinkContext>
  setPicker: Dispatch<SetStateAction<PickerState | null>>
  autoCopyRef: MutableRefObject<boolean>
  copyTextRef: MutableRefObject<(text: string) => void>
  lastCopiedRef: MutableRefObject<string>
  onState(state: AttachedState): void
  onInfo(info: SessionInfo): void
  onExit(exit: SessionExit): void
}

export function useAttachedXterm(opts: AttachedXtermOptions): void {
  const { tabId, session, fontsReady, containerRef, termRef, fitRef, projectIdRef, terminalFontRef } = opts
  const { metaRef, buildLinkContextRef, setPicker, autoCopyRef, copyTextRef, lastCopiedRef } = opts
  // The latest callbacks, read by the long-lived event subscription.
  const handlersRef = useRef(opts)
  handlersRef.current = opts
  const app = session.app
  const id = session.session

  useEffect(() => {
    if (!fontsReady) return
    const container = containerRef.current
    if (!container) return
    const { xterm, fit } = createTerminal(terminalFontRef.current)
    xterm.open(container)
    termRef.current = xterm
    fitRef.current = fit

    const clearAttention = (): void => useTabsStore.getState().clearTabAttention(projectIdRef.current, tabId)
    const disposeLinks = attachLinkProvider(xterm, container, { metaRef, buildLinkContextRef, setPicker })
    const disposeCopy = attachCopyOnSelect(xterm, container, { autoCopyRef, copyTextRef, lastCopiedRef })
    const disposeInput = forwardUserInput(xterm, (data) => void window.pomade.attached.input(tabId, data))
    const keys = xterm.onKey(() => clearAttention())
    // A paste goes to the keeper as text (it knows the program's bracketed-paste mode).
    const onPaste = (ev: ClipboardEvent): void => {
      ev.preventDefault()
      ev.stopPropagation()
      const text = ev.clipboardData?.getData('text') ?? ''
      clearAttention()
      if (text) void window.pomade.attached.paste(tabId, text)
    }
    container.addEventListener('paste', onPaste, true)

    const paint = (data: string, info: SessionInfo): void => {
      xterm.reset()
      if (xterm.cols !== info.cols || xterm.rows !== info.rows) xterm.resize(info.cols, info.rows)
      xterm.write(data)
      xterm.options.disableStdin = info.state === 'exited'
    }
    const off = window.pomade.attached.onEvent(tabId, (e: AttachedEvent) => {
      const h = handlersRef.current
      switch (e.type) {
        case 'snapshot':
          paint(e.data, e.info)
          h.onInfo(e.info)
          break
        case 'delta':
          xterm.write(e.data)
          xterm.options.disableStdin = e.info.state === 'exited'
          h.onInfo(e.info)
          break
        case 'output':
          xterm.write(e.data)
          break
        case 'resized':
          if (xterm.cols !== e.cols || xterm.rows !== e.rows) xterm.resize(e.cols, e.rows)
          break
        case 'exit':
          xterm.options.disableStdin = true
          h.onExit(e.exit)
          break
        case 'info':
          h.onInfo(e.info)
          break
        case 'state':
          h.onState(e.state)
          break
        case 'attention':
          useTerminalsStore.getState().handleAttention(projectIdRef.current, tabId)
          break
      }
    })

    // Fit first, then attach at the pane's size (the session is resized to it: last active client
    // wins). A later size change follows.
    let lastCols = -1
    let lastRows = -1
    let opened = false
    const doFit = (): void => {
      try {
        fit.fit()
      } catch {
        return // hidden: refit on re-show
      }
      if (!opened) {
        opened = true
        lastCols = xterm.cols
        lastRows = xterm.rows
        void window.pomade.attached.open(tabId, { app, session: id }, xterm.cols, xterm.rows)
        return
      }
      if (xterm.cols !== lastCols || xterm.rows !== lastRows) {
        lastCols = xterm.cols
        lastRows = xterm.rows
        void window.pomade.attached.resize(tabId, xterm.cols, xterm.rows)
      }
    }
    // e2e hook (the `__pomadeTermLinks` precedent): the whole buffer as text, scrollback included,
    // for the tab — the DOM shows only the viewport.
    const buffers = ((window as unknown as { __pomadeAttachedBuffer?: Record<string, () => string> }).__pomadeAttachedBuffer ??= {})
    buffers[tabId] = () => {
      const b = xterm.buffer.active
      const lines: string[] = []
      for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)?.translateToString(true) ?? '')
      return lines.join('\n')
    }

    const raf = requestAnimationFrame(doFit)
    const ro = new ResizeObserver(() => doFit())
    ro.observe(container)
    // A pane created hidden still attaches (its project is open in the background).
    const fallback = setTimeout(() => {
      if (!opened) {
        opened = true
        void window.pomade.attached.open(tabId, { app, session: id }, xterm.cols, xterm.rows)
      }
    }, 250)

    return () => {
      delete buffers[tabId]
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
      ro.disconnect()
      off()
      void window.pomade.attached.close(tabId)
      container.removeEventListener('paste', onPaste, true)
      keys.dispose()
      disposeInput()
      disposeLinks()
      disposeCopy()
      xterm.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // The session reference and the tab are the identity; the refs are stable.
  }, [
    tabId,
    app,
    id,
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
  ])
}
