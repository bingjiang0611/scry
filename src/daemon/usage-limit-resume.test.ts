import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import {
  decideUsageLimitResume,
  submitUsageLimitResume,
  usageLimitResumeCommandId,
  type UsageLimitPending
} from './usage-limit-resume'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function sinkWithSession(): EventSink {
  const userData = mkdtempSync(join(tmpdir(), 'scry-usage-limit-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  sink.execute({
    type: 'session.create',
    commandId: 'create-1',
    actor: 'system',
    scope: 'system',
    at: 1,
    payload: { sessionKey: 'native-1', provider: 'codex', profile: null, cwd: '/w' }
  } as never)
  return sink
}

const resetAt = 1_700_000_000_000
const pending = (overrides: Partial<UsageLimitPending> = {}): UsageLimitPending => ({
  sessionKey: 'native-1',
  provider: 'codex',
  profile: null,
  cwd: '/w',
  prompt: '继续修复测试',
  recordedAt: resetAt - 60_000,
  resetAt,
  source: 'relative',
  ...overrides
})

// C4: an automatic resume spends the user's quota, so it happens only when the user asked for it and
// only when the Provider named a reset time. A due resume is an ordinary queued agent submit, and the
// derived command id keeps a re-armed timer from submitting twice.
describe('usage-limit resume', () => {
  it('never resumes a limit without a reset time', () => {
    expect(decideUsageLimitResume(pending({ resetAt: null, source: null }), { autoResume: true }, resetAt + 1))
      .toEqual({ status: 'no_reset_time' })
  })

  it('stays disabled while the user has not turned it on', () => {
    expect(decideUsageLimitResume(pending(), { autoResume: false }, resetAt + 1)).toEqual({ status: 'disabled' })
  })

  it('waits for the reset time it read from the Provider', () => {
    expect(decideUsageLimitResume(pending(), { autoResume: true }, resetAt - 1))
      .toEqual({ status: 'not_due', at: resetAt })
  })

  it('submits one deterministic resume once the reset time has passed', () => {
    const first = decideUsageLimitResume(pending(), { autoResume: true }, resetAt)
    const second = decideUsageLimitResume(pending(), { autoResume: true }, resetAt + 30_000)
    expect(first).toMatchObject({ status: 'submit', commandId: usageLimitResumeCommandId(pending()) })
    expect(second).toMatchObject({ status: 'submit' })
    // Re-arming the timer must not produce a second submit.
    expect(second.status === 'submit' && second.commandId).toBe(first.status === 'submit' && first.commandId)
  })

  it('records an agent-origin queued run and treats the repeat as a duplicate', () => {
    const sink = sinkWithSession()
    try {
      const first = submitUsageLimitResume(sink, pending(), resetAt + 1)
      const second = submitUsageLimitResume(sink, pending(), resetAt + 2)
      expect(first.status).toBe('recorded')
      expect(second).toEqual({ status: 'duplicate', runId: first.runId })
    } finally {
      sink.close()
    }
  })

  it('refuses to submit without a reset time or a writable store', () => {
    expect(submitUsageLimitResume(sinkWithSession(), pending({ resetAt: null }), resetAt))
      .toEqual({ status: 'unavailable', reason: 'usage_limit_without_reset_time' })
    expect(submitUsageLimitResume(undefined, pending(), resetAt))
      .toEqual({ status: 'unavailable', reason: 'orchestration_unavailable' })
  })
})
