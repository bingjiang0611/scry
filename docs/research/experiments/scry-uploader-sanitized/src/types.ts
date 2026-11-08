export interface ExportPage {
  records: unknown[]
  nextCursor: number
  hasMore: boolean
  snapshotMaxSequence: number
}

export interface UploadState {
  version: 1
  enqueuedThrough: number
  workspaceId?: string
  redactionVersion?: string
  initializedAt?: string
  lastSuccessAt?: string
  /** Highest export sequence observed while uploads were disabled. */
  disabledThrough?: number
  disabledEpoch?: number
  enabledEpoch?: number
  uploadEnabled?: boolean
  lastError?: { at: string; code: string; message: string }
  /** Consecutive transport failures used for the workspace cooldown. */
  transportFailures?: number
  /** Background wakeups defer until this time instead of probing each second. */
  transportCooldownUntilMs?: number
}

export interface CustodyReceipt {
  version: 1
  recordId: string
  sequence: number
  sha256: string
  contentSha256?: string
  provider?: string
  sessionId?: string
  status: 'pending' | 'skipped_disabled' | 'uploaded' | 'dead_letter'
  takenAt: string
  remoteStatus?: string
  finishedAt?: string
  releasedAt?: string
  wakeupQueuedAt?: string
  bodyPruneStartedAt?: string
  bodyPrunedAt?: string
}

export interface OutboxEnvelope {
  version: 1
  sequence: number
  recordId: string
  workspaceId: string
  redactionVersion: string
  recordBytes: number
  record: string
  sha256?: string
  localRetry?: {
    kind: 'report_timeout' | 'report_transient' | 'report_request' | 'report_unknown'
    attempts: number
    notBeforeMs: number
    lastCode?: string
    /** First failure of the current streak; evidence must be newer than this. */
    firstAtMs?: number
  }
}

export interface QueueJob {
  version: 1
  id: string
  kind: 'record-commit' | 'wakeup'
  workspace: string
  createdAt: string
  attempts: number
  /** Consecutive failures; drives backoff and never consumes the dead-letter budget. */
  failures?: number
  maxAttempts?: number
  notBeforeMs: number
  expectedSequence?: number
  recordId?: string
  provider?: string
  sessionId?: string
  env?: Record<string, string | null>
  lastAttemptAt?: string
  lastError?: string
  rerunRequested?: boolean
  generation?: number
}

export interface RecordCommittedNotification {
  schemaVersion: number
  event: 'record-committed'
  workspace: string
  provider: string
  sessionId: string
  recordId: string
  sequence: number
  recordPath?: string
  sha256?: string
}

export interface UploadSummary {
  enqueued: number
  uploaded: number
  duplicated: number
  deadLettered: number
  pending: number
  /** Due time for remaining work after a partial/deferred invocation. */
  deferredUntilMs?: number
  /** Set only when the endpoint itself failed, not when work was merely deferred. */
  endpointFailed?: boolean
  /** Why the remaining work was deferred, when the caller must tell the cases apart. */
  deferredReason?: string
}
