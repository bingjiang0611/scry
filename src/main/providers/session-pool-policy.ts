/**
 * C1: every Provider that keeps a process uses the same lifetime policy, so "released because idle"
 * means the same thing on every Provider and the host can compare them.
 *
 * Idle is 20 minutes, clamped to 15–30. The cap is 8 live processes. The environment override exists
 * so a test can reach the window without waiting a quarter of an hour.
 */
export const SESSION_IDLE_MIN_MS = 15 * 60_000
export const SESSION_IDLE_MAX_MS = 30 * 60_000
export const SESSION_IDLE_DEFAULT_MS = 20 * 60_000
export const SESSION_POOL_CAP = 8

/** `crashed` says the process died under the pool, so the close is a cleanup, not a policy choice. */
export type SessionReleaseReason = 'idle' | 'lru' | 'dispose' | 'crashed'

export interface SessionLifecycleObserver {
  onOpened?: (key: string, provider: string, at: number) => void
  onNativeSessionId?: (key: string, nativeSessionId: string) => void
  onReleased?: (key: string, reason: SessionReleaseReason, at: number) => void
}

export function sessionIdleWindowMs(
  env: Readonly<Record<string, string | undefined>>,
  variable: string
): number {
  const raw = Number(env[variable])
  if (!Number.isFinite(raw) || raw <= 0) return SESSION_IDLE_DEFAULT_MS
  return Math.min(SESSION_IDLE_MAX_MS, Math.max(SESSION_IDLE_MIN_MS, raw))
}
