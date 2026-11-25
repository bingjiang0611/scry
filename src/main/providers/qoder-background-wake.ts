import type { QoderBackgroundTasks } from './qoder-messages'

/** The run's side of the watch. Taking the session and its ids here keeps the run a lifecycle story. */
export function watchSettledQoderBackground(input: {
  session: { key: string; watchIdle(listener: (message: Record<string, unknown>) => void): () => void }
  tasks: QoderBackgroundTasks
  taskIds: readonly string[]
  cwd: string | undefined
  onWake: (wake: { taskIds: string[]; reason: 'terminal'; sessionId: string; cwd: string | undefined }) => void
}): () => void {
  return observeQoderBackground({
    subscribe: (listener) => input.session.watchIdle(listener),
    tasks: input.tasks,
    taskIds: input.taskIds,
    onWake: (wake) => input.onWake({ ...wake, reason: 'terminal', sessionId: input.session.key, cwd: input.cwd })
  }).stop
}

/**
 * C3 (Qoder): the answer ends the turn, and the session's own reader keeps receiving the child's report
 * after that. This watcher turns the last report into one wake instead of a held run.
 *
 * It reuses the run's `QoderBackgroundTasks`, so a task the answer already knew about stays known and the
 * wake names it. Silence is not a result: only a report that the tracked work is gone wakes the session.
 * A child the answer never named is still tracked — a later report that starts it is picked up, and its
 * terminal report wakes too.
 */
export function observeQoderBackground(input: {
  subscribe: (listener: (message: Record<string, unknown>) => void) => () => void
  tasks: QoderBackgroundTasks
  /** Tasks the settled turn left behind. Empty still watches: a child may be reported after the answer. */
  taskIds: readonly string[]
  onWake: (wake: { taskIds: string[] }) => void
}): { stop: () => void } {
  const seen = new Set(input.taskIds)
  let stopped = false
  // A child the settled turn named is not proof that this session still knows it; only a report that the
  // work was running makes its end meaningful. Without one, silence stays silence.
  let observed = input.tasks.pending
  const unsubscribe = input.subscribe((message) => {
    if (stopped) return
    input.tasks.observe(message)
    for (const task of input.tasks.tasks) seen.add(task.taskId)
    if (input.tasks.pending) { observed = true; return }
    if (!observed) return
    stopped = true
    unsubscribe()
    input.onWake({ taskIds: [...seen].sort() })
  })
  return {
    stop(): void {
      if (stopped) return
      stopped = true
      unsubscribe()
    }
  }
}
