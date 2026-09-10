import { useState } from 'react'
import type { BackgroundTaskStopResult, BackgroundWork } from '@shared/background-work'
import { Icon } from './primitives/Icon'
import './background-work.css'

export function BackgroundWorkPanel({ runId, work, stopTask = (taskId) => window.scry.stopBackgroundTask({ runId, taskId }) }: {
  runId: string
  work: BackgroundWork
  stopTask?: (taskId: string) => Promise<BackgroundTaskStopResult>
}) {
  const [results, setResults] = useState<Record<string, BackgroundTaskStopResult | { status: 'sending'; message: string }>>({})
  const stop = async (taskId: string): Promise<void> => {
    setResults((previous) => ({ ...previous, [taskId]: { status: 'sending', message: '正在请求停止…' } }))
    let result: BackgroundTaskStopResult
    try { result = await stopTask(taskId) } catch { result = { status: 'unknown', message: '停止结果未确认，不会自动重复请求。' } }
    setResults((previous) => ({ ...previous, [taskId]: result }))
  }
  if (work.phase === 'inactive') return null
  return <section className="background-work-panel" aria-label="后台任务" data-quiet={work.quiet || undefined}>
    <div className="background-work-heading"><Icon name="clock" /><b>{work.quiet ? '后台任务长时间未更新' : '后台任务'}</b><span>已观测 {work.tasks.length} 项 · 非完整清单</span></div>
    {work.quiet && <p role="status">已至少 15 分钟未收到新执行事件（最近：{new Date(work.lastEventAt).toLocaleTimeString()}），运行状态待确认。继续等待不会取消任务；文件可能已写入，重试前请先核验。</p>}
    {work.tasks.map((task) => {
      const result = results[task.taskId]
      const requested = task.stopState || (result && ['sending', 'requested', 'unknown'].includes(result.status))
      return <div className="background-work-task" key={task.taskId}>
        <div><b>{task.tool}</b> <span>{task.description}</span><small>任务 {task.taskId} · 观测于 {new Date(task.observedAt).toLocaleTimeString()}</small>
          {(result || task.stopState) && <small role="status">{result?.message ?? (task.stopState === 'unconfirmed' ? '停止结果未确认' : '已请求停止；等待任务终态')}</small>}
        </div>
        {work.taskStop === 'available' && <button type="button" disabled={Boolean(requested)} onClick={() => void stop(task.taskId)} aria-label={`停止任务 ${task.taskId}`}>
          <Icon name="square" />{requested ? '等待停止确认' : '停止任务'}
        </button>}
      </div>
    })}
    {work.tasks.length === 0 && <p>等待 Qoder 返回后续事件；当前没有可关联的后台任务明细，本轮尚未结束。</p>}
    {work.taskStop === 'unavailable' && <p>当前 Qoder 版本的单任务停止未验证；可使用输入框中的“停止本轮”。</p>}
  </section>
}
