import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { listPendingUsageLimits } from '../host-runtime/orchestration/usage-limit-store'
import { createAuthorityRunTerminalHandler } from './orchestration-run-terminal'
import { createUsageLimitScheduler } from './usage-limit-scheduler'
import { createQuotaFailureHook } from './usage-limit-capture'
import { submitAgentWake } from './agent-wake'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const now = 1_700_000_000_000

function harness() {
  const userData = mkdtempSync(join(tmpdir(), 'scry-usage-terminal-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  sink.execute({
    type: 'session.create', commandId: 'create-1', actor: 'system', scope: 'system', at: 1,
    payload: { sessionKey: 'native-1', provider: 'codex', profile: null, cwd: '/w' }
  } as never)
  const run = submitAgentWake(sink, {
    taskId: 'task-1', sessionKey: 'native-1', provider: 'codex', profile: null, cwd: '/w', prompt: '继续'
  }, 10)
  const armed: number[] = []
  const scheduler = createUsageLimitScheduler({
    db: () => sink.handle.db, sink: () => sink, settings: () => ({ autoResume: true }),
    now: () => now, schedule: (_fn, ms) => { armed.push(ms); return {} }
  })
  const terminalWriteback: string[] = []
  const handler = createAuthorityRunTerminalHandler({
    engine: {
      recordProgress: vi.fn(),
      recordTerminal: (input: { runId: string }) => { terminalWriteback.push(input.runId) }
    },
    liveRunMeta: () => undefined,
    resolveCanonical: (runId) => runId,
    schedule: () => {},
    evidenceFor: () => ['provider'],
    releaseRun: () => {},
    onProviderFailure: createQuotaFailureHook(() => sink, () => scheduler, () => now)
  })
  return { sink, runId: run.runId!, armed, scheduler, handler, terminalWriteback }
}

// C4: the daemon path end to end — a failed run whose text is a quota writes the pending resume and
// arms one timer for its reset; a failure that is not a quota writes nothing.
describe('quota failure through the terminal handler', () => {
  it('records one pending resume and arms one timer for a quota failure', () => {
    const h = harness()
    try {
      h.handler(h.runId, 'failed', '429 rate limit exceeded; resets in 45 minutes')
      const rows = listPendingUsageLimits(h.sink.handle.db)
      expect(rows).toHaveLength(1)
      expect(rows[0].resetAt).toBe(now + 45 * 60_000)
      expect(h.armed).toEqual([45 * 60_000])
    } finally {
      h.scheduler.stop()
      h.sink.close()
    }
  })

  it('records nothing for a failure that is not a quota', () => {
    const h = harness()
    try {
      h.handler(h.runId, 'failed', 'Qoder CLI 已退出，但 SDK 事件流未结束')
      expect(listPendingUsageLimits(h.sink.handle.db)).toEqual([])
      expect(h.armed).toEqual([])
    } finally {
      h.scheduler.stop()
      h.sink.close()
    }
  })

  it('records nothing when the same run is reported failed twice', () => {
    const h = harness()
    try {
      h.handler(h.runId, 'failed', '429 rate limit exceeded; retry after 60')
      h.handler(h.runId, 'failed', '429 rate limit exceeded; retry after 60')
      // One row per attempt: a repeated report at the same instant is the same recorded_at.
      expect(listPendingUsageLimits(h.sink.handle.db)).toHaveLength(1)
    } finally {
      h.scheduler.stop()
      h.sink.close()
    }
  })
})

// B1/D4: the conversation writeback is an outcome of the terminal record, so it must be asked for only
// after that record exists — never for a run whose terminal was not written.
describe('terminal writeback hook', () => {
  it('asks for the conversation writeback exactly once, after the terminal is recorded', () => {
    const h = harness()
    const asked: string[] = []
    const handler = createAuthorityRunTerminalHandler({
      engine: { recordProgress: vi.fn(), recordTerminal: () => { asked.push('terminal') } },
      liveRunMeta: () => undefined,
      resolveCanonical: (runId) => runId,
      schedule: () => {},
      evidenceFor: () => ['provider'],
      releaseRun: () => {},
      onTerminalRecorded: (runId) => { asked.push(`writeback:${runId}`) }
    })
    try {
      handler(h.runId, 'settled')
      expect(asked).toEqual(['terminal', `writeback:${h.runId}`])
    } finally {
      h.scheduler.stop()
    }
  })
})
