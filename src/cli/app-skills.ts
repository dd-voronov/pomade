// Pomade — E-027 app-shipped agent skills (docs/HOST-API.md §1 `skills`, §2). An app ships agent
// skills as folders in its build, each holding a SKILL.md. Pomade links them nowhere: `pomade apps
// install` (and `link` for a build folder) checks they exist and reports where each one is, so the
// user can give it to an agent by copying or linking the folder. Runs under plain Node with the CLI
// (erasable TypeScript, explicit `.ts` imports).

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import type { AppManifest } from '../shared/app-manifest.ts'

const SKILL_FILE = 'SKILL.md'

/** The manifest's skill folders that hold no SKILL.md in `buildDir`. */
export async function missingSkills(manifest: AppManifest, buildDir: string): Promise<string[]> {
  const missing: string[] = []
  for (const s of manifest.skills) {
    try {
      await fs.access(join(buildDir, s.path, SKILL_FILE))
    } catch {
      missing.push(s.path)
    }
  }
  return missing
}

/** One line per shipped skill: where its folder is in the build at `buildDir`, and how to give it
 *  to an agent. */
export function skillLines(manifest: AppManifest, buildDir: string): string[] {
  return manifest.skills.map(
    (s) =>
      `Skill ${s.name} is at ${join(buildDir, s.path)}. To give it to an agent, copy or link this folder into the agent's skills folder.`
  )
}
