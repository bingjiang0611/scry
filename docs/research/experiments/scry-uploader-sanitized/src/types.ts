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
  lastError?: { at: string; code: string; message: string }
}

export interface CustodyReceipt {
  version: 1
  recordId: string
  sequence: number
  sha256: string
  provider?: string
  sessionId?: string
  status: 'pending' | 'skipped_disabled' | 'uploaded' | 'dead_letter'
  takenAt: string
  remoteStatus?: string
  finishedAt?: string
  releasedAt?: string
  wakeupQueuedAt?: string
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
    kind: 'report_timeout'
    attempts: number
    notBeforeMs: number
  }
}

export interface QueueJob {
  version: 1
  id: string
  kind: 'record-commit' | 'wakeup'
  workspace: string
  createdAt: string
  attempts: number
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
}
