// Pomade — E-037: a commit message rendered as markdown (GFM: lists, task boxes, tables, code,
// strikethrough, autolinks). Read-only and safe by construction: the mdast tree is mapped to React
// elements — raw HTML in a message shows as text, never as markup. Links open in the browser.

import { Fragment, useMemo, type ReactNode } from 'react'
import type { Nodes, Parents, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'

import styles from './CommitPane.module.css'

function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) void window.pomade.app.openExternal(url)
}

function children(node: Parents, keyPrefix: string): ReactNode[] {
  return node.children.map((c, i) => render(c as Nodes, `${keyPrefix}.${i}`))
}

function render(node: Nodes, key: string): ReactNode {
  switch (node.type) {
    case 'root':
      return <Fragment key={key}>{children(node, key)}</Fragment>
    case 'paragraph':
      return <p key={key}>{children(node, key)}</p>
    case 'heading': {
      const H = `h${Math.min(node.depth + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
      return <H key={key}>{children(node, key)}</H>
    }
    case 'text':
      return <Fragment key={key}>{node.value}</Fragment>
    case 'emphasis':
      return <em key={key}>{children(node, key)}</em>
    case 'strong':
      return <strong key={key}>{children(node, key)}</strong>
    case 'delete':
      return <del key={key}>{children(node, key)}</del>
    case 'inlineCode':
      return <code key={key}>{node.value}</code>
    case 'code':
      return (
        <pre key={key}>
          <code>{node.value}</code>
        </pre>
      )
    case 'break':
      return <br key={key} />
    case 'thematicBreak':
      return <hr key={key} />
    case 'blockquote':
      return <blockquote key={key}>{children(node, key)}</blockquote>
    case 'list': {
      const L = node.ordered ? 'ol' : 'ul'
      return (
        <L key={key} start={node.ordered && node.start != null && node.start !== 1 ? node.start : undefined}>
          {children(node, key)}
        </L>
      )
    }
    case 'listItem':
      return (
        <li key={key} className={node.checked != null ? styles.task : undefined}>
          {node.checked != null && <input type="checkbox" checked={node.checked} readOnly tabIndex={-1} />}
          {/* A tight item's paragraphs read inline, like the source. */}
          {node.spread
            ? children(node, key)
            : node.children.map((c, i) =>
                c.type === 'paragraph' ? (
                  <Fragment key={`${key}.${i}`}>{children(c, `${key}.${i}`)}</Fragment>
                ) : (
                  render(c as Nodes, `${key}.${i}`)
                )
              )}
        </li>
      )
    case 'link':
      return (
        <a
          key={key}
          href={node.url}
          title={node.url}
          onClick={(e) => {
            e.preventDefault()
            openLink(node.url)
          }}
        >
          {children(node, key)}
        </a>
      )
    case 'image':
      return <Fragment key={key}>{node.alt ?? ''}</Fragment>
    case 'table':
      return (
        <table key={key}>
          <tbody>
            {node.children.map((row, r) => (
              <tr key={`${key}.${r}`}>
                {row.children.map((cell, c) => {
                  const Cell = r === 0 ? 'th' : 'td'
                  return <Cell key={`${key}.${r}.${c}`}>{children(cell, `${key}.${r}.${c}`)}</Cell>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'html':
      return <Fragment key={key}>{node.value}</Fragment>
    default:
      return 'children' in node ? <Fragment key={key}>{children(node as Parents, key)}</Fragment> : null
  }
}

export function CommitMessage({ text }: { text: string }): React.JSX.Element | null {
  const tree = useMemo(
    () => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
    [text]
  )
  if (!text.trim()) return null
  return (
    <div className={styles.message} data-testid="commit-message">
      {tree.children.map((c: RootContent, i) => render(c as Nodes, `m${i}`))}
    </div>
  )
}
