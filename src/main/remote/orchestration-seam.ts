import type { LedgerStore, RunLifecycle } from './session-ledger'

/**
 * Pure interface seam for P4-2 authoritative orchestration (`SCRY_ORCHESTRATION=on`).
 * Kept in `src/main/remote/` with zero imports from `src/host-runtime/orchestration/`
 * so Electron main preserves the Layer 3 single-writer static import boundary (core §2.9).
 */
export interface OrchestrationAuthorityHooks {
  /**
   * Returns an in-memory-backed `LedgerStore` whose appends mirror asynchronously to H1
   * off the pre-first-token critical path (zero synchronous H1 file fsync on hot path).
   */
  createLedgerStore(ledgerDirectory: string): { store: LedgerStore; close(): Promise<void> }
  /** Authoritative async submit (durable >16 KiB body written BEFORE SQLite commit). */
  submitAsync(input: {
    peerCertSHA256: string
    grantScope: 'local' | 'remote'
    scopedIntentId: string
    detail?: string
  }): Promise<{ runId: string; status: 'recorded' | 'duplicate'; seq: number }>
  /** Authoritative sync submit (non-attachment path, durable >16 KiB body BEFORE commit). */
  submitSync(input: {
    peerCertSHA256: string
    grantScope: 'local' | 'remote'
    scopedIntentId: string
    detail?: string
  }): { runId: string; status: 'recorded' | 'duplicate'; seq: number }
  /** Writes a permanent `resolved_absent` tombstone or returns existing intent state. */
  resolveIntent(input: {
    peerCertSHA256: string
    grantScope: 'local' | 'remote'
    scopedIntentId: string
  }): { runId: string; state: RunLifecycle }
  /**
   * Pre-dispatch recheck (`core §2.3`) + single-tx `admitted_and_dispatched` fence commit
   * BEFORE the Provider is invoked.
   */
  beforeDispatch(input: {
    runId: string
    detail?: string
    peerCertSHA256?: string
    grantScope: 'local' | 'remote'
    isPeerAuthorized: (peerCertSHA256: string) => boolean
    authorizeWorkspace: (cwd: string) => string
    isProviderAuthenticating: (provider: string, profile: string | null) => boolean
  }): { ok: true } | { ok: false; action: 'fail' | 'requeue'; reason: string }
  onRunProgress(runId: string, detail?: string): void
  onRunTerminal(runId: string, step: 'settled' | 'failed' | 'cancelled', detail?: string): void
  onQuestionAnswer(input: {
    peerCertSHA256?: string
    grantScope: 'local' | 'remote'
    runId: string
    questionId: string
    answerId: string
    answerSha256: string
  }): void
  /** Tightening-only stop: always stops live runs even during storage fence (core §2.5). */
  onRunStop(input: {
    peerCertSHA256: string
    grantScope: 'local' | 'remote'
    runId: string
    abortLive: () => boolean
  }): { status: 'requested' | 'already_requested' | 'not_running' }
  isWriteIndeterminate(): boolean
}
