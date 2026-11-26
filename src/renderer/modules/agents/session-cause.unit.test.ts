// T-327 — why an agent tab's session changed: the cause derived from what opened the bind window
// and the new transcript's record of its parent, and the noted cause handed to the event diff.

import { describe, expect, it } from 'vitest'

import { bindCause, forgetSessionCause, noteSessionCause, sessionChange, takeSessionCause } from './session-cause'

describe('bindCause', () => {
  it('a fresh launch binds the tab\'s first session', () => {
    expect(bindCause('launch', null, false)).toBe('first')
    // A launch (no resume) in a tab that held a session before: still that launch's first session.
    expect(bindCause('launch', null, true)).toBe('first')
  })

  it('a clear command: clear; a fork command: fork', () => {
    expect(bindCause('clear', null, true)).toBe('clear')
    expect(bindCause('fork', null, true)).toBe('fork')
    // claude `/branch` and codex `/fork` transcripts name their parent too — same verdict.
    expect(bindCause('fork', 'parent', true)).toBe('fork')
  })

  it('a transcript that records a parent is a fork, whatever opened the window', () => {
    expect(bindCause('launch', 'parent', false)).toBe('fork')
    expect(bindCause('clear', 'parent', true)).toBe('fork')
    expect(bindCause('retry', 'parent', true)).toBe('fork')
  })

  it('an in-session /resume adopts an existing session: resume, even of a fork', () => {
    expect(bindCause('resume', null, true)).toBe('resume')
    expect(bindCause('resume', 'parent', true)).toBe('resume')
  })

  it('a retry: first while the tab never had a session, else unknown', () => {
    expect(bindCause('retry', null, false)).toBe('first')
    expect(bindCause('retry', null, true)).toBe('unknown')
  })
})

describe('sessionChange', () => {
  it('the noted cause and the previous session; unknown when none was noted or the tab holds none', () => {
    expect(sessionChange('s1', 's2', 'fork')).toEqual({ cause: 'fork', previousSessionId: 's1' })
    expect(sessionChange(null, 's1', 'first')).toEqual({ cause: 'first', previousSessionId: null })
    expect(sessionChange('s1', 's2', undefined)).toEqual({ cause: 'unknown', previousSessionId: 's1' })
    expect(sessionChange('s1', null, 'clear')).toEqual({ cause: 'unknown', previousSessionId: 's1' })
  })
})

describe('noted causes', () => {
  it('are taken once, and only for the session they explain', () => {
    noteSessionCause('t1', 's2', 'clear')
    expect(takeSessionCause('t1', 's2')).toBe('clear')
    expect(takeSessionCause('t1', 's2')).toBeUndefined()
    noteSessionCause('t1', 's3', 'fork')
    expect(takeSessionCause('t1', 's4')).toBeUndefined()
    expect(takeSessionCause('t1', 's3')).toBeUndefined()
    noteSessionCause('t1', 's5', 'resume')
    forgetSessionCause('t1')
    expect(takeSessionCause('t1', 's5')).toBeUndefined()
  })
})
