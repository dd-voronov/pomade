// Pomade — symlink target popover (E-012 final). One shared component anchored under whichever
// symlink indicator was clicked (tree row, tab, or editor header). Resolves the link target on
// open (fs.linkTarget) and offers state-appropriate actions per the blessed wireframes:
//   B · inside the workspace — [Open target] [Reveal in tree | Open in project…] [Copy path]
//   C · outside the workspace — honest note + [Copy full path] [Reveal in Finder]
//   D · broken link — danger note + [Copy path]
// Esc / click-outside closes.

import { isDocTabOf } from '@shared/doc-version'
import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'

import type { LinkTarget, Tab } from '@shared/types'
import { buildAllProjects, useWorkspaceStore } from '../../stores/workspace-store'
import { useTabsStore } from '../../stores/tabs-store'
import { useRevealStore } from '../../stores/reveal-store'
import { useToast } from '../../hooks/useToast'
import { initialDocMode } from '../editor/open-mode'
import { Popover } from '../../components/Popover'
import { basename, splitPath } from '../../lib/path-display'
import { SymlinkGlyph } from './icons'
import styles from './SymlinkPopover.module.css'

const POP_WIDTH = 340

/** True when `rel` is at, or inside, a project rooted at `rootPath` ('' = workspace root). */
function underRoot(rel: string, rootPath: string): boolean {
  return rootPath === '' || rel === rootPath || rel.startsWith(rootPath + '/')
}

export function SymlinkPopover({
  rel,
  isDir,
  anchorRect,
  onClose
}: {
  rel: string
  isDir: boolean
  anchorRect: DOMRect
  onClose: () => void
}): React.JSX.Element {
  const [target, setTarget] = useState<LinkTarget | null>(null)
  const [showProjects, setShowProjects] = useState(false)

  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject)
  const tabsByProject = useTabsStore((s) => s.tabsByProject)
  const openTab = useTabsStore((s) => s.openTab)
  const setActive = useTabsStore((s) => s.setActive)
  const reveal = useRevealStore((s) => s.reveal)
  const toast = useToast()

  const allProjects = buildAllProjects(projects)
  const rootPath = allProjects.find((p) => p.id === activeProjectId)?.rootPath ?? ''

  useEffect(() => {
    let cancelled = false
    void window.pomade.fs
      .linkTarget(rel)
      .then((t) => {
        if (!cancelled) setTarget(t)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [rel])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - POP_WIDTH - 8))
  const top = anchorRect.bottom + 4

  const copy = (text: string, label: string): void => {
    void window.pomade.app.clipboardWrite(text)
    toast(label)
    onClose()
  }

  const openTarget = (): void => {
    if (!target || target.targetRel === null) return
    const r = target.targetRel
    const pid = activeProjectId
    const existing = (tabsByProject[pid] ?? []).find((t) => isDocTabOf(t, r))
    if (existing) {
      setActive(pid, existing.id)
      onClose()
      return
    }
    const mode = initialDocMode(r) // E-024 — shared open-mode rule
    const tab: Tab = { id: nanoid(), projectId: pid, kind: 'doc', title: basename(r), path: r, mode, dirty: false }
    openTab(tab)
    onClose()
  }

  const revealInTree = (): void => {
    if (!target || target.targetRel === null) return
    reveal(target.targetRel, activeProjectId)
    onClose()
  }

  const pickProject = (pid: string): void => {
    if (!target || target.targetRel === null) return
    // Switch first, then reveal — FileTree acts on the request once it is rooted at `pid`.
    setActiveProject(pid)
    reveal(target.targetRel, pid)
    onClose()
  }

  const containingProjects =
    target && target.targetRel !== null
      ? allProjects.filter((p) => underRoot(target.targetRel as string, p.rootPath))
      : []

  const renderBody = (): React.JSX.Element => {
    if (!target) {
      return <div className={styles.resolving}>Resolving…</div>
    }

    // D · broken link.
    if (!target.exists) {
      const shown = target.targetRel ?? target.targetAbs
      const { parent: dir, leaf: name } = splitPath(shown)
      return (
        <>
          <div className={styles.path} data-testid="symlink-path">
            {dir && <span className={styles.dir}>{dir}</span>}
            {name}
          </div>
          <div className={`${styles.note} ${styles.noteErr}`} data-testid="symlink-note" data-broken="true">
            Target doesn’t exist — the link is broken.
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btn}
              data-testid="symlink-copy-path"
              onClick={() => copy(shown, 'Copied path')}
            >
              Copy path
            </button>
          </div>
        </>
      )
    }

    // C · target outside the workspace.
    if (target.targetRel === null) {
      return (
        <>
          <div className={styles.path} data-testid="symlink-path">
            {target.targetAbs}
          </div>
          <div className={styles.note} data-testid="symlink-note">
            Target is outside the workspace — Pomade can’t open it or show it in the tree.
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btn}
              data-testid="symlink-copy-full-path"
              onClick={() => copy(target.targetAbs, 'Copied full path')}
            >
              Copy full path
            </button>
            <button
              type="button"
              className={styles.btn}
              data-testid="symlink-reveal-finder"
              onClick={() => {
                void window.pomade.app.showItemInFolder(target.targetAbs)
                onClose()
              }}
            >
              Reveal in Finder
            </button>
          </div>
        </>
      )
    }

    // B · target inside the workspace.
    const { parent: dir, leaf: name } = splitPath(target.targetRel)
    const inCurrentProject = underRoot(target.targetRel, rootPath)
    return (
      <>
        <div className={styles.path} data-testid="symlink-path">
          {dir && <span className={styles.dir}>{dir}</span>}
          {name}
        </div>
        {showProjects ? (
          <div className={styles.projectList} data-testid="symlink-project-list">
            <div className={styles.projectHead}>Open in project…</div>
            {containingProjects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.projectItem}
                data-testid={`symlink-project-${p.id}`}
                onClick={() => pickProject(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.actions}>
            {!isDir && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                data-testid="symlink-open-target"
                onClick={openTarget}
              >
                Open target
              </button>
            )}
            {inCurrentProject ? (
              <button
                type="button"
                className={styles.btn}
                data-testid="symlink-reveal-tree"
                onClick={revealInTree}
              >
                Reveal in tree
              </button>
            ) : (
              <button
                type="button"
                className={styles.btn}
                data-testid="symlink-open-in-project"
                onClick={() => setShowProjects(true)}
              >
                Open in project…
              </button>
            )}
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.btn}
              data-testid="symlink-copy-path"
              onClick={() => copy(target.targetRel as string, 'Copied path')}
            >
              Copy path
            </button>
          </div>
        )}
      </>
    )
  }

  return (
    <Popover
      onDismiss={onClose}
      style={{ left, top, width: POP_WIDTH }}
      ariaLabel="Symbolic link target"
      testId="symlink-popover"
      panelClassName={styles.pop}
    >
      <div className={styles.head}>
        <span className={styles.headGlyph} aria-hidden="true">
          <SymlinkGlyph />
        </span>
        Symbolic link
      </div>
      {renderBody()}
    </Popover>
  )
}
