// Pomade E-001 (T-012) — in-document find for the rendered (ProseMirror/Milkdown) view.
// ProseMirror has no built-in search, so this is a small plugin: it keeps the active query +
// match ranges in plugin state and paints them as inline decorations (all matches highlighted,
// the current one distinctly). Step-through moves the selection to the current match and
// scrolls it into view. Replace stays raw-only for v1 (see the panel note in EditorPane).

import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

import type { FindMatchInfo, RenderedFindApi } from './editor-controller'

export interface Match {
  from: number
  to: number
}

interface FindState {
  query: string
  caseSensitive: boolean
  matches: Match[]
  current: number // index into matches, -1 when none
}

export const findPluginKey = new PluginKey<FindState>('pomade-find')

const SET_FIND = 'pomade-set-find'

const EMPTY: FindState = { query: '', caseSensitive: false, matches: [], current: -1 }

// Search each text node independently: a query that spans a mark boundary (e.g. a bolded
// letter mid-word) won't match, which is acceptable for v1 find and avoids cross-block
// false positives that a flattened-string approach would produce.
function computeMatches(doc: ProseNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return []
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const hay = caseSensitive ? node.text : node.text.toLowerCase()
    let idx = hay.indexOf(needle)
    while (idx !== -1) {
      matches.push({ from: pos + idx, to: pos + idx + query.length })
      idx = hay.indexOf(needle, idx + Math.max(needle.length, 1))
    }
  })
  return matches
}

function buildDeco(doc: ProseNode, fs: FindState): DecorationSet {
  if (fs.matches.length === 0) return DecorationSet.empty
  const decos = fs.matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === fs.current ? 'pomade-find-match pomade-find-current' : 'pomade-find-match'
    })
  )
  return DecorationSet.create(doc, decos)
}

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findPluginKey,
    state: {
      init: () => EMPTY,
      apply(tr, prev) {
        const meta = tr.getMeta(SET_FIND) as FindState | undefined
        if (meta) return meta
        if (tr.docChanged && prev.query) {
          const matches = computeMatches(tr.doc, prev.query, prev.caseSensitive)
          const current = matches.length ? Math.min(Math.max(prev.current, 0), matches.length - 1) : -1
          return { ...prev, matches, current }
        }
        return prev
      }
    },
    props: {
      decorations(state) {
        const fs = findPluginKey.getState(state)
        return fs ? buildDeco(state.doc, fs) : null
      }
    }
  })
}

function info(fs: FindState): FindMatchInfo {
  return { count: fs.matches.length, current: fs.matches.length ? fs.current + 1 : 0 }
}

/** Apply a new FindState and (when there's a current match) move + scroll the selection to it,
 *  WITHOUT stealing DOM focus from the find input. Returns the resulting match info. */
function commit(view: EditorView, next: FindState, moveSelection: boolean): FindMatchInfo {
  let tr = view.state.tr.setMeta(SET_FIND, next)
  if (moveSelection && next.current >= 0) {
    const m = next.matches[next.current]
    tr = tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView()
  }
  view.dispatch(tr)
  return info(next)
}

/** Build the rendered-mode find API bound to a live ProseMirror view. */
export function makeRenderedFindApi(view: EditorView): RenderedFindApi {
  const read = (state: EditorState): FindState => findPluginKey.getState(state) ?? EMPTY

  return {
    setQuery(query, opts) {
      const matches = computeMatches(view.state.doc, query, opts.caseSensitive)
      // Start at the first match at/after the caret so find feels anchored to where you are.
      const anchor = view.state.selection.from
      let current = matches.findIndex((m) => m.from >= anchor)
      if (current === -1 && matches.length) current = 0
      return commit(view, { query, caseSensitive: opts.caseSensitive, matches, current }, matches.length > 0)
    },
    next() {
      const fs = read(view.state)
      if (fs.matches.length === 0) return info(fs)
      const current = (fs.current + 1) % fs.matches.length
      return commit(view, { ...fs, current }, true)
    },
    prev() {
      const fs = read(view.state)
      if (fs.matches.length === 0) return info(fs)
      const current = (fs.current - 1 + fs.matches.length) % fs.matches.length
      return commit(view, { ...fs, current }, true)
    },
    clear() {
      commit(view, EMPTY, false)
    }
  }
}
