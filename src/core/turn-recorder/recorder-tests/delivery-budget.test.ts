import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { drainCommitNotifications } from '../store'
import { completeTurn, workspace, commitHook, commitAckPath } from './fixture.test'

export function registerSuite19(): void {


describe('commit notification drain budget', () => {
  async function backlog(root: string, sessions: number): Promise<void> {
    for (let index = 0; index < sessions; index++) await completeTurn(root, `budget-${index}`)
  }

  it('hook 事件路径按条数预算截断，剩余保持 pending 且不跳号', async () => {
    const root = await workspace()
    await backlog(root, 3)
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }

    await expect(drainCommitNotifications(join(root, '.scry'), env, { maxRecords: 2 }))
      .resolves.toEqual({ delivered: 2, pending: 1, truncated: true })
    await expect(readFile(commitAckPath(root), 'utf8'))
      .resolves.toContain('"ackedThrough":2')
    await expect(drainCommitNotifications(join(root, '.scry'), env, { maxRecords: 2 }))
      .resolves.toEqual({ delivered: 1, pending: 0, truncated: false })
    expect((await readFile(hook.capture, 'utf8')).trim().split('\n')).toHaveLength(3)
  })

  it('时间预算只在两次调用之间生效，且至少投递一条以保证前进', async () => {
    const root = await workspace()
    await backlog(root, 3)
    const hook = await commitHook(root)
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }
    let clock = 0
    // Deadline already elapsed before the first record: the drain must still make progress.
    const now = (): number => (clock += 10_000)

    await expect(drainCommitNotifications(join(root, '.scry'), env, { budgetMs: 1, now }))
      .resolves.toEqual({ delivered: 1, pending: 2, truncated: true })
  })

  it('hook 失败不标记为预算截断，便于区分停滞原因', async () => {
    const root = await workspace()
    await backlog(root, 2)
    const failing = await commitHook(root, 1)

    await expect(drainCommitNotifications(join(root, '.scry'), { ...process.env, SCRY_RECORDER_COMMIT_HOOK: failing.path }, { maxRecords: 2 }))
      .resolves.toEqual({ delivered: 0, pending: 2, truncated: false })
  })

  it('无预算的显式 drain 一次清空积压', async () => {
    const root = await workspace()
    await backlog(root, 4)
    const hook = await commitHook(root)

    await expect(drainCommitNotifications(join(root, '.scry'), { ...process.env, SCRY_RECORDER_COMMIT_HOOK: hook.path }))
      .resolves.toEqual({ delivered: 4, pending: 0, truncated: false })
  })
})
}
