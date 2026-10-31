export class UploadError extends Error {
  stage?: string
  durationMs?: number
  errorType?: string
  statusCode?: number
  exitCode?: number
  signal?: string
  stderr?: string
  retryAfterMs?: number
  /** Retry without spending the durable queue/job attempt budget. */
  deferJobAttempt?: boolean
  /** A record-level retry has been persisted, so the caller should stop this run. */
  deferred?: boolean

  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly retryAtMs?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'UploadError'
  }
}
