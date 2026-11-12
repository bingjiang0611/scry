// Evidence a finished Qoder run recovers from the CLI's own per-process run log
// (`~/.qoder/logs/runs/*-p<pid>/qodercli.log`): the native turn id, background Bash
// failures, sub-agent terminals the stream never delivered, and hooks the SDK omitted.
// The log belongs to this run's daemon, so it is read only after that daemon stopped.

import type { TraceEvent } from '../../shared/trace'
import {
  observedAgentStatus,
  parseQoderBackgroundTaskFailures,
  parseQoderHookLog,
  parseQoderSubagentTerminals,
  qoderHookFallbackOnly,
  qoderHookLog,
  qoderProviderTurnIdFromLog,
  type QoderHookFallbackState
} from './qoder-hooks'
import { newId } from './qoder-shared'

export interface QoderRunLogContext {
  runId: string
  /** This run's daemon pid; undefined when it could not be told apart. */
  pid: number | undefined
  externalSessionId: string | undefined
  stopped: boolean
  managedRecorder: boolean
  sdkHooks: readonly TraceEvent[]
  hookFallback: QoderHookFallbackState
  emit: (event: TraceEvent) => void
  observeProviderTurnId: (id: string | undefined) => void
  settleBackgroundBash: (toolUseId: string) => void
  hasAgentTerminal: (toolUseId: string) => boolean
  emitAgentTerminal: (event: TraceEvent) => void
}

/** Returns whether the log proves a failure the stream did not report. */
export async function reconcileQoderRunLog(ctx: QoderRunLogContext): Promise<{ failed: boolean }> {
  const logHooksEnabled = process.env.SCRY_QODER_LOG_HOOKS?.trim() !== '0'
  if (!ctx.managedRecorder && !logHooksEnabled) return { failed: false }
  if (!ctx.pid) {
    ctx.hookFallback.error = 'Qoder log fallback could not identify this run\'s daemon process'
    return { failed: false }
  }
  let failed = false
  try {
    const log = await qoderHookLog(ctx.pid)
    ctx.observeProviderTurnId(qoderProviderTurnIdFromLog(log, ctx.externalSessionId))
    const backgroundFailures = parseQoderBackgroundTaskFailures(ctx.runId, log, ctx.externalSessionId)
    for (const event of backgroundFailures) {
      if (event.toolUseId) ctx.settleBackgroundBash(event.toolUseId)
      ctx.emit(event)
    }
    if (backgroundFailures.length > 0) failed = true
    const missingSubagentTerminals = parseQoderSubagentTerminals(ctx.runId, log, ctx.externalSessionId)
      .filter((event) => event.toolUseId && !ctx.hasAgentTerminal(event.toolUseId))
    for (const event of missingSubagentTerminals) ctx.emitAgentTerminal(event)
    if (!ctx.stopped && missingSubagentTerminals.some((event) => observedAgentStatus(event) !== 'completed')) failed = true
    if (logHooksEnabled) {
      const fallback = parseQoderHookLog(ctx.runId, log, ctx.externalSessionId)
      for (const event of qoderHookFallbackOnly([...ctx.sdkHooks], fallback)) ctx.emit(event)
      ctx.hookFallback.observed = true
    }
    ctx.hookFallback.error = undefined
  } catch (error) {
    ctx.hookFallback.error = String((error as Error).message)
    ctx.emit({
      id: newId(), runId: ctx.runId, ts: new Date().toISOString(),
      kind: 'harness', stage: 'runtime:telemetry_degraded', text: ctx.hookFallback.error,
      runtimeMetadata: { source: 'qoder_cli_log', capability: 'hooks' }
    })
  }
  return { failed }
}
