// Startup failures split by whether waiting could ever fix them. `daemon_*` and
// `remote_*` messages are machine codes produced by the lock, lease and recorder
// checks: they report a state that needs an operator (a live holder, an
// unverifiable owner, a missing private CLI), so retrying only delays the report.
// Anything else stays retryable, and free-form text is never recorded.
export const EXIT_DETERMINISTIC_STARTUP = 4

const MACHINE_CODE = /^(?:daemon|remote)_[a-z0-9_]+$/

export function classifyDaemonStartupFailure(error: unknown): { code: number; reason?: string } {
  const message = error instanceof Error ? error.message : undefined
  if (message && MACHINE_CODE.test(message)) return { code: EXIT_DETERMINISTIC_STARTUP, reason: message }
  return { code: 1 }
}