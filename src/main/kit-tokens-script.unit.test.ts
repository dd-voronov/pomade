// scripts/kit-tokens.mjs: Pomade's design tokens (src/renderer/tokens.css) are the one source of
// pomade-kit's `pomade-kit/tokens.css`. The drift check: the pinned kit ships exactly what the
// source generates — after a change to tokens.css, regenerate the kit's copy
// (`node scripts/kit-tokens.mjs --kit <pomade-kit>`) and move the kit pin.

import { execFileSync, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, '../../scripts/kit-tokens.mjs')
const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

function print(source?: string): string {
  return execFileSync(process.execPath, [SCRIPT, '--print', ...(source ? ['--source', source] : [])], { encoding: 'utf8' })
}

async function sourceFile(css: string): Promise<string> {
  const dir = await tempDir('kit-tokens-')
  const file = join(dir, 'tokens.css')
  await fs.writeFile(file, css)
  return file
}

describe('kit-tokens', () => {
  it("the pinned pomade-kit ships exactly the tokens Pomade's tokens.css generates", async () => {
    const shipped = await fs.readFile(createRequire(__filename).resolve('pomade-kit/tokens.css'), 'utf8')
    expect(shipped).toBe(print())
  })

  it('keeps every rule and declaration in order, without comments, under the generated header', async () => {
    const out = print(
      await sourceFile(`/* top */\n:root {\n  /* a */\n  color-scheme: light;\n  --a: #fff; /* tail */\n  --font: -apple-system,\n    "SF Pro";\n}\n\n:root[data-theme="dark"] { --a: #000 }\n`)
    )
    expect(out).toMatch(/^\/\* Pomade's design tokens \(pomade-kit\/tokens\.css\)\. Generated from Pomade's src\/renderer\/tokens\.css/)
    expect(out.slice(out.indexOf('*/') + 2)).toBe(
      `\n\n:root {\n  color-scheme: light;\n  --a: #fff;\n  --font: -apple-system, "SF Pro";\n}\n\n:root[data-theme="dark"] {\n  --a: #000;\n}\n`
    )
  })

  it.each([
    ['an at-rule', '@media (prefers-color-scheme: dark) { :root { --a: #000; } }'],
    ['stray text', ':root { --a: #fff; } oops'],
    ['a rule without declarations syntax', ':root { not a declaration }'],
    ['no rules', '/* only a comment */']
  ])('refuses %s', async (_label, css) => {
    const r = spawnSync(process.execPath, [SCRIPT, '--print', '--source', await sourceFile(css)], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/^kit-tokens: /)
  })

  it('--kit writes src/tokens/tokens.css in the kit folder', async () => {
    const kit = await tempDir('kit-tokens-kit-')
    execFileSync(process.execPath, [SCRIPT, '--kit', kit], { encoding: 'utf8' })
    expect(await fs.readFile(join(kit, 'src/tokens/tokens.css'), 'utf8')).toBe(print())
  })
})
