// Pomade — Milkdown parse-health check (E-023 contract).
//
// HISTORY: through E-002…T-126 this file was a byte-exact ROUND-TRIP guard — it checked that
// serialize(parse(body)) reproduced `body`, and a mismatch ("lossy") forced the file open in raw
// mode. That made the guard the de-facto owner of the DEFAULT open mode, and ~61% of the real
// vault opened raw over purely cosmetic serializer canonicalization (table re-padding, blank-line
// normalization, `_em_`→`*em*`) — never data risk.
//
// E-023 (the Owner, 2026-08-19, explicit): the canonicalization-on-save policy is ACCEPTED ("it only
// affects files we open, then edit and save"), so the default open mode is decided by the "New
// markdown opens as" setting ALONE. This check is demoted to a pure PARSE safety net: a file
// Milkdown genuinely cannot parse must not enter rendered mode by default (it would render as an
// empty/broken doc and a save would destroy it). No serialize, no byte compare.
//
// The headless editor (a detached DOM node) uses the SAME parser the live editor uses, configured
// identically via md-config — including `commonmarkNoEmptyLine` (the preset with
// `remark-preserve-empty-line` removed) so the two stay in lock-step.

import { Editor, rootCtx, parserCtx } from '@milkdown/kit/core'
import { gfm } from '@milkdown/kit/preset/gfm'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

import { bulletListSpreadFix, commonmarkNoEmptyLine, configureRemarkStringify, softBreakFix } from './md-config'

interface RoundTripper {
  parse: (markdown: string) => ProseNode | null
}

let cached: Promise<RoundTripper> | null = null

function build(): Promise<RoundTripper> {
  return (async () => {
    const root = document.createElement('div')
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        configureRemarkStringify(ctx)
      })
      .use(commonmarkNoEmptyLine)
      .use(gfm)
      .use(bulletListSpreadFix)
      .use(softBreakFix)
      .create()
    return {
      parse: editor.ctx.get(parserCtx)
    }
  })()
}

/** True iff Milkdown can parse `body` into a document. On any failure (parse returns null, or the
 *  parser throws) returns false so the caller falls back to raw mode — the parse-error→raw safety
 *  net that is now this check's ONLY job (E-023). It does NOT judge round-trip fidelity: a parseable
 *  file opens rendered even when a save would canonicalize it (accepted policy). */
export async function parsesCleanly(body: string): Promise<boolean> {
  try {
    if (!cached) cached = build()
    const { parse } = await cached
    return parse(body) != null
  } catch {
    return false
  }
}
