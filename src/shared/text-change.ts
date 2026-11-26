// Pomade — the smallest single replacement turning `from` into `to`: the common prefix and suffix
// stay, only the middle is replaced. An editor reconciling an outside change (a disk reload, a
// comparison tab editing the same buffer) dispatches this instead of replacing the whole document,
// so the caret, the selection and the undo history around the change survive.

export interface TextChange {
  from: number
  to: number
  insert: string
}

/** Null when the texts are equal. Never splits a UTF-16 surrogate pair. */
export function minimalChange(from: string, to: string): TextChange | null {
  if (from === to) return null
  const max = Math.min(from.length, to.length)
  let start = 0
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1))) start--
  let endFrom = from.length
  let endTo = to.length
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--
    endTo--
  }
  if (endFrom < from.length && isLowSurrogate(from.charCodeAt(endFrom))) {
    endFrom++
    endTo++
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) }
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}
