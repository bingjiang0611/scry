import type Database from 'better-sqlite3'
import {
  claimNextEffect,
  deferEffect,
  failEffect,
  retryEffect,
  succeedEffect,
} from '../host-runtime/orchestration/effect-outbox'
import type { OrchestrationOutboxGate } from '../main/remote/orchestration-seam'

/** B1: exposes the durable effect outbox to the remote dispatcher (kept out of the 20 KB authority file). */
export function createOutboxGate(db: () => Database.Database): OrchestrationOutboxGate {
  return {
    claim: (owner, now) => {
      // Every kind this dispatcher can execute, not just run starts: stop and question answers are
      // queued effects too. A kind it cannot run is failed by name instead of sitting unclaimed
      // (A4: `unhandled_effect_kind:<kind>`), so filtering here would strand stop forever.
      const { expired, effect } = claimNextEffect({ db: db(), owner, now })
      return effect ? { expired, effect } : { expired }
    },
    succeed: (effectId, owner, now) => succeedEffect({ db: db(), effectId, owner, now }),
    fail: (effectId, owner, now, reason) => failEffect({ db: db(), effectId, owner, now, reason }),
    defer: (effectId, owner, reason) => deferEffect({ db: db(), effectId, owner, reason }),
    retry: (effectId, owner, now, reason) => {
      const outcome = retryEffect({ db: db(), effectId, owner, now, reason })
      return outcome.status === 'retry'
        ? { status: outcome.status, delayMs: outcome.delayMs }
        : { status: outcome.status }
    }
  }
}
