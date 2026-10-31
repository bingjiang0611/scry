export class UploadError extends Error {
  stage?: string
  durationMs?: number
  errorType?: string

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
