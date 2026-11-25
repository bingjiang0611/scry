import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { listPendingUsageLimits } from '../host-runtime/orchestration/usage-limit-store'
import { createUsageLimitScheduler } from './usage-limit-scheduler'
import { quotaFailureIdentity, recordQuotaFailure, USAGE_LIMIT_RESUME_PROMPT } from './usage-limit-capture'
import { submitAgentWake } from './agent-wake'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function store() {
  const userData = mkdtempSync(join(tmpdir(), 'scry-usage-capture-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  sink.execute({
    type: 'session.create', commandId: 'create-1', actor: 'system', scope: 'system', at: 1,
    payload: { sessionKey: 'native-1', provider: 'codex', profile: null, cwd: '/w' }
  } as never)
  return { sink, db: sink.handle.db }
}

const now = 1_700_000_000_000
const base = { sessionKey: 'native-1', cwd: '/w', provider: 'codex', profile: null, now }
const schedulerFor = (deps: ReturnType<typeof store>) => createUsageLimitScheduler({
  db: () => deps.db, sink: () => deps.sink, settings: () => ({ autoResume: true }),
  now: () => now, schedule: () => ({})
})

// C4: only an actual quota failure with a known session becomes a pending resume. Another error, a
// message that is not a quota, or a run whose session is already gone records nothing.
describe('usage-limit capture from a failed run', () => {
  it('records a pending resume for a quota failure with a reset time', () => {
    const deps = store()
    try {
      const scheduler = schedulerFor(deps)
      expect(recordQuotaFailure(scheduler, {
        ...base, detail: '429 rate limit exceeded; resets in 30 minutes'
      })).toBe(true)
      const rows = listPendingUsageLimits(deps.db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sessionKey: 'native-1', cwd: '/w', provider: 'codex', prompt: USAGE_LIMIT_RESUME_PROMPT })
      expect(rows[0].resetAt).toBe(now + 30 * 60_000)
      scheduler.stop()
    } finally {
      deps.sink.close()
    }
  })

  it('records nothing for a failure that is not a quota', () => {
    const deps = store()
    try {
      const scheduler = schedulerFor(deps)
      expect(recordQuotaFailure(scheduler, { ...base, detail: 'Qoder CLI 已退出（code=1）' })).toBe(false)
      expect(listPendingUsageLimits(deps.db)).toEqual([])
      scheduler.stop()
    } finally {
      deps.sink.close()
    }
  })

  it('resolves the failed run\'s session from the projection', () => {
    const deps = store()
    try {
      // A real run row, written by the same submit path a dispatch uses.
      const wake = submitAgentWake(deps.sink, {
        taskId: 'task-1', sessionKey: 'native-1', provider: 'codex', profile: null, cwd: '/w', prompt: '继续'
      }, 10)
      expect(wake.runId).toBeDefined()
      expect(quotaFailureIdentity(deps.db, wake.runId!)).toEqual({
        sessionKey: 'native-1', cwd: '/w', provider: 'codex', profile: null
      })
      expect(quotaFailureIdentity(deps.db, 'missing-run')).toBeUndefined()
    } finally {
      deps.sink.close()
    }
  })

  it('records nothing when the session is no longer known', () => {
    const deps = store()
    try {
      const scheduler = schedulerFor(deps)
      expect(recordQuotaFailure(scheduler, {
        ...base, sessionKey: undefined, detail: '429 rate limit; retry after 60'
      })).toBe(false)
      expect(listPendingUsageLimits(deps.db)).toEqual([])
      scheduler.stop()
    } finally {
      deps.sink.close()
    }
  })
})
