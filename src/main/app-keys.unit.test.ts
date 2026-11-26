import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appKeyFile, ensureAppKey, keysMatch, readAppKey, removeAppKey } from './app-keys'

let ud: string
beforeEach(async () => {
  ud = await mkdtemp(join(tmpdir(), 'pomade-keys-'))
})
afterEach(async () => {
  await rm(ud, { recursive: true, force: true })
})

describe('app keys', () => {
  it('issues a 64-hex key once, readable only by the user, in a 0700 folder', async () => {
    const key = await ensureAppKey(ud, 'pomade-agents')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(await ensureAppKey(ud, 'pomade-agents')).toBe(key)
    expect(await readAppKey(ud, 'pomade-agents')).toBe(key)
    expect((await stat(appKeyFile(ud, 'pomade-agents'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(ud, 'app-keys'))).mode & 0o777).toBe(0o700)
    expect(await readFile(appKeyFile(ud, 'pomade-agents'), 'utf8')).toBe(`${key}\n`)
  })

  it('every app gets its own key', async () => {
    const a = await ensureAppKey(ud, 'a1')
    const b = await ensureAppKey(ud, 'b1')
    expect(a).not.toBe(b)
  })

  it('two issuers at once agree on one key', async () => {
    const keys = await Promise.all(Array.from({ length: 8 }, () => ensureAppKey(ud, 'racer')))
    expect(new Set(keys).size).toBe(1)
    expect(await readAppKey(ud, 'racer')).toBe(keys[0])
  })

  it('keeps a key written by someone else; an empty file is re-issued', async () => {
    await ensureAppKey(ud, 'x1')
    await writeFile(appKeyFile(ud, 'x1'), 'handmade\n')
    expect(await ensureAppKey(ud, 'x1')).toBe('handmade')
    await writeFile(appKeyFile(ud, 'x1'), '')
    expect(await readAppKey(ud, 'x1')).toBeNull()
    const reissued = await ensureAppKey(ud, 'x1')
    expect(reissued).toMatch(/^[0-9a-f]{64}$/)
    expect(await readAppKey(ud, 'x1')).toBe(reissued)
  })

  it('remove revokes; reading a missing key is null', async () => {
    await ensureAppKey(ud, 'gone')
    await removeAppKey(ud, 'gone')
    expect(await readAppKey(ud, 'gone')).toBeNull()
    await removeAppKey(ud, 'gone')
    expect(await readAppKey(ud, 'never')).toBeNull()
  })

  it('keysMatch compares exactly', () => {
    expect(keysMatch('abc', 'abc')).toBe(true)
    expect(keysMatch('abc', 'abd')).toBe(false)
    expect(keysMatch('abc', 'abcd')).toBe(false)
    expect(keysMatch('', 'a')).toBe(false)
  })
})
