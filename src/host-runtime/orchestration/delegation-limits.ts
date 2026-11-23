import { createHash } from 'node:crypto'

export interface DelegationLimits {
  maxDepth: number
  maxConcurrentPerParentRun: number
  maxTotalPerParentRun: number
  maxHostAgentRuns: number
  writePerMinute: number
  readPerMinute: number
  interactionTimeoutMs: number
  maxWaitMs: number
}

export const DEFAULT_DELEGATION_LIMITS: Readonly<DelegationLimits> = {
  maxDepth: 1,
  maxConcurrentPerParentRun: 4,
  maxTotalPerParentRun: 8,
  maxHostAgentRuns: 8,
  writePerMinute: 6,
  readPerMinute: 60,
  interactionTimeoutMs: 30 * 60_000,
  maxWaitMs: 20_000
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}

export function readDelegationLimits(env: NodeJS.ProcessEnv = process.env): DelegationLimits {
  return {
    maxDepth: DEFAULT_DELEGATION_LIMITS.maxDepth,
    maxConcurrentPerParentRun: parsePositiveInt(env.SCRY_P6_MAX_CONCURRENT_PER_PARENT, DEFAULT_DELEGATION_LIMITS.maxConcurrentPerParentRun, 64),
    maxTotalPerParentRun: parsePositiveInt(env.SCRY_P6_MAX_TOTAL_PER_PARENT, DEFAULT_DELEGATION_LIMITS.maxTotalPerParentRun, 128),
    maxHostAgentRuns: parsePositiveInt(env.SCRY_P6_MAX_HOST_AGENT_RUNS, DEFAULT_DELEGATION_LIMITS.maxHostAgentRuns, 128),
    writePerMinute: parsePositiveInt(env.SCRY_P6_WRITE_RATE_LIMIT, DEFAULT_DELEGATION_LIMITS.writePerMinute, 600),
    readPerMinute: parsePositiveInt(env.SCRY_P6_READ_RATE_LIMIT, DEFAULT_DELEGATION_LIMITS.readPerMinute, 6_000),
    interactionTimeoutMs: parsePositiveInt(env.SCRY_P6_INTERACTION_TIMEOUT_MS, DEFAULT_DELEGATION_LIMITS.interactionTimeoutMs, 24 * 60 * 60_000),
    maxWaitMs: parsePositiveInt(env.SCRY_P6_MAX_WAIT_MS, DEFAULT_DELEGATION_LIMITS.maxWaitMs, 20_000)
  }
}

/**
 * Deterministic UUID-shaped command ID for agent write tools (D20 / L1 / L3):
 * `sha256(tool \0 actorRunId \0 clientRequestId)` formatted as a v4-like UUID.
 */
export function agentCommandId(tool: string, actorRunId: string, clientRequestId: string): string {
  const hex = createHash('sha256')
    .update(`${tool}\0${actorRunId}\0${clientRequestId}`)
    .digest('hex')
    .slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

export type RateLimitKind = 'read' | 'write'

export class PerRunRateLimiter {
  readonly #writePerMinute: number
  readonly #readPerMinute: number
  readonly #clock: () => number
  readonly #windows = new Map<string, number[]>()

  constructor(options: { writePerMinute: number; readPerMinute: number; clock?: () => number }) {
    this.#writePerMinute = options.writePerMinute
    this.#readPerMinute = options.readPerMinute
    this.#clock = options.clock ?? (() => Date.now())
  }

  consume(runId: string, kind: RateLimitKind): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.#clock()
    const limit = kind === 'write' ? this.#writePerMinute : this.#readPerMinute
    const key = `${kind}\0${runId}`
    const cutoff = now - 60_000
    const timestamps = (this.#windows.get(key) ?? []).filter((ts) => ts > cutoff)
    if (timestamps.length >= limit) {
      const oldest = timestamps[0]!
      const retryAfterMs = Math.max(1, oldest + 60_000 - now)
      this.#windows.set(key, timestamps)
      return { ok: false, retryAfterMs }
    }
    timestamps.push(now)
    this.#windows.set(key, timestamps)
    return { ok: true }
  }

  clearRun(runId: string): void {
    this.#windows.delete(`read\0${runId}`)
    this.#windows.delete(`write\0${runId}`)
  }
}
