// Pomade e2e — fixture workspace builder.
// Creates a throwaway workspace tree plus a separate userData dir,
// and seeds .pomade/workspace.json with two real projects so the Projects panel offers a
// project switch for the "hidden, never unmounted" invariant test.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './temp'

export interface Fixture {
  workspaceRoot: string
  userDataDir: string
  projects: { alpha: string; beta: string }
  cleanup: () => Promise<void>
}

const ALPHA_ID = 'proj-alpha'
const BETA_ID = 'proj-beta'

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

export async function createFixtureWorkspace(): Promise<Fixture> {
  const workspaceRoot = await tempDir('pomade-ws-')
  const userDataDir = await tempDir('pomade-ud-')

  // Project / app folders with a few files each.
  await write(join(workspaceRoot, 'Projects/alpha/README.md'), '# Alpha\n\nAlpha project.\n')
  await write(join(workspaceRoot, 'Projects/alpha/notes.txt'), 'alpha notes\n')
  await write(join(workspaceRoot, 'Projects/beta/README.md'), '# Beta\n\nBeta project.\n')
  await write(join(workspaceRoot, 'Projects/beta/data.csv'), 'a,b,c\n1,2,3\n4,5,6\n')
  await write(join(workspaceRoot, 'Apps/gamma/README.md'), '# Gamma\n\nGamma app.\n')

  // An agent folder (built-ins aside) for later waves.
  await write(
    join(workspaceRoot, 'Agents/claude-test/CLAUDE.md'),
    '# claude-test\n\nTest agent identity.\n'
  )

  // A template folder for "create project from template".
  await write(
    join(workspaceRoot, 'Templates/basic-project/README.md'),
    '# {{name}}\n\nTemplate.\n'
  )

  // Loose files at the workspace root.
  await write(join(workspaceRoot, 'welcome.md'), '# Welcome\n\nWorkspace root doc.\n')
  await write(join(workspaceRoot, 'todo.txt'), 'first todo\n')

  // T-019 fixture: a node_modules folder so the ignored-items transparency e2e (hidden by
  // default, revealed dimmed by the tree's "show ignored" toggle) has something real to
  // assert against, matching the exact default ignored item.
  await write(join(workspaceRoot, 'node_modules/dummy-pkg/index.js'), 'module.exports = {}\n')

  // Seed .pomade/workspace.json with two projects so the Projects panel can switch between them.
  const workspaceConfig = {
    groups: [],
    projects: [
      {
        id: ALPHA_ID,
        name: 'Alpha',
        rootPath: 'Projects/alpha',
        visibleAgents: ['*'],
        order: 0
      },
      {
        id: BETA_ID,
        name: 'Beta',
        rootPath: 'Projects/beta',
        visibleAgents: ['*'],
        order: 1
      }
    ]
  }
  await write(
    join(workspaceRoot, '.pomade/workspace.json'),
    JSON.stringify(workspaceConfig, null, 2)
  )

  return {
    workspaceRoot,
    userDataDir,
    projects: { alpha: ALPHA_ID, beta: BETA_ID },
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true })
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  }
}
