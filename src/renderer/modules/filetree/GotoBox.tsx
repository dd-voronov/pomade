// Pomade — the file-tree go-to-path row (P-021 / T-105 / T-122), extracted in T-159. Owns its own
// input value, inline error, and the "did you mean ~/…?" suggestion popover. A target under the
// active project's root reveals + opens via the props; any other target is resolved on disk by main
// and routed through the SHARED terminal-link matrix (`routeProbe`) — which reveals a path under a
// visible mount in that mount's section — so this entry point can never drift from a terminal
// Cmd+click.

import { useEffect, useRef, useState } from 'react'

import { Tooltip } from '../../components/Tooltip'
import { Popover } from '../../components/Popover'
import { routeProbe } from '../terminal/term-link-open'
import { ClipboardIcon } from './icons'
import { GOTO_HINT_WIDTH, nameOf } from './filetree-ops'
import styles from './FileTree.module.css'

export interface GotoBoxProps {
  rootPath: string
  wsRoot: string | null
  activeProjectId: string
  requestReveal: (path: string, projectId: string) => void
  openDoc: (node: { name: string; path: string; symlink?: boolean }, opts?: { real?: boolean }) => void
}

export function GotoBox({
  rootPath,
  wsRoot,
  activeProjectId,
  requestReveal,
  openDoc
}: GotoBoxProps): React.JSX.Element {
  // P-021 — the go-to-path row: the input value + an inline error state (cleared on next edit).
  const [goto, setGoto] = useState('')
  const [gotoError, setGotoError] = useState<string | null>(null)
  const gotoInputRef = useRef<HTMLInputElement | null>(null)
  const gotoBoxRef = useRef<HTMLDivElement | null>(null)
  // T-122 — the "did you mean ~/…?" suggestion. The bare short "Not found" stays inline (gotoError);
  // the longer home-anchored hint would collapse the flex-row input, so it renders as a cancelable
  // popover anchored under the box instead. `suggestion` is the `~/…` variant Apply submits; `anchor`
  // is the box's screen rect measured when the hint is raised.
  const [gotoHint, setGotoHint] = useState<{ suggestion: string; anchor: DOMRect } | null>(null)

  // T-122 — Escape dismisses the go-to-path suggestion popover (keeps the typed text), consistent
  // with the other popovers. A window listener covers the case where focus isn't in the input; the
  // input's own onKeyDown covers the focused case (both just close the hint — harmless overlap).
  useEffect(() => {
    if (!gotoHint) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setGotoHint(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gotoHint])

  // P-021 / T-105 — go-to-path: accept an absolute path, a `~`-prefixed path, or a
  // workspace-relative path. A target under the active project's root reveals in the tree and opens
  // the doc. Any other target is resolved on disk by main and routed through the SHARED
  // terminal-link matrix (`routeProbe`): under a visible mount it is revealed in that mount's
  // section (a file also opens); elsewhere a file opens a tab (workspace-relative → orange
  // triangle; absolute → red triangle) and a folder or an unsupported file reveals in Finder.
  // Reusing `routeProbe` keeps this entry point identical to a terminal Cmd+click — the two can't
  // drift. Inline error states never disturb the tree.
  const submitGoto = async (override?: string): Promise<void> => {
    // T-122 — Apply passes the `~/…` suggestion explicitly so the re-submit never races setState.
    const raw = (override ?? goto).trim()
    if (!raw) return
    // Any fresh submit dismisses a stale suggestion popover.
    setGotoHint(null)
    // Expand a leading `~` to the home dir (paths users paste straight from a shell).
    let input = raw
    if (input === '~' || input.startsWith('~/')) input = (window.pomade.env.home ?? '') + input.slice(1)
    const base = wsRoot ?? ''
    // The workspace-relative form when the path is inside the workspace, else null (outside it).
    let rel: string | null
    if (input.startsWith('/')) {
      if (input === base) rel = ''
      else if (base && input.startsWith(base + '/')) rel = input.slice(base.length + 1)
      else rel = null
    } else {
      const r = input.replace(/^\.\//, '').replace(/\/+$/, '')
      // A `..` escape can't map cleanly into the workspace — treat it as out of scope and let
      // main resolve/canonicalize it.
      rel = r.split('/').includes('..') ? null : r
    }
    const inActiveProject =
      rel !== null && (rootPath === '' || rel === rootPath || rel.startsWith(rootPath + '/'))

    if (inActiveProject) {
      // In scope — reveal in the CURRENT project tree and open a file (unchanged P-021 behaviour).
      const inRel = rel as string
      let st
      try {
        st = await window.pomade.fs.stat(inRel)
      } catch {
        setGotoError('Not found')
        return
      }
      requestReveal(inRel, activeProjectId)
      if (st.isFile) {
        openDoc({
          name: nameOf(inRel),
          path: inRel,
          ...(st.isSymbolicLink ? { symlink: true } : {})
        })
      }
    } else {
      // T-105 — out of the current tree's scope. Main can stat outside the workspace and
      // canonicalize (macOS /var → /private/var), which a renderer-side string test can't; the
      // shared `routeProbe` then opens the file/reveals the folder exactly as a terminal link does.
      const probe = await window.pomade.fs.probePath(input, base)
      if (!probe) {
        // T-105 follow-up (the Owner's user test): the most common miss is a path that exists under
        // the HOME dir but was typed root-anchored — e.g. `/Downloads/x` after deleting the `~`
        // (which IS `/Users/<you>`; removing it leaves an absolute path from the filesystem root).
        // Probe the home-anchored variant and, when it exists, say so instead of a bare "Not
        // found" — a hint only, never an auto-open (the typed path genuinely doesn't exist).
        const home = window.pomade.env.home ?? ''
        if (home && !input.startsWith(home + '/')) {
          const homeVariant = `~/${input.replace(/^\/+/, '')}`
          const rescued = await window.pomade.fs.probePath(`${home}/${input.replace(/^\/+/, '')}`, base)
          if (rescued) {
            // T-122 — the long hint would collapse the inline flex-row input; show it as a
            // cancelable popover anchored under the box, with an Apply button that submits the
            // `~/…` variant. The inline error span stays clear in this case.
            setGotoError(null)
            const anchor = gotoBoxRef.current?.getBoundingClientRect() ?? null
            if (anchor) setGotoHint({ suggestion: homeVariant, anchor })
            else setGotoError(`Not found — did you mean ${homeVariant}?`)
            return
          }
        }
        setGotoError('Not found')
        return
      }
      await routeProbe(probe)
    }
    setGoto('')
    setGotoError(null)
    setGotoHint(null)
  }

  return (
    <>
      {/* P-021 — go-to-path row: quiet until focused; paste-friendly. Enter reveals + opens.
          T-058: input + paste button share ONE box — the button is embedded at the right
          edge behind a thin separator, so the control reads as a single full-width field. */}
      <div className={styles.gotoRow}>
        <div
          ref={gotoBoxRef}
          className={`${styles.gotoBox} ${gotoError ? styles.gotoBoxError : ''}`}
          data-testid="tree-goto-box"
        >
          <input
            ref={gotoInputRef}
            className={styles.gotoInput}
            data-testid="tree-goto"
            type="text"
            spellCheck={false}
            autoComplete="off"
            placeholder="Go to path…"
            value={goto}
            aria-invalid={gotoError ? true : undefined}
            onChange={(e) => {
              setGoto(e.target.value)
              if (gotoError) setGotoError(null)
              // T-122 — typing dismisses the suggestion popover (same as the old error-clear).
              if (gotoHint) setGotoHint(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitGoto()
              if (e.key === 'Escape') {
                // T-122 — with the suggestion popover open, Escape only dismisses it (keeps the
                // typed text, consistent with other popovers); otherwise it clears the input.
                if (gotoHint) {
                  setGotoHint(null)
                  return
                }
                setGoto('')
                setGotoError(null)
              }
            }}
          />
          {/* P-021 — paste the clipboard into the input (the user presses Enter to go). */}
          <Tooltip lines={['Paste path']}>
            <button
              type="button"
              className={styles.gotoPaste}
              data-testid="tree-goto-paste"
              aria-label="Paste path"
              onClick={() => {
                void (async () => {
                  const text = await window.pomade.app.clipboardRead()
                  if (text) {
                    setGoto(text.trim())
                    setGotoError(null)
                  }
                  gotoInputRef.current?.focus()
                })()
              }}
            >
              <ClipboardIcon />
            </button>
          </Tooltip>
        </div>
        {gotoError && (
          <span className={styles.gotoError} data-testid="tree-goto-error">
            {gotoError}
          </span>
        )}
      </div>

      {/* T-122 — go-to-path "did you mean ~/…?" suggestion. Anchored under the goto box (shifted a
          little right), viewport-clamped. Apply submits the ~-variant; × / scrim-click / Escape
          dismiss and keep the typed text. The bare short "Not found" stays inline (above). */}
      {gotoHint && (
        <Popover
          onDismiss={() => setGotoHint(null)}
          scrimTestId="tree-goto-hint-scrim"
          ariaLabel="Path suggestion"
          testId="tree-goto-hint"
          panelClassName={styles.gotoHintPop}
          style={{
            top: gotoHint.anchor.bottom + 4,
            left: Math.max(
              8,
              Math.min(gotoHint.anchor.left + 10, window.innerWidth - GOTO_HINT_WIDTH - 8)
            ),
            width: GOTO_HINT_WIDTH
          }}
        >
          <Tooltip lines={['Dismiss']}>
            <button
              type="button"
              className={styles.gotoHintClose}
              data-testid="tree-goto-hint-close"
              aria-label="Dismiss suggestion"
              onClick={() => setGotoHint(null)}
            >
              ×
            </button>
          </Tooltip>
          <div className={styles.gotoHintText}>
            Not found — did you mean <span className={styles.gotoHintPath}>{gotoHint.suggestion}</span>?
          </div>
          <div className={styles.gotoHintActions}>
            <button
              type="button"
              className={styles.gotoHintApply}
              data-testid="tree-goto-hint-apply"
              onClick={() => {
                const suggestion = gotoHint.suggestion
                setGoto(suggestion)
                setGotoHint(null)
                void submitGoto(suggestion)
              }}
            >
              Apply
            </button>
          </div>
        </Popover>
      )}
    </>
  )
}
