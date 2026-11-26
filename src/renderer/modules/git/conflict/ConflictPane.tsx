// Pomade — E-040: the conflict tab — a rebase stopped on a conflict, combined file by file. Three
// columns: **theirs** (what your commits go on top of) · the **result** (editable) · **yours** (your
// commit being replayed). Each conflict has take arrows (→ theirs into the result, ← yours; both,
// one after the other, keeps both in that order) and its result can be typed. The stretches git
// combined on its own span all three columns, long ones folded. A file with a deleted, binary or
// too-big side is combined whole: one side or the other.
//
// **Mark resolved & continue** (in the action bar above the columns, clear of the toasts) saves the
// result, marks the file resolved and — on the last file — continues the rebase (its preview line
// says which). **Abort, back to before** stays in the header
// whatever is shown; it opens the abort dialog (git-ops-store), which puts the repository back
// exactly as before the rebase.
//
// The tab persists only its repo; the rebase is read from git when the pane mounts and again
// whenever the repo's git state changes. Hidden, never unmounted.
//
// E-041: a merge into main stopped on a conflict opens the same tab. Its sides are **main** (what
// is there) and **the branch** (what lands); the last file — or **Finish the merge** — commits it
// (one commit for a squash), and Abort runs `merge --abort`, checked the same way.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import {
  UNDECIDED,
  conflictCount,
  resultText,
  takeInto,
  type ConflictFile,
  type ConflictPick,
  type ConflictResolution,
  type ConflictSide,
  type RebaseState
} from '@shared/git-conflict'
import type { ConflictTab, Tab } from '@shared/types'
import { Tooltip } from '../../../components/Tooltip'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { GitTerm } from '../GitTerm'
import { useGitStateStore } from '../git-state-store'
import { OpNote, PreviewLine, usePreview } from '../ops/OpParts'
import { repoKeyOf } from '../ops/CommitComposer'
import { failureText, runGitOp, useGitOpsStore } from '../ops/git-ops-store'
import editorStyles from '../../editor/EditorPane.module.css'
import compareStyles from '../compare/ComparePane.module.css'
import styles from './ConflictPane.module.css'

