import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceRuntime } from './workspace-runtime'

describe('rememberProject', () => {
  let root = ''
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scry-workspace-runtime-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('records a chosen directory but not a Scry-managed worktree', () => {
    const userData = join(root, 'user-data')
    const worktree = join(userData, 'worktrees', 'repo-hash', 'session-uuid')
    const workspace = join(root, 'repo')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(workspace)
    const runtime = createWorkspaceRuntime({ appUserDataDir: userData, loadSessions: () => [] })

    // 打开 worktree 会话会用执行 cwd 走这里；它只是运行的目录，不是项目。
    runtime.rememberProject(worktree)
    expect(runtime.recentStore().load()).toEqual([])
    expect(runtime.projectStore().load()).toEqual([])

    runtime.rememberProject(workspace)
    expect(runtime.recentStore().load()).toEqual([realpathSync(workspace)])
    expect(runtime.projectStore().load().map((project) => project.cwd)).toEqual([realpathSync(workspace)])
  })
})
