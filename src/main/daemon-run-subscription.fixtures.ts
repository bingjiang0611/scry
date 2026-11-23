import type { SubscribeActiveRunRow, SubscribeEventItem, SubscribeHint } from '../shared/orchestration-subscribe'
import type { DaemonRunRuntime } from './daemon-run-runtime'

export function subscribedRun(runId: string, input: Partial<SubscribeActiveRunRow> = {}): SubscribeActiveRunRow {
  return {
    runId, scope: 'local', lifecycle: 'dispatched', sessionKey: null, origin: 'app',
    provider: 'codex', profile: null, cwd: '/w', promptPreview: null, stopState: null,
    outputSeq: null, intentSeq: 1, settledAt: null, recoveredAt: null, outcome: null, revSeq: 1,
    ...input
  }
}

export function runEvent(type: string, runId: string, payload: Record<string, unknown> = {},
  runRow?: SubscribeActiveRunRow): SubscribeEventItem {
  return { seq: 1, type, runId, stream: `run:${runId}`, at: 0, payload, runRow }
}

export function announceRun(runtime: DaemonRunRuntime, runId: string, fields: Partial<Extract<SubscribeHint, { kind: 'run' }>> = {}) {
  return runtime.applyRunHint({
    kind: 'run', runId, scryRunId: runId, outputSeq: 1,
    cwd: '/w', providerId: 'codex', admitted: true, ...fields
  })
}