/** A same stretch longer than this many lines is folded to its first and last FOLD_KEEP lines. */
const FOLD_OVER = 8
const FOLD_KEEP = 3

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function sizeLabel(n: number): string {
  return n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** How the two sides are called: theirs / yours in a rebase; main / the branch in a merge. */
interface SideNames {
  theirs: string
  yours: string
  theirsDeleted: string
  yoursDeleted: string
}

const REBASE_SIDES: SideNames = { theirs: 'theirs', yours: 'yours', theirsDeleted: 'Deleted on their side', yoursDeleted: 'Deleted in your commit' }

function mergeSides(main: string, branch: string | null): SideNames {
  const b = branch ?? 'the branch'
  return { theirs: main, yours: b, theirsDeleted: `Deleted on ${main}`, yoursDeleted: `Deleted on ${b}` }
}

const Sides = createContext<SideNames>(REBASE_SIDES)

function sideWords(side: ConflictSide, who: 'theirs' | 'yours', names: SideNames): string {
  switch (side.kind) {
    case 'absent':
      return who === 'theirs' ? names.theirsDeleted : names.yoursDeleted
    case 'binary':
      return `A binary file (${sizeLabel(side.size)})`
    case 'too-big':
      return `A large file (${sizeLabel(side.size)}) — over 2 MB`
    case 'text':
      return `${side.text.split('\n').length} lines of text`
  }
}

/** The text of a side, or a faint "nothing here" for an empty one. */
function SideText({ text, testId }: { text: string; testId: string }): React.JSX.Element {
  return text ? (
    <pre className={styles.code} data-testid={testId}>
      {text}
    </pre>
  ) : (
    <div className={styles.empty} data-testid={testId}>
      nothing here
    </div>
  )
}

/** A stretch both sides agree on (or git combined), across all three columns; folded when long. */
function SameRow({ text, index }: { text: string; index: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  const folded = !open && lines.length > FOLD_OVER
  return (
    <div className={styles.same} data-testid={`conflict-same-${index}`}>
      {folded ? (
        <>
          <pre className={styles.code}>{lines.slice(0, FOLD_KEEP).join('\n')}</pre>
          <button type="button" className={styles.fold} data-testid={`conflict-unfold-${index}`} onClick={() => setOpen(true)}>
            ⋯ {lines.length - 2 * FOLD_KEEP} unchanged lines
          </button>
          <pre className={styles.code}>{lines.slice(-FOLD_KEEP).join('\n')}</pre>
        </>
      ) : (
        <pre className={styles.code}>{text.replace(/\n$/, '')}</pre>
      )}
    </div>
  )
}

/** A textarea that grows with its text (the result cell never scrolls on its own). */
function ResultBox({
  value,
  onChange,
  testId,
  decided
}: {
  value: string
  onChange: (v: string) => void
  testId: string
  decided: boolean
}): React.JSX.Element {
  const names = useContext(Sides)
  // Every line shown, the empty one after a final line end included (the caret can sit there).
  const rows = Math.max(2, value.split('\n').length)
  return (
    <textarea
      className={styles.result}
      data-testid={testId}
      data-decided={decided || undefined}
      rows={rows}
      spellCheck={false}
      value={value}
      placeholder={`Take ${names.theirs} →, ← ${names.yours}, or both — or type the result here.`}
      aria-label="Result"
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function ConflictRow({
  seg,
  k,
  pick,
  setPick
}: {
  seg: { theirs: string; base: string; yours: string }
  k: number
  pick: ConflictPick
  setPick: (p: ConflictPick) => void
}): React.JSX.Element {
  const names = useContext(Sides)
  return (
    <div className={styles.conflict} data-testid={`conflict-hunk-${k}`} data-decided={pick.decided || undefined}>
      <div className={styles.theirs}>
        <SideText text={seg.theirs} testId={`conflict-theirs-${k}`} />
      </div>
      <div className={styles.arrowCol}>
        <Tooltip lines={[`Take ${names.theirs} — put that version into the result`, `Taken after ${names.yours}, it goes below it.`]}>
          <button
            type="button"
            className={styles.arrow}
            aria-label={`Take ${names.theirs} into the result`}
            data-testid={`conflict-take-theirs-${k}`}
            onClick={() => setPick(takeInto(pick, seg.theirs))}
          >
            →
          </button>
        </Tooltip>
      </div>
      <div className={styles.resultCell}>
        <ResultBox value={pick.text} decided={pick.decided} testId={`conflict-result-${k}`} onChange={(text) => setPick({ text, decided: true })} />
        {pick.decided && (
          <button type="button" className={styles.reset} data-testid={`conflict-reset-${k}`} onClick={() => setPick(UNDECIDED)}>
            Start over
          </button>
        )}
      </div>
      <div className={styles.arrowCol}>
        <Tooltip lines={[`Take ${names.yours} — put that version into the result`, `Taken after ${names.theirs}, it goes below it.`]}>
          <button
            type="button"
            className={styles.arrow}
            aria-label={`Take ${names.yours} into the result`}
            data-testid={`conflict-take-yours-${k}`}
            onClick={() => setPick(takeInto(pick, seg.yours))}
          >
            ←
          </button>
        </Tooltip>
      </div>
      <div className={styles.yours}>
        <SideText text={seg.yours} testId={`conflict-yours-${k}`} />
      </div>
    </div>
  )
}

/** A file combined whole: one side or the other. */
function WholeFile({
  file,
  choice,
  setChoice
}: {
  file: ConflictFile
  choice: 'theirs' | 'yours' | null
  setChoice: (c: 'theirs' | 'yours') => void
}): React.JSX.Element {
  const names = useContext(Sides)
  const card = (who: 'theirs' | 'yours'): React.JSX.Element => (
    <div className={styles.card} data-chosen={choice === who || undefined} data-testid={`conflict-whole-${who}`}>
      <div className={styles.cardText}>{sideWords(who === 'theirs' ? file.theirs : file.yours, who, names)}</div>
      <button
        type="button"
        className={styles.cardBtn}
        data-testid={`conflict-take-whole-${who}`}
        onClick={() => setChoice(who)}
      >
        {(who === 'theirs' ? file.theirs : file.yours).kind === 'absent' ? 'Take this — delete the file' : `Take ${names[who]}`}
      </button>
    </div>
  )
  return (
    <div className={styles.whole} data-testid="conflict-whole">
      <p className={styles.wholeNote}>This file cannot be combined line by line — keep one side whole.</p>
      <div className={styles.cards}>
        {card('theirs')}
        {card('yours')}
      </div>
    </div>
  )
}

interface FileWork {
  /** The loaded versions' identity: a reload with other versions starts the picks over. */
  key: string
  picks: ConflictPick[]
  whole: 'theirs' | 'yours' | null
}

export function ConflictPane({ tab }: { tab: Tab }): React.JSX.Element | null {
  const t = tab as ConflictTab
  const repo = useGitStateStore((s) => s.snapshot.repos.find((r) => r.root === t.repo))
  const repoKey = repo ? repoKeyOf(repo) : ''
  const name = repo?.name ?? base(t.repo)
  const running = useGitOpsStore((s) => s.running[t.repo])
  const openDialog = useGitOpsStore((s) => s.openDialog)

  const [rebase, setRebase] = useState<RebaseState | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<ConflictFile | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [work, setWork] = useState<Record<string, FileWork>>({})
  const [failure, setFailure] = useState<{ message: string; copy?: string; detail?: string } | null>(null)

  // ── the rebase: read on mount and whenever the repo's state moves ───────────
  useEffect(() => {
    let cancelled = false
    if (!repo) {
      setRebase(null)
      return
    }
    window.pomade.git.rebase(t.repo).then(
      (r) => {
        if (cancelled) return
        setRebase(r)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(cleanIpcError(err))
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- repoKey covers every change of `repo`
  }, [t.repo, repoKey])

  const conflicts = rebase?.conflicts ?? []
  const current = selected && conflicts.includes(selected) ? selected : (conflicts[0] ?? null)

  // ── the selected file's versions ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setFileError(null)
    if (!current) {
      setFile(null)
      return
    }
    window.pomade.git.conflictFile(t.repo, current).then(
      (f) => {
        if (cancelled) return
        setFile(f)
        const key = JSON.stringify([f.theirs, f.yours, f.segments])
        setWork((w) =>
          w[f.path]?.key === key
            ? w
            : { ...w, [f.path]: { key, picks: (f.segments ?? []).filter((s) => s.kind === 'conflict').map(() => UNDECIDED), whole: null } }
        )
      },
      (err: unknown) => {
        if (!cancelled) setFileError(cleanIpcError(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [t.repo, current, rebase])

  const fw = file ? work[file.path] : undefined
  const setPick = useCallback(
    (k: number, p: ConflictPick): void => {
      if (!file) return
      setWork((w) => {
        const cur = w[file.path]
        if (!cur) return w
        const picks = cur.picks.slice()
        picks[k] = p
        return { ...w, [file.path]: { ...cur, picks } }
      })
    },
    [file]
  )

  const resolution: ConflictResolution | null = useMemo(() => {
    if (!file || !fw) return null
    if (!file.segments) return fw.whole ? { kind: 'take', side: fw.whole } : null
    if (fw.picks.some((p) => !p.decided)) return null
    return { kind: 'text', content: resultText(file.segments, fw.picks) }
  }, [file, fw])

  const resolveReq = current ? ({ op: 'resolve-file', path: current } as const) : null
  const merging = rebase?.kind === 'merge'
  const continueReq = rebase && conflicts.length === 0 ? ({ op: merging ? 'merge-continue' : 'rebase-continue' } as const) : null
  const preview = usePreview(t.repo, resolveReq ?? continueReq, repoKey)
  const p = preview.preview
  const canRun = !!p && !p.blocked && !running && !preview.loading && (continueReq ? true : !!resolution)

  const run = async (): Promise<void> => {
    if (!canRun || !p) return
    setFailure(null)
    const req = resolveReq && resolution ? { ...resolveReq, resolution } : continueReq
    if (!req) return
    const result = await runGitOp(t.repo, name, req, { token: p.token })
    if (!result.ok) {
      setFailure({ message: failureText(result.failure), copy: result.failure.copy, detail: result.failure.detail })
      preview.reload()
    }
  }

  const undecided = fw ? fw.picks.filter((x) => !x.decided).length : 0
  const total = file?.segments ? conflictCount(file.segments) : 0
  /** Each segment's conflict number (-1 for a same stretch). */
  const ordinals = useMemo(() => {
    let n = 0
    return (file?.segments ?? []).map((s) => (s.kind === 'conflict' ? n++ : -1))
  }, [file])

  const names = rebase?.kind === 'merge' ? mergeSides(rebase.onto, rebase.branch) : REBASE_SIDES
  const what = merging ? 'merge' : 'rebase'

  return (
    <Sides.Provider value={names}>
    <div className={styles.pane} data-testid="conflict-pane" data-repo={t.repo} data-kind={rebase?.kind}>
      <div className={editorStyles.header}>
        <span className={compareStyles.title}>
          <span className={compareStyles.name}>
            <GitTerm term="conflict">Conflict</GitTerm> · {name}
          </span>
          {rebase?.branch && <span className={compareStyles.folder}>{rebase.branch}</span>}
        </span>
        <span className={compareStyles.actions}>
          {rebase && (
            <Tooltip lines={[`Stop the ${what} and put everything back exactly as it was before it.`]}>
              <button
                type="button"
                className={styles.abort}
                data-testid="conflict-abort"
                disabled={!!running}
                onClick={() => openDialog(t.repo, name, { op: merging ? 'merge-abort' : 'rebase-abort' })}
              >
                Abort, back to before
              </button>
            </Tooltip>
          )}
        </span>
      </div>

      {error ? (
        <div className={compareStyles.message} data-testid="conflict-error">
          Could not read what stopped: {error}
        </div>
      ) : rebase === undefined ? (
        <div className={compareStyles.message}>Loading…</div>
      ) : rebase === null ? (
        <div className={compareStyles.message} data-testid="conflict-none">
          Nothing is stopped on a conflict in {name} — there is nothing to combine. You can close this tab.
        </div>
      ) : (
        <>
          <div className={styles.summary} data-testid="conflict-summary">
            {merging ? (
              <>
                Landing <b>{rebase.branch ?? 'the branch'}</b> on <b>{rebase.onto}</b>. Both changed the same lines — pick what
                the file should say.
              </>
            ) : rebase.commit ? (
              <>
                Putting your commit <b>“{rebase.commit.subject}”</b>
                {rebase.total > 1 ? ` (${rebase.step} of ${rebase.total})` : ''} on top of <b>{rebase.onto}</b>. Their
                change and yours touch the same lines — pick what the file should say.
              </>
            ) : (
              <>
                Rebasing onto <b>{rebase.onto}</b>.
              </>
            )}
          </div>

          {conflicts.length > 0 && (
            <div className={styles.files} role="tablist" aria-label="Files with a conflict" data-testid="conflict-files">
              {conflicts.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="tab"
                  aria-selected={c === current}
                  className={styles.fileChip}
                  data-testid={`conflict-file-${c}`}
                  title={c}
                  onClick={() => setSelected(c)}
                >
                  {base(c)}
                </button>
              ))}
            </div>
          )}

          <div className={styles.actionBar} data-testid="conflict-actions">
            <div className={styles.actionText}>
              {preview.error ? (
                <OpNote tone="failed" message={preview.error} copy={preview.error} testId="conflict-preview-error" />
              ) : p ? (
                <>
                  <PreviewLine preview={p} testId="conflict-preview" />
                  {p.blocked && <OpNote tone="blocked" message={p.blocked.message} copy={p.blocked.copy} testId="conflict-blocked" />}
                </>
              ) : null}
              {failure && (
                <OpNote tone="failed" message={failure.message} copy={failure.copy} detail={failure.detail} testId="conflict-failure" />
              )}
            </div>
            <button
              type="button"
              className={styles.primary}
              data-testid="conflict-resolve"
              disabled={!canRun}
              onClick={() => void run()}
            >
              {running ? 'Working…' : continueReq ? (merging ? 'Finish the merge' : 'Continue the rebase') : 'Mark resolved & continue'}
            </button>
          </div>

          {conflicts.length === 0 ? (
            <div className={compareStyles.message} data-testid="conflict-all-combined">
              {merging ? 'Every file is combined. Finish the merge to land it.' : 'Every file is combined. Continue the rebase to make your commit.'}
            </div>
          ) : fileError ? (
            <div className={compareStyles.message} data-testid="conflict-file-error">
              Could not read {current ? base(current) : 'the file'}: {fileError}
            </div>
          ) : !file || file.path !== current || !fw ? (
            <div className={compareStyles.message}>Loading…</div>
          ) : (
            <>
              <div className={`${compareStyles.labels} ${styles.labels}`}>
                <span className={compareStyles.label} data-testid="conflict-label-theirs">
                  <span className={compareStyles.labelMain}>{merging ? 'Main' : 'Theirs'}</span>
                  <span className={compareStyles.labelSubject}>{rebase.onto}</span>
                </span>
                <span className={styles.labelGap} aria-hidden="true" />
                <span className={compareStyles.label} data-testid="conflict-label-result">
                  <span className={compareStyles.labelMain}>Result</span>
                  {file.segments && total > 0 && (
                    <span className={compareStyles.labelSubject}>
                      {undecided === 0 ? 'every conflict decided' : `${undecided} of ${total} to decide`}
                    </span>
                  )}
                </span>
                <span className={styles.labelGap} aria-hidden="true" />
                <span className={compareStyles.label} data-testid="conflict-label-yours">
                  <span className={compareStyles.labelMain}>{merging ? 'Landing' : 'Yours'}</span>
                  {merging ? (
                    <span className={compareStyles.labelSubject}>{rebase.branch ?? 'the branch'}</span>
                  ) : (
                    rebase.commit && <span className={compareStyles.labelSubject}>“{rebase.commit.subject}”</span>
                  )}
                </span>
              </div>
              <div className={styles.body} data-testid="conflict-body">
                {file.segments ? (
                  <>
                    {total === 0 && (
                      <div className={styles.wholeNote}>No lines conflict — git combined the two. Mark resolved takes the file below.</div>
                    )}
                    {file.segments.map((s, i) =>
                      s.kind === 'same' ? (
                        <SameRow key={i} text={s.text} index={i} />
                      ) : (
                        <ConflictRow
                          key={i}
                          seg={s}
                          k={ordinals[i]}
                          pick={fw.picks[ordinals[i]] ?? UNDECIDED}
                          setPick={(x) => setPick(ordinals[i], x)}
                        />
                      )
                    )}
                  </>
                ) : (
                  <WholeFile
                    file={file}
                    choice={fw.whole}
                    setChoice={(c) => setWork((w) => ({ ...w, [file.path]: { ...fw, whole: c } }))}
                  />
                )}
              </div>
            </>
          )}

        </>
      )}
    </div>
    </Sides.Provider>
  )
}
