// Pomade — E-014 workspace frontmatter index (properties-panel autocomplete).
// A cheap frequency scan of every workspace .md file's LEADING `---` block — no full YAML lib
// in the hot path, just a line parse (a stale/approximate index is fine, it only drives
// suggestions). Bounded by INDEX_IGNORE_NAMES (T-091 — the same list the name index uses, so
// build outputs and vendored trees are never read for frontmatter either). Cached per app run
// and keyed by root so a workspace switch rebuilds it lazily on next request.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { isMarkdownPath } from 'pomade-kit/protocol'

import type { FrontmatterIndex } from '@shared/types'

import { INDEX_IGNORE_NAMES, INDEX_WALK_CONCURRENCY, walkWorkspace } from './fs-shared'

function unquoteYamlScalar(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

function bumpValue(
  values: Record<string, Record<string, number>>,
  key: string,
  value: string
): void {
  const v = value.trim()
  if (!v) return
  ;(values[key] ??= {})[v] = (values[key][v] ?? 0) + 1
}

function indexFrontmatterText(
  text: string,
  keys: Record<string, number>,
  values: Record<string, Record<string, number>>
): void {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return
  const lines = text.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      end = i
      break
    }
  }
  if (end < 0) return
  let currentKey: string | null = null
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const km = /^([^\s#][^:]*?):(?:\s+(.*))?$/.exec(line)
    if (km && !/^\s/.test(line)) {
      const key = unquoteYamlScalar(km[1].trim())
      keys[key] = (keys[key] ?? 0) + 1
      currentKey = key
      const rest = (km[2] ?? '').trim()
      if (rest.startsWith('[') && rest.endsWith(']')) {
        for (const item of rest.slice(1, -1).split(',')) bumpValue(values, key, unquoteYamlScalar(item))
      } else if (rest !== '') {
        bumpValue(values, key, unquoteYamlScalar(rest))
      }
    } else if (currentKey && /^\s*-\s+/.test(line)) {
      bumpValue(values, currentKey, unquoteYamlScalar(line.replace(/^\s*-\s+/, '')))
    }
  }
}

async function buildFrontmatterIndex(root: string): Promise<FrontmatterIndex> {
  const keys: Record<string, number> = {}
  const values: Record<string, Record<string, number>> = {}
  // T-091 — shared bounded-concurrency walk, then bounded-concurrency reads. Collecting the
  // paths first keeps the two I/O phases (metadata / content) from serializing behind each other.
  const mdFiles: string[] = []
  await walkWorkspace(root, new Set(INDEX_IGNORE_NAMES), (dirAbs, entries) => {
    for (const entry of entries) {
      if (entry.isFile() && isMarkdownPath(entry.name)) {
        mdFiles.push(join(dirAbs, entry.name))
      }
    }
  }, root)
  for (let i = 0; i < mdFiles.length; i += INDEX_WALK_CONCURRENCY) {
    const texts = await Promise.all(
      mdFiles.slice(i, i + INDEX_WALK_CONCURRENCY).map((p) =>
        fs.readFile(p, 'utf8').catch(() => null) /* unreadable file — skip */
      )
    )
    for (const text of texts) {
      if (text !== null) indexFrontmatterText(text, keys, values)
    }
  }
  return { keys, values }
}

/** The workspace frontmatter index, cached per app run and keyed by root (rebuilt lazily on the
 *  first request after a workspace switch). */
class FmIndex {
  private cache: { root: string; index: FrontmatterIndex } | null = null

  async get(root: string): Promise<FrontmatterIndex> {
    if (!this.cache || this.cache.root !== root) {
      this.cache = { root, index: await buildFrontmatterIndex(root) }
    }
    return this.cache.index
  }
}

export const fmIndex = new FmIndex()
