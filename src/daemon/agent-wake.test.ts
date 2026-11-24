import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { submitAgentWake } from './agent-wake'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function sinkWithSession(): EventSink {
  const userData = mkdtempSync(join(tmpdir(), 'scry-wake-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  sink.execute({
    type: 'session.create',
    commandId: 'create-1',
    actor: 'system',
    scope: 'system',
    at: 1,
    payload: { sessionKey: 'native-1', provider: 'pi', profile: null, cwd: '/w' }
  } as never)
  return sink
}

const wake = {
  taskId: 'task-1', sessionKey: 'native-1', provider: 'pi', profile: null,
  cwd: '/w', prompt: '后台任务已完成：读取日志'
}

// C3: a finished background task wakes the session once, as an agent-origin queued run, so the
// reply is not stranded and never overtakes work that is already live.

describe('agent wake', () => {
  it('records one agent-origin queued run', () => {
    const sink = sinkWithSession()
    try {
      const result = submitAgentWake(sink, wake, 1_700_000_000_000)
      expect(result.status).toBe('recorded')
      const run = sink.getRun(result.runId!)
      // Nothing was live on the session, so the wake is recorded and immediately claimable; it only
      // becomes `queued` when an earlier run is still live.
      expect(run).toMatchObject({ origin: 'agent', lifecycle: 'recorded', sessionKey: 'native-1' })
      const pending = sink.handle.db.prepare(
        "SELECT state FROM orch_outbox WHERE run_id = ? AND kind = 'provider.run.start'"
      ).get(result.runId!) as { state: string }
      expect(pending.state).toBe('pending')
      const intent = sink.listEvents().find((row) => row.type === 'run.intent_recorded')
      expect(intent?.payload).toMatchObject({ origin: 'agent' })
      const began = sink.listEvents().find((row) => row.type === 'turn.began')
      expect(began?.payload).toMatchObject({ author: 'agent' })
    } finally { sink.close() }
  })

  it('wakes once for the same task', () => {
    const sink = sinkWithSession()
    try {
      const first = submitAgentWake(sink, wake, 1_700_000_000_000)
      const second = submitAgentWake(sink, wake, 1_700_000_001_000)
      expect(second.status).toBe('duplicate')
      expect(second.runId).toBe(first.runId)
      expect(sink.listEvents().filter((row) => row.type === 'run.intent_recorded')).toHaveLength(1)
    } finally { sink.close() }
  })

  it('refuses to wake without a task or session identity', () => {
    const sink = sinkWithSession()
    try {
      expect(submitAgentWake(sink, { ...wake, taskId: '' }, 1)).toEqual({ status: 'unavailable', reason: 'agent_wake_missing_identity' })
    } finally { sink.close() }
  })
})
