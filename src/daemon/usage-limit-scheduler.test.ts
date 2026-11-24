import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { listPendingUsageLimits } from '../host-runtime/orchestration/usage-limit-store'
import { createUsageLimitScheduler } from './usage-limit-scheduler'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function store() {
  const userData = mkdtempSync(join(tmpdir(), 'scry-usage-sched-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  sink.execute({
    type: 'session.create', commandId: 'create-1', actor: 'system', scope: 'system', at: 1,
    payload: { sessionKey: 'native-1', provider: 'codex', profile: null, cwd: '/w' }
  } as never)
  return { sink, db: sink.handle.db }
}

const limit = (resetAt: number | null) => ({ provider: 'codex' as const, resetAt, source: resetAt ? 'relative' as const : null })
const input = (resetAt: number | null) => ({
  sessionKey: 'native-1', provider: 'codex', profile: null, cwd: '/w', prompt: '重试这次改动', limit: limit(resetAt)
})

// C4: the stored item is what survives a restart, so the scheduler must read the due list, claim
// before submitting, and re-arm exactly one timer for the earliest still-pending reset.
describe('usage-limit scheduler', () => {
  it('stores a named reset time and submits nothing before it is due', () => {
    const { sink, db } = store()
    const armed: number[] = []
    const scheduler = createUsageLimitScheduler({
      db: () => db, sink: () => sink, settings: () => ({ autoResume: true }),
      now: () => 1_000, schedule: (_fn, ms) => { armed.push(ms); return {} }
    })
    expect(scheduler.record(input(61_000))).toBe(true)
    expect(listPendingUsageLimits(db)).toHaveLength(1)
    expect(armed).toHaveLength(1)
    expect(armed[0]).toBe(60_000)
    scheduler.stop()
  })

  it('submits one resume once the reset time passes and marks the row', () => {
    const { sink, db } = store()
    let clock = 1_000
    const scheduler = createUsageLimitScheduler({
      db: () => db, sink: () => sink, settings: () => ({ autoResume: true }),
      now: () => clock, schedule: () => ({})
    })
    scheduler.record(input(2_000))
    clock = 2_000
    scheduler.pump()
    // The claim already happened, so a second pump cannot submit again.
    scheduler.pump()
    expect(listPendingUsageLimits(db)).toEqual([])
    const runs = db.prepare("SELECT COUNT(*) AS n FROM orch_p_run").get() as { n: number }
    expect(runs.n).toBe(1)
    scheduler.stop()
  })

  it('leaves the row pending while auto-resume is off', () => {
    const { sink, db } = store()
    let clock = 5_000
    const scheduler = createUsageLimitScheduler({
      db: () => db, sink: () => sink, settings: () => ({ autoResume: false }),
      now: () => clock, schedule: () => ({})
    })
    scheduler.record(input(2_000))
    clock = 9_000
    scheduler.pump()
    expect(listPendingUsageLimits(db)).toHaveLength(1)
    scheduler.stop()
  })

  it('keeps a limit without a reset time as a record but never arms it', () => {
    const { sink, db } = store()
    const armed: number[] = []
    const scheduler = createUsageLimitScheduler({
      db: () => db, sink: () => sink, settings: () => ({ autoResume: true }),
      now: () => 1_000, schedule: (_fn, ms) => { armed.push(ms); return {} }
    })
    scheduler.record(input(null))
    expect(armed).toEqual([])
    expect(listPendingUsageLimits(db)).toEqual([])
    scheduler.stop()
  })
})
