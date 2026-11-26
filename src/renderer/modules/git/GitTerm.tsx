// Pomade — E-039: a git term in the UI, with its one-line explanation and an example on hover. The
// words come from the one glossary (shared/git-glossary.ts); nothing else words a git term.

import { glossaryLines, type GlossaryTerm } from '@shared/git-glossary'
import type { Seg } from '@shared/git-ops'
import { Tooltip } from '../../components/Tooltip'
import styles from './GitTerm.module.css'

export function GitTerm({ term, children }: { term: GlossaryTerm; children: React.ReactNode }): React.JSX.Element {
  return (
    <Tooltip lines={glossaryLines(term)} testId={`git-term-tip-${term}`}>
      <span className={styles.term} tabIndex={0} data-testid={`git-term-${term}`} data-term={term}>
        {children}
      </span>
    </Tooltip>
  )
}

/** A sentence from shared/git-ops (`previewSentence`), its terms explained on hover. */
export function Sentence({ segs }: { segs: readonly Seg[] }): React.JSX.Element {
  return (
    <>
      {segs.map((s, i) =>
        typeof s === 'string' ? (
          <span key={i}>{s}</span>
        ) : (
          <GitTerm key={i} term={s.term}>
            {s.text}
          </GitTerm>
        )
      )}
    </>
  )
}
