import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface WorkspacesModule {
  gitEnv(gitHome: string, tmp: string): Record<string, string>
  canonicalWorkspace(path: string): string
  seedWorkspaces(input: { work: string; count: number; gitHome: string; tmp: string; log?: (scope: string, line: string) => void }): string[]
}

let workspaces: WorkspacesModule
beforeAll(async () => {
  workspaces = await import(new URL('./fixtures/concurrency-trace-live-workspaces.mjs', import.meta.url).href) as WorkspacesModule
})

// The App stores the cwd it was given in canonical form and RemoteChatFoundation matches a
// catalog session by exact cwd, so the seeded identity has to be the real path. A symlinked
// work root reproduces the /tmp -> /private/tmp case that made the real peer-1 session inactive.
const root = mkdtempSync(join(tmpdir(), 'scry-live-workspaces-'))
const real = join(root, 'real')
const link = join(root, 'linked-work')
const gitHome = join(root, 'git-home')
const gitTmp = join(root, 'git-tmp')
mkdirSync(real, { recursive: true })
mkdirSync(gitHome, { recursive: true })
mkdirSync(gitTmp, { recursive: true })
symlinkSync(real, link, 'dir')

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('concurrency trace live seeded workspace identity', () => {
  it('returns the canonical path of each workspace, and git agrees on it', () => {
    const seeded = workspaces.seedWorkspaces({ work: link, count: 2, gitHome, tmp: gitTmp })
    expect(seeded).toHaveLength(2)
    for (const [index, workspace] of seeded.entries()) {
      const built = join(link, 'workspaces', `task-0${index}`)
      // The path the fixture built is not the identity it may report.
      expect(built).not.toBe(workspace)
      expect(workspace).toBe(realpathSync(built))
      expect(workspace.startsWith(realpathSync(real))).toBe(true)
    }
    // The identity used for start/target/session/oracle is the same one git reports.
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: seeded[0], env: workspaces.gitEnv(gitHome, gitTmp), stdio: ['ignore', 'pipe', 'pipe']
    }).toString().trim()
    expect(toplevel).toBe(seeded[0])
  })
})
