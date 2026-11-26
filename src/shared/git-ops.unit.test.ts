import { describe, expect, it } from 'vitest'

import { GIT_GLOSSARY, glossaryLines } from './git-glossary'
import {
  classifyGitError,
  discardLine,
  lastGitLine,
  previewSentence,
  remoteHost,
  remoteUrlProblem,
  segText,
  skipLine,
  GIT_OP_TITLE,
  opTitle,
  type CommitPushPreview,
  type ErrorContext,
  type GitOpPreview,
  type PushTarget,
  type UndoPreview
} from './git-ops'

const gh = (url: string): ErrorContext => ({ action: 'push', host: remoteHost(url), url })

describe('remoteHost', () => {
  it('names GitHub and GitLab over https and ssh', () => {
    expect(remoteHost('https://github.com/dd-voronov/pomade.git')).toMatchObject({ kind: 'github', name: 'GitHub', ssh: false })
    expect(remoteHost('git@github.com:dd-voronov/pomade.git')).toMatchObject({ kind: 'github', ssh: true, sshTarget: 'git@github.com' })
    expect(remoteHost('ssh://git@gitlab.com:22/a/b.git')).toMatchObject({ kind: 'gitlab', ssh: true, sshTarget: 'git@gitlab.com' })
    expect(remoteHost('https://gitlab.example.org/a/b')).toMatchObject({ kind: 'gitlab', name: 'GitLab' })
  })
  it('names any other host by its name, a path as local', () => {
    expect(remoteHost('https://git.example.com/a/b.git')).toMatchObject({ kind: 'other', name: 'git.example.com' })
    expect(remoteHost('/tmp/pomade-remote-x')).toMatchObject({ kind: 'local', name: 'the remote' })
    expect(remoteHost('file:///tmp/x.git')).toMatchObject({ kind: 'local' })
    expect(remoteHost('../sibling.git')).toMatchObject({ kind: 'local' })
  })
})

describe('classifyGitError', () => {
  it('GitHub over ssh: the real publickey refusal → plain words + ssh -T', () => {
    const text =
      'git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n'
    const f = classifyGitError(text, gh('git@github.com:dd-voronov/x.git'))
    expect(f.kind).toBe('auth')
    expect(f.message).toBe('GitHub refused the push — your SSH key was not accepted. Check it with `ssh -T git@github.com` in a terminal.')
    expect(f.copy).toBe('ssh -T git@github.com')
    expect(f.detail).toBe('fatal: Could not read from remote repository.')
  })
  it('GitHub over https with prompts disabled → gh auth login', () => {
    const text = "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"
    const f = classifyGitError(text, gh('https://github.com/a/b.git'))
    expect(f).toMatchObject({ kind: 'auth', copy: 'gh auth login' })
    expect(f.message).toBe('GitHub refused the push — not signed in. Run `gh auth login` in a terminal.')
  })
  it('GitLab https → glab auth login; another host → git push in a terminal', () => {
    const gl = classifyGitError("remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/a/b.git/'\n", gh('https://gitlab.com/a/b.git'))
    expect(gl).toMatchObject({ kind: 'auth', copy: 'glab auth login' })
    expect(gl.message.startsWith('GitLab refused the push — not signed in.')).toBe(true)
    const other = classifyGitError("fatal: Authentication failed for 'https://git.example.com/a.git/'\n", gh('https://git.example.com/a.git'))
    expect(other.message.startsWith('git.example.com refused the push — not signed in.')).toBe(true)
  })
  it('getting changes and checking a remote use their own verbs', () => {
    const t = 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'
    expect(classifyGitError(t, { ...gh('git@github.com:a/b'), action: 'get' }).message).toMatch(/^GitHub refused to send their changes —/)
    expect(classifyGitError(t, { ...gh('git@github.com:a/b'), action: 'check' }).message).toMatch(/^GitHub refused access —/)
  })
  it('a rejected push because the remote moved on', () => {
    const text =
      'To /tmp/remote\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\nerror: failed to push some refs to \'/tmp/remote\'\nhint: Updates were rejected because the remote contains work that you do not\n'
    const f = classifyGitError(text, gh('/tmp/remote'))
    expect(f.kind).toBe('remote-moved')
    expect(f.message).toBe('/tmp/remote has commits you don’t have yet — someone pushed in the meantime.')
    expect(classifyGitError(' ! [rejected]        main -> main (non-fast-forward)', gh('https://github.com/a/b')).kind).toBe('remote-moved')
  })
  it('a hook or protected branch refusing the push', () => {
    const f = classifyGitError('!\trefs/heads/main:refs/heads/main\t[remote rejected] (protected branch hook declined)\n', gh('https://github.com/a/b'))
    expect(f).toMatchObject({ kind: 'remote-refused', message: 'GitHub refused the push: protected branch hook declined.' })
  })
  it('a missing repository: locally plain, on GitHub with the sign-in hint', () => {
    expect(classifyGitError("fatal: '/nope' does not appear to be a git repository\n", gh('/nope')).message).toBe('There is no repository at /nope.')
    const f = classifyGitError('remote: Repository not found.\nfatal: repository \'https://github.com/a/b.git/\' not found', gh('https://github.com/a/b.git'))
    expect(f.kind).toBe('not-found')
    expect(f.copy).toBe('gh auth login')
  })
  it('network, lock and identity', () => {
    expect(classifyGitError('ssh: Could not resolve hostname github.com: nodename nor servname provided', gh('git@github.com:a/b')).kind).toBe('network')
    expect(classifyGitError("fatal: Unable to create '/r/.git/index.lock': File exists.", gh('')).kind).toBe('locked')
    const id = classifyGitError('Author identity unknown\n\n*** Please tell me who you are.\n', gh(''))
    expect(id.kind).toBe('identity')
    expect(id.copy).toContain('git config --global user.email')
  })
  it('anything else is git’s last error line', () => {
    const f = classifyGitError('hint: something\nerror: pathspec did not match\nhint: more', gh(''))
    expect(f).toMatchObject({ kind: 'other', message: 'error: pathspec did not match', copy: 'error: pathspec did not match' })
    expect(lastGitLine('one\ntwo\n')).toBe('two')
    expect(lastGitLine('')).toBe('git failed without saying why.')
  })
})

