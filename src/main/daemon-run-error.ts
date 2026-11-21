// The named failures of the App's run surface against its own daemon. Kept apart from
// the transport so the frame readers (the transport and its trace read) share one
// error type without importing each other.

export type DaemonRunFailure =
  | 'daemon_not_running'
  | 'daemon_device_not_authorized'
  | 'daemon_run_unknown'
  | 'daemon_stop_not_confirmed'
  | 'daemon_answer_not_delivered'
  | 'daemon_run_control_unavailable'
  // The request was written and no reply came back: the daemon may or may not have
  // acted. Callers reconcile (by intent id) and never resend.
  | 'daemon_outcome_unknown'
  // A start was submitted, the reply was lost, and the daemon could not confirm what
  // it recorded. Reported as unknown so the App never starts the same prompt twice.
  | 'daemon_submit_unknown'
  | 'command_payload_conflict'
  | 'daemon_attachment_transfer_failed'
  | 'daemon_attachment_limit_exceeded'
  | 'daemon_submit_payload_too_large'
  | 'invalid_daemon_response'

export class DaemonRunError extends Error {
  readonly reason: DaemonRunFailure
  constructor(reason: DaemonRunFailure) {
    super(reason)
    this.name = 'DaemonRunError'
    this.reason = reason
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function fail(): never {
  throw new DaemonRunError('invalid_daemon_response')
}
