import { describe, expect, it } from 'vitest'
import { CommandInvariantError, CommandReceipts, assertCommandId } from './command-receipts'
import { normalizeAgentStartRequest } from '../shared/runtime'

describe('命令收据', () => {
  it('同一 commandId 只执行一次，重投拿回同一结果与序号', async () => {
    const receipts = new CommandReceipts<{ runId: string }>()
    let executions = 0
    const execute = async (): Promise<{ runId: string }> => {
      executions += 1
      return { runId: `run-${executions}` }
    }

    const first = await receipts.submit('cmd-abcdef12', execute)
    const second = await receipts.submit('cmd-abcdef12', execute)

    expect(executions).toBe(1)
    expect(first).toMatchObject({ status: 'executed', result: { runId: 'run-1' } })
    expect(second).toMatchObject({ status: 'duplicate', result: { runId: 'run-1' }, sequence: first.sequence })
  })

  it('第一条还在执行时重投不会并发执行第二次', async () => {
    const receipts = new CommandReceipts<string>()
    let executions = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const execute = async (): Promise<string> => {
      executions += 1
      await gate
      return 'run-1'
    }

    const first = receipts.submit('cmd-inflight01', execute)
    const second = receipts.submit('cmd-inflight01', execute)
    // 不靠 sleep：先证明两次提交都还没结束，再放行同一个闸门。
    expect(executions).toBe(1)
    release()

    expect(await first).toMatchObject({ status: 'executed', result: 'run-1' })
    expect(await second).toMatchObject({ status: 'duplicate', result: 'run-1' })
    expect(executions).toBe(1)
  })

  it('失败不构成收据：重试仍然真正执行', async () => {
    const receipts = new CommandReceipts<string>()
    let attempts = 0
    const execute = async (): Promise<string> => {
      attempts += 1
      if (attempts === 1) throw new Error('provider 启动失败')
      return 'run-2'
    }

    await expect(receipts.submit('cmd-retry0001', execute)).rejects.toThrow('provider 启动失败')
    expect(receipts.size()).toBe(0)
    const retried = await receipts.submit('cmd-retry0001', execute)
    expect(retried).toMatchObject({ status: 'executed', result: 'run-2' })
    expect(attempts).toBe(2)
  })

  it('不给 commandId 就不去重', async () => {
    const receipts = new CommandReceipts<number>()
    let executions = 0
    const execute = async (): Promise<number> => ++executions
    const first = await receipts.submit(undefined, execute)
    const second = await receipts.submit(undefined, execute)
    expect(executions).toBe(2)
    expect(first.status).toBe('executed')
    expect(second.status).toBe('executed')
    expect(second.sequence).toBeGreaterThan(first.sequence)
    expect(receipts.size()).toBe(0)
  })

  it('非法 commandId 抛出带 code 的不变式错误', async () => {
    const receipts = new CommandReceipts<number>()
    await expect(receipts.submit('short', async () => 1)).rejects.toBeInstanceOf(CommandInvariantError)
    await expect(receipts.submit('bad id with spaces', async () => 1)).rejects.toMatchObject({ code: 'invalid_command_id' })
    expect(() => assertCommandId('a'.repeat(129))).toThrow(CommandInvariantError)
    expect(() => assertCommandId('cmd-6f1a2b3c')).not.toThrow()
  })

  it('超出上限时淘汰最旧的收据', async () => {
    const receipts = new CommandReceipts<number>(2)
    await receipts.submit('cmd-00000001', async () => 1)
    await receipts.submit('cmd-00000002', async () => 2)
    await receipts.submit('cmd-00000003', async () => 3)
    expect(receipts.size()).toBe(2)
    // 被淘汰的命令会被重新执行，而不是谎称重复。
    const revisited = await receipts.submit('cmd-00000001', async () => 10)
    expect(revisited).toMatchObject({ status: 'executed', result: 10 })
  })
})

describe('启动请求里的 commandId', () => {
  it('合法值被保留，非法值被拒绝', () => {
    expect(normalizeAgentStartRequest({ prompt: 'hi', commandId: 'cmd-9f8e7d6c' }).commandId).toBe('cmd-9f8e7d6c')
    expect(normalizeAgentStartRequest({ prompt: 'hi' }).commandId).toBeUndefined()
    expect(() => normalizeAgentStartRequest({ prompt: 'hi', commandId: 'nope' })).toThrow('commandId')
    expect(() => normalizeAgentStartRequest({ prompt: 'hi', commandId: 'has space inside' })).toThrow('commandId')
  })
})
