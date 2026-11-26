// Pomade's design tokens for apps (docs/HOST-API.md §5 "Theme and design tokens"): pomade-kit ships
// `pomade-kit/tokens.css`, generated here from Pomade's `src/renderer/tokens.css` — the one
// source. The kit's copy keeps every rule and declaration in order, without comments, under a
// header saying where it comes from. `src/main/kit-tokens-script.unit.test.ts` fails while the
// pinned kit's copy differs from what this generates.
//
// Usage:
//   node scripts/kit-tokens.mjs --kit <pomade-kit folder>   write <kit>/src/tokens/tokens.css
//   node scripts/kit-tokens.mjs --print [--source <file>]   print the kit's copy to stdout
// The source must be flat rules (`selector { --name: value; … }`): an at-rule, a nested rule or
// stray text fails the run.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'src/renderer/tokens.css')

/** Where the copy lives in the kit's source tree. */
export const KIT_TOKENS_PATH = 'src/tokens/tokens.css'

const HEADER = `/* Pomade's design tokens (pomade-kit/tokens.css). Generated from Pomade's src/renderer/tokens.css
   by its scripts/kit-tokens.mjs — never edit by hand. Each theme is keyed by \`data-theme\` on the
   root element; pomade-kit/sdk \`followTheme\` puts Pomade's theme there. */
`

/** @param {string} css the source tokens */
export function kitTokens(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  let rest = text
  const RULE = /^\s*([^{}@;]+?)\s*\{([^{}]*)\}/
  for (let m = RULE.exec(rest); m; m = RULE.exec(rest)) {
    const decls = m[2]
      .split(';')
      .map((d) => d.trim().replace(/\s+/g, ' '))
      .filter((d) => d !== '')
    for (const d of decls) if (!/^(--)?[a-zA-Z][\w-]*\s*:\s*\S/.test(d)) throw new Error(`kit-tokens: not a declaration: ${d}`)
    rules.push(`${m[1].replace(/\s+/g, ' ')} {\n${decls.map((d) => `  ${d};`).join('\n')}\n}\n`)
    rest = rest.slice(m[0].length)
  }
  if (rest.trim() !== '') throw new Error(`kit-tokens: not a flat token rule: ${rest.trim().slice(0, 60)}`)
  if (rules.length === 0) throw new Error('kit-tokens: no rules')
  return `${HEADER}\n${rules.join('\n')}`
}

async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  const source = flag('--source') ? resolve(flag('--source')) : SOURCE
  const out = kitTokens(await readFile(source, 'utf8'))
  const kit = flag('--kit')
  if (kit) {
    const target = join(resolve(kit), KIT_TOKENS_PATH)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, out)
    console.log(`kit-tokens: wrote ${target}`)
  } else if (argv.includes('--print')) {
    process.stdout.write(out)
  } else {
    throw new Error('usage: kit-tokens.mjs --kit <pomade-kit folder> | --print [--source <file>]')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
