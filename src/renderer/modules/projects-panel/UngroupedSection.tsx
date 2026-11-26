// Pomade — the Ungrouped pseudo-group (E-015): a DRAGGABLE header participating in top-level
// ordering (but never nestable/renamable/deletable), plus its project rows. T-074: rendered ONLY
// when it actually holds projects — an empty "Ungrouped / Drop a project here" placeholder is
// noise. A project can still be moved OUT of every group while the section is hidden: the below-all
// zone accepts a project drag and un-groups it.

import type { Project } from '@shared/types'
import { Gap } from './GroupSection'
import { ProjectRow } from './ProjectRow'
import type { ProjectsPanelCtx } from './tree-context'
import styles from './ProjectsPanel.module.css'

export function UngroupedSection({
  ungrouped,
  ctx
}: {
  ungrouped: Project[]
  ctx: ProjectsPanelCtx
}): React.JSX.Element | null {
  const { dnd } = ctx
  if (ungrouped.length === 0) return null
  const ungroupedDropClass = dnd.headerDropClass(
    dnd.dropInd?.kind === 'ungrouped' ? dnd.dropInd.zone : undefined
  )
  return (
    <section
      className={styles.group}
      data-testid="ungrouped-section"
      // The whole section accepts a PROJECT drop (→ move out to Ungrouped) — a broad,
      // forgiving target. Group/ungrouped-source ordering is handled by the header below.
      {...dnd.ungroupedSectionHandlers()}
    >
      <Gap
        gapKey="gap-ungrouped"
        testId="ungrouped-gap"
        target={{ kind: 'ungrouped-before' }}
        depth={1}
        dnd={dnd}
      />
      <div
        className={`${styles.groupHeader} ${ungroupedDropClass}`}
        data-testid="ungrouped-header"
        {...dnd.ungroupedHeaderHandlers()}
      >
        <span className={styles.groupName}>Ungrouped</span>
      </div>
      <ul className={styles.list}>
        {ungrouped.map((p) => (
          <ProjectRow key={p.id} project={p} siblings={ungrouped} depth={0} ctx={ctx} />
        ))}
      </ul>
    </section>
  )
}
