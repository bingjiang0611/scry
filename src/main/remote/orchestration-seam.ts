import type { AgentQuestionResponse } from '../../shared/runtime'
import type { LedgerStore, RunLifecycle } from './session-ledger'

/**
 * Pure interface seam for P4-2 authoritative orchestration.
 * Kept in `src/main/remote/` with zero imports from `src/host-runtime/orchestration/`
 * so Electron main preserves the Layer 3 single-writer static import boundary (core §2.9).
 */
export interface OrchestrationImmediateDispatchChecks {
  isPeerAuthorized: (peerCertSHA256: string) => boolean
  authorizeWorkspace: (cwd: string) => string
  isProviderAuthenticating: (provider: string, profile: string | null) => boolean
}

/**
 * B1: the durable effect outbox the dispatcher must claim from. Structurally compatible with
 * `RemoteDispatcherOutbox`; kept dependency-free for the Layer 3 import boundary.
 */
export interface OrchestrationOutboxGate {
  /** Expired rows are reported with the claim so their runs can be cancelled, never dropped. */
  claim(owner: string, now: number): {
    expired: Array<{ effectId: string; runId: string | null }>
    effect?: { effectId: string; kind: string; runId: string | null; payload: string; attempts: number }
  }
  succeed(effectId: string, owner: string, now: number): boolean
  fail(effectId: string, owner: string, now: number, reason: string): boolean
  /**
   * Policy deferral: back to pending without spending an attempt. `delayMs` is when it may be
   * claimed again, so a held row cannot become the head of every other session's queue.
   */
  defer(effectId: string, owner: string, reason: string, now: number, delayMs: number): boolean
  /** Clears every backoff after the condition that held the rows has actually changed. */
  wake?(): void
  retry(effectId: string, owner: string, now: number, reason: string): { status: string; delayMs?: number }
}

/** D3: the lineage of a session that already exists natively (fork, side chat or remote fork). */
export interface SessionLineageRecord {
  sessionKey: string
  parentSessionKey: string
  rootSessionKey?: string
  conversationId?: string | null
  provider?: string | null
  profile?: string | null
  cwd?: string | null
  title?: string | null
  lineage: { kind: 'fork' | 'side_chat' | 'delegated'; source: { sessionKey: string; runId?: string; throughOrdinal?: number }; taskId?: string }
}

export interface OrchestrationAuthorityHooks {
  currentLogId?(): string | undefined
  /**
   * D3: record a fork or side chat that already exists natively. Absent sinks report
   * `unavailable` instead of claiming the row was written.
   */
  recordSessionLineage?(input: SessionLineageRecord): { status: 'recorded' | 'unavailable'; reason?: string }
  /**
   * C3: the answer's run ended while Provider-native background work continued. The host wakes the
   * session with an `origin: 'agent'` run through D1's queue instead of holding the answered run open.
   */
  wakeBackground?(input: { runId: string; taskIds: string[]; reason: 'continuation' | 'terminal' | 'cleared' }): void
  /**
   * C4: the note a restart owes this session's next turn. Reading it removes it, so one turn gets
   * told and later turns do not.
   */
  takeRestartBackgroundNote?(runId: string): string | undefined
  /**
   * D4: rename, pin and archive are decided by the authority so the projection and every device
   * see the change, and the event names the caller that asked for it.
   */
  recordSessionMetadata?(input: {
    externalSessionId: string
    providerId: string
    agentProfileId?: string | undefined
    cwd: string
    change: { kind: 'rename'; title: string } | { kind: 'pin'; pinned: boolean } | { kind: 'archive'; archived: boolean }
    actor: string
  }): { status: 'recorded' | 'unavailable'; reason?: string }
  /** Rebuilds the transient dispatcher state from the durable log. */
  createLedgerStore(): LedgerStore
  /**
   * R5: maps a canonical run id back to the ledger run id the dispatcher's ledger is keyed by. A
   * non-v4 id gets its own ledger id, so the two are not interchangeable.
   */
  ledgerIdForRun(runId: string): string
  /** B1: dispatch claims come from the durable outbox, not from in-memory bookkeeping. */
  outbox(): OrchestrationOutboxGate
  /** Authoritative async submit (durable >16 KiB body written BEFORE SQLite commit). */
  submitAsync(input: {
    peerCertSHA256: string
    grantScope: 'local' | 'remote'
    scopedIntentId: string
    detail?: string
    immediateDispatch?: OrchestrationImmediateDispatchChecks
    /** D2/D1: `queued` waits behind the live run instead of being rejected. */
    claimMode?: 'immediate' | 'queued'
  }, indexCommittedIntent: (ledgerRunId: string) => void): Promise<{ runId: string; status: 'recorded' | 'duplicate'; seq: number }>
  /** Authoritative sync submit (non-attachment path, durable >16 KiB body BEFORE commit). */
  submitSync(input: {
    peerCertSHA256: string
    grantScope: 'local' | 'remote'
    scopedIntentId: string
    detail?: string
    immediateDispatch?: OrchestrationImmediateDispatchChecks
  }): { runId: string; status: 'recorded' | 'duplicate'; seq: number }
  hasSubmitReceipt(peerCertSHA256: string, scopedIntentId: string): boolean
  intentStatus(peerCertSHA256: string, scopedIntentId: string): { runId: string; state: RunLifecycle }
  /** Compensates a committed submit when the dispatcher could not accept it. */
  compensateSubmitFailure(runId: string, reason: string): void
  /** Startup recovery outcome for a previously dispatched run so H1 matches orchestration.db. */
  recoveredRunLifecycle?(runId: string): 'settled' | 'failed' | 'cancelled' | 'interrupted' | undefined
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
  }):
    | { ok: true }
    | { ok: false; action: 'fail'; reason: string; detail?: string }
    | { ok: false; action: 'requeue'; reason: string; retryAfterMs?: number }
  onRunProgress(runId: string, detail?: string): void
  onRunTerminal(runId: string, step: 'settled' | 'failed' | 'cancelled', detail?: string): void
  onQuestionAnswer(input: {
    peerCertSHA256?: string
    grantScope: 'local' | 'remote'
    runId: string
    questionId: string
    answerId: string
    answerSha256: string
    /** R7: the answer the Provider must receive; the queued effect delivers exactly this. */
    response: AgentQuestionResponse
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
