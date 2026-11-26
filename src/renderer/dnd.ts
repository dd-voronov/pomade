// Renderer-internal drag-and-drop contract (T-104).
//
// A tab dragged off the tab strip carries a custom MIME marker in addition to its `text/plain`
// tab id, so a DROP TARGET OUTSIDE the strip (the Projects panel's project rows) can recognise a tab
// drag DURING dragover — when `DataTransfer.getData()` is deliberately blocked by the browser
// for security and only `DataTransfer.types` is readable. The marker is never read for its value
// during dragover (types-only); the tab id is read from it (or `text/plain`) on drop.
//
// The Projects panel's OWN project/group reorder DnD sets only `text/plain`, never this marker, so the
// two gestures never confuse each other: `isTabDrag` is true only for a strip-originated drag.

export const TAB_DRAG_MIME = 'application/x-pomade-tab'

/** True when the in-flight drag originated from the tab strip (carries the tab marker). */
export function isTabDrag(dt: DataTransfer): boolean {
  return dt.types.includes(TAB_DRAG_MIME)
}
