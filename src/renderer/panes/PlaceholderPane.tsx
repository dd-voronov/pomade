// Pomade — Wave 1 placeholder pane renderer (doc / terminal / agent).
// Exists to prove the tab framework end-to-end. Two liveness signals let e2e verify
// the "hidden, never unmounted" invariant:
//   - data-mount-id: a stable id generated ONCE per mount. If the pane were unmounted
//     and remounted on project switch, this id would change; it must not.
//   - a ticking counter that keeps advancing even while the pane is hidden (its interval
//     survives display:none), demonstrating live panes behind an inactive project.

import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'

import type { PaneProps } from './registry'
import styles from './PlaceholderPane.module.css'

const KIND_LABEL: Record<string, string> = {
  doc: 'Document',
  terminal: 'Terminal',
  agent: 'Agent'
}

export function PlaceholderPane({ tab }: PaneProps): React.JSX.Element {
  const mountId = useRef(nanoid()).current
  const [ticks, setTicks] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTicks((t) => t + 1), 250)
    return () => clearInterval(timer)
  }, [])

  return (
    <div
      className={styles.pane}
      data-testid={`pane-body-${tab.id}`}
      data-kind={tab.kind}
      data-mount-id={mountId}
      data-ticks={ticks}
    >
      <div className={styles.badge}>{KIND_LABEL[tab.kind] ?? tab.kind}</div>
      <div className={styles.title}>{tab.title}</div>
      <div className={styles.meta}>
        <span className={styles.kv}>
          kind <code>{tab.kind}</code>
        </span>
        <span className={styles.kv}>
          project <code>{tab.projectId}</code>
        </span>
        <span className={styles.kv}>
          live ticks <code data-testid={`ticks-${tab.id}`}>{ticks}</code>
        </span>
      </div>
      <p className={styles.note}>
        Placeholder pane. The real {KIND_LABEL[tab.kind]?.toLowerCase() ?? tab.kind} renderer is
        wired in a later wave. This element stays mounted while its project is inactive.
      </p>
    </div>
  )
}
