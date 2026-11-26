// Pomade — E-039: "Track with git" in the project dialog. A new project — from a template, or a
// folder that does not exist yet (it is created) — is offered checked: Create runs `git init` and a
// first commit. An existing folder without git is offered unchecked. A folder that already is a
// repository shows its remote, or Local only; a folder another repository tracks says so.

import { useEffect, useState } from 'react'

import { remoteLabel } from '@shared/git-history'
import type { FolderGitInfo } from '@shared/git-ops'
import { normalizeWorkspaceRelPath } from '@shared/paths'
import { GitTerm } from '../GitTerm'
import { LOCAL_ONLY } from '../panel/RepoStatus'
import styles from './TrackWithGit.module.css'

export interface TrackWithGit {
  /** The folder's relation to git (existing-folder mode); null while unknown or in template mode. */
  info: FolderGitInfo | null
  /** The checkbox is shown: Create can start a repository here. */
  offered: boolean
  track: boolean
  setTrack: (on: boolean) => void
}

export function useTrackWithGit(mode: 'existing' | 'template', rootPath: string, enabled: boolean): TrackWithGit {
  const [info, setInfo] = useState<FolderGitInfo | null>(null)
  const [touched, setTouched] = useState<boolean | null>(null)
  const root = normalizeWorkspaceRelPath(rootPath)

  useEffect(() => {
    if (!enabled || mode !== 'existing' || !root) {
      setInfo(null)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      window.pomade.git.folderInfo(root).then(
        (i) => {
          if (!cancelled) setInfo(i)
        },
        () => {
          if (!cancelled) setInfo(null)
        }
      )
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [enabled, mode, root])

  const offered = enabled && (mode === 'template' || info?.kind === 'missing' || info?.kind === 'none')
  const byDefault = mode === 'template' || info?.kind === 'missing'
  return {
    info: mode === 'existing' ? info : null,
    offered,
    track: offered && (touched ?? byDefault),
    setTrack: (on) => setTouched(on)
  }
}

export function TrackWithGitRow({ git }: { git: TrackWithGit }): React.JSX.Element | null {
  const info = git.info
  if (git.offered) {
    return (
      <div className={styles.row}>
        <label className={styles.check}>
          <input type="checkbox" checked={git.track} data-testid="project-track-git" onChange={(e) => git.setTrack(e.target.checked)} />
          <span>
            Track with git
            <span className={styles.hint}>
              {' '}
              — starts a <GitTerm term="repository">repository</GitTerm> here and makes the first{' '}
              <GitTerm term="commit">commit</GitTerm>
            </span>
          </span>
        </label>
        {info?.kind === 'missing' && (
          <span className={styles.hint} data-testid="project-folder-new">
            The folder does not exist yet — it will be created.
          </span>
        )}
      </div>
    )
  }
  if (info?.kind === 'repo') {
    return (
      <div className={styles.row} data-testid="project-git-info" data-kind="repo">
        <span className={styles.hint}>
          Already a git <GitTerm term="repository">repository</GitTerm> ·{' '}
          {info.remoteUrl ? (
            <span data-testid="project-git-remote">{remoteLabel(info.remoteUrl)}</span>
          ) : (
            <span className={styles.localOnly} data-testid="project-git-remote">
              {LOCAL_ONLY}
            </span>
          )}
        </span>
      </div>
    )
  }
  if (info?.kind === 'inside') {
    return (
      <div className={styles.row} data-testid="project-git-info" data-kind="inside">
        <span className={styles.hint}>
          Tracked by the {info.repoName} <GitTerm term="repository">repository</GitTerm>
          {info.remoteUrl ? ` · ${remoteLabel(info.remoteUrl)}` : ' · local only'}
        </span>
      </div>
    )
  }
  return null
}