const target = (over: Partial<PushTarget> = {}): PushTarget => ({
  remote: 'origin',
  branch: 'main',
  url: 'git@github.com:dd-voronov/pomade.git',
  host: remoteHost('git@github.com:dd-voronov/pomade.git'),
  setUpstream: false,
  ...over
})
const commitPreview = (over: Partial<CommitPushPreview>): CommitPushPreview => ({
  op: 'commit-push',
  repo: 'Projects/a',
  token: 't',
  blocked: null,
  files: 5,
  branch: 'main',
  push: target(),
  pushes: true,
  pushCommits: 1,
  behind: 0,
  ...over
})

describe('previewSentence', () => {
  it('commit & push: the ticket’s sentence, host-aware', () => {
    expect(segText(previewSentence(commitPreview({})))).toBe('This will commit 5 files and push 1 commit to GitHub (origin/main).')
    expect(segText(previewSentence(commitPreview({ files: 1, pushCommits: 3 })))).toBe('This will commit 1 file and push 3 commits to GitHub (origin/main).')
    expect(segText(previewSentence(commitPreview({ push: target({ branch: 'feat', setUpstream: true }) })))).toBe(
      'This will commit 5 files and push 1 commit to GitHub (origin/feat) — a new branch there.'
    )
  })
  it('T-309: the upstream has commits this branch lacks — the push would be turned down', () => {
    expect(segText(previewSentence(commitPreview({ files: 2, behind: 1 })))).toBe(
      'This will commit 2 files. origin/main has 1 commit you don’t have yet, so the push will be turned down — the commit stays here until you get their changes.'
    )
  })
  it('T-309: nothing to commit and the upstream ahead — the commits wait', () => {
    expect(segText(previewSentence(commitPreview({ files: 0, pushCommits: 1, behind: 1 })))).toBe(
      'Nothing to commit — your 1 unpushed commit waits here until you get their changes.'
    )
  })
  it('T-308: get their changes, then push — a conflict opens the conflict tab', () => {
    expect(segText(previewSentence({ op: 'sync-push', repo: 'Projects/a', token: 't', blocked: null, push: target(), local: 2 }))).toBe(
      'This will get the new commits from GitHub (origin/main), put your 2 unpushed commits on top of them (rebase), then push. If their changes conflict with yours, a conflict tab opens: combine them there, then it pushes — or abort, back to before.'
    )
  })
  it('local only: the commit stays on this Mac', () => {
    expect(segText(previewSentence(commitPreview({ push: null, pushes: false, files: 2 })))).toBe('This will commit 2 files. No remote — the commit stays on this Mac.')
  })
  it('commit only, with a remote: nothing is pushed', () => {
    const segs = previewSentence(commitPreview({ pushes: false, files: 2, pushCommits: 3 }))
    expect(segText(segs)).toBe('This will commit 2 files. Nothing is pushed — the commit stays on this Mac until you push.')
    expect(segs.flatMap((s) => (typeof s === 'string' ? [] : [s.term]))).toEqual(['commit', 'push'])
  })
  it('the title names whether a commit pushes', () => {
    expect(opTitle({ op: 'commit-push' })).toBe('Commit & push')
    expect(opTitle({ op: 'commit-push', push: false })).toBe('Commit')
    expect(opTitle({ op: 'commit-staged' })).toBe('Commit staged')
    expect(opTitle({ op: 'commit-staged', push: true })).toBe('Commit staged & push')
    expect(opTitle({ op: 'fetch' })).toBe('Fetch')
  })
  it('nothing to commit, commits to push', () => {
    expect(segText(previewSentence(commitPreview({ files: 0, pushCommits: 2 })))).toBe('This will push 2 commits to GitHub (origin/main).')
  })
  it('marks glossary terms', () => {
    const terms = previewSentence(commitPreview({})).flatMap((s) => (typeof s === 'string' ? [] : [s.term]))
    expect(terms).toEqual(['commit', 'push', 'upstream'])
  })
  it('undo says which behaviour', () => {
    const base: UndoPreview = {
      op: 'undo-commit',
      repo: '',
      token: 't',
      blocked: null,
      mode: 'undo',
      commit: { hash: 'a'.repeat(40), subject: 'Fix typo' },
      merge: false,
      push: target()
    }
    expect(segText(previewSentence(base))).toBe('Not pushed yet — this takes back “Fix typo”: the commit goes away and its changes are back as uncommitted.')
    expect(segText(previewSentence({ ...base, mode: 'revert' }))).toBe(
      'Already on GitHub — this adds a commit that cancels “Fix typo” (revert) and pushes it. Nothing is rewritten.'
    )
    expect(segText(previewSentence({ ...base, mode: 'revert', merge: true }))).toContain('cancels the merge “Fix typo” (against its first parent)')
  })
})

