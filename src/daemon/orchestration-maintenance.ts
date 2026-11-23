import { pruneOrchestrationInDb, type PruneReport } from '../host-runtime/orchestration/orchestration-retention'
import type { EventSink } from '../host-runtime/orchestration/event-sink'

export interface OrchestrationMaintenanceOptions {
  sink: EventSink
  intervalMs?: number
  eventRetentionMs?: number
  now?: () => number
  log?: (line: string) => void
}

export interface OrchestrationMaintenance {
  /** Runs one retention pass immediately; safe to call concurrently with the interval. */
  runOnce(): PruneReport | undefined
  stop(): void
}

const DEFAULT_INTERVAL_MS = 6 * 3_600_000

/**
 * B2: scheduled retention. One pass per interval, never overlapping, and skipped while the sink
 * is fenced or closing so pruning can never race a writer that already failed.
 */
export function startOrchestrationMaintenance(options: OrchestrationMaintenanceOptions): OrchestrationMaintenance {
  const now = options.now ?? Date.now
  const runOnce = (): PruneReport | undefined => {
    if (!options.sink.handle.db.open || options.sink.isWriteIndeterminate()) return undefined
    try {
      const report = pruneOrchestrationInDb(options.sink.handle.db, {
        now: now(),
        ...(options.eventRetentionMs === undefined ? {} : { eventRetentionMs: options.eventRetentionMs })
      })
      options.log?.(
        `daemon.orchestration-retention events=${report.deletedEvents} outbox=${report.deletedOutbox} ` +
          `inline=${report.clearedInlineBodies} bodies=${report.queuedBodyErasures}`
      )
      return report
    } catch (error) {
      options.log?.(`daemon.orchestration-retention-failed ${(error as Error)?.message ?? String(error)}`)
      return undefined
    }
  }

  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    try {
      runOnce()
    } finally {
      running = false
    }
  }, Math.max(60_000, options.intervalMs ?? DEFAULT_INTERVAL_MS))
  timer.unref()
  return {
    runOnce,
    stop: () => clearInterval(timer)
  }
}

/** B2: `intervalMs: null` disables the timer (tests drive retention passes explicitly). */
export function maybeStartOrchestrationMaintenance(
  options: Omit<OrchestrationMaintenanceOptions, 'intervalMs'> & { intervalMs?: number | null }
): OrchestrationMaintenance | undefined {
  if (options.intervalMs === null) return undefined
  const { intervalMs, ...rest } = options
  return startOrchestrationMaintenance(intervalMs === undefined ? rest : { ...rest, intervalMs })
}
