import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { addWorktree, endTurn, gitWorkspace, startTurn, worktreePath } from './worktree-fixture'
import { pexecFile } from './fixture.test'

export function registerSuite25(): void {

describe('不是本轮新建的 worktree 不产出快照', () => {

  it('老 worktree（创建时间早于本轮）：静默跳过，不产出快照，整轮 diff 不被标成 partial', async () => {
    const root = await gitWorkspace(false)
    const worktree = await addWorktree(root, 'old')
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await startTurn(root, 'wt-old', new Date().toISOString())
    await writeFile(join(worktree, 'a.txt'), 'changed outside the turn\n')
    const record = await endTurn(root, 'wt-old', new Date().toISOString())

    expect(record.diff.value).toHaveLength(1)
    expect(record.diff.value?.[0].requestedRoot).toBe(root)
    expect(record.diff.status).toBe('available')
    expect(record.diff.omissionReason).toBeUndefined()
  }, 35_000)

  it('发现逻辑跳过的目录里的老 worktree：连续两轮都不产出快照，diff 状态不受影响', async () => {
    const root = await gitWorkspace(false)
    const deep = join(root, 'trees', '2026', '07', 'wt')
    await pexecFile('git', ['worktree', 'add', '-b', 'branch-deep', deep], { cwd: root })
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const base = Date.now()
    for (const turn of [0, 1]) {
      await startTurn(root, 'wt-deep', new Date(base + turn * 60_000).toISOString())
      const record = await endTurn(root, 'wt-deep', new Date(base + turn * 60_000 + 1_000).toISOString())
      expect(record.diff.value).toHaveLength(1)
      expect(record.diff.value?.[0].requestedRoot).toBe(root)
      expect(record.diff.status).toBe('available')
    }
  }, 45_000)

  it('reflog 关闭 + 老 worktree：跳过，不产出快照', async () => {
    const root = await gitWorkspace(false)
    const worktree = worktreePath(root, 'old-noreflog')
    await pexecFile('git', ['-c', 'core.logAllRefUpdates=false', 'worktree', 'add', '-b', 'branch-old-noreflog', worktree], { cwd: root })
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    await startTurn(root, 'wt-old-noreflog', new Date().toISOString())
    await writeFile(join(worktree, 'a.txt'), 'changed outside the turn\n')
    const record = await endTurn(root, 'wt-old-noreflog', new Date().toISOString())

    expect(record.diff.value).toHaveLength(1)
    expect(record.diff.value?.[0].requestedRoot).toBe(root)
    expect(record.diff.status).toBe('available')
  }, 35_000)

})
}
