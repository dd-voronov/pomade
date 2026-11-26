// T-297 — the burst count of local history sees changes of content only. The service runs for real
// (real files, the real store in the temp workspace); only its Electron and workspace plumbing is stubbed.

import { mkdtempSync, promises as fsp, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  process.env['POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS'] = '5'
  process.env['POMADE_TEST_LOCAL_HISTORY_MAX_WAIT_MS'] = '50'
  return {
    root: '',
    userData: '',
    onChange: null as ((c: { path: string }) => void) | null
  }
})

vi.mock('electron', () => ({ app: { getPath: () => h.userData, isPackaged: false } }))
vi.mock('./config-store', () => ({
  configStore: { getRoot: () => h.root, getAppSettings: () => Promise.resolve({}) },
  onAppSettingsChanged: () => undefined,
  onWorkspaceReady: () => undefined,
  onWorkspaceTeardown: () => undefined
}))
vi.mock('./doc-watch', () => ({ isDocOpen: () => false }))
vi.mock('./fs-watch', () => ({
  holdAppWatch: () => 'k',
  releaseAppWatch: () => undefined,
  tapWorkspaceChanges: (fn: (c: { path: string }) => void) => {
    h.onChange = fn
    return () => undefined
  }
}))
vi.mock('./git-state', () => ({ GIT_READ_ENV: {} }))
vi.mock('./ipc', () => ({ defineHandler: () => undefined }))
vi.mock('./windows', () => ({ safeBroadcast: () => undefined }))
vi.mock('./ws-path', () => ({ abs: (rel: string) => join(h.root, rel), requireRoot: () => h.root }))

import { STREAMING_BURSTS } from '@shared/local-history'
import { LocalHistoryStore } from './local-history-store'
import { startLocalHistory, stopLocalHistory } from './local-history'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const reads = vi.spyOn(fsp, 'readFile')

/** Write `text` at a fresh mtime and wait until the path's job has read it (a streaming file is
 *  never read: the wait gives up), then let the job's store write land. */
async function write(rel: string, text: string, n: number): Promise<void> {
  const file = join(h.root, rel)
  await fsp.writeFile(file, text)
  const t = new Date(1_700_000_000_000 + n * 1000)
  await fsp.utimes(file, t, t)
  const before = reads.mock.calls.filter((c) => c[0] === file).length
  h.onChange?.({ path: rel })
  const deadline = Date.now() + 400
  while (reads.mock.calls.filter((c) => c[0] === file).length === before && Date.now() < deadline) await sleep(5)
  await sleep(40)
}

const versions = (rel: string): Promise<number> =>
  new LocalHistoryStore({ dir: join(h.root, 'Apps/Pomade/dev/local-history'), capBytes: 1 << 30 })
    .list(rel)
    .then((l) => l.length)

describe('local history — the burst count (T-297)', () => {
  beforeAll(() => {
    h.root = mkdtempSync(join(tmpdir(), 't297-ws-'))
    h.userData = mkdtempSync(join(tmpdir(), 't297-ud-'))
    startLocalHistory()
  })
  afterAll(() => {
    stopLocalHistory()
    rmSync(h.root, { recursive: true, force: true })
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('touches with the same content never make a file streaming; a later real change is kept', async () => {
    await write('same.ts', 'one\n', 0)
    for (let i = 1; i <= STREAMING_BURSTS * 2; i++) await write('same.ts', 'one\n', i)
    expect(await versions('same.ts')).toBe(1)
    await write('same.ts', 'two\n', 100)
    await vi.waitFor(async () => expect(await versions('same.ts')).toBe(2))
  }, 30_000)

  it('real changes make a file streaming after the threshold', async () => {
    for (let i = 1; i <= STREAMING_BURSTS + 3; i++) await write('real.ts', `v${i}\n`, i)
    await vi.waitFor(async () => expect(await versions('real.ts')).toBe(STREAMING_BURSTS))
  }, 30_000)
})
