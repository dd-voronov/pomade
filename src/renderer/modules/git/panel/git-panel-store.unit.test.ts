import { describe, expect, it } from 'vitest'

import { branchStamp, useGitPanelStore } from './git-panel-store'

const at = { head: 'a'.repeat(40), upstream: 'origin/main', ahead: 1, behind: 0 }

describe('branchStamp', () => {
  it('is null before the first commit', () => {
    expect(branchStamp({ ...at, head: null })).toBeNull()
  })

  it('changes on a commit, a push, a fetch and a new upstream — each reloads History and Not pushed', () => {
    const base = branchStamp(at)
    expect(branchStamp({ ...at, head: 'b'.repeat(40) })).not.toBe(base)
    expect(branchStamp({ ...at, ahead: 0 })).not.toBe(base)
    expect(branchStamp({ ...at, behind: 2 })).not.toBe(base)
    expect(branchStamp({ ...at, upstream: null, ahead: 0 })).not.toBe(branchStamp({ ...at, ahead: 0 }))
    expect(branchStamp({ ...at })).toBe(base)
  })
})

describe('revealRepo (T-320)', () => {
  it('a drill into another repo goes back to the list; a drill into the revealed repo stays; one request at a time', () => {
    const store = useGitPanelStore.getState()
    store.drill('p1', 'Repos/a')
    store.drill('p2', 'Repos/b')
    store.revealRepo('p1', 'Repos/c')
    store.revealRepo('p2', 'Repos/b')
    const s = useGitPanelStore.getState()
    expect(s.drillByProject).toMatchObject({ p1: undefined, p2: 'Repos/b' })
    expect(s.revealRequest).toMatchObject({ projectId: 'p2', root: 'Repos/b' })
  })

  it('consumeReveal clears only the request it names; a repeat request gets a new nonce', () => {
    const store = useGitPanelStore.getState()
    store.revealRepo('p1', 'Repos/c')
    const first = useGitPanelStore.getState().revealRequest!
    store.revealRepo('p1', 'Repos/c')
    const second = useGitPanelStore.getState().revealRequest!
    expect(second.nonce).not.toBe(first.nonce)
    store.consumeReveal(first.nonce)
    expect(useGitPanelStore.getState().revealRequest).toBe(second)
    store.consumeReveal(second.nonce)
    expect(useGitPanelStore.getState().revealRequest).toBeNull()
  })
})
