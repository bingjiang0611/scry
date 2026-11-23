import { existsSync } from 'node:fs'
import type { RunRegistry, RunRegistryControl, RunRegistryState } from '../../main/run-registry'
import { BodyStore } from './body-store'
import { assertBoundedPayload, assertNoUsageNumbersInEvent, canonicalJson } from './canonical-json'
import {
  openOrchestrationDatabase,
  type OpenOrchestrationDbOptions,
  type OrchestrationDbHandle,
  type WalCheckpointResult,
  type WalCheckpointSample
} from './db'
import { getEffectPolicy } from './effect-policy'
import { findNativeSession } from './native-session-lookup'
import {
  deleteSessionInDb,
  pruneEventsInDb,
  resumeBodyErasure,
  stopRunBypassingFenceInRegistry,
  unlinkUnreferencedExternalBodyInDb,
  verifyReplayConsistencyInDb,
  type DeleteSessionInput,
  type DeleteSessionOutcome
} from './event-sink-maintenance'
import {
  listAllEventsRaw,
  listAllOutboxRaw,
  listNonTerminalChildRunsBySessionRaw,
  listNonTerminalChildRunsRaw,
  readInteractionRaw,
  readNextTurnOrdinalRaw,
  readReceiptRaw,
  readRunRaw,
  readSessionRaw,
  readTurnByRunIdRaw,
  readTurnRaw
} from './event-sink-queries'
import { prepareEventSinkStatements, type EventSinkStatements } from './event-sink-statements'
import { decide, type DecisionResult, type OrchestrationCommand, type OrchestratorReadView } from './orchestrator'
import { applyEventToProjection } from './projection'
import {
  ORCHESTRATION_EVENT_TYPES,
  OrchestrationStoreError,
  type CommandReceiptRow,
  type InteractionProjectionRow,
  type OrchestrationEventRow,
  type OutboxEffectRow,
  type RunProjectionRow,
  type SessionProjectionRow,
  type TurnProjectionRow
} from './types'

export type { DeleteSessionInput, DeleteSessionOutcome } from './event-sink-maintenance'

export interface EventSinkOptions extends OpenOrchestrationDbOptions {
  authorizedActors?: Iterable<string>
  maxActiveRuns?: number
  isProviderAuthenticating?: (provider: string, profile: string | null) => boolean
  checkpointIntervalMs?: number
  beforeCommitHook?: () => void
}

export interface EventSinkTxExtras {
  legacyLedgerSeq?: number
  legacyRunMapping?: { ledgerRunId: string; runId: string }
  requireExternalBodyDurable?: boolean
  expectedSessionDeleteEpoch?: number
}

export class EventSink {
  readonly handle: OrchestrationDbHandle
  readonly bodyStore: BodyStore
  #authorizedActors: Set<string>
  #maxActiveRuns: number
  #isProviderAuthenticating: (provider: string, profile: string | null) => boolean
  #beforeCommitHook?: () => void
  #writeIndeterminate = false
  #walModeEnforced = false
  #inBatchTransaction = false
  #checkpointIntervalMs: number
  #checkpointTimer: ReturnType<typeof setTimeout> | null = null
  #checkpointCount = 0
  #workerCheckpointActive = false
  #onCheckpoint?: (sample: WalCheckpointSample) => void
  #onCommit?: (seq: number) => void
  #sessionDeleteEpoch = new Map<string, number>()
  #stmts: EventSinkStatements

  private constructor(handle: OrchestrationDbHandle, options: EventSinkOptions) {
    this.handle = handle
    this.bodyStore = new BodyStore(handle.orchestrationDir)
    this.#authorizedActors = new Set(['system', ...(options.authorizedActors ?? [])])
    this.#maxActiveRuns = options.maxActiveRuns ?? 8
    this.#isProviderAuthenticating = options.isProviderAuthenticating ?? (() => false)
    this.#checkpointIntervalMs = options.checkpointIntervalMs ?? 500
    this.#beforeCommitHook = options.beforeCommitHook
    this.#stmts = prepareEventSinkStatements(handle.db)
    this.#walModeEnforced = existsSync(`${handle.dbPath}-wal`)
  }

