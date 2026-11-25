export const EXIT_DETERMINISTIC_STARTUP = 4

const MACHINE_CODE = /^(?:daemon|remote)_[a-z0-9_]+$/

export function classifyDaemonStartupFailure(error: unknown): { code: number; reason?: string } {
  const message = error instanceof Error ? error.message : undefined
  if (message && MACHINE_CODE.test(message)) return { code: EXIT_DETERMINISTIC_STARTUP, reason: message }
  return { code: 1 }
}