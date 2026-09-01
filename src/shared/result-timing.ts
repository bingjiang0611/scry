import type { TraceEvent } from './trace.js'

export interface ResultWallTiming {
  startedAt: string
  completedAt: string
  durationMs: number
}

type ResultEvent = Pick<TraceEvent, 'kind' | 'stage' | 'text' | 'runtimeProvider'>

/** Provider usage result：Claude continuation 为累计快照，其他 Provider 当前为增量事件。 */
export function providerUsageResultEvents<T extends ResultEvent>(events: readonly T[]): T[] {
  const observed = events.filter((event) => event.kind === 'harness' && event.stage === 'result')
  const native = observed.filter((event) => event.text !== 'transcript assistant usage')
  const candidates = native.length > 0 ? native : observed
  const latest = candidates.at(-1)
  return latest?.runtimeProvider === 'claude_sdk' ? [latest] : candidates
}

function finiteDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 合并同一顶层轮次内的多个 Provider result 墙钟区间。
 *
 * result.durationMs 是墙钟边界，不是可累加的 API 活动量。正常 continuation、后台任务通知
 * 或累计快照都可能产生多个 result；用所有 `[ts - durationMs, ts]` 的外包络既保留间隔，
 * 也不会把重叠区间重复计时。只要任一 canonical result 缺少可靠边界，就不伪造整轮墙钟。
 */
export function resultWallTiming(events: readonly {
  kind: string
  stage: string
  ts: string
  durationMs?: number
  text?: string
}[]): ResultWallTiming | undefined {
  const observed = events.filter(
    (event) => event.kind === 'harness' && event.stage === 'result' && event.text !== 'transcript assistant usage'
  )
  if (observed.length === 0) return undefined

  const intervals = observed.map((event) => {
    const completed = Date.parse(event.ts)
    const durationMs = finiteDuration(event.durationMs)
    if (!Number.isFinite(completed) || durationMs == null) return undefined
    return { started: completed - durationMs, completed }
  })
  if (intervals.some((interval) => interval == null)) return undefined

  const valid = intervals as Array<{ started: number; completed: number }>
  const started = Math.min(...valid.map((interval) => interval.started))
  const completed = Math.max(...valid.map((interval) => interval.completed))
  return {
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - started
  }
}
