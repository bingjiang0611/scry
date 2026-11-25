import { latestBackgroundWork, type BackgroundTaskStopResult } from '../shared/background-work'
import type { TraceEvent } from '../shared/trace'

interface ActiveTaskRun {
  state: { done: boolean; providerId?: string; items: TraceEvent[] }
  control: { stopBackgroundTask?: (taskId: string) => Promise<BackgroundTaskStopResult> }
}

/** Resolves a stop request against tasks observed in an active run; forwards only the task ID. */
export async function stopObservedBackgroundTask(payload: unknown, lookup: (runId: string) => ActiveTaskRun | undefined): Promise<BackgroundTaskStopResult> {
  const denied: BackgroundTaskStopResult = { status: 'rejected', message: '不是当前活动轮次中可停止的后台任务。' }
  if (!payload || typeof payload !== 'object') return denied
  const { runId, taskId } = payload as Record<string, unknown>
  if (typeof runId !== 'string' || !runId || runId.length > 256 || typeof taskId !== 'string' || !taskId || taskId.length > 256) return denied
  const run = lookup(runId)
  if (!run || run.state.done || run.state.providerId !== 'qoder') return denied
  const work = latestBackgroundWork(run.state.items)
  if (!work || work.phase === 'inactive' || !work.tasks.some((task) => task.taskId === taskId && !task.stopState)) return denied
  if (work.taskStop !== 'available' || !run.control.stopBackgroundTask) return { status: 'unavailable', message: '当前 Provider 不支持单任务停止。' }
  return run.control.stopBackgroundTask(taskId)
}
