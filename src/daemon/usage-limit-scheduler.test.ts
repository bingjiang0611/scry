import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { listPendingUsageLimits } from '../host-runtime/orchestration/usage-limit-store'
import { createUsageLimitScheduler } from './usage-limit-scheduler'
import { usageLimitResumeSettings } from './usage-limit-resume'
import { writeUsageLimitResumeSwitch } from '../shared/background-service'

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

// B5 (review): the claim is the fence, but a claim without a submit claims something that never
// happened — and the row is excluded from the pending list forever, so the resume is silently lost.
describe('usage-limit scheduler: a resume that was not submitted keeps its row pending', () => {
  it('releases the claim, logs the reason, and retries on the next pump', () => {
    const { sink, db } = store()
    let clock = 1_000
    const logged: string[] = []
    let sinkAvailable = false
    const scheduler = createUsageLimitScheduler({
      db: () => db,
      // The authority is not ready yet, so the submit is refused before anything is written.
      sink: () => (sinkAvailable ? sink : undefined),
      settings: () => ({ autoResume: true }),
      now: () => clock, schedule: () => ({}),
      log: (line) => logged.push(line)
    })
    scheduler.record(input(2_000))
    clock = 2_000
    scheduler.pump()
    expect(listPendingUsageLimits(db)).toHaveLength(1)
    expect(logged[0]).toContain('usage-limit resume not submitted')
    sinkAvailable = true
    scheduler.pump()
    expect(listPendingUsageLimits(db)).toEqual([])
    scheduler.stop()
  })
})

// C4 (review): the resume is an outbox write, and the dispatcher is the only thing that drains it. The
// scheduler had no pump, so a resume submitted at the reset time sat pending until unrelated activity.
describe('usage-limit scheduler: a submitted resume drives the dispatcher', () => {
  it('pumps after an accepted resume and not when the submit is refused', () => {
    const { sink, db } = store()
    let clock = 1_000
    let pumped = 0
    let available = false
    const scheduler = createUsageLimitScheduler({
      db: () => db,
      sink: () => (available ? sink : undefined),
      settings: () => ({ autoResume: true }),
      now: () => clock, schedule: () => ({}),
      pump: () => { pumped += 1 },
      log: () => {}
    })
    scheduler.record(input(2_000))
    clock = 2_000
    scheduler.pump()
    expect(pumped).toBe(0)
    available = true
    scheduler.pump()
    expect(pumped).toBe(1)
    scheduler.stop()
  })
})

describe('C4: where the resume switch comes from', () => {
  it('follows the App switch file, and the environment is an explicit override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scry-usage-limit-where-'))
    try {
      expect(usageLimitResumeSettings({}, dir)).toEqual({ autoResume: false })
      writeUsageLimitResumeSwitch(dir, true)
      expect(usageLimitResumeSettings({}, dir)).toEqual({ autoResume: true })
      // The override enables a host that has no App switch; it never disables a switch the user turned on.
      expect(usageLimitResumeSettings({ SCRY_USAGE_LIMIT_AUTO_RESUME: '1' }, dir)).toEqual({ autoResume: true })
      writeUsageLimitResumeSwitch(dir, false)
      expect(usageLimitResumeSettings({ SCRY_USAGE_LIMIT_AUTO_RESUME: '1' }, dir)).toEqual({ autoResume: true })
      expect(usageLimitResumeSettings({ SCRY_USAGE_LIMIT_AUTO_RESUME: '0' }, dir)).toEqual({ autoResume: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
