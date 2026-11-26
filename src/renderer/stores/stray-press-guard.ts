// Pomade — T-228: the stray second press of a habitual double click. A single click on a row (the
// Git panel, a commit or branch tab, Document history, the tree) opens or activates a tab, and the
// new pane can appear right under the pointer. The double click's second press then lands in that
// pane — on the editable side of a comparison it would place the caret, select a word and keep the
// preview tab. The guard drops that press.
//
// The rule: a mousedown with `detail >= 2` is dropped when, since the first press of its sequence,
// a tab was activated and the element under the pointer is no longer the one pressed first (nor
// inside it, nor around it). The press and its mouseup, click and dblclick never reach the page —
// no caret, no selection, no focus change, no pane mousedown handler. A double click whose two
// presses hit the same element (the tree's double-click Rename, a tab's double-click rename, the
// same Git panel row) passes untouched, and so does any double click that activated no tab.

import { useTabsStore } from './tabs-store'

/** How long after the first press a tab activation still counts as caused by it. Opens that read
 *  something first (a comparison's titles) land a beat after the click. */
const ACTIVATION_WINDOW_MS = 1500

interface Press {
  target: Node
  time: number
}

/** The last primary-button press that started a click sequence (`detail` 1). */
let firstPress: Press | null = null
/** Set when a tab was activated within the window after `firstPress`. */
let armedBy: Press | null = null
/** True from a dropped press until the next press: its mouseup / click / dblclick are dropped too. */
let dropping = false

function related(a: Node, b: Node): boolean {
  return a === b || a.contains(b) || b.contains(a)
}

function drop(e: Event): void {
  e.preventDefault()
  e.stopImmediatePropagation()
}

function onMouseDown(e: MouseEvent): void {
  dropping = false
  if (e.button !== 0) {
    firstPress = null
    armedBy = null
    return
  }
  const target = e.target instanceof Node ? e.target : null
  if (!target) return
  if (e.detail <= 1) {
    firstPress = { target, time: performance.now() }
    armedBy = null
    return
  }
  if (armedBy && armedBy === firstPress && !related(armedBy.target, target)) {
    dropping = true
    drop(e)
  }
}

function onFollowUp(e: MouseEvent): void {
  if (dropping) drop(e)
}

/** Active tab ids by project, to tell a real activation from a state write that kept it. */
function activeIds(): Record<string, string | undefined> {
  return useTabsStore.getState().activeTabByProject
}

/** Install the guard (window capture listeners + the tabs-store watch). Returns the teardown. */
export function startStrayPressGuard(): () => void {
  let last = activeIds()
  const unsubscribe = useTabsStore.subscribe((s) => {
    const next = s.activeTabByProject
    if (next === last) return
    const changed = Object.keys(next).some((pid) => next[pid] && next[pid] !== last[pid])
    last = next
    if (changed && firstPress && performance.now() - firstPress.time < ACTIVATION_WINDOW_MS) armedBy = firstPress
  })
  window.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onFollowUp, true)
  window.addEventListener('click', onFollowUp, true)
  window.addEventListener('dblclick', onFollowUp, true)
  return () => {
    unsubscribe()
    window.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onFollowUp, true)
    window.removeEventListener('click', onFollowUp, true)
    window.removeEventListener('dblclick', onFollowUp, true)
    firstPress = null
    armedBy = null
    dropping = false
  }
}
