import { describe, expect, it } from 'vitest'
import { verifyForkArchiveBoundary } from './session-fork'
import type { TraceArchive } from './transcript-archive'

const request = { sourceRunId: 'run-1', sourceProviderTurnId: 'turn-1', sourceForkTurnId: 'turn-1' }
const archive = (turns: Array<Record<string, unknown>>) => ({ turns } as unknown as TraceArchive)

describe('fork boundary errors name the failed check without IDs', () => {
  it.each([
    ['no archive', null, '没有找到该会话的归档'],
    ['run not archived', archive([{ runId: 'other', done: true, status: 'completed' }]), '该会话归档的 1 轮中没有这一轮'],
    ['interrupted turn', archive([{ runId: 'run-1', done: true, status: 'interrupted' }]), '这一轮状态为 interrupted'],
    ['unfinished turn', archive([{ runId: 'run-1', done: false }]), '这一轮尚未结束，状态为 未知']
  ])('%s', (_case, value, reason) => {
    const call = () => verifyForkArchiveBoundary(value, request)
    expect(call).toThrow(`找不到可分支的已结束轮次：${reason}`)
    expect(call).not.toThrow(/run-1|turn-1/)
  })

  it('still accepts a completed turn with a matching boundary', () => {
    const value = archive([{ runId: 'run-1', done: true, status: 'completed', providerTurnId: 'turn-1' }])
    expect(verifyForkArchiveBoundary(value, request).sourceIndex).toBe(0)
  })
})