describe('previewSentence — the operator layer (E-040)', () => {
  const push: PushTarget = { remote: 'origin', branch: 'feature', url: 'git@github.com:a/b.git', host: remoteHost('git@github.com:a/b.git'), setUpstream: true }
  const base = { repo: 'p', token: 't', blocked: null }
  const say = (p: GitOpPreview): string => segText(previewSentence(p))
  it('stage and unstage name the file', () => {
    expect(say({ ...base, op: 'stage', paths: ['p/README.md'] })).toBe('This will stage README.md — it goes into the next commit; the rest stays as it is.')
    expect(say({ ...base, op: 'unstage', paths: ['p/a.md', 'p/b.md'] })).toBe('This will unstage 2 files — they stay changed on disk, just not in the next commit.')
  })
  it('commit staged says what stays uncommitted and that nothing is pushed', () => {
    const staged = { ...base, op: 'commit-staged' as const, branch: 'main', push, pushes: false, pushCommits: 1 }
    expect(say({ ...staged, staged: ['p/README.md'], others: 1 })).toBe(
      'This will commit the staged file (README.md). 1 other change stays uncommitted; nothing is pushed.'
    )
    expect(say({ ...staged, staged: ['p/a.md', 'p/b.md'], others: 0, push: null })).toBe('This will commit the 2 staged files. Nothing is pushed.')
  })
  it('commit staged & push says where the commits go', () => {
    const staged = { ...base, op: 'commit-staged' as const, branch: 'main', push: target(), pushes: true, pushCommits: 2 }
    expect(say({ ...staged, staged: ['p/README.md'], others: 1 })).toBe(
      'This will commit the staged file (README.md) and push 2 commits to GitHub (origin/main). 1 other change stays uncommitted.'
    )
    expect(say({ ...staged, staged: ['p/a.md', 'p/b.md'], others: 0, push, pushCommits: 1 })).toBe(
      'This will commit the 2 staged files and push 1 commit to GitHub (origin/feature) — a new branch there.'
    )
  })
  it('branches: create carries the changes along, switch says what changes', () => {
    expect(say({ ...base, op: 'create-branch', name: 'fix/typo', from: 'main', at: 'abc1234', carried: 2 })).toBe(
      'This will create the branch “fix/typo” from main (abc1234) and switch to it. Your 2 uncommitted changes come along.'
    )
    const sw = { ...base, op: 'switch-branch' as const, branches: [], conflicts: [], carried: 0 }
    expect(say({ ...sw, branch: 'feature', local: null })).toBe('This will switch to “feature”: the files change to that branch’s version.')
    expect(say({ ...sw, branch: 'origin/feature', local: 'feature', carried: 1 })).toBe(
      'This will make a local “feature” from origin/feature (it follows it) and switch to it: the files change to that branch’s version. Your 1 uncommitted change comes along.'
    )
  })
  it('fetch, pull, publish name the remote', () => {
    expect(say({ ...base, op: 'fetch', remote: 'origin', url: push.url, host: push.host })).toBe(
      'This will look at GitHub (origin) and note its new commits, without changing your files (fetch).'
    )
    const up = { ...push, branch: 'main', setUpstream: false }
    expect(say({ ...base, op: 'pull', push: up, local: 0 })).toBe('This will get the new commits from GitHub (origin/main) into your branch (pull).')
    expect(say({ ...base, op: 'pull', push: up, local: 2 })).toBe(
      'This will get the new commits from GitHub (origin/main) and put your 2 unpushed commits on top of them (rebase). If their changes conflict with yours, a conflict tab opens: combine them there, or abort, back to before.'
    )
    expect(say({ ...base, op: 'publish', push, commits: 1 })).toBe(
      'This will publish the branch “feature” to GitHub as origin/feature — 1 commit goes there — and the branch follows it from now on.'
    )
  })
  it('rebase, resolve, continue, abort', () => {
    expect(say({ ...base, op: 'rebase', onto: 'main', target: 'main', branch: 'feature', theirs: 2, mine: 1 })).toMatch(
      /^This will put your 1 commit on top of main’s 2 newer commits \(rebase\)\. If their changes conflict/
    )
    expect(say({ ...base, op: 'resolve-file', path: 'p/a.md', others: [], stopped: 'rebase', pushes: null })).toBe('This will save the result as a.md, mark it resolved, then continue the rebase.')
    expect(say({ ...base, op: 'resolve-file', path: 'p/a.md', others: [], stopped: 'rebase', pushes: 'origin/main' })).toBe(
      'This will save the result as a.md, mark it resolved, then continue the rebase. Once it finishes, your commits are pushed to origin/main.'
    )
    expect(say({ ...base, op: 'resolve-file', path: 'p/a.md', others: ['p/b.md'], stopped: 'rebase', pushes: null })).toBe(
      'This will save the result as a.md and mark it resolved — 1 more file to resolve before the rebase goes on.'
    )
    const cont = { ...base, op: 'rebase-continue' as const, conflicts: [], commit: { hash: 'h', subject: 'Fix typo' }, pushes: null }
    expect(say({ ...cont, remaining: 1, empty: false })).toBe(
      'This will make your commit “Fix typo” with the combined files and continue the rebase, then 1 more commit is replayed.'
    )
    expect(say({ ...cont, remaining: 0, empty: true })).toBe('Combined, your commit “Fix typo” changes nothing — it is left out, and the rebase goes on.')
    expect(say({ ...cont, remaining: 0, empty: false, pushes: 'origin/main' })).toBe(
      'This will make your commit “Fix typo” with the combined files and continue the rebase. Once it finishes, your commits are pushed to origin/main.'
    )
    expect(say({ ...base, op: 'rebase-abort', branch: 'feature', before: 'abc1234', recorded: true })).toBe(
      'This puts everything back exactly as before the rebase: “feature” at abc1234, your files as they were (abort). Pomade checks it afterwards.'
    )
  })
  it('E-041: worktree, merge into main, finish / abort, remove, rebase a branch', () => {
    expect(say({ ...base, op: 'worktree-add', branch: 'origin/fix', local: 'fix', path: '/w/alpha/fix' })).toBe(
      'This will make a local “fix” from origin/fix (it follows it) and check it out in a new worktree folder, /w/alpha/fix. This checkout stays exactly as it is.'
    )
    expect(say({ ...base, op: 'worktree-add', branch: 'feature', local: null, path: '/w/alpha/feature' })).toBe(
      'This will check out “feature” in a new worktree folder, /w/alpha/feature. This checkout stays exactly as it is.'
    )
    const merge = { ...base, op: 'merge-branch' as const, branch: 'feature', into: 'main', commits: 4, subjects: [], files: 2, worktree: null, agents: [] }
    expect(say({ ...merge, mode: 'squash' })).toMatch(/^This lands 4 commits from “feature” as 1 commit on main \(squash merge\)\. If its changes conflict with main’s, a conflict tab opens/)
    expect(say({ ...merge, mode: 'merge' })).toMatch(/^This lands 4 commits from “feature” on main with a merge commit that keeps them\./)
    expect(say({ ...base, op: 'resolve-file', path: 'p/a.md', others: [], stopped: 'merge', pushes: null })).toBe('This will save the result as a.md, mark it resolved, then commit the merge.')
    expect(say({ ...base, op: 'merge-continue', branch: 'feature', mode: 'squash', conflicts: [] })).toBe(
      'This will commit the combined files: “feature” lands as 1 commit (squash merge).'
    )
    expect(say({ ...base, op: 'merge-abort', branch: 'feature', recorded: true })).toBe(
      'This puts everything back exactly as before the merge: main and your files as they were (abort). Pomade checks it afterwards.'
    )
    const remove = { ...base, op: 'remove-landed' as const, branch: 'feature', worktree: '/w/alpha/feature', remoteStays: 'origin/feature', remoteWhere: 'GitHub' }
    expect(say({ ...remove, landed: { by: 'squash', commit: 'abc1234' } })).toBe(
      '“feature” is in main (landed as abc1234). This removes the branch and its worktree folder /w/alpha/feature. origin/feature stays on GitHub.'
    )
    expect(say({ ...remove, landed: null })).toBe('“feature” has not landed on main — it stays.')
    expect(say({ ...base, op: 'rebase-branch', branch: 'feature', target: 'main', theirs: 2, mine: 1, worktree: null })).toBe(
      'This will put “feature”’s 1 commit on top of main’s 2 newer commits (rebase), in a temporary folder — this checkout is untouched. If their changes conflict with its own, nothing changes.'
    )
  })
  it('every operation has a title', () => {
    for (const t of Object.values(GIT_OP_TITLE)) expect(t.length).toBeGreaterThan(0)
  })
})

