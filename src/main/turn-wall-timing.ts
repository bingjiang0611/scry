import type { TraceEvent } from '../shared/trace'

interface Clock {
  now(): number
  monotonic(): number
}

// 从本轮执行被接受到 adapter promise 收口：包括启动、同步 Hook 和 adapter 清理，
// 不等待 detached 后台任务、diff 归档或异步上传。独立于 Provider 自报 result 计时。
export function createTurnWallTimer(runId: string, clock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now()
}): () => TraceEvent {
  const startedAt = new Date(clock.now()).toISOString()
  const started = clock.monotonic()
  let terminal: TraceEvent | undefined
  return () => {
    terminal ??= {
      id: `turn-wall:${runId}`,
      runId,
      kind: 'harness',
      stage: 'runtime:turn_wall',
      ts: new Date(clock.now()).toISOString(),
      durationMs: Math.max(0, clock.monotonic() - started),
      input: { startedAt, boundary: 'provider_settled' }
    }
    return terminal
  }
}