  setCheckpointObserver(observer: ((sample: WalCheckpointSample) => void) | undefined): void {
    this.#onCheckpoint = observer
  }

  setCommitObserver(observer: ((seq: number) => void) | undefined): void {
    this.#onCommit = observer
  }

  #maxSeqStatement: { get(): unknown } | undefined

  #notifyCommitted(): void {
    if (!this.#onCommit || !this.handle.db.open) return
    try {
      this.#maxSeqStatement ??= this.handle.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM orch_event')
      const row = this.#maxSeqStatement.get() as { seq: number }
      this.#onCommit(Number(row.seq))
    } catch {
    }
  }

  checkpointCount(): number { return this.#checkpointCount }

  walFileBytes(): number { return this.handle.db.open ? this.handle.walFileBytes() : 0 }

  setLockingMode(mode: 'normal' | 'exclusive'): void {
    this.#workerCheckpointActive = mode === 'normal'
    if (mode === 'normal' && this.#checkpointTimer) {
      clearTimeout(this.#checkpointTimer)
      this.#checkpointTimer = null
    }
    this.handle.setLockingMode(mode)
  }

  recordExternalCheckpoint(sample: WalCheckpointSample): void {
    this.#checkpointCount += 1
    this.#onCheckpoint?.(sample)
  }

  private scheduleIdleCheckpoint(): void {
    if (this.#checkpointIntervalMs <= 0 || this.#writeIndeterminate || this.#workerCheckpointActive || this.#checkpointTimer) return
    const timer = setTimeout(() => {
      this.#checkpointTimer = null
      this.checkpointPassive()
    }, this.#checkpointIntervalMs)
    timer.unref?.()
    this.#checkpointTimer = timer
  }

  checkpointPassive(): WalCheckpointResult { return this.runCheckpoint('passive') }
  checkpointTruncate(): WalCheckpointResult { return this.runCheckpoint('truncate') }

  private runCheckpoint(mode: 'passive' | 'truncate'): WalCheckpointResult {
    if (this.#writeIndeterminate || !this.handle.db.open) {
      return { busy: 0, log: 0, checkpointed: 0 }
    }
    if (this.#checkpointTimer) {
      clearTimeout(this.#checkpointTimer)
      this.#checkpointTimer = null
    }
    const walBytesBefore = this.handle.walFileBytes()
    const started = performance.now()
    try {
      const result = mode === 'truncate' ? this.handle.checkpointTruncate() : this.handle.checkpointPassive()
      const durationMs = Number((performance.now() - started).toFixed(2))
      this.#checkpointCount += 1
      this.#onCheckpoint?.({
        mode,
        durationMs,
        walBytesBefore,
        walBytesAfter: this.handle.walFileBytes(),
        result,
        executor: 'main',
        threadId: 0
      })
      return result
    } catch {
      return { busy: 1, log: 0, checkpointed: 0 }
    }
  }

  getSessionDeleteEpoch(sessionKey: string): number {
    return this.#sessionDeleteEpoch.get(sessionKey) ?? 0
  }

  private enforceModesOnceForWal(): void {
    if (this.#walModeEnforced) return
    if (existsSync(`${this.handle.dbPath}-wal`)) {
      this.handle.enforceModes()
      this.#walModeEnforced = true
    }
  }

  static open(options: EventSinkOptions): EventSink {
    const handle = openOrchestrationDatabase(options)
    const sink = new EventSink(handle, options)
    const erasure = resumeBodyErasure(handle.db, sink.bodyStore)
    if (erasure.error) console.warn('[scry] orchestration body erasure pending:', erasure.error)
    return sink
  }

  isWriteIndeterminate(): boolean {
    return this.#writeIndeterminate
  }

  authorizeActor(actor: string): void {
    this.#authorizedActors.add(actor)
  }

  private assertDeterminate(): void {
    if (this.#writeIndeterminate) {
      throw new OrchestrationStoreError('orchestration_write_indeterminate')
    }
  }

  private tripFence(error: unknown): never {
    this.#writeIndeterminate = true
    const message = error instanceof Error ? error.message : String(error)
    throw new OrchestrationStoreError('orchestration_write_indeterminate', message)
  }

  private createReadView(): OrchestratorReadView {
    return {
      isActorAuthorized: (actor) => actor.startsWith('effect:') || this.#authorizedActors.has(actor),
      getReceipt: (commandId, actor) => readReceiptRaw(this.#stmts, commandId, actor),
      getRun: (runId) => readRunRaw(this.#stmts, runId),
      getSession: (sessionKey) => readSessionRaw(this.#stmts, sessionKey),
      getNativeSession: (identity) => findNativeSession(this, identity),
      getTurnByRunId: (runId) => readTurnByRunIdRaw(this.#stmts, runId),
      getNextTurnOrdinal: (sessionKey) => readNextTurnOrdinalRaw(this.#stmts, sessionKey),
      getInteraction: (runId, questionId) => readInteractionRaw(this.#stmts, runId, questionId),
      listNonTerminalChildRuns: (parentRunId) => listNonTerminalChildRunsRaw(this.#stmts, parentRunId),
      listNonTerminalChildRunsBySession: (sessionKey) => listNonTerminalChildRunsBySessionRaw(this.#stmts, sessionKey),
      hasActiveRunForSession: (sessionKey) => Boolean(this.#stmts.hasActiveSessionRun.get(sessionKey)),
      activeRunCount: () => (this.#stmts.activeRunCount.get() as { count: number }).count,
      maxActiveRuns: () => this.#maxActiveRuns,
      isProviderAuthenticating: (provider, profile) => this.#isProviderAuthenticating(provider, profile)
    }
  }

  execute(command: OrchestrationCommand, txExtras?: EventSinkTxExtras): DecisionResult {
    if (this.#writeIndeterminate) {
      return {
        kind: 'rejected',
        reason: 'orchestration_write_indeterminate',
        sticky: false,
        writeReceipt: false
      }
    }
    if (command.type === 'run.submit') {
      const body = command.payload.body
      if (
        txExtras?.expectedSessionDeleteEpoch !== undefined &&
        command.payload.sessionKey &&
        this.getSessionDeleteEpoch(command.payload.sessionKey) !== txExtras.expectedSessionDeleteEpoch
      ) {
        if (body?.storage === 'external') {
          unlinkUnreferencedExternalBodyInDb(this.handle.db, this.bodyStore, body.sha256)
        }
        return {
          kind: 'rejected',
          reason: 'session_deleted_during_prepare',
          sticky: false,
          writeReceipt: false
        }
      }
      if (txExtras?.requireExternalBodyDurable && body?.storage === 'external') {
        if (!this.bodyStore.hasExternalBody(body.sha256)) {
          throw new OrchestrationStoreError(
            'orchestration_body_corrupt',
            `External body ${body.sha256} must be durable before commit`
          )
        }
      }
    }
    const decision = decide(command, this.createReadView())
    if (decision.kind === 'duplicate') {
      if (txExtras?.legacyLedgerSeq !== undefined) {
        this.advanceLegacyLedgerSeq(txExtras.legacyLedgerSeq)
      }
      return decision
    }
    if (decision.kind === 'rejected' && !decision.writeReceipt) return decision
    return this.commitDecision(decision, txExtras)
  }

  private advanceLegacyLedgerSeq(seq: number): void {
    try {
      this.#stmts.advanceLegacySeq.run(String(seq))
    } catch (error) {
      this.tripFence(error)
    }
  }

  runInBatchTransaction<T>(fn: () => T): T {
    this.assertDeterminate()
    if (this.#inBatchTransaction) return fn()
    const db = this.handle.db
    try {
      const tx = db.transaction(() => {
        this.#inBatchTransaction = true
        try {
          return fn()
        } finally {
          this.#inBatchTransaction = false
        }
      })
      const result = tx()
      this.enforceModesOnceForWal()
      this.scheduleIdleCheckpoint()
      this.#notifyCommitted()
      return result
    } catch (error) {
      if (error instanceof OrchestrationStoreError && error.code !== 'orchestration_write_indeterminate') {
        throw error
      }
      this.tripFence(error)
    }
  }

  private commitDecision(
    decision: Extract<DecisionResult, { kind: 'accepted' | 'rejected' }>,
    txExtras?: { legacyLedgerSeq?: number; legacyRunMapping?: { ledgerRunId: string; runId: string } }
  ): DecisionResult {
    const db = this.handle.db
    const writeRows = (): void => {
      let lastSeq: number | null = null
      if (decision.kind === 'accepted') {
        for (const pending of decision.events) {
          if (!ORCHESTRATION_EVENT_TYPES.has(pending.type)) {
            throw new OrchestrationStoreError('orchestration_invalid_event', `Invalid event type: ${pending.type}`)
          }
          assertNoUsageNumbersInEvent(pending.type, pending.payload)
          const payloadJson = assertBoundedPayload(pending.payload)
          const evidenceJson = pending.evidence ? canonicalJson(pending.evidence) : null
          const info = this.#stmts.insertEvent.run(
            pending.eventId,
            pending.at,
            pending.type,
            pending.stream,
            pending.sessionKey,
            pending.runId,
            pending.cwd,
            pending.commandId,
            pending.actor,
            pending.scope,
            payloadJson,
            evidenceJson,
            pending.principal,
            pending.via,
            pending.actorRunId
          )
          const seq = Number(info.lastInsertRowid)
          lastSeq = seq
          applyEventToProjection(db, { ...pending, seq })
        }

        const causationSeq = lastSeq ?? 0
        for (const effect of decision.effects) {
          const spec = getEffectPolicy(effect.kind)
          const payloadJson = assertBoundedPayload(effect.payload)
          this.#stmts.insertOutbox.run(
            effect.effectId,
            effect.kind,
            spec.policy,
            effect.runId,
            causationSeq,
            payloadJson,
            effect.state,
            effect.expiresAt,
            effect.leaseOwner,
            effect.claimedAt,
            effect.state === 'done' ? decision.receipt.acceptedAt : null
          )
        }
      }

      const receipt = decision.kind === 'accepted' ? decision.receipt : decision.receipt
      if (receipt) {
        const finalSeq = decision.kind === 'accepted' ? lastSeq : null
        receipt.resultSeq = finalSeq
        this.#stmts.insertCommand.run(
          receipt.commandId,
          receipt.actor,
          receipt.type,
          receipt.payloadSha256,
          receipt.acceptedAt,
          receipt.status,
          receipt.reason,
          receipt.result ? canonicalJson(receipt.result) : null,
          finalSeq,
          receipt.principal,
          receipt.via,
          receipt.actorRunId
        )
      }

      if (txExtras?.legacyRunMapping) {
        this.#stmts.insertLegacyRun.run(txExtras.legacyRunMapping.ledgerRunId, txExtras.legacyRunMapping.runId)
      }
      if (txExtras?.legacyLedgerSeq !== undefined) {
        this.#stmts.advanceLegacySeq.run(String(txExtras.legacyLedgerSeq))
      }

      this.#beforeCommitHook?.()
    }

    if (this.#inBatchTransaction) {
      writeRows()
      return decision
    }
    try {
      db.transaction(writeRows)()
      this.enforceModesOnceForWal()
      this.scheduleIdleCheckpoint()
      this.#notifyCommitted()
      return decision
    } catch (error) {
      if (error instanceof OrchestrationStoreError && error.code !== 'orchestration_write_indeterminate') {
        throw error
      }
      this.tripFence(error)
    }
  }

  stopRunBypassingFence<State extends RunRegistryState, Control extends RunRegistryControl>(
    runId: string,
    registry: RunRegistry<State, Control>,
    stopControl: (control: Control) => void
  ): string[] {
    return stopRunBypassingFenceInRegistry(runId, registry, stopControl)
  }

  deleteSession(input: DeleteSessionInput): DeleteSessionOutcome {
    if (this.#writeIndeterminate) {
      return { status: 'unavailable', error: 'orchestration_write_indeterminate' }
    }
    try {
      const { existed, redactedEvents } = deleteSessionInDb(
        this.handle.db,
        input,
        this.#beforeCommitHook
      )
      if (existed) {
        this.#sessionDeleteEpoch.set(input.sessionKey, (this.#sessionDeleteEpoch.get(input.sessionKey) ?? 0) + 1)
        this.handle.enforceModes()
        this.scheduleIdleCheckpoint()
        this.#notifyCommitted()
      }
      const erased = resumeBodyErasure(this.handle.db, this.bodyStore, {
        sessionKey: input.sessionKey, canWrite: () => !this.#writeIndeterminate
      })
      if (erased.error) return { status: 'unavailable', error: erased.error }
      if (!existed && erased.completed === 0 && erased.deferred === 0) return { status: 'not_present' }
      return { status: 'deleted', deletedBodies: erased.erased, redactedEvents }
    } catch (error) {
      this.#writeIndeterminate = true
      return { status: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
  }

  pruneEvents(options: { olderThanAt: number }): { deletedEvents: number; prunedThrough: number } {
    this.assertDeterminate()
    try {
      const current = Number(this.getMeta('pruned_through') ?? '0')
      return pruneEventsInDb(this.handle.db, options.olderThanAt, current)
    } catch (error) {
      this.tripFence(error)
    }
  }

  verifyReplayConsistency(): { matches: boolean; diff?: string } {
    this.assertDeterminate()
    return verifyReplayConsistencyInDb(this.handle.db, this.listEvents())
  }

  getMeta(key: string): string | undefined {
    this.assertDeterminate()
    const row = this.handle.db.prepare('SELECT value FROM orch_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.assertDeterminate()
    try {
      this.handle.db
        .prepare('INSERT OR REPLACE INTO orch_meta (key, value) VALUES (?, ?)')
        .run(key, value)
    } catch (error) {
      this.tripFence(error)
    }
  }

  getReceipt(commandId: string, actor: string): CommandReceiptRow | undefined {
    this.assertDeterminate()
    return readReceiptRaw(this.#stmts, commandId, actor)
  }

  getRun(runId: string): RunProjectionRow | undefined {
    this.assertDeterminate()
    return readRunRaw(this.#stmts, runId)
  }

  getSession(sessionKey: string): SessionProjectionRow | undefined {
    this.assertDeterminate()
    return readSessionRaw(this.#stmts, sessionKey)
  }

  getTurn(sessionKey: string, ordinal: number): TurnProjectionRow | undefined {
    this.assertDeterminate()
    return readTurnRaw(this.handle.db, sessionKey, ordinal)
  }

  getTurnByRunId(runId: string): TurnProjectionRow | undefined {
    this.assertDeterminate()
    return readTurnByRunIdRaw(this.#stmts, runId)
  }

  getNextTurnOrdinal(sessionKey: string): number {
    this.assertDeterminate()
    return readNextTurnOrdinalRaw(this.#stmts, sessionKey)
  }

  getInteraction(runId: string, questionId: string): InteractionProjectionRow | undefined {
    this.assertDeterminate()
    return readInteractionRaw(this.#stmts, runId, questionId)
  }

  listEvents(): OrchestrationEventRow[] {
    this.assertDeterminate()
    return listAllEventsRaw(this.handle.db)
  }

  listOutbox(): OutboxEffectRow[] {
    this.assertDeterminate()
    return listAllOutboxRaw(this.handle.db)
  }

  close(): void {
    if (this.#checkpointTimer) {
      clearTimeout(this.#checkpointTimer)
      this.#checkpointTimer = null
    }
    this.handle.close({ skipCheckpoint: this.#writeIndeterminate })
  }
}
