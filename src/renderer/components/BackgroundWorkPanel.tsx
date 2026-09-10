import { useEffect, useState } from 'react'
import type { BackgroundTaskStopResult, BackgroundWork } from '@shared/background-work'
import { Icon } from './primitives/Icon'
import './background-work.css'

export function backgroundTaskAge(observedAt: number, now: number): string | undefined {
  if (!Number.isFinite(observedAt) || observedAt > now) return undefined
  const seconds = Math.floor((now - observedAt) / 1000)
  if (seconds < 60) return '<1m'
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function BackgroundWorkPanel({ runId, work, stopTask = (taskId) => window.scry.stopBackgroundTask({ runId, taskId }) }: {
  runId: string
  work: BackgroundWork
  stopTask?: (taskId: string) => Promise<BackgroundTaskStopResult>
}) {
  const [now, setNow] = useState(Date.now)
  const [results, setResults] = useState<Record<string, BackgroundTaskStopResult | { status: 'sending'; message: string }>>({})
  useEffect(() => {
    if (work.phase === 'inactive' || work.tasks.length === 0) return
    const timer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [work.phase, work.tasks.length])
  const stop = async (taskId: string): Promise<void> => {
    setResults((previous) => ({ ...previous, [taskId]: { status: 'sending', message: '正在请求停止…' } }))
    let result: BackgroundTaskStopResult
    try { result = await stopTask(taskId) } catch { result = { status: 'unknown', message: '停止结果未确认，不会自动重复请求。' } }
    setResults((previous) => ({ ...previous, [taskId]: result }))
  }
  if (work.phase === 'inactive') return null
  return <section className="background-work-panel" aria-label="后台任务" data-quiet={work.quiet || undefined}>
    {work.tasks.map((task) => {
      const result = results[task.taskId]
      const requested = task.stopState || (result && ['sending', 'requested', 'unknown'].includes(result.status))
      const status = task.stopState === 'unconfirmed' || result?.status === 'unknown' ? '停止待确认'
        : result?.status === 'sending' ? '请求停止中'
          : requested ? '已请求停止'
            : result?.status === 'rejected' ? '停止被拒绝'
              : result?.status === 'unavailable' ? '无法单独停止'
                : work.quiet ? '状态待确认' : '执行中'
      const age = backgroundTaskAge(task.observedAt, now)
      return <div className="background-work-task" key={task.taskId}>
        <details className="background-work-details">
          <summary aria-label={`任务详情 ${task.description}`}>
            <Icon name="chevronRight" />
            <span className="background-work-name" title={task.description}>{task.description}</span>
            <span className="background-work-kind">{task.tool}</span>
            <span className="background-work-state" role="status">{status}</span>
            {age && <span className="background-work-age" title="自收到启动回执起的时长，非精确进程运行时间">{age}</span>}
          </summary>
          <div className="background-work-evidence">
            <p>{task.description}</p>
            <p>任务 {task.taskId} · 启动回执：{new Date(task.observedAt).toLocaleTimeString()}</p>
            <p>时长从收到启动回执起计算；仅展示已观测任务，清单可能不完整。</p>
            {(result || task.stopState) && <p>{result?.message ?? (task.stopState === 'unconfirmed' ? '停止结果未确认' : '已请求停止；等待任务终态')}</p>}
            {work.taskStop === 'unavailable' && <p>当前 Qoder 的单任务停止未验证；需要时可使用输入框中的“停止本轮”。</p>}
          </div>
        </details>
        {work.taskStop === 'available' && <button type="button" disabled={Boolean(requested)} onClick={() => void stop(task.taskId)} aria-label={`停止任务 ${task.taskId}`}>
          <Icon name="square" />停止
        </button>}
      </div>
    })}
    {work.tasks.length === 0 && <p className="background-work-empty"><Icon name="clock" />等待后续结果</p>}
    {work.quiet && <p className="background-work-warning" role="status">长时间无新进展；文件可能已写入，重试前请先核验。</p>}
  </section>
}
