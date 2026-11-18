import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { providerRecordingPolicy } from './provider-recording-policy'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// A recording failure inside the daemon is only visible to the user if the run's own
// error travels back through the trace frame. In the App's own process the executor
// also sends `agent:error`; a daemon run has no such channel, so the frame is the whole
// evidence. Dropping these fields would leave a blocked session looking healthy.

const RUN = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f'
const CANONICAL = 'remote-run-mw6osn9o-0'
const CONTEXT = { cwd: '/w', providerId: 'codex' }

describe('recording failure evidence (L3: the daemon frame is the whole message)', () => {
  it('keeps the recording error and recovery hint the daemon reported', async () => {
    const policy = providerRecordingPolicy('completed', { message: 'disk full' })
    if (!('rendererError' in policy)) throw new Error('a recording failure must block the session')
    const failed: ActiveRun = {
      runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: true,
      providerSettled: true,
      error: policy.rendererError.message,
      errorHint: '清理磁盘后重试；这一轮的 Scry 记录不完整。'
    }
    const request = async (payload: Record<string, unknown>): Promise<unknown> => {
      if (payload.op === 'submit') return { runId: RUN, status: 'recorded' }
      if (payload.op === 'watch') {
        const bound = { runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: CANONICAL, providerId: 'codex', cwd: '/w' }) }
        return { watch: { state: 'failed', poll: { cursor: 1, events: [bound] } } }
      }
      if (payload.op === 'desktop') return { desktop: { kind: 'trace', run: failed, cursor: { revision: 'r1', count: 0 } } }
      if (payload.op === 'questions') return { questions: [] }
      return { error: 'unknown_op' }
    }
    const runtime = new DaemonRunRuntime({
      transport: new DaemonRunTransport(request),
      send: () => {},
      bridge: new TraceOutputBridge({ canSend: () => true, send: () => {}, schedule: (fn) => { fn(); return () => {} } }),
      waitMs: 0
    })
    await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    const view = runtime.runView(CANONICAL)
    runtime.dispose()
    expect(view).toMatchObject({ error: policy.rendererError.message, errorHint: failed.errorHint, done: true })
    // The wording is the same one the in-process path puts in front of the user.
    expect(view?.error).toContain('但 Scry 精确记录不完整')
  })
})
