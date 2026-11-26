import { describe, expect, it } from 'vitest'

import type { Project } from '@shared/types'
import { upgradeProject } from './project-upgrade'

const base: Project = { id: 'p1', name: 'Alpha', rootPath: 'alpha', visibleAgents: ['*'], order: 0 }

describe('upgradeProject', () => {
  it('reads an old-only coverImage as image', () => {
    expect(upgradeProject({ ...base, coverImage: '.pomade/assets/a.png' } as Project)).toEqual({
      ...base,
      image: '.pomade/assets/a.png'
    })
  })

  it('leaves a new-only image as it is', () => {
    expect(upgradeProject({ ...base, image: '.pomade/assets/a.png' })).toEqual({
      ...base,
      image: '.pomade/assets/a.png'
    })
  })

  it('keeps image over coverImage when both are set, and drops coverImage', () => {
    const out = upgradeProject({ ...base, image: 'new.png', coverImage: 'old.png' } as Project)
    expect(out).toEqual({ ...base, image: 'new.png' })
    expect('coverImage' in out).toBe(false)
  })

  it('leaves a project with no image alone', () => {
    expect(upgradeProject(base)).toEqual(base)
  })
})
