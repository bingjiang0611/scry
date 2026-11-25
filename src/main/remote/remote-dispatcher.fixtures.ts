import { type LedgerEvent, type LedgerStore } from './session-ledger'
import type { RemoteExecutor, RemoteExecutorInput } from './remote-dispatcher'

// Shared doubles for the dispatcher tests: a ledger that keeps its event log in memory, an executor
// the test resolves by hand, and a durable-outbox stand-in that records how a row was settled.

export class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[]
  constructor(seed: LedgerEvent[] = []) { this.log = seed.map((e) => ({ ...e })) }
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return this.log.map((e) => ({ ...e })) }
  append(event: LedgerEvent): void { this.log.push({ ...event }) }
}

// A controllable executor whose completion the test resolves explicitly.
export function deferredExecutor() {
  const calls: string[] = []
  const gates = new Map<string, { resolve(): void; reject(e: Error): void; input: RemoteExecutorInput }>()
  const executor: RemoteExecutor = {
    execute(input) {
      calls.push(input.runId)
      return new Promise<void>((resolve, reject) => gates.set(input.runId, { resolve, reject, input }))
    }
  }
  return { executor, calls, gates }
}

export function memoryOutbox(seed: Array<{ effectId: string; runId: string | null; kind?: string; expiresAt?: number }>) {
  const rows = seed.map((row) => ({
    effectId: row.effectId,
    kind: row.kind ?? 'provider.run.start',
    runId: row.runId,
    payload: JSON.stringify({ runId: row.runId }),
    attempts: 0,
    state: 'pending' as 'pending' | 'done' | 'failed' | 'voided',
    expiresAt: row.expiresAt,
    // R1: a settled-deferred row is invisible until its backoff elapses.
    availableAt: undefined as number | undefined
  }))
  const settled: string[] = []
  return {
    rows,
    settled,
    claim(owner: string, now: number) {
      void owner
      const expired = rows.filter((r) => r.state === 'pending' && r.expiresAt !== undefined && r.expiresAt <= now)
      for (const row of expired) row.state = 'voided'
      const row = rows.find((r) => r.state === 'pending' && (r.expiresAt === undefined || r.expiresAt > now)
        && (r.availableAt === undefined || r.availableAt <= now))
      if (!row) return { expired: expired.map((r) => ({ effectId: r.effectId, runId: r.runId })) }
      row.state = 'done'
      row.attempts += 1
      settled.push(`claim:${row.effectId}`)
      return {
        expired: expired.map((r) => ({ effectId: r.effectId, runId: r.runId })),
        effect: { effectId: row.effectId, kind: row.kind, runId: row.runId, payload: row.payload, attempts: row.attempts }
      }
    },
    succeed(effectId: string) {
      settled.push(`succeed:${effectId}`)
      return true
    },
    fail(effectId: string) {
      settled.push(`fail:${effectId}`)
      return true
    },
    retry(effectId: string) {
      settled.push(`retry:${effectId}`)
      const row = rows.find((r) => r.effectId === effectId)
      if (row) {
        row.state = 'pending'
        row.availableAt = Date.now() + 100
      }
      return { status: 'retry' as const, delayMs: 100 }
    },
    defer(effectId: string, _owner: string, _reason: string, now: number, delayMs: number) {
      settled.push(`defer:${effectId}`)
      const row = rows.find((r) => r.effectId === effectId)
      if (row) {
        row.state = 'pending'
        row.availableAt = now + delayMs
      }
      return true
    }
  }
}
