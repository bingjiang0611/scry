import { describe, expect, it } from 'vitest'
import type { TraceEvent } from './trace'
import { providerUsageResultEvents, resultWallTiming } from './result-timing'

function result(id: string, ts: string, durationMs: number, extra: Partial<TraceEvent> = {}): TraceEvent {
  return { id, runId: 'run', kind: 'harness', stage: 'result', ts, durationMs, ...extra }
}

describe('resultWallTiming', () => {
  it('用多 result 区间外包络保留间隔，不把墙钟 duration 简单相加', () => {
    expect(resultWallTiming([
      result('first', '2026-01-01T00:00:10.000Z', 10_000),
      result('second', '2026-01-01T00:00:30.000Z', 5_000)
    ])).toEqual({
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:30.000Z',
      durationMs: 30_000
    })
  })

  it('重叠 result 只计算一次墙钟，并支持乱序事件', () => {
    expect(resultWallTiming([
      result('later', '2026-01-01T00:00:12.000Z', 8_000),
      result('earlier', '2026-01-01T00:00:10.000Z', 10_000)
    ])?.durationMs).toBe(12_000)
  })

  it('任一 canonical result 缺少可靠边界时保持 unavailable', () => {
    expect(resultWallTiming([
      result('valid', '2026-01-01T00:00:10.000Z', 10_000),
      { ...result('invalid', 'invalid', 5_000) }
    ])).toBeUndefined()
  })
})

describe('providerUsageResultEvents', () => {
  it('Claude continuation 使用最终累计快照，其他 Provider 保留增量 result', () => {
    const claude = [
      result('c1', '2026-01-01T00:00:01.000Z', 1_000, { runtimeProvider: 'claude_sdk' }),
      result('c2', '2026-01-01T00:00:02.000Z', 2_000, { runtimeProvider: 'claude_sdk' })
    ]
    const qoder = claude.map((event) => ({ ...event, runtimeProvider: 'qoder_cli' as const }))
    expect(providerUsageResultEvents(claude).map((event) => event.id)).toEqual(['c2'])
    expect(providerUsageResultEvents(qoder).map((event) => event.id)).toEqual(['c1', 'c2'])
  })
})