describe('discard lines and remote addresses', () => {
  it('words each file', () => {
    expect(discardLine({ path: 'a/notes.md', action: 'restore' })).toBe('notes.md — back to the last commit')
    expect(discardLine({ path: 'draft.md', action: 'delete', staged: true })).toBe('draft.md — new, deleted (its staged version is kept too)')
    expect(discardLine({ path: 'keep.md', action: 'bring-back' })).toBe('keep.md — deleted, comes back')
    expect(discardLine({ path: 'x/new.md', action: 'unrename', from: 'x/old.md' })).toBe('new.md — renamed back to old.md')
    expect(skipLine({ path: 'img/photo.png', reason: 'binary' })).toMatch(/^photo\.png — stays: binary/)
  })
  it('refuses option-like or spaced addresses', () => {
    expect(remoteUrlProblem('')).not.toBeNull()
    expect(remoteUrlProblem('--upload-pack=evil')).not.toBeNull()
    expect(remoteUrlProblem('git@github.com:a/b c')).not.toBeNull()
    expect(remoteUrlProblem(' git@github.com:a/b.git ')).toBeNull()
  })
})

describe('glossary', () => {
  it('every term has a line and an example', () => {
    for (const [term, e] of Object.entries(GIT_GLOSSARY)) {
      expect(e.line.length, term).toBeGreaterThan(10)
      expect(e.example.startsWith('e.g. '), term).toBe(true)
    }
    expect(glossaryLines('push')).toHaveLength(2)
  })
})
