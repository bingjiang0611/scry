import type { AgentSteerInput, AgentSteerResult } from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import type { QoderSessionLease } from './qoder-session-pool'
import { steerKeptQoderSession } from './qoder-session'

/**
 * C2: steer on Qoder's kept session, kept out of the run module so its lifecycle stays readable.
 *
 * The capability is announced only once a session is actually kept: before that, the honest answer is
 * "no native steer" and the dispatcher's restart path applies.
 */
export function qoderSteerCapability(runId: string, sessionKey: string, id: string, ts: string): TraceEvent {
  return {
    id, runId, ts, kind: 'harness',
    stage: 'runtime:steer_capability',
    steerCapability: { status: 'available', attachments: false },
    runtimeMetadata: { source: 'qoder_kept_session', sessionKey }
  }
}

/** A run that has settled, stopped or lost its session cannot take input any more. */
export function steerQoderRun(
  lease: QoderSessionLease | undefined,
  input: AgentSteerInput,
  live: boolean
): AgentSteerResult {
  if (!lease || !live) return { status: 'unavailable', message: '当前这一轮已结束，消息未作为 Steer 发送。' }
  return steerKeptQoderSession(lease, input)
}
