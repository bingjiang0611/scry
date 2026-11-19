export type OrchestrationRequestedMode = 'off' | 'shadow' | 'on'
export type OrchestrationEffectiveMode = 'off' | 'shadow'

export interface OrchestrationModeResolution {
  requested: OrchestrationRequestedMode
  /**
   * P4-1 implements `off` and `shadow`. When `SCRY_ORCHESTRATION=on` is passed (for example
   * by the daemon CI matrix before P4-2 switches authority), it runs in `shadow` mode so the
   * orchestration store, incremental import, and shadow writes execute without changing run authority.
   */
  effective: OrchestrationEffectiveMode
}

export const ORCHESTRATION_MODE_ENV = 'SCRY_ORCHESTRATION'
export const ORCHESTRATION_FULLFSYNC_ENV = 'SCRY_ORCHESTRATION_FULLFSYNC'
export const ORCHESTRATION_PENDING_TTL_ENV = 'SCRY_ORCHESTRATION_PENDING_TTL_MS'

export function parseOrchestrationMode(env: NodeJS.ProcessEnv): OrchestrationModeResolution {
  const raw = env[ORCHESTRATION_MODE_ENV]?.trim().toLowerCase()
  if (raw === 'shadow') return { requested: 'shadow', effective: 'shadow' }
  if (raw === 'on') return { requested: 'on', effective: 'shadow' }
  return { requested: 'off', effective: 'off' }
}

export function parseOrchestrationFullfsync(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[ORCHESTRATION_FULLFSYNC_ENV]?.trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  return undefined
}

export function parsePendingTtlMs(env: NodeJS.ProcessEnv, fallback = 60_000): number {
  const raw = env[ORCHESTRATION_PENDING_TTL_ENV]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
