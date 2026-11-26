// Pomade — a project record read from workspace.json. A project's icon image was once stored as
// `coverImage`; a workspace.json that still holds it is read through `upgradeProject`, so the
// image survives, and the next save writes only `image`.

import type { Project } from '@shared/types'

/** The stored project under the current keys: `coverImage` moves to `image` unless `image` is
 *  already set; `coverImage` never comes back out. */
export function upgradeProject(stored: Project): Project {
  if (!('coverImage' in stored)) return stored
  const { coverImage, ...rest } = stored as Project & { coverImage?: string }
  return rest.image === undefined && coverImage !== undefined ? { ...rest, image: coverImage } : rest
}
