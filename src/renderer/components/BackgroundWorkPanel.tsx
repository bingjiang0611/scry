import { useEffect, useState } from 'react'
import type { BackgroundTaskStopResult, BackgroundWork } from '@shared/background-work'
import { BACKGROUND_WORK_COPY as copy } from '../constants/copy'
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
    setResults((previous) => ({ ...previous, [taskId]: { status: 'sending', message: copy.stopping } }))
    let result: BackgroundTaskStopResult
    try { result = await stopTask(taskId) } catch { result = { status: 'unknown', message: copy.stopUnknownMessage } }
    setResults((previous) => ({ ...previous, [taskId]: result }))
  }
  if (work.phase === 'inactive') return null
  const observedNow = Math.max(now, Date.now())
  return <section className="background-work-panel" aria-label={copy.regionLabel} data-quiet={work.quiet || undefined}>
    {work.tasks.map((task) => {
      const result = results[task.taskId]
      const age = backgroundTaskAge(task.observedAt, observedNow)
      const stopping = result?.status === 'sending'
      const requested = Boolean(task.stopState || stopping || result?.status === 'requested' || result?.status === 'unknown')
      const unknown = work.quiet || task.status === 'unconfirmed'
      const status = task.stopState === 'unconfirmed' || result?.status === 'unknown' ? copy.stopUnconfirmed
        : stopping ? copy.stopping : requested ? copy.stopRequested
          : result?.status === 'rejected' ? copy.stopRejected
            : result?.status === 'unavailable' ? copy.stopUnavailable
              : unknown ? copy.unknown : copy.waiting
      const canStop = work.taskStop === 'available' && !requested
      const uncertain = unknown || task.stopState === 'unconfirmed' || result?.status === 'unknown' || result?.status === 'rejected'
      return <article className="background-work-task" data-status={uncertain ? 'unknown' : 'waiting'} key={task.taskId}>
        <header className="background-work-head">
          <Icon name="agents" />
          <span className="background-work-identity">
            <strong className="background-work-name" title={task.description}>{task.description}</strong>
            <span className="background-work-provider">{copy.provider[work.providerId]}</span>
          </span>
          <span className="background-work-state" role="status"><i aria-hidden="true" />{status}</span>
          {age && <span className="background-work-age" title={copy.ageTitle}>{copy.age(age)}</span>}
        </header>
        <div className="background-work-actions">
          <details className="background-work-details">
            <summary aria-label={copy.detailsLabel(task.description)}>
              <span>{copy.details}</span><Icon name="chevronRight" />
            </summary>
            <dl className="background-work-evidence">
              <div><dt>{copy.taskId}</dt><dd><code>{task.taskId}</code></dd></div>
              <div><dt>{copy.receipt}</dt><dd><time>{new Date(task.observedAt).toLocaleTimeString()}</time></dd></div>
            </dl>
          </details>
          {work.taskStop === 'available' && <button type="button" className="btn background-work-stop" disabled={!canStop}
            aria-label={copy.stopLabel(task.taskId)} onClick={() => { void stop(task.taskId) }}>
            <Icon name="square" />{stopping ? copy.stopping : copy.stop}
          </button>}
        </div>
        {result?.message && <p className="background-work-result" role="status">{result.message}</p>}
      </article>
    })}
    {work.tasks.length === 0 && <p className="background-work-empty"><Icon name="clock" />{copy.empty}</p>}
    {work.quiet && <p className="background-work-warning" role="status">{copy.quiet}</p>}
  </section>
}
