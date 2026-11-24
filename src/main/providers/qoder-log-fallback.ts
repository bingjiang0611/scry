import type { TraceEvent } from '../../shared/trace'
import type { QoderBackgroundTasks } from './qoder-messages'
import {
  parseQoderBackgroundTaskFailures,
  parseQoderHookLog,
  parseQoderSubagentTerminals,
  qoderHookFallbackOnly,
  qoderHookLog,
  qoderProviderTurnIdFromLog,
  observedAgentStatus,
  type QoderHookFallbackState
} from './qoder-hooks'
import { newId } from './qoder-shared'
import type { ProviderRunRequest } from './types'

export interface QoderLogFallbackInput {
  request: ProviderRunRequest
  hookFallback: QoderHookFallbackState
  /** The CLI process this run spawned; without it the log cannot be attributed to this turn. */
  pid: number | undefined
  externalSessionId: string | undefined
  sdkHooks: TraceEvent[]
  terminalAgentCalls: ReadonlySet<string>
  backgroundTasks: QoderBackgroundTasks
  stopped: boolean
  observeProviderTurnId: (id: string | undefined) => void
  emitAgentFallback: (event: TraceEvent, hasTerminalEvidence: boolean) => void
}

/**
 * The CLI's own JSON log is the fallback when SDK hook events never arrive. It runs after the
 * stream settles, so it may only add evidence the stream missed: it never reopens a settled Agent
 * and never upgrades a failed turn to success.
 *
 * Returns whether this pass found a durable failure the stream did not report.
 */
export async function applyQoderLogFallback(input: QoderLogFallbackInput): Promise<boolean> {
  const { request, hookFallback, externalSessionId, stopped } = input
  const enabled = process.env.SCRY_QODER_LOG_HOOKS?.trim() !== '0'
  if (!(request.managedRecorder === true || enabled)) return false
  if (!input.pid) {
    // Silence here would look like "hooks worked and saw nothing".
    hookFallback.error = 'Qoder log fallback could not identify the current CLI process'
    return false
  }
  let failed = false
  try {
    const log = await qoderHookLog(input.pid)
    input.observeProviderTurnId(qoderProviderTurnIdFromLog(log, externalSessionId))
    const backgroundFailures = parseQoderBackgroundTaskFailures(request.runId, log, externalSessionId)
    for (const event of backgroundFailures) {
      if (event.toolUseId) input.backgroundTasks.settleCall(event.toolUseId, 'Bash')
      request.emit(event)
    }
    if (backgroundFailures.length > 0) failed = true
    const subagentTerminals = parseQoderSubagentTerminals(request.runId, log, externalSessionId)
    const missing = subagentTerminals.filter((event) => event.toolUseId && !input.terminalAgentCalls.has(event.toolUseId))
    for (const event of missing) input.emitAgentFallback(event, true)
    if (!stopped && missing.some((event) => observedAgentStatus(event) !== 'completed')) failed = true
    if (enabled) {
      const fallback = parseQoderHookLog(request.runId, log, externalSessionId)
      for (const event of qoderHookFallbackOnly(input.sdkHooks, fallback)) request.emit(event)
      hookFallback.observed = true
    }
    hookFallback.error = undefined
  } catch (error) {
    hookFallback.error = String((error as Error).message)
    request.emit({
      id: newId(), runId: request.runId, ts: new Date().toISOString(),
      kind: 'harness', stage: 'runtime:telemetry_degraded', text: hookFallback.error,
      runtimeMetadata: { source: 'qoder_cli_log', capability: 'hooks' }
    })
  }
  return failed
}
