import { DEFAULT_PENDING_TTL_MS } from './types'

export const ORCHESTRATION_FULLFSYNC_ENV = 'SCRY_ORCHESTRATION_FULLFSYNC'
export const ORCHESTRATION_PENDING_TTL_ENV = 'SCRY_ORCHESTRATION_PENDING_TTL_MS'
export const MAX_PENDING_TTL_MS = DEFAULT_PENDING_TTL_MS

export function parseOrchestrationFullfsync(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[ORCHESTRATION_FULLFSYNC_ENV]?.trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  return undefined
}

export function parsePendingTtlMs(env: NodeJS.ProcessEnv, fallback = DEFAULT_PENDING_TTL_MS): number {
  const boundedFallback = Math.min(Math.max(1, fallback), MAX_PENDING_TTL_MS)
  const raw = env[ORCHESTRATION_PENDING_TTL_ENV]
  if (!raw) return boundedFallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return boundedFallback
  return Math.min(Math.floor(parsed), MAX_PENDING_TTL_MS)
}
