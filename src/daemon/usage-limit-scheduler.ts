import type Database from 'better-sqlite3'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import {
  claimUsageLimitResume,
  listPendingUsageLimits,
  releaseUsageLimitResume,
  recordUsageLimit,
  type UsageLimitRow
} from '../host-runtime/orchestration/usage-limit-store'
import type { UsageLimit } from '../main/providers/usage-limit'
import {
  decideUsageLimitResume,
  submitUsageLimitResume,
  type UsageLimitPending,
  type UsageLimitResumeSettings
} from './usage-limit-resume'

type SqliteDb = Database.Database

export interface UsageLimitSchedulerDeps {
  /** Resolved per call: the authority and its database appear after the daemon starts. */
  db: () => SqliteDb | undefined
  sink: () => EventSink | undefined
  settings: () => UsageLimitResumeSettings
  now?: () => number
  schedule?: (fn: () => void, ms: number) => { unref?: () => void }
  log?: (line: string) => void
}

export interface UsageLimitScheduler {
  /** Stores a limit the Provider reported, replacing nothing: each attempt is its own row. */
  record(input: {
    sessionKey: string
    provider: string
    profile: string | null
    cwd: string
    prompt: string
    limit: UsageLimit
  }): boolean
  /** Submits every due resume, then arms one timer for the next one. Safe to call repeatedly. */
  pump(): void
  stop(): void
}

/** Never arm a timer further out than this: a wall-clock change must not strand a pending resume. */
const MAX_ARM_MS = 6 * 60 * 60_000

function toPending(row: UsageLimitRow): UsageLimitPending {
  return {
    sessionKey: row.sessionKey,
    provider: row.provider,
    profile: row.profile,
    cwd: row.cwd,
    prompt: row.prompt,
    recordedAt: row.recordedAt,
    resetAt: row.resetAt,
    source: (row.source ?? null) as UsageLimitPending['source'],
    ...(row.window ? { window: row.window } : {})
  }
}

/**
 * C4: the daemon drives the resume it stored. Two reasons it is a scheduler and not a `setTimeout`
 * per failure: the due list is read from the database, so a restart re-arms exactly the items that
 * are still pending, and the claim happens before the submit, so two daemons cannot both resume.
 */
export function createUsageLimitScheduler(deps: UsageLimitSchedulerDeps): UsageLimitScheduler {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let timer: { unref?: () => void } | undefined

  const clearTimer = (): void => {
    if (!timer) return
    clearTimeout(timer as never)
    timer = undefined
  }

  const pump = (): void => {
    clearTimer()
    const db = deps.db()
    if (!db) return
    const settings = deps.settings()
    let nextAt: number | undefined
    for (const row of listPendingUsageLimits(db)) {
      const pending = toPending(row)
      const decision = decideUsageLimitResume(pending, settings, now())
      if (decision.status === 'not_due') {
        nextAt = nextAt === undefined ? decision.at : Math.min(nextAt, decision.at)
        continue
      }
      if (decision.status !== 'submit') continue
      // The claim is the fence: without it a second pump would submit the same resume again.
      const claimedAt = now()
      if (!claimUsageLimitResume(db, row.sessionKey, row.recordedAt, claimedAt)) continue
      const submitted = submitUsageLimitResume(deps.sink(), pending, claimedAt)
      if (submitted.status === 'unavailable') {
        // The resume never entered the queue, so the claim is released and the reason is kept: the row
        // stays pending instead of claiming a resume that did not happen.
        releaseUsageLimitResume(db, row.sessionKey, row.recordedAt, claimedAt)
        deps.log?.(`usage-limit resume not submitted for ${row.sessionKey}: ${submitted.reason}`)
      }
    }
    if (nextAt === undefined) return
    const wait = Math.min(MAX_ARM_MS, Math.max(0, nextAt - now()))
    timer = schedule(() => pump(), wait)
    timer.unref?.()
  }

  return {
    record(input) {
      const db = deps.db()
      if (!db) return false
      const at = now()
      recordUsageLimit(db, {
        sessionKey: input.sessionKey,
        resetAt: input.limit.resetAt,
        provider: input.provider,
        profile: input.profile,
        cwd: input.cwd,
        prompt: input.prompt,
        source: input.limit.source,
        window: input.limit.window ?? null,
        recordedAt: at,
        resumedAt: null
      })
      // A limit without a reset time cannot become due, so there is nothing to arm.
      if (input.limit.resetAt !== null) pump()
      return true
    },
    pump,
    stop: clearTimer
  }
}
