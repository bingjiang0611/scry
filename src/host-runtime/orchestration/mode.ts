import { DEFAULT_PENDING_TTL_MS } from './types'

export type OrchestrationRequestedMode = 'off' | 'shadow' | 'on'
export type OrchestrationEffectiveMode = 'off' | 'shadow' | 'on'

export interface OrchestrationModeResolution {
  requested: OrchestrationRequestedMode
  effective: OrchestrationEffectiveMode
  refused: boolean
  reason?: string
}

export const ORCHESTRATION_MODE_ENV = 'SCRY_ORCHESTRATION'
export const ORCHESTRATION_FULLFSYNC_ENV = 'SCRY_ORCHESTRATION_FULLFSYNC'
export const ORCHESTRATION_PENDING_TTL_ENV = 'SCRY_ORCHESTRATION_PENDING_TTL_MS'
export const MAX_PENDING_TTL_MS = DEFAULT_PENDING_TTL_MS

export function parseOrchestrationMode(env: NodeJS.ProcessEnv): OrchestrationModeResolution {
  const raw = env[ORCHESTRATION_MODE_ENV]?.trim().toLowerCase()
  if (raw === 'shadow') return { requested: 'shadow', effective: 'shadow', refused: false }
  if (raw === 'on') return { requested: 'on', effective: 'on', refused: false }
  return { requested: 'off', effective: 'off', refused: false }
}

export function parseOrchestrationFullfsync(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[ORCHESTRATION_FULLFSYNC_ENV]?.trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  return undefined
}

/**
 * Parses `SCRY_ORCHESTRATION_PENDING_TTL_MS`, capped strictly at `MAX_PENDING_TTL_MS` (60 s)
 * so the variable can shorten the TTL for tests without ever extending past Decision B's bound.
 */
export function parsePendingTtlMs(env: NodeJS.ProcessEnv, fallback = DEFAULT_PENDING_TTL_MS): number {
  const boundedFallback = Math.min(Math.max(1, fallback), MAX_PENDING_TTL_MS)
  const raw = env[ORCHESTRATION_PENDING_TTL_ENV]
  if (!raw) return boundedFallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return boundedFallback
  return Math.min(Math.floor(parsed), MAX_PENDING_TTL_MS)
}
