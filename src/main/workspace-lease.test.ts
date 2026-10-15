import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { withWorkspaceLease, workspaceLeaseCount, workspaceLeaseHolders } from './workspace-lease'
import { readWorkspaceFile, writeWorkspaceFile } from './workspace-files'

const revision = (content: string): string => createHash('sha256').update(content).digest('hex')

describe('工作区租约', () => {
  it('同一键串行执行，并在归零后回收', async () => {
    const order: string[] = []
    const first = withWorkspaceLease('/repo', async () => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('first:end')
      return 1
    })
    const second = withWorkspaceLease('/repo', async () => {
      order.push('second:start')
      return 2
    })
    expect(workspaceLeaseHolders('/repo')).toBe(2)
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    expect(workspaceLeaseHolders('/repo')).toBe(0)
    expect(workspaceLeaseCount()).toBe(0)
  })

  it('不同键并发执行', async () => {
    let active = 0
    let peak = 0
    const task = (key: string) => withWorkspaceLease(key, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
    })
    await Promise.all([task('/a'), task('/b')])
    expect(peak).toBe(2)
    expect(workspaceLeaseCount()).toBe(0)
  })

  it('前驱抛错不阻塞后继，租约仍然释放', async () => {
    const failed = withWorkspaceLease('/repo', async () => { throw new Error('boom') })
    const next = withWorkspaceLease('/repo', async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(workspaceLeaseCount()).toBe(0)
  })
})

describe('并发工作区写入', () => {
  it('两个基于同一 revision 的写入只有一个成功，另一个被 revision 比对拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-workspace-lease-'))
    const file = 'notes.md'
    await writeFile(join(root, file), 'base\n', 'utf8')
    const expectedRevision = revision('base\n')

    const results = await Promise.allSettled([
      writeWorkspaceFile({ cwd: root, path: file, content: 'first\n', expectedRevision }),
      writeWorkspaceFile({ cwd: root, path: file, content: 'second\n', expectedRevision })
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: '文件已在磁盘上发生变化，请重新载入后再编辑'
    })

    // 磁盘内容与成功方返回的快照一致：没有发生「后写者静默覆盖」
    const onDisk = await readFile(join(root, file), 'utf8')
    const snapshot = (fulfilled[0] as PromiseFulfilledResult<{ content: string; revision: string }>).value
    expect(snapshot.content).toBe(onDisk)
    expect(snapshot.revision).toBe(revision(onDisk))
    expect(['first\n', 'second\n']).toContain(onDisk)

    const reread = await readWorkspaceFile({ cwd: root, path: file })
    expect(reread.content).toBe(onDisk)
    expect(workspaceLeaseCount()).toBe(0)
  })
})
