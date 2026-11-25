import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { wakeBackgroundSession } from './agent-wake'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function sinkWithRun() {
  const userData = mkdtempSync(join(tmpdir(), 'scry-bg-wake-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  sink.handle.db.prepare(
    `INSERT INTO orch_p_session (session_key, conversation_id, provider, profile, cwd, title, ts, catalog, rev_seq)
     VALUES ('s-bg', NULL, 'pi', NULL, '/w', 'T', 0, NULL, 0)`
  ).run()
  sink.handle.db.prepare(
    `INSERT INTO orch_p_run (run_id, session_key, owner_actor, scope, provider, profile, cwd, origin,
       prompt_preview, lifecycle, stop_state, output_seq, intent_seq, body, rev_seq, queue_position, queue_held)
     VALUES ('run-answered', 's-bg', 'system', 'system', 'pi', NULL, '/w', 'user', 'ask', 'settled', NULL, NULL, 1, '{}', 3, NULL, 0)`
  ).run()
  return sink
}

describe('wakeBackgroundSession', () => {
  it('submits one agent-origin queued run for the session the task was reported on, and pumps', () => {
    const sink = sinkWithRun()
    let pumped = 0
    const wake = { runId: 'run-answered', taskIds: ['child-1'], reason: 'terminal' as const }
    const first = wakeBackgroundSession(sink, wake, () => { pumped += 1 })
    expect(first.status).toBe('recorded')
    expect(pumped).toBe(1)
    const run = sink.getRun(first.runId!)!
    expect(run).toMatchObject({ sessionKey: 's-bg', origin: 'agent', lifecycle: 'recorded' })
    // The prompt says the result must be checked, not assumed.
    expect(run.promptPreview).toContain('child-1')
    expect(run.promptPreview).toContain('核验')
    // The same report twice is one wake: the command id derives from the task set and the reason.
    expect(wakeBackgroundSession(sink, wake, () => { pumped += 1 }).status).toBe('duplicate')
    expect(pumped).toBe(1)
    sink.close()
  })

  it('reports a missing session instead of waking something else', () => {
    const sink = sinkWithRun()
    expect(wakeBackgroundSession(sink, { runId: 'run-gone', taskIds: ['child-1'], reason: 'terminal' }))
      .toEqual({ status: 'unavailable', reason: 'background_wake_without_session' })
    sink.close()
  })
})
