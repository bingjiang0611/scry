import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { addWorktree, endTurn, gitWorkspace, startTurn, worktreePath } from './worktree-fixture'
import { pexecFile } from './fixture.test'

/** 采集范围内、但能确认不是本轮新建的 worktree：静默跳过，不产出任何快照。 */
export function registerSuite25(): void {

describe('不是本轮新建的 worktree 不产出快照', () => {

  it('老 worktree（创建时间早于本轮）：静默跳过，不产出快照，整轮 diff 不被标成 partial', async () => {
    // workspace-only 模式下回合开始不发现 linked worktree，所以旧 worktree 不在本轮基线里。
    const root = await gitWorkspace(false)
    const worktree = await addWorktree(root, 'old')
    // reflog 只有秒精度，必须让创建时间明确早于本轮窗口（>1s）。
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
    // workspace-only 模式不探测 linked worktree，即使它在采集范围内（这里嵌在 trees/年/月/ 下面）。
    const root = await gitWorkspace(false)
    const deep = join(root, 'trees', '2026', '07', 'wt')
    await pexecFile('git', ['worktree', 'add', '-b', 'branch-deep', deep], { cwd: root })
    // 老 worktree：创建时间必须明确早于两轮的开始（reflog 只有秒精度）。
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
    // 没有创建记录时按 gitdir 自身的创建/修改时间粗判：这里它停在建好那一刻，早于本轮开始。
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
